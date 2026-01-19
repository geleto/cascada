(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let isPoison;
  let isPoisonError;
  //let PoisonError;
  //let collectErrors;
  let AsyncFrame;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime/runtime');
    createPoison = runtime.createPoison;
    isPoison = runtime.isPoison;
    isPoisonError = runtime.isPoisonError;
    //PoisonError = runtime.PoisonError;
    //collectErrors = runtime.collectErrors;
    AsyncFrame = runtime.AsyncFrame;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    isPoisonError = nunjucks.runtime.isPoisonError;
    //PoisonError = nunjucks.runtime.PoisonError;
    //collectErrors = nunjucks.runtime.collectErrors;
    AsyncFrame = nunjucks.runtime.AsyncFrame;
  }

  describe('Lookup Functions Poison Handling', () => {

    describe('memberLookupAsync - Sync-First Hybrid', () => {
      it('should return poison synchronously for poisoned object', () => {
        const poison = createPoison(new Error('Poisoned object'));
        const result = runtime.memberLookupAsync(poison, 'prop');

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0].message).to.equal('Poisoned object');
      });

      it('should return poison synchronously for poisoned key', () => {
        const obj = { name: 'test' };
        const poison = createPoison(new Error('Poisoned key'));
        const result = runtime.memberLookupAsync(obj, poison);

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0].message).to.equal('Poisoned key');
      });

      it('should return value synchronously for non-promise inputs', () => {
        const obj = { name: 'test' };
        const result = runtime.memberLookupAsync(obj, 'name');

        expect(result).to.equal('test');
        expect(typeof result.then).to.equal('undefined');
      });

      it('should handle promise that resolves to poison', async () => {
        const poison = createPoison(new Error('Async poison'));
        const promise = Promise.resolve(poison);

        try {
          await runtime.memberLookupAsync(promise, 'prop');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should collect errors from multiple promises', async () => {
        const poison1 = createPoison(new Error('Error 1'));
        const poison2 = createPoison(new Error('Error 2'));
        const promise1 = Promise.resolve(poison1);
        const promise2 = Promise.resolve(poison2);

        try {
          await runtime.memberLookupAsync(promise1, promise2);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(2);
        }
      });

      it('should handle rejected promise', async () => {
        const promise = Promise.reject(new Error('Rejected'));

        try {
          await runtime.memberLookupAsync(promise, 'prop');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.equal('Rejected');
        }
      });

      it('should successfully lookup valid property', async () => {
        const obj = Promise.resolve({ name: 'test' });
        const result = await runtime.memberLookupAsync(obj, 'name');

        expect(result).to.equal('test');
      });
    });

    describe('memberLookupScriptAsync - Sync-First Hybrid', () => {
      it('should return poison for poisoned inputs', () => {
        const poison = createPoison(new Error('Test'));
        const result = runtime.memberLookupScriptAsync(poison, 'prop');

        expect(isPoison(result)).to.be(true);
      });

      it('should return value synchronously for literals', () => {
        const obj = { value: 42 };
        const result = runtime.memberLookupScriptAsync(obj, 'value');

        expect(result).to.equal(42);
      });

      it('should handle async inputs', async () => {
        const obj = Promise.resolve({ count: 10 });
        const result = await runtime.memberLookupScriptAsync(obj, 'count');

        expect(result).to.equal(10);
      });
    });

    describe('sequentialMemberLookupAsync - Pure Async', () => {
      let frame;

      beforeEach(() => {
        frame = new AsyncFrame();
        frame.set('!lockKey', undefined, true);
      });

      it('should throw PoisonError for poisoned lock', async () => {
        const lockPoison = createPoison(new Error('Lock poisoned'));
        frame.set('!lockKey', lockPoison, true);

        try {
          await runtime.sequentialMemberLookupAsync(
            frame,
            { prop: 'value' },
            'prop',
            '!lockKey',
            '!lockKey~'
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should throw PoisonError and poison lock for poisoned target', async () => {
        const poison = createPoison(new Error('Target poisoned'));

        try {
          await runtime.sequentialMemberLookupAsync(
            frame,
            poison,
            'prop',
            '!lockKey',
            '!lockKey~'
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);

          const readLock = frame.lookup('!lockKey~');
          expect(isPoison(readLock)).to.be(true);
        }
      });

      it('should handle promise that resolves to poison', async () => {
        const poison = createPoison(new Error('Resolved poison'));
        const promise = Promise.resolve(poison);

        try {
          await runtime.sequentialMemberLookupAsync(
            frame,
            promise,
            'prop',
            '!lockKey',
            '!lockKey~'
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);

          const readLock = frame.lookup('!lockKey~');
          expect(isPoison(readLock)).to.be(true);
        }
      });

      it('should handle promise that rejects', async () => {
        const promise = Promise.reject(new Error('Rejected'));

        try {
          await runtime.sequentialMemberLookupAsync(
            frame,
            promise,
            'prop',
            '!lockKey',
            '!lockKey~'
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);

          const readLock = frame.lookup('!lockKey~');
          expect(isPoison(readLock)).to.be(true);
        }
      });

      it('should successfully lookup and release lock', async () => {
        const obj = { name: 'test' };
        const result = await runtime.sequentialMemberLookupAsync(
          frame,
          obj,
          'name',
          '!lockKey',
          '!lockKey~'
        );

        expect(result).to.equal('test');

        const readLock = frame.lookup('!lockKey~');
        expect(readLock).to.equal(true);
      });
    });

    describe('sequentialContextLookup - Pure Async', () => {
      let frame, context;

      beforeEach(() => {
        frame = new AsyncFrame();
        frame.set('!lockKey', undefined, true);
        frame.set('myVar', 'test value', true);

        context = {
          lookup: (name) => undefined
        };
      });

      it('should throw PoisonError for poisoned lock', async () => {
        const lockPoison = createPoison(new Error('Lock poisoned'));
        frame.set('!lockKey', lockPoison, true);

        try {
          await runtime.sequentialContextLookup(
            context,
            frame,
            'myVar',
            '!lockKey',
            '!lockKey~'
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should throw PoisonError when variable is poisoned', async () => {
        const poison = createPoison(new Error('Variable poisoned'));
        frame.set('myVar', poison, true);

        try {
          await runtime.sequentialContextLookup(
            context,
            frame,
            'myVar',
            '!lockKey',
            '!lockKey~'
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);

          const lock = frame.lookup('!lockKey');
          expect(isPoison(lock)).to.be(true);
        }
      });

      it('should successfully lookup and release lock', async () => {
        const result = await runtime.sequentialContextLookup(
          context,
          frame,
          'myVar',
          '!lockKey',
          '!lockKey~'
        );

        expect(result).to.equal('test value');

        const readLock = frame.lookup('!lockKey~');
        expect(readLock).to.equal(true);
      });
    });

    describe('Sync-First Pattern Performance', () => {
      it('should not allocate Promise for literal in memberLookupAsync', () => {
        const obj = { items: [1, 2, 3] };
        const results = [];

        for (let i = 0; i < 100; i++) {
          results.push(runtime.memberLookupAsync(obj, 'items'));
        }

        results.forEach(r => {
          expect(Array.isArray(r)).to.be(true);
          expect(typeof r.then).to.equal('undefined');
        });
      });
    });

    describe('Error Collection Completeness', () => {
      it('should await both obj and val promises even if obj is poison', async () => {
        const poison = createPoison(new Error('Obj error'));
        const objPromise = Promise.resolve(poison);
        const valPromise = Promise.reject(new Error('Val error'));

        try {
          await runtime.memberLookupAsync(objPromise, valPromise);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          // Should contain both errors
          expect(err.errors).to.have.length(2);
          expect(err.errors.some(e => e.message === 'Obj error')).to.be(true);
          expect(err.errors.some(e => e.message === 'Val error')).to.be(true);
        }
      });
    });
  });
})();
