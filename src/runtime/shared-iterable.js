import {markPromiseHandled} from './errors.js';
import {assertIteratorResult, readIteratorResult, iteratorClose, asyncIteratorClose} from './iterator.js';

const sources = new WeakMap();
const WAIT = Symbol('waiting for a shared iterator');

class SharedSourceDisposedError extends Error {
  constructor() {
    super('The shared iterable has been disposed.');
    this.name = 'SharedSourceDisposedError';
  }
}

class SharedIterable {
  #source;
  #method;
  #iterator = null;
  #next;
  #buffer = [];
  #terminal = null;

  constructor(source, method) {
    this.#source = source;
    this.#method = method;
  }

  [Symbol.iterator]() {
    let position = 0;
    let closed = false;
    return {
      [Symbol.iterator]() { return this; },
      next: () => {
        if (closed) return {value: undefined, done: true};
        const result = this.#read(position);
        if (result.failed) {
          if (!result.disposed) closed = true;
          throw result.error;
        }
        if (result.done) closed = true;
        else position++;
        return {value: result.value, done: !!result.done};
      },
      return() {
        closed = true;
        return {value: undefined, done: true};
      }
    };
  }

  #read(position) {
    if (this.#terminal?.disposed) return this.#terminal;
    if (position < this.#buffer.length) return {value: this.#buffer[position]};
    if (!this.#terminal) {
      try {
        if (!this.#iterator) {
          const iterator = this.#method.call(this.#source);
          assertIteratorResult(iterator);
          this.#iterator = iterator;
          this.#source = null;
          this.#method = null;
          if (this.#terminal?.disposed) {
            this.#iterator = null;
            iteratorClose(iterator);
            return this.#terminal;
          }
          this.#next = iterator.next;
        }
        if (this.#terminal?.disposed) {
          this.#next = null;
          return this.#terminal;
        }
        const result = readIteratorResult(this.#next.call(this.#iterator));
        if (result.value instanceof Promise) markPromiseHandled(result.value);
        if (!this.#terminal?.disposed) {
          if (result.done) this.#terminal = {done: true};
          else this.#buffer.push(result.value);
        }
      } catch (error) {
        if (!this.#terminal?.disposed) this.#terminal = {failed: true, error};
      }
      if (this.#terminal && !this.#terminal.disposed) {
        if (this.#terminal.done) this.#iterator = null;
        this.#source = null;
        this.#method = null;
        this.#next = null;
      }
    }
    return this.#terminal || {value: this.#buffer[position]};
  }

  dispose() {
    if (this.#terminal?.disposed) return;
    this.#terminal = {failed: true, disposed: true, error: new SharedSourceDisposedError()};
    this.#buffer = [];
    this.#source = null;
    this.#method = null;
    const iterator = this.#iterator;
    this.#iterator = null;
    this.#next = null;
    if (iterator) iteratorClose(iterator);
  }
}

if (typeof Symbol.dispose === 'symbol') {
  SharedIterable.prototype[Symbol.dispose] = SharedIterable.prototype.dispose;
}

// One source iterator and history; each cursor owns only its position and requests.
class SharedAsyncIterable {
  #source;
  #method;
  #iterator = null;
  #next;
  #buffer = [];
  #terminal = null;
  #pulling = false;
  #waiters = new Set();
  #cleanup = null;

  constructor(source, method) {
    this.#source = source;
    this.#method = method;
  }

  [Symbol.asyncIterator]() {
    let position = 0;
    let closed = false;
    const requests = [];
    const drain = () => {
      while (requests.length) {
        const result = closed ? {done: true} : this.#read(position);
        if (result === WAIT) {
          this.#waiters.add(drain);
          if (!this.#pulling) {
            this.#pulling = true;
            markPromiseHandled(this.#pull());
          }
          return;
        }
        const {resolve, reject} = requests.shift();
        if (result.failed) {
          if (!result.disposed) closed = true;
          reject(result.error);
        } else {
          if (result.done) closed = true;
          else position++;
          resolve({value: result.value, done: !!result.done});
        }
      }
      this.#waiters.delete(drain);
    };
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        const pending = new Promise((resolve, reject) => requests.push({resolve, reject}));
        drain();
        return pending;
      },
      return() {
        closed = true;
        drain();
        return Promise.resolve({value: undefined, done: true});
      }
    };
  }

  #read(position) {
    if (this.#terminal?.disposed) return this.#terminal;
    if (position < this.#buffer.length) return {value: this.#buffer[position]};
    return this.#terminal || WAIT;
  }

  async #pull() {
    try {
      if (!this.#iterator) {
        const iterator = this.#method.call(this.#source);
        assertIteratorResult(iterator);
        this.#iterator = iterator;
        this.#source = null;
        this.#method = null;
        if (this.#terminal?.disposed) return;
        this.#next = this.#iterator.next;
      }
      if (this.#terminal?.disposed) return;
      const result = readIteratorResult(await this.#next.call(this.#iterator));
      if (result.value instanceof Promise) markPromiseHandled(result.value);
      if (this.#terminal?.disposed) return;
      if (result.done) {
        this.#terminal = {done: true};
      } else {
        this.#buffer.push(result.value);
      }
    } catch (error) {
      if (!this.#terminal?.disposed) this.#terminal = {failed: true, error};
    } finally {
      this.#pulling = false;
      if (this.#terminal && !this.#terminal.disposed) {
        if (this.#terminal.done) this.#iterator = null;
        this.#source = null;
        this.#method = null;
        this.#next = null;
      }
      this.#notify();
    }
  }

  #notify() {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const drain of waiters) drain();
  }

  dispose() {
    if (this.#cleanup) return this.#cleanup;
    this.#terminal = {failed: true, disposed: true, error: new SharedSourceDisposedError()};
    this.#buffer = [];
    this.#source = null;
    this.#method = null;
    // Install cleanup before calling user code, including reentrant acquisition.
    this.#cleanup = Promise.resolve().then(() => {
      const iterator = this.#iterator;
      this.#iterator = null;
      this.#next = null;
      return iterator ? asyncIteratorClose(iterator) : undefined;
    });
    markPromiseHandled(this.#cleanup);
    this.#notify();
    return this.#cleanup;
  }
}

if (typeof Symbol.asyncDispose === 'symbol') {
  SharedAsyncIterable.prototype[Symbol.asyncDispose] = SharedAsyncIterable.prototype.dispose;
}

function sharedSource(source, method, SharedType) {
  let shared = sources.get(source);
  if (!shared) {
    shared = new SharedType(source, method);
    if (typeof source === 'object' || typeof source === 'function') sources.set(source, shared);
    sources.set(shared, shared);
  }
  return shared;
}

// Called only at iteration boundaries. Values elsewhere retain native identity.
function getAsyncIterator(source, replay = true) {
  const shared = replay && sources.get(source);
  if (shared) return shared instanceof SharedAsyncIterable ? shared[Symbol.asyncIterator]() : null;
  const method = source?.[Symbol.asyncIterator];
  if (typeof method !== 'function') return null;
  if (replay) return sharedSource(source, method, SharedAsyncIterable)[Symbol.asyncIterator]();
  const iterator = method.call(source);
  assertIteratorResult(iterator);
  return iterator;
}

function makeSharedIterable(source) {
  const existing = sources.get(source);
  if (existing) return existing;
  const asyncMethod = source?.[Symbol.asyncIterator];
  if (typeof asyncMethod === 'function') return sharedSource(source, asyncMethod, SharedAsyncIterable);
  const method = source?.[Symbol.iterator];
  if (typeof method !== 'function') throw new TypeError('Expected an iterable.');
  return sharedSource(source, method, SharedIterable);
}

export {makeSharedIterable, getAsyncIterator};
