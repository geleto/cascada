(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let isPoison;
  let isPoisonError;
  //let PoisonError;
  let collectErrors;
  let AsyncFrame;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime/runtime');
    createPoison = runtime.createPoison;
    isPoison = runtime.isPoison;
    isPoisonError = runtime.isPoisonError;
    //PoisonError = runtime.PoisonError;
    collectErrors = runtime.collectErrors;
    AsyncFrame = runtime.AsyncFrame;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    isPoisonError = nunjucks.runtime.isPoisonError;
    //PoisonError = nunjucks.runtime.PoisonError;
    collectErrors = nunjucks.runtime.collectErrors;
    AsyncFrame = nunjucks.runtime.AsyncFrame;
  }

  const mockErrorContext = { lineno: 1, colno: 1, errorContextString: 'test', path: 'test' };

  async function expectLockPoison(lock) {
    if (lock && typeof lock.then === 'function') {
      try {
        await lock;
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    } else {
      expect(isPoison(lock)).to.be(true);
    }
  }

  async function expectLockTrue(lock) {
    if (lock && typeof lock.then === 'function') {
      const resolved = await lock;
      expect(resolved).to.equal(true);
    } else {
      expect(lock).to.equal(true);
    }
  }

  async function expectLockValue(lock, value) {
    if (lock && typeof lock.then === 'function') {
      const resolved = await lock;
      expect(resolved).to.equal(value);
    } else {
      expect(lock).to.equal(value);
    }
  }

  describe('Call and Suppression Function Poison Handling', () => {

    describe('callWrap - Sync Function (original behavior)', () => {
      let mockContext;

      beforeEach(() => {
        mockContext = {
          env: { globals: {} },
          ctx: {}
        };
      });

      it('should throw for undefined function', () => {
        expect(() => {
          runtime.callWrap(undefined, 'missing', mockContext, []);
        }).to.throwError(/undefined or falsey/);
      });

      it('should throw for non-function value', () => {
        expect(() => {
          runtime.callWrap('not a function', 'notFunc', mockContext, []);
        }).to.throwError(/not a function/);
      });

      it('should throw when function throws', () => {
        expect(() => {
          runtime.callWrap(
            () => { throw new Error('Function error'); },
            'throwingFunc',
            mockContext,
            []
          );
        }).to.throwError(/Function error/);
      });

      it('should successfully call valid function', () => {
        const result = runtime.callWrap(
          (x, y) => x + y,
          'add',
          mockContext,
          [5, 3]
        );

        expect(result).to.equal(8);
      });
    });

    describe('callWrapAsync - Async Function (returns poison)', () => {
      let mockContext;

      beforeEach(() => {
        mockContext = {
          env: { globals: {} },
          ctx: {}
        };
      });

      it('should return poison for poisoned arguments', () => {
        const err = new Error('Poisoned argument');
        const poison = createPoison(err);

        const result = runtime.callWrapAsync(
          (x) => x * 2,
          'double',
          mockContext,
          [poison],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors).to.have.length(1);
        expect(result.errors[0]).to.equal(err);
      });

      it('should collect errors from multiple poisoned arguments', () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison1 = createPoison(err1);
        const poison2 = createPoison(err2);

        const result = runtime.callWrapAsync(
          (x, y) => x + y,
          'add',
          mockContext,
          [poison1, poison2],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors).to.have.length(2);
        expect(result.errors[0]).to.equal(err1);
        expect(result.errors[1]).to.equal(err2);
      });

      it('should return poison for poisoned function', () => {
        const err = new Error('Poisoned function');
        const poison = createPoison(err);

        const result = runtime.callWrapAsync(
          poison,
          'poisonedFunc',
          mockContext,
          [5, 3],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0]).to.equal(err);
      });

      it('should convert thrown errors to poison', () => {
        const result = runtime.callWrapAsync(
          () => { throw new Error('Function error'); },
          'throwingFunc',
          mockContext,
          [],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0].message).to.contain('Function error');
      });

      it('should return poison for undefined function', () => {
        const result = runtime.callWrapAsync(
          undefined,
          'missing',
          mockContext,
          [],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0].message).to.contain('undefined or falsey');
      });

      it('should return poison for non-function value', () => {
        const result = runtime.callWrapAsync(
          'not a function',
          'notFunc',
          mockContext,
          [],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0].message).to.contain('not a function');
      });

      it('should successfully call valid function with valid args', () => {
        const result = runtime.callWrapAsync(
          (x, y) => x + y,
          'add',
          mockContext,
          [5, 3],
          mockErrorContext
        );

        expect(result).to.equal(8);
        expect(isPoison(result)).to.be(false);
      });

      it('should handle mixed valid and poisoned arguments', () => {
        const err = new Error('Poisoned arg');
        const poison = createPoison(err);

        const result = runtime.callWrapAsync(
          (x, y, z) => x + y + z,
          'addThree',
          mockContext,
          [5, poison, 3],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0]).to.equal(err);
      });
    });

    describe('callWrapAsync - Never Miss Any Error Principle', () => {
      let mockContext;

      beforeEach(() => {
        mockContext = {
          env: { globals: {} },
          ctx: {}
        };
      });

      it('should await all arg promises even if func is poison', async () => {
        const funcPoison = createPoison(new Error('Func error'));
        const argPromise = Promise.reject(new Error('Arg error'));

        // callWrapAsync returns a promise when args contain promises
        // When awaited, poison values trigger thenable protocol and throw PoisonError
        try {
          await runtime.callWrapAsync(
            funcPoison,
            'func',
            mockContext,
            [argPromise, 'normalArg']
          );
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          // Must collect BOTH errors
          expect(runtime.isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(2);
          expect(err.errors.some(e => e.message === 'Func error')).to.be(true);
          expect(err.errors.some(e => e.message === 'Arg error')).to.be(true);
        }
      });

      it('should collect errors from multiple poisoned args even if func is poison', () => {
        const funcErr = new Error('Func error');
        const err1 = new Error('Arg1 error');
        const err2 = new Error('Arg2 error');

        const result = runtime.callWrapAsync(
          createPoison(funcErr),
          'add',
          mockContext,
          [createPoison(err1), createPoison(err2)]
        );

        expect(isPoison(result)).to.be(true);
        expect(result.errors).to.have.length(3);
        expect(result.errors[0]).to.equal(funcErr);
        expect(result.errors[1]).to.equal(err1);
        expect(result.errors[2]).to.equal(err2);
      });

      it('should await promise args before calling function', async () => {
        const callOrder = [];

        const slowPromise = new Promise(resolve => {
          setTimeout(() => {
            callOrder.push('promise-resolved');
            resolve(5);
          }, 10);
        });

        const func = (...args) => {
          callOrder.push('function-called');
          return args.reduce((a, b) => a + b, 0);
        };

        const result = await runtime.callWrapAsync(func, 'sum', mockContext, [1, slowPromise, 3]);

        expect(callOrder).to.eql(['promise-resolved', 'function-called']);
        expect(result).to.equal(9);
      });

      it('should await promise func before calling', async () => {
        const callOrder = [];

        const slowFuncPromise = new Promise(resolve => {
          setTimeout(() => {
            callOrder.push('func-resolved');
            resolve((...args) => {
              callOrder.push('function-called');
              return args.reduce((a, b) => a + b, 0);
            });
          }, 10);
        });

        const result = await runtime.callWrapAsync(slowFuncPromise, 'sum', mockContext, [1, 2, 3]);

        expect(callOrder).to.eql(['func-resolved', 'function-called']);
        expect(result).to.equal(6);
      });

      it('should collect all errors when both func and args are rejecting promises', async () => {
        const funcPromise = Promise.reject(new Error('Func promise error'));
        const argPromise1 = Promise.reject(new Error('Arg1 promise error'));
        const argPromise2 = Promise.reject(new Error('Arg2 promise error'));

        try {
          await runtime.callWrapAsync(
            funcPromise,
            'func',
            mockContext,
            [argPromise1, argPromise2, 'normalArg'],
            mockErrorContext
          );
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(runtime.isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(3);
          expect(err.errors.some(e => e.message.includes('Func promise error'))).to.be(true);
          expect(err.errors.some(e => e.message.includes('Arg1 promise error'))).to.be(true);
          expect(err.errors.some(e => e.message.includes('Arg2 promise error'))).to.be(true);
        }
      });

      it('should collect errors from mix of poison values and rejecting promises', async () => {
        const poisonFunc = createPoison(new Error('Func poison'));
        const poisonArg = createPoison(new Error('Arg1 poison'));
        const rejectingArg = Promise.reject(new Error('Arg2 promise error'));

        try {
          await runtime.callWrapAsync(
            poisonFunc,
            'func',
            mockContext,
            [poisonArg, rejectingArg, 'normalArg'],
            mockErrorContext
          );
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(runtime.isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(3);
          expect(err.errors.some(e => e.message.includes('Func poison'))).to.be(true);
          expect(err.errors.some(e => e.message.includes('Arg1 poison'))).to.be(true);
          expect(err.errors.some(e => e.message.includes('Arg2 promise error'))).to.be(true);
        }
      });

      it('should handle promises that resolve to poison', async () => {
        const argPromise = Promise.resolve(createPoison(new Error('Resolved to poison')));

        try {
          await runtime.callWrapAsync(
            (x) => x * 2,
            'double',
            mockContext,
            [argPromise],
            mockErrorContext
          );
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(runtime.isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(1);
          expect(err.errors[0].message).to.contain('Resolved to poison');
        }
      });
    });

    describe('sequentialCallWrap - Pure Async Function', () => {
      let frame, root, mockContext;

      beforeEach(() => {
        root = new AsyncFrame();
        root.set('!lockKey', undefined, true);
        root.set('!lockKey~', undefined, true);
        frame = root.pushAsyncBlock(null, { '!lockKey': 1, '!lockKey~': 1 });
        mockContext = {
          env: { globals: {} },
          ctx: {}
        };
      });

      it('should throw PoisonError for poisoned arguments', async () => {
        const err = new Error('Poisoned arg');
        const poison = createPoison(err);

        try {
          await runtime.sequentialCallWrap(
            (x) => x * 2,
            'double',
            mockContext,
            [poison],
            frame,
            '!lockKey',
            '!lockKey~',
            mockErrorContext
          );
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0]).to.equal(err);

          // Lock should be poisoned
          const lock = root.lookup('!lockKey');
          await expectLockPoison(lock);
        }
      });

      it('should throw PoisonError when function throws', async () => {
        try {
          await runtime.sequentialCallWrap(
            () => { throw new Error('Boom'); },
            'throwingFunc',
            mockContext,
            [],
            frame,
            '!lockKey',
            '!lockKey~',
            mockErrorContext
          );
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);

          const lock = root.lookup('!lockKey');
          await expectLockPoison(lock);
        }
      });

      it('should throw PoisonError for poisoned function', async () => {
        const poison = createPoison(new Error('Poisoned function'));

        try {
          await runtime.sequentialCallWrap(
            poison,
            'poisonedFunc',
            mockContext,
            [],
            frame,
            '!lockKey',
            '!lockKey~',
            mockErrorContext
          );
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);

          const lock = root.lookup('!lockKey');
          await expectLockPoison(lock);
        }
      });

      it('should throw PoisonError for poisoned lock', async () => {
        const lockPoison = createPoison(new Error('Lock poisoned'));
        root = new AsyncFrame();
        root.set('!lockKey', lockPoison, true);
        root.set('!lockKey~', undefined, true);
        frame = root.pushAsyncBlock(null, { '!lockKey': 1, '!lockKey~': 1 });

        try {
          await runtime.sequentialCallWrap(
            (x) => x * 2,
            'double',
            mockContext,
            [5],
            frame,
            '!lockKey',
            '!lockKey~',
            mockErrorContext
          );
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
        }
      });

      it('should handle async function that rejects', async () => {
        const asyncFunc = async () => {
          throw new Error('Async rejection');
        };

        try {
          await runtime.sequentialCallWrap(
            asyncFunc,
            'asyncFunc',
            mockContext,
            [],
            frame,
            '!lockKey',
            '!lockKey~',
            mockErrorContext
          );
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);

          const lock = root.lookup('!lockKey');
          await expectLockPoison(lock);
        }
      });

      it('should handle promise argument that rejects', async () => {
        const rejectingPromise = Promise.reject(new Error('Promise rejection'));

        try {
          await runtime.sequentialCallWrap(
            (x) => x * 2,
            'double',
            mockContext,
            [rejectingPromise],
            frame,
            '!lockKey',
            '!lockKey~',
            mockErrorContext
          );
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);

          const lock = root.lookup('!lockKey');
          await expectLockPoison(lock);
        }
      });

      it('should successfully call valid function', async () => {
        const result = await runtime.sequentialCallWrap(
          (x, y) => x + y,
          'add',
          mockContext,
          [5, 3],
          frame,
          '!lockKey',
          '!lockKey~',
          mockErrorContext
        );

        expect(result).to.equal(8);

        // Lock should be released (set to true)
        const lock = root.lookup('!lockKey');
        await expectLockTrue(lock);
      });

      it('should handle async function that resolves', async () => {
        const asyncFunc = async () => {
          return 42;
        };

        const result = await runtime.sequentialCallWrap(
          asyncFunc,
          'asyncFunc',
          mockContext,
          [],
          frame,
          '!lockKey',
          '!lockKey~',
          mockErrorContext
        );

        expect(result).to.equal(42);

        const lock = root.lookup('!lockKey');
        await expectLockValue(lock, 42);
      });
    });

    describe('suppressValueAsync - Sync-First Hybrid', () => {
      it('should return literal values synchronously (no Promise)', () => {
        const result = runtime.suppressValueAsync('hello', false, mockErrorContext);

        // Should be the value itself, not a Promise
        expect(result).to.equal('hello');
        expect(typeof result.then).to.equal('undefined');
      });

      it('should return rejected Promise for poison synchronously', async () => {
        const poison = createPoison(new Error('Test'));
        const result = runtime.suppressValueAsync(poison, false, mockErrorContext);

        // Should be a Promise
        expect(typeof result.then).to.equal('function');

        try {
          await result;
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.equal('Test');
        }
      });

      it('should handle poison in promise', async () => {
        const poison = createPoison(new Error('Async error'));
        const promise = Promise.resolve(poison);

        try {
          await runtime.suppressValueAsync(promise, false, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.equal('Async error');
        }
      });

      it('should collect errors from array with multiple poisons', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison1 = createPoison(err1);
        const poison2 = createPoison(err2);

        const arr = [poison1, 'text', poison2];

        try {
          await runtime.suppressValueAsync(arr, false, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(2);
          expect(thrown.errors[0]).to.equal(err1);
          expect(thrown.errors[1]).to.equal(err2);
        }
      });

      it('should handle rejected promise in array', async () => {
        const arr = [
          Promise.resolve('ok'),
          Promise.reject(new Error('Rejected')),
          'text'
        ];

        try {
          await runtime.suppressValueAsync(arr, false, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.equal('Rejected');
        }
      });

      it('should handle promise that resolves to poison', async () => {
        const poison = createPoison(new Error('Resolved poison'));
        const promise = Promise.resolve(poison);

        try {
          await runtime.suppressValueAsync(promise, false, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.equal('Resolved poison');
        }
      });

      it('should suppress valid values correctly', () => {
        // suppressValue doesn't convert to string unless autoescape is true
        expect(runtime.suppressValueAsync(123, false, mockErrorContext)).to.equal(123);
        expect(runtime.suppressValueAsync('hello', false, mockErrorContext)).to.equal('hello');
        expect(runtime.suppressValueAsync(true, false, mockErrorContext)).to.equal(true);
        expect(runtime.suppressValueAsync(null, false, mockErrorContext)).to.equal('');
        expect(runtime.suppressValueAsync(undefined, false, mockErrorContext)).to.equal('');
      });

      it('should handle autoescape correctly for literals', () => {
        const result = runtime.suppressValueAsync('<script>', true, mockErrorContext);
        expect(result).to.equal('&lt;script&gt;');
      });

      it('should handle array without promises synchronously', () => {
        const arr = ['hello', 'world'];
        const result = runtime.suppressValueAsync(arr, false, mockErrorContext);

        // Should be an array, not a Promise
        expect(Array.isArray(result)).to.be(true);
        expect(result.length).to.be.greaterThan(0);
        expect(result[0]).to.equal('hello,world');
      });

      it('should handle array with promises asynchronously', async () => {
        const arr = ['hello', Promise.resolve('world')];
        const result = await runtime.suppressValueAsync(arr, false, mockErrorContext);

        expect(Array.isArray(result)).to.be(true);
        expect(result[0]).to.equal('hello,world');
      });
    });

    describe('ensureDefinedAsync - Sync-First Hybrid', () => {
      const mockContext = { path: '/test.html' };

      it('should return literal values synchronously', () => {
        const result = runtime.ensureDefinedAsync('hello', 1, 1, mockContext, mockErrorContext);

        expect(result).to.equal('hello');
        expect(typeof result.then).to.equal('undefined');
      });

      it('should return rejected Promise for poison synchronously', async () => {
        const poison = createPoison(new Error('Test'));
        const result = runtime.ensureDefinedAsync(poison, 1, 1, mockContext, mockErrorContext);

        expect(typeof result.then).to.equal('function');

        try {
          await result;
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.equal('Test');
        }
      });

      it('should throw for null values', () => {
        try {
          runtime.ensureDefinedAsync(null, 1, 1, mockContext, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('null or undefined');
        }
      });

      it('should throw for undefined values', () => {
        try {
          runtime.ensureDefinedAsync(undefined, 1, 1, mockContext, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('null or undefined');
        }
      });

      it('should handle poison in promise', async () => {
        const poison = createPoison(new Error('Async'));
        const promise = Promise.resolve(poison);

        try {
          await runtime.ensureDefinedAsync(promise, 1, 1, mockContext, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.equal('Async');
        }
      });

      it('should collect errors from array', async () => {
        const poison1 = createPoison(new Error('E1'));
        const poison2 = createPoison(new Error('E2'));

        const arr = [poison1, poison2];

        try {
          await runtime.ensureDefinedAsync(arr, 1, 1, mockContext, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(2);
          expect(thrown.errors[0].message).to.equal('E1');
          expect(thrown.errors[1].message).to.equal('E2');
        }
      });

      it('should append validation function to valid array', async () => {
        const arr = ['valid'];
        const result = await runtime.ensureDefinedAsync(arr, 1, 1, mockContext, mockErrorContext);

        expect(Array.isArray(result)).to.be(true);
        expect(result.length).to.equal(2);
        expect(result[0]).to.equal('valid');
        expect(typeof result[1]).to.equal('function');
      });

      it('should handle promise that resolves to null', async () => {
        const promise = Promise.resolve(null);

        try {
          await runtime.ensureDefinedAsync(promise, 1, 1, mockContext, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('null or undefined');
        }
      });

      it('should handle promise that resolves to valid value', async () => {
        const promise = Promise.resolve('valid');
        const result = await runtime.ensureDefinedAsync(promise, 1, 1, mockContext, mockErrorContext);

        expect(result).to.equal('valid');
      });

      it('should handle promise that rejects', async () => {
        const promise = Promise.reject(new Error('Promise rejection'));

        try {
          await runtime.ensureDefinedAsync(promise, 1, 1, mockContext, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.contain('Promise rejection');
        }
      });
    });

    describe('Sync-First Pattern Performance', () => {
      it('should not allocate Promise for literal in suppressValueAsync', () => {
        const results = [];
        for (let i = 0; i < 100; i++) {
          results.push(runtime.suppressValueAsync('test', false, mockErrorContext));
        }

        // All should be strings, not Promises
        results.forEach(r => {
          expect(typeof r).to.equal('string');
        });
      });

      it('should not allocate Promise for literal in ensureDefinedAsync', () => {
        const results = [];
        for (let i = 0; i < 100; i++) {
          results.push(runtime.ensureDefinedAsync('test', 1, 1, null, mockErrorContext));
        }

        results.forEach(r => {
          expect(typeof r).to.equal('string');
        });
      });

      it('should return rejected Promise for poison without async overhead', () => {
        const poison = createPoison(new Error('Test'));
        const result = runtime.suppressValueAsync(poison, false, mockErrorContext);

        // Should be a Promise (specifically a rejected one)
        expect(result && typeof result.then === 'function').to.be(true);

        return result.catch(err => {
          expect(isPoisonError(err)).to.be(true);
        });
      });
    });

    describe('Error Collection Determinism', () => {
      it('should collect all errors from multiple sources', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const err3 = new Error('Error 3');

        const poison1 = createPoison(err1);
        const poison2 = createPoison(err2);
        const poison3 = createPoison(err3);

        const arr = [poison1, 'valid', poison2, poison3];

        try {
          await runtime.suppressValueAsync(arr, false, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(3);
          // Should collect all errors deterministically
          expect(thrown.errors[0]).to.equal(err1);
          expect(thrown.errors[1]).to.equal(err2);
          expect(thrown.errors[2]).to.equal(err3);
        }
      });

      it('should collect errors from mixed promise and poison sources', async () => {
        const err1 = new Error('Poison error');
        const err2 = new Error('Promise rejection');
        const err3 = new Error('Another poison');

        const poison1 = createPoison(err1);
        const poison2 = createPoison(err3);
        const rejectingPromise = Promise.reject(err2);

        const arr = [poison1, rejectingPromise, 'valid', poison2];

        try {
          await runtime.suppressValueAsync(arr, false, mockErrorContext);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(3);
          expect(thrown.errors[0]).to.equal(err1);
          expect(thrown.errors[1]).to.equal(err2);
          expect(thrown.errors[2]).to.equal(err3);
        }
      });
    });

    describe('Integration with Existing Poison Infrastructure', () => {
      it('should work with collectErrors function', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison1 = createPoison(err1);
        const poison2 = createPoison(err2);

        const errors = await collectErrors([poison1, 'valid', poison2]);

        expect(errors).to.have.length(2);
        expect(errors[0]).to.equal(err1);
        expect(errors[1]).to.equal(err2);
      });

      it('should preserve error stack traces', () => {
        const originalError = new Error('Original error');
        originalError.stack = 'Error: Original error\n    at test (test.js:1:1)';

        const poison = createPoison(originalError);
        const result = runtime.callWrapAsync(poison, 'test', { env: { globals: {} }, ctx: {} }, [], mockErrorContext);

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0]).to.equal(originalError);
        expect(result.errors[0].stack).to.equal(originalError.stack);
      });

      it('should handle nested poison values correctly', () => {
        const innerError = new Error('Inner error');
        const innerPoison = createPoison(innerError);

        const mockContext = {
          env: { globals: {} },
          ctx: {}
        };

        const result = runtime.callWrapAsync(
          (x) => x * 2,
          'double',
          mockContext,
          [innerPoison],
          mockErrorContext
        );

        expect(isPoison(result)).to.be(true);
        // The errors are flattened by flatMap
        expect(result.errors[0]).to.equal(innerError);
      });
    });
  });

})();
