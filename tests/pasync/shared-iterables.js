import expect from 'expect.js';
import {StringLoader} from '../util.js';

const runtime = typeof window !== 'undefined' ? window.nunjucks.runtime : await import('../../src/runtime/runtime.js');
const {makeSharedIterable} = runtime;
const {AsyncEnvironment} = typeof window !== 'undefined' ? window.nunjucks : await import('../../src/environment/environment.js');

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return {promise, resolve};
}
async function collect(iterable) {
  const result = [];
  for await (const item of iterable) result.push(item);
  return result;
}
async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('Expected rejection');
}
const makeStream = () => (async function* () { yield 'a'; yield 'b'; yield 'c'; })();

describe('Shared iteration', () => {
  describe('Synchronous replay', () => {
    it('pulls lazily and replays one source through independent synchronous cursors', () => {
      let acquisitions = 0;
      let nextReads = 0;
      let pulls = 0;
      const raw = {
        [Symbol.iterator]() {
          acquisitions++;
          return {
            get next() {
              nextReads++;
              return () => (pulls < 3 ? {value: ++pulls, done: false} : {done: true});
            }
          };
        }
      };
      const shared = makeSharedIterable(raw);
      const a = shared[Symbol.iterator]();
      const b = shared[Symbol.iterator]();
      expect(acquisitions).to.be(0);
      expect(a.next()).to.eql({value: 1, done: false});
      expect(a.next()).to.eql({value: 2, done: false});
      expect(b.next()).to.eql({value: 1, done: false});
      expect([...a]).to.eql([3]);
      expect([...b]).to.eql([2, 3]);
      expect([...shared]).to.eql([1, 2, 3]);
      expect(acquisitions).to.be(1);
      expect(nextReads).to.be(1);
      expect(makeSharedIterable(raw)).to.be(shared);
      expect(makeSharedIterable(shared)).to.be(shared);
      expect(shared[Symbol.asyncIterator]).to.be(undefined);
      expect(shared.dispose()).to.be(undefined);
    });

    it('supports arrays, sets and primitive strings without changing yielded identity', () => {
      const item = {id: 1};
      for (const raw of [[item], new Set([item]), 'abc']) {
        const shared = makeSharedIterable(raw);
        expect([...shared]).to.eql([...raw]);
        expect([...shared]).to.eql([...raw]);
        if (typeof raw !== 'string') expect([...shared][0]).to.be(item);
        expect(makeSharedIterable(shared)).to.be(shared);
        shared.dispose();
      }
    });

    it('keeps promise-valued items intact in synchronous iteration', () => {
      const item = Promise.resolve('a');
      const shared = makeSharedIterable([item]);
      expect(shared[Symbol.iterator]().next()).to.eql({value: item, done: false});
      expect([...shared][0]).to.be(item);
      shared.dispose();
    });

    it('closes a cursor independently and disposes the native source only once', () => {
      let closes = 0;
      const raw = (function* () { try { yield 'a'; yield 'b'; } finally { closes++; } })();
      const shared = makeSharedIterable(raw);
      const a = shared[Symbol.iterator]();
      const b = shared[Symbol.iterator]();
      expect(a.next().value).to.be('a');
      expect(a.return()).to.eql({value: undefined, done: true});
      expect(a.next().done).to.be(true);
      expect(b.next().value).to.be('a');
      expect(closes).to.be(0);
      expect(shared[Symbol.dispose]()).to.be(undefined);
      expect(closes).to.be(1);
      shared.dispose();
      expect(closes).to.be(1);
      for (const cursor of [b, shared[Symbol.iterator]()]) {
        expect(() => cursor.next()).to.throwException(error => expect(error.name).to.be('SharedSourceDisposedError'));
      }
    });

    it('does not acquire an unused source or close an exhausted iterator', () => {
      let acquisitions = 0;
      let closes = 0;
      const raw = {
        [Symbol.iterator]() { acquisitions++; return this; },
        next: () => ({done: true}),
        return() { closes++; return {done: true}; }
      };
      makeSharedIterable(raw).dispose();
      expect(acquisitions).to.be(0);
      const shared = makeSharedIterable({...raw});
      expect([...shared]).to.eql([]);
      shared.dispose();
      expect(acquisitions).to.be(1);
      expect(closes).to.be(0);
    });

    it('replays the buffered prefix and original source failure', () => {
      const cause = new Error('sync read failed');
      let closes = 0;
      const raw = {
        [Symbol.iterator]() { return this; },
        index: 0,
        next() { if (this.index++ === 0) return {value: 'a'}; throw cause; },
        return() { closes++; return {done: true}; }
      };
      const shared = makeSharedIterable(raw);
      for (let pass = 0; pass < 2; pass++) {
        const cursor = shared[Symbol.iterator]();
        expect(cursor.next().value).to.be('a');
        expect(() => cursor.next()).to.throwException(error => expect(error).to.be(cause));
        expect(cursor.next().done).to.be(true);
      }
      shared.dispose();
      expect(closes).to.be(1);
    });

    it('reports malformed results and cleanup failures without retrying cleanup', () => {
      for (const raw of [
        {[Symbol.iterator]: () => null},
        {[Symbol.iterator]: () => ({next: () => 1})}
      ]) {
        const shared = makeSharedIterable(raw);
        expect(() => [...shared]).to.throwException(error => expect(error).to.be.a(TypeError));
        shared.dispose();
      }
      const cause = new Error('sync cleanup failed');
      let closes = 0;
      const shared = makeSharedIterable({
        [Symbol.iterator]() { return this; },
        next: () => ({value: 'a'}),
        return() { closes++; throw cause; }
      });
      shared[Symbol.iterator]().next();
      expect(() => shared.dispose()).to.throwException(error => expect(error).to.be(cause));
      shared.dispose();
      expect(closes).to.be(1);
    });

    it('prefers async iteration when both protocols exist', async () => {
      const raw = {
        get [Symbol.iterator]() { throw new Error('sync protocol must not be read'); },
        async *[Symbol.asyncIterator]() { yield 'async'; }
      };
      const shared = makeSharedIterable(raw);
      expect(shared[Symbol.iterator]).to.be(undefined);
      expect(await collect(shared)).to.eql(['async']);
      await shared.dispose();
    });

    it('replays explicit sync wrappers while raw synchronous sources keep native consumption', async () => {
      const template = '{% for x in source %}{{x}}{% endfor %}|{% for x in source %}{{x}}{% endfor %}';
      const makeSource = function* () { yield 'a'; yield 'b'; };
      const env = new AsyncEnvironment();
      const raw = makeSource();
      const rawShared = makeSharedIterable(raw);
      expect(await env.renderTemplateString(template, {source: raw})).to.be('ab|');
      expect([...rawShared]).to.eql([]);
      rawShared.dispose();
      const shared = makeSharedIterable(makeSource());
      for (const replayAsyncIterables of [true, false]) {
        const renderEnv = new AsyncEnvironment(null, {replayAsyncIterables});
        expect(await renderEnv.renderTemplateString(template, {source: shared})).to.be('ab|ab');
      }
      shared.dispose();
    });

    it('preserves synchronous source failures as iterator poison in async loops', async () => {
      const ec = [1, 2, 'source', 'origin.casc', null, null];
      const poison = runtime.PoisonError.create('sync source failed', ec, 'UserCallThrew');
      const fatal = runtime.RuntimeError.create('sync source failed', ec);
      for (const cause of [new Error('sync source failed'), poison, fatal]) {
        const shared = makeSharedIterable((function* () { yield 'a'; throw cause; })());
        const env = new AsyncEnvironment();
        for (let pass = 0; pass < 2; pass++) {
          const error = await rejection(env.renderTemplateString('{% for x in source %}{{x}}{% endfor %}', {source: shared}));
          if (cause === poison || cause === fatal) expect(error).to.be(cause);
          else {
            expect(runtime.isPoisonError(error)).to.be(true);
            expect(error.kind).to.be('IteratorThrew');
            expect(error.cause).to.be(cause);
          }
        }
        shared.dispose();
      }
    });
  });
  it('leaves native values and unused iteration protocols untouched', async () => {
    let reads = 0;
    const source = Object.defineProperty({total: 7}, Symbol.asyncIterator, {
      get() { reads++; throw new Error('must not be read'); }
    });
    const env = new AsyncEnvironment();
    env.addFilter('identity', value => value);
    const result = await env.renderScriptString(
      'var v = source\nreturn [v, box.stream, identity(v), promised, source | identity]',
      {source, box: {stream: source}, identity: value => value, promised: Promise.resolve(source)}
    );
    expect(result.every(value => value === source)).to.be(true);
    expect(reads).to.be(0);
    expect(await env.renderTemplateString('{{source | dump | safe}}:{{source | length}}', {source}))
      .to.be('{"total":7}:1');
    expect(reads).to.be(0);
  });

  it('preserves native properties, receivers and exported identity', async () => {
    class Stream {
      #total = 7;
      get total() { return this.#total; }
      count() { return this.#total; }
      async *[Symbol.asyncIterator]() { yield this.#total; }
    }
    const source = new Stream();
    const env = new AsyncEnvironment();
    expect(await env.renderScriptString(
      'var v = source\nreturn [v.total, v.count(), identity(v), v]',
      {source, identity: value => value}
    )).to.eql([7, 7, source, source]);
    expect(await env.renderScriptString('return source', {source})).to.be(source);
  });

  it('preserves plain-object sources through data copies and snapshots', async () => {
    let reads = 0;
    const source = {get [Symbol.asyncIterator]() { reads++; return makeStream; }};
    const replacement = {[Symbol.asyncIterator]: makeStream};
    const env = new AsyncEnvironment();
    const snapshots = await env.renderScriptString(`
      data result
      result.deepMerge({stream: source})
      var before = result.snapshot()
      result.extra = true
      var after = result.snapshot()
      result.deepMerge({stream: replacement})
      return [before, after, result.snapshot()]
    `, {source, replacement});
    expect(reads).to.be(0);
    expect(snapshots[0].stream).to.be(source);
    expect(snapshots[1].stream).to.be(source);
    expect(snapshots[2].stream).to.be(replacement);
    expect(await env.renderTemplateString(
      '{% for x in a.stream %}{{x}}{% endfor %}{% for x in b.stream %}{{x}}{% endfor %}',
      {a: snapshots[0], b: snapshots[1]}
    )).to.be('abcabc');
    expect(reads).to.be(1);
    await makeSharedIterable(source).dispose();
  });

  it('provides an explicit iterable with only replay and disposal, without native members', async () => {
    const raw = makeStream();
    raw.label = 'native';
    const shared = makeSharedIterable(raw);
    expect(shared).not.to.be(raw);
    expect(shared.label).to.be(undefined);
    expect(shared.next).to.be(undefined);
    expect(shared.return).to.be(undefined);
    expect(shared.throw).to.be(undefined);
    expect(Object.keys(shared)).to.eql([]);
    expect(makeSharedIterable(raw)).to.be(shared);
    expect(makeSharedIterable(shared)).to.be(shared);
    expect(await collect(shared)).to.eql(['a', 'b', 'c']);
    expect(await collect(shared)).to.eql(['a', 'b', 'c']);
    await shared.dispose();
    expect(makeSharedIterable(raw)).to.be(shared);
  });

  it('preserves async-iterable arrays as sources through data snapshots', async () => {
    const source = [1, 2];
    source[Symbol.asyncIterator] = makeStream;
    const env = new AsyncEnvironment();
    const snapshots = await env.renderScriptString(`
      data result
      result.stream = source
      var before = result.snapshot()
      result.extra = true
      return [before, result.snapshot()]
    `, {source});
    expect(snapshots.every(value => value.stream === source)).to.be(true);
    expect(await env.renderTemplateString(
      '{% for x in source %}{{x}}{% endfor %}{% for x in source %}{{x}}{% endfor %}', {source}
    )).to.be('abcabc');
    await makeSharedIterable(source).dispose();
  });

  it('keeps disposal visible to later Cascada loops over the original source', async () => {
    const raw = makeStream();
    const env = new AsyncEnvironment();
    const template = '{% for x in source %}{{x}}{% endfor %}';
    expect(await env.renderTemplateString(template, {source: raw})).to.be('abc');
    await makeSharedIterable(raw).dispose();
    const error = await rejection(env.renderTemplateString(template, {source: raw}));
    expect(runtime.isPoisonError(error)).to.be(true);
    expect(error.kind).to.be('IteratorThrew');
    expect(error.cause.name).to.be('SharedSourceDisposedError');
  });

  it('uses the same factory for raw sources and explicit iterables in either creation order', async () => {
    for (const explicitFirst of [false, true]) {
      let acquisitions = 0;
      const raw = {[Symbol.asyncIterator]() { acquisitions++; return makeStream(); }};
      const env = new AsyncEnvironment();
      let shared = explicitFirst ? makeSharedIterable(raw) : null;
      expect(await env.renderTemplateString('{% for x in source %}{{x}}{% endfor %}', {source: raw}))
        .to.be('abc');
      shared ??= makeSharedIterable(raw);
      expect(await env.renderTemplateString(
        '{% for x in raw %}{{x}}{% endfor %}{% for x in shared %}{{x}}{% endfor %}',
        {raw, shared}
      )).to.be('abcabc');
      expect(await collect(shared)).to.eql(['a', 'b', 'c']);
      expect(acquisitions).to.be(1);
      await shared.dispose();
    }
  });

  it('shares concurrent and later renders of the same source', async () => {
    let acquisitions = 0;
    const source = {[Symbol.asyncIterator]() { acquisitions++; return makeStream(); }};
    const template = '{% for x in source %}{{x}}{% endfor %}';
    const render = () => new AsyncEnvironment().renderTemplateString(template, {source});
    expect(await Promise.all([render(), render()])).to.eql(['abc', 'abc']);
    expect(await render()).to.be('abc');
    expect(acquisitions).to.be(1);
    await makeSharedIterable(source).dispose();
  });

  it('shares promised aliases regardless of which lookup resolves first', async () => {
    for (const first of ['a', 'b']) {
      const acquired = deferred();
      let acquisitions = 0;
      const raw = {[Symbol.asyncIterator]() { acquisitions++; acquired.resolve(); return makeStream(); }};
      const gates = {a: deferred(), b: deferred()};
      const render = new AsyncEnvironment().renderTemplateString(
        '{% for x in reads.a %}{{x}}{% endfor %}|{% for x in reads.b %}{{x}}{% endfor %}',
        {reads: {get a() { return gates.a.promise; }, get b() { return gates.b.promise; }}}
      );
      gates[first].resolve(raw);
      await acquired.promise;
      gates[first === 'a' ? 'b' : 'a'].resolve(raw);
      expect(await render).to.be('abc|abc');
      expect(acquisitions).to.be(1);
      await makeSharedIterable(raw).dispose();
    }
  });

  it('shares one ReadableStream reader while preserving native identity', async () => {
    const source = new ReadableStream({start(controller) {
      controller.enqueue('a'); controller.enqueue('b'); controller.close();
    }});
    const env = new AsyncEnvironment();
    expect(await env.renderScriptString('return source', {source})).to.be(source);
    expect(await env.renderTemplateString(
      '{% for x in source %}{{x}}{% endfor %}{% for x in source %}{{x}}{% endfor %}', {source}
    )).to.be('abab');
    expect(source.locked).to.be(false);
    expect(await env.renderTemplateString('{% for x in source %}{{x}}{% endfor %}', {source})).to.be('ab');
    await makeSharedIterable(source).dispose();
  });

  it('leaves JavaScript consumption native unless given an explicit shared iterable', async () => {
    const env = new AsyncEnvironment();
    const raw = makeStream();
    expect(await env.renderScriptString('return read(source)', {source: raw, read: collect}))
      .to.eql(['a', 'b', 'c']);
    expect(await env.renderTemplateString('{% for x in source %}{{x}}{% endfor %}', {source: raw})).to.be('');
    const shared = makeSharedIterable(makeStream());
    expect(await env.renderScriptString('return [read(source), read(source)]', {source: shared, read: collect}))
      .to.eql([['a', 'b', 'c'], ['a', 'b', 'c']]);
    await shared.dispose();
  });

  it('keeps native calls on callable iterables and accepts explicitly prepared iterable members', async () => {
    const callable = Object.assign(n => n * 2, {[Symbol.asyncIterator]: makeStream});
    const env = new AsyncEnvironment();
    expect(await env.renderScriptString('return [f(21), box.f(21)]', {f: callable, box: {f: callable}}))
      .to.eql([42, 42]);
    const shared = makeSharedIterable(callable);
    expect(await env.renderTemplateString(
      '{% for x in f %}{{x}}{% endfor %}{% for x in box.stream %}{{x}}{% endfor %}',
      {f: callable, box: {stream: shared}}
    )).to.be('abcabc');
    await shared.dispose();
  });

  it('reuses a factory created by a reentrant protocol getter', async () => {
    let inner;
    let entered = false;
    let acquisitions = 0;
    const raw = {get [Symbol.asyncIterator]() {
      if (!entered) { entered = true; inner = makeSharedIterable(raw); }
      return () => { acquisitions++; return makeStream(); };
    }};
    const outer = makeSharedIterable(raw);
    expect(outer).to.be(inner);
    expect(await Promise.all([collect(outer), collect(inner)])).to.eql([
      ['a', 'b', 'c'], ['a', 'b', 'c']
    ]);
    expect(acquisitions).to.be(1);
    await outer.dispose();
  });

  it('validates explicit inputs without acquiring the source', () => {
    for (const source of [null, undefined, 1, {}, {[Symbol.asyncIterator]: 1}]) {
      expect(() => makeSharedIterable(source)).to.throwException(error => expect(error).to.be.a(TypeError));
    }
    let acquisitions = 0;
    makeSharedIterable({[Symbol.asyncIterator]() { acquisitions++; return makeStream(); }});
    expect(acquisitions).to.be(0);
  });

  it('keeps native iteration and early-stop cleanup when replay is disabled', async () => {
    let closes = 0;
    const raw = (async function* () { try { yield 'a'; yield 'b'; } finally { closes++; } })();
    const env = new AsyncEnvironment(null, {replayAsyncIterables: false});
    expect(await env.renderScriptString('each x in source\nreturn x\nendeach', {source: raw})).to.be('a');
    expect(closes).to.be(1);
    expect(await env.renderScriptString('return source', {source: raw})).to.be(raw);
    const shared = makeSharedIterable(makeStream());
    expect(await env.renderTemplateString(
      '{% for x in source %}{{x}}{% endfor %}{% for x in source %}{{x}}{% endfor %}', {source: shared}
    )).to.be('abcabc');
    await shared.dispose();
  });

  for (const failure of ['invalid', 'rejected']) {
    it(`does not acquire a native stream when its loop limit is ${failure}`, async () => {
      const source = new ReadableStream({start(controller) {
        controller.enqueue('a'); controller.close();
      }});
      const cause = new Error('limit failed');
      const env = new AsyncEnvironment(null, {replayAsyncIterables: false});
      const error = await rejection(env.renderTemplateString(
        '{% for x in source of getLimit() %}{{x}}{% endfor %}',
        {source, async getLimit() { if (failure === 'rejected') throw cause; return -1; }}
      ));
      expect(runtime.isPoisonError(error)).to.be(true);
      expect(error.kind).to.be(failure === 'invalid' ? 'InvalidConcurrentLimit' : 'UserCallThrew');
      if (failure === 'rejected') expect(error.cause).to.be(cause);
      expect(source.locked).to.be(false);
      expect(await env.renderTemplateString('{% for x in source %}{{x}}{% endfor %}', {source})).to.be('a');
    });
  }

  it('leaves early-stop lifetime to the source owner', async () => {
    let closes = 0;
    const raw = (async function* () { try { yield 'a'; yield 'b'; } finally { closes++; } })();
    const env = new AsyncEnvironment();
    expect(await env.renderScriptString('each x in source\nreturn x\nendeach', {source: raw})).to.be('a');
    expect(closes).to.be(0);
    const shared = makeSharedIterable(raw);
    expect(await collect(shared)).to.eql(['a', 'b']);
    await shared.dispose();
    expect(closes).to.be(1);
  });

  for (const loop of ['for x in v', 'each x in v', 'for x in v of 2']) {
    const end = loop.startsWith('each') ? 'endeach' : 'endfor';
    it(`replays aliases and late readers with ${loop}`, async () => {
      const raw = makeStream();
      const result = await new AsyncEnvironment().renderScriptString(`
        var v = source
        var alias = v
        data result
        ${loop}
          result.first.push(x)
        ${end}
        for y in alias
          result.second.push(y)
        endfor
        result.stream = v
        return result.snapshot()
      `, {source: raw});
      expect(result.first).to.eql(['a', 'b', 'c']);
      expect(result.second).to.eql(['a', 'b', 'c']);
      expect(result.stream).to.be(raw);
      expect(await collect(makeSharedIterable(raw))).to.eql(['a', 'b', 'c']);
    });

    it(`preserves original poison and fatal errors with ${loop}`, async () => {
      const ec = [1, 2, 'source', 'origin.casc', null, null];
      const poison = runtime.PoisonError.create('source failed', ec, 'UserCallThrew');
      const fatal = runtime.RuntimeError.create('source failed', ec);
      for (const cause of [new Error('source failed'), poison, fatal]) {
        const raw = (async function* () { yield 'a'; throw cause; })();
        const error = await rejection(new AsyncEnvironment().renderScriptString(`
          var v = source
          text output
          ${loop}
            output(x)
          ${end}
          return output.snapshot()
        `, {source: raw}));
        if (cause === fatal || cause === poison) expect(error).to.be(cause);
        else {
          expect(runtime.isPoisonError(error)).to.be(true);
          expect(error.kind).to.be('IteratorThrew');
          expect(error.cause).to.be(cause);
        }
        expect(Object.hasOwn(cause, 'didIterate')).to.be(false);
        await makeSharedIterable(raw).dispose();
      }
    });

    it(`handles throwing protocol getters at the iteration boundary with ${loop}`, async () => {
      const cause = new Error('protocol getter failed');
      const raw = {get [Symbol.asyncIterator]() { throw cause; }};
      const error = await rejection(new AsyncEnvironment().renderScriptString(`
        var v = source
        text output
        ${loop}
          output(x)
        ${end}
        return output.snapshot()
      `, {source: raw}));
      expect(runtime.isPoisonError(error)).to.be(true);
      expect(error.kind).to.be('IteratorThrew');
      expect(error.cause).to.be(cause);
    });
  }

  it('retains failed iterators for explicit cleanup and reports cleanup failures separately', async () => {
    const cause = new Error('read failed');
    const cleanupError = new Error('cleanup failed');
    for (const failInGetter of [false, true]) {
      let closes = 0;
      const source = makeSharedIterable({
        [Symbol.asyncIterator]() {
          return {
            get next() {
              if (failInGetter) throw cause;
              return () => Promise.reject(cause);
            },
            return() {
              closes++;
              if (failInGetter) throw cleanupError;
              return {done: true};
            }
          };
        }
      });
      const error = await rejection(new AsyncEnvironment().renderTemplateString(
        '{% for x in source %}{{x}}{% endfor %}', {source}));
      expect(error.errors[0].cause).to.be(cause);
      expect(await rejection(collect(source))).to.be(cause);
      expect(closes).to.be(0);
      const cleanup = source.dispose();
      expect(source.dispose()).to.be(cleanup);
      if (failInGetter) expect(await rejection(cleanup)).to.be(cleanupError);
      else await cleanup;
      expect(closes).to.be(1);
    }
  });

  it('pulls lazily, serializes pulls and gives concurrent and late cursors the full sequence', async () => {
    let acquisitions = 0;
    let pulls = 0;
    let active = 0;
    const source = makeSharedIterable({
      [Symbol.asyncIterator]() { acquisitions++; return this; },
      async next() {
        expect(active++).to.be(0);
        await Promise.resolve();
        active--;
        return pulls < 3 ? {value: ++pulls, done: false} : {done: true};
      }
    });
    const a = source[Symbol.asyncIterator]();
    const b = source[Symbol.asyncIterator]();
    expect(acquisitions).to.be(0);
    expect(pulls).to.be(0);
    const first = await Promise.all([a.next(), a.next(), b.next()]);
    expect(first.map(item => item.value)).to.eql([1, 2, 1]);
    expect(pulls).to.be(2);
    expect(await Promise.all([collect(a), collect(b), collect(source)])).to.eql([[3], [2, 3], [1, 2, 3]]);
    expect(await collect(source)).to.eql([1, 2, 3]);
    expect(acquisitions).to.be(1);
    await source.dispose();
  });

  it('closes one cursor immediately without stopping another pending reader', async () => {
    const next = deferred();
    let closes = 0;
    const source = makeSharedIterable({
      [Symbol.asyncIterator]() { return this; },
      next: () => next.promise,
      return() { closes++; return {done: true}; }
    });
    const a = source[Symbol.asyncIterator]();
    const b = source[Symbol.asyncIterator]();
    const pendingA = a.next();
    const pendingB = b.next();
    expect((await a.return()).done).to.be(true);
    expect((await pendingA).done).to.be(true);
    expect(closes).to.be(0);
    next.resolve({value: 'a', done: false});
    expect((await pendingB).value).to.be('a');
    await source.dispose();
    expect(closes).to.be(1);
  });

  it('disposes once, rejects pending and future reads and discards late pull results', async () => {
    const next = deferred();
    let closes = 0;
    const source = makeSharedIterable({
      [Symbol.asyncIterator]() { return this; },
      next: () => next.promise,
      return() { closes++; return {done: true}; }
    });
    const cursor = source[Symbol.asyncIterator]();
    const pending = rejection(cursor.next());
    const cleanup = source.dispose();
    expect(source.dispose()).to.be(cleanup);
    const error = await pending;
    expect(error.name).to.be('SharedSourceDisposedError');
    expect(await rejection(cursor.next())).to.be(error);
    expect(await rejection(collect(source))).to.be(error);
    next.resolve({value: 'too late'});
    await cleanup;
    expect(closes).to.be(1);
    expect(await rejection(collect(source))).to.be(error);
  });

  it('does not acquire an unused source and does not return an exhausted iterator', async () => {
    let acquisitions = 0;
    let closes = 0;
    const raw = {
      [Symbol.asyncIterator]() { acquisitions++; return this; },
      next: () => ({done: true}),
      return() { closes++; return {done: true}; }
    };
    await makeSharedIterable(raw).dispose();
    expect(acquisitions).to.be(0);
    const source = makeSharedIterable({...raw});
    expect(await collect(source)).to.eql([]);
    await source.dispose();
    expect(acquisitions).to.be(1);
    expect(closes).to.be(0);
  });

  it('reports cleanup failure through the same disposal promise', async () => {
    const cause = new Error('cleanup failed');
    const source = makeSharedIterable({
      [Symbol.asyncIterator]() { return this; },
      next: () => ({value: 1}),
      return() { throw cause; }
    });
    await source[Symbol.asyncIterator]().next();
    const cleanup = source.dispose();
    expect(await rejection(cleanup)).to.be(cause);
    expect(source.dispose()).to.be(cleanup);
    expect((await rejection(collect(source))).name).to.be('SharedSourceDisposedError');
  });

  it('replays the prefix and original failure, including falsy thrown values', async () => {
    for (const cause of [new Error('failed'), undefined, null, false, 0]) {
      const source = makeSharedIterable((async function* () { yield 'a'; yield 'b'; throw cause; })());
      for (let pass = 0; pass < 2; pass++) {
        const cursor = source[Symbol.asyncIterator]();
        expect((await cursor.next()).value).to.be('a');
        expect((await cursor.next()).value).to.be('b');
        expect(await rejection(cursor.next())).to.be(cause);
      }
      await source.dispose();
    }
  });

  it('keeps promise-valued chunks intact and rejects malformed iterator results', async () => {
    const chunk = Promise.resolve('value');
    const source = makeSharedIterable({[Symbol.asyncIterator]() { return this; }, next: () => ({value: chunk})});
    expect((await source[Symbol.asyncIterator]().next()).value).to.be(chunk);
    await source.dispose();
    for (const raw of [
      {[Symbol.asyncIterator]: () => null},
      {[Symbol.asyncIterator]: () => ({next: () => 1})}
    ]) {
      expect(await rejection(collect(makeSharedIterable(raw)))).to.be.a(TypeError);
    }
  });

  it('keeps disposal terminal when iterator acquisition or result getters reenter', async () => {
    for (const stage of ['acquire', 'next', 'done', 'value']) {
      let view;
      let cleanup;
      let closes = 0;
      let pulls = 0;
      const disposeAt = name => {
        if (stage === name) cleanup = view.dispose();
      };
      view = makeSharedIterable({
        [Symbol.asyncIterator]() { disposeAt('acquire'); return this; },
        get next() {
          disposeAt('next');
          return () => {
            pulls++;
            return {
              get done() { disposeAt('done'); return false; },
              get value() { disposeAt('value'); return 'late'; }
            };
          };
        },
        return() { closes++; return {done: true}; }
      });
      const error = await rejection(view[Symbol.asyncIterator]().next());
      expect(error.name).to.be('SharedSourceDisposedError');
      await cleanup;
      expect(await rejection(view[Symbol.asyncIterator]().next())).to.be(error);
      expect(closes).to.be(1);
      expect(pulls).to.be(stage === 'acquire' || stage === 'next' ? 0 : 1);
    }
  });

  it('shares sources through inheritance, includes and components', async () => {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);
    loader.addTemplate('base.njk', '{% for x in source %}{{x}}{% endfor %}{% block body() %}{% endblock %}');
    loader.addTemplate('child.njk', '{% for x in source %}{{x}}{% endfor %}');
    expect(await env.renderTemplateString('{% extends "base.njk" %}{% block body() %}{% include "child.njk" with context %}{% endblock %}', {source: makeStream()})).to.be('abcabc');
    loader.addTemplate('component.script', 'method read()\ntext output\nfor x in source\noutput(x)\nendfor\nreturn output.snapshot()\nendmethod');
    expect(await env.renderScriptString('component "component.script" as card with context\nreturn [card.read(), card.read()]', {source: makeStream()})).to.eql(['abc', 'abc']);
  });

  it('retains sources captured by an extension content callback', async () => {
    let callback;
    const env = new AsyncEnvironment();
    env.addExtension('retain', {
      tags: ['retain'],
      parse(parser, nodes) {
        const token = parser.nextToken();
        const args = parser.parseSignature(null, true);
        parser.advanceAfterBlockEnd(token.value);
        const body = parser.parseUntilBlocks('endretain');
        parser.advanceAfterBlockEnd();
        return new nodes.CallExtension(this, 'run', args, [body]);
      },
      run(context, body) { callback = body; return ''; }
    });
    expect(await env.renderTemplateString(`
      {%- set v = makeStream() -%}
      {%- retain -%}{%- for x in v -%}{{x}}{%- endfor -%}{%- endretain -%}
      {%- for x in v -%}{{x}}{%- endfor -%}
    `, {makeStream})).to.be('abc');
    const invoke = () => new Promise((resolve, reject) => callback((error, value) => {
      if (error) reject(error);
      else resolve(value);
    }));
    expect(String(await invoke())).to.be('abc');
    expect(String(await invoke())).to.be('abc');
  });

  it('shares keyword arguments passed to macros', async () => {
    const output = await new AsyncEnvironment().renderTemplateString(`
      {%- macro read(v = null) -%}
        {%- for x in v -%}{{x}}{%- endfor -%}{%- for x in v -%}{{x}}{%- endfor -%}
      {%- endmacro -%}
      {{- read(v = makeStream()) -}}
    `, {makeStream});
    expect(output).to.be('abcabc');
  });

  it('preserves sharing through includes and imports', async () => {
    const loader = new StringLoader();
    loader.addTemplate('read.njk', '{% for x in v %}{{x}}{% endfor %}');
    loader.addTemplate('source.njk', '{% set v = makeStream() %}{% for x in v %}{{x}}{% endfor %}');
    const env = new AsyncEnvironment(loader);
    expect(await env.renderTemplateString(`
      {%- set v = makeStream() -%}
      {%- include "read.njk" with v -%}
      {%- for x in v -%}{{x}}{%- endfor -%}
    `, {makeStream})).to.be('abcabc');
    expect(await env.renderTemplateString(`
      {%- import "source.njk" as source with context -%}
      {%- for x in source.v -%}{{x}}{%- endfor -%}
      {%- for x in source.v -%}{{x}}{%- endfor -%}
    `, {makeStream})).to.be('abcabc');
  });
});
