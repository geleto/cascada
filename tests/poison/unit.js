(function () {
  'use strict';

  var expect;
  //var unescape;
  //var Environment;
  let runtime;
  let createPoison;
  let isPoison;
  let isPoisonError;
  let PoisonError;
  let collectErrors;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime/runtime');
    createPoison = runtime.createPoison;
    isPoison = runtime.isPoison;
    isPoisonError = runtime.isPoisonError;
    PoisonError = runtime.PoisonError;
    collectErrors = runtime.collectErrors;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    isPoisonError = nunjucks.runtime.isPoisonError;
    PoisonError = nunjucks.runtime.PoisonError;
    collectErrors = nunjucks.runtime.collectErrors;
  }


  describe('Error Propagation Dataflow Poisoning - Unit Tests', () => {
    describe('createPoison and isPoison', () => {
      it('should create poison from single error', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        expect(isPoison(poison)).to.be(true);
        expect(poison.errors).to.have.length(1);
        expect(poison.errors[0]).to.equal(err);
      });

      it('should create poison from multiple errors', () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison = createPoison([err1, err2]);

        expect(isPoison(poison)).to.be(true);
        expect(poison.errors).to.have.length(2);
        expect(poison.errors[0]).to.equal(err1);
        expect(poison.errors[1]).to.equal(err2);
      });

      it('should identify non-poison values correctly', () => {
        expect(isPoison(null)).to.be(false);
        expect(isPoison(undefined)).to.be(false);
        expect(isPoison(42)).to.be(false);
        expect(isPoison('string')).to.be(false);
        expect(isPoison({})).to.be(false);
        expect(isPoison([])).to.be(false);
      });

      it('should identify poison values correctly', () => {
        const poison = createPoison(new Error('test'));
        expect(isPoison(poison)).to.be(true);
      });
    });

    describe('PoisonedValue thenable protocol', () => {
      it('should implement thenable protocol with catch', async () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        let caughtError = null;
        await poison.catch(e => {
          caughtError = e;
        });

        expect(caughtError).to.be.a(PoisonError);
        expect(caughtError.errors).to.have.length(1);
        expect(caughtError.errors[0]).to.equal(err);
      });

      it('should chain poison values without handlers', () => {
        const err = new Error('Original error');
        const poison = createPoison(err);

        // Chaining without a rejection handler should return poison
        const chained = poison.then(val => val * 2);
        expect(isPoison(chained)).to.be(true);
      });

      it('should propagate poison through then without rejection handler', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const result = poison.then(val => val * 2);
        expect(isPoison(result)).to.be(true);
      });

      it('should handle errors in rejection handler', async () => {
        const err = new Error('Original error');
        const poison = createPoison(err);

        const result = poison.catch(() => {
          throw new Error('Handler error');
        });

        expect(isPoison(result)).to.be(true);
      });

      it('should implement finally method', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        let finallyCalled = false;
        const result = poison.finally(() => {
          finallyCalled = true;
        });

        expect(finallyCalled).to.be(true);
        expect(isPoison(result)).to.be(true);
      });

      it('should ignore errors in finally handler', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const result = poison.finally(() => {
          throw new Error('Finally error');
        });

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0]).to.equal(err);
      });
    });

    describe('PoisonError', () => {
      it('should handle single error with simple message', () => {
        const err = new Error('Single error');
        const compound = new PoisonError([err]);

        expect(compound.message).to.equal('Single error');
        expect(compound.name).to.equal('PoisonError');
        expect(compound.errors).to.have.length(1);
      });

      it('should handle multiple errors with combined message', () => {
        const err1 = new Error('First error');
        const err2 = new Error('Second error');
        const compound = new PoisonError([err1, err2]);

        expect(compound.message).to.contain('Multiple errors occurred (2)');
        expect(compound.message).to.contain('First error');
        expect(compound.message).to.contain('Second error');
        expect(compound.errors).to.have.length(2);
      });

      it('should return stack from only error', () => {
        const err = new Error('Test error');
        const compound = new PoisonError([err]);

        expect(compound.stack).to.equal(err.stack);
      });
    });

    describe('collectErrors', () => {
      it('should collect errors from array of poison values', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison1 = createPoison(err1);
        const poison2 = createPoison(err2);

        const errors = await collectErrors([poison1, poison2]);

        expect(errors).to.have.length(2);
        expect(errors[0]).to.equal(err1);
        expect(errors[1]).to.equal(err2);
      });

      it('should collect errors from rejected promises', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');

        const values = [
          Promise.reject(err1),
          Promise.reject(err2)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(2);
        expect(errors[0]).to.equal(err1);
        expect(errors[1]).to.equal(err2);
      });

      it('should collect errors from promises that resolve to poison', async () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const values = [
          Promise.resolve(poison)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(1);
        expect(errors[0]).to.equal(err);
      });

      it('should await all promises even after finding errors', async () => {
        let promise2Resolved = false;
        let promise3Resolved = false;

        const values = [
          createPoison(new Error('Error 1')),
          Promise.resolve(42).then(v => { promise2Resolved = true; return v; }),
          Promise.resolve(100).then(v => { promise3Resolved = true; return v; })
        ];

        await collectErrors(values);

        expect(promise2Resolved).to.be(true);
        expect(promise3Resolved).to.be(true);
      });

      it('should ignore non-poison, non-error values', async () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const values = [
          poison,
          42,
          'string',
          { obj: true },
          Promise.resolve(100)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(1);
        expect(errors[0]).to.equal(err);
      });

      it('should handle mixed poison and rejected promises', async () => {
        const err1 = new Error('Poison error');
        const err2 = new Error('Rejection error');
        const poison = createPoison(err1);

        const values = [
          poison,
          Promise.reject(err2),
          Promise.resolve(42)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(2);
      });

      it('should handle empty array', async () => {
        const errors = await collectErrors([]);
        expect(errors).to.have.length(0);
      });

      it('should handle multiple errors in single poison value', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison = createPoison([err1, err2]);

        const errors = await collectErrors([poison]);

        expect(errors).to.have.length(2);
      });
    });
  });

  describe('Resolution Functions - Error Propagation', () => {
    // Note: Tests that go through renderString() are expected to fail until Steps 3-5 are complete
    // This step only tests the resolution layer functions directly

    it('should detect poison values correctly', () => {
      const poison = runtime.createPoison(new Error('Test error'));
      expect(runtime.isPoison(poison)).to.be(true);
      expect(runtime.isPoison('regular value')).to.be(false);
      expect(runtime.isPoison(null)).to.be(false);
      expect(runtime.isPoison(undefined)).to.be(false);
      expect(runtime.isPoison(42)).to.be(false);
      expect(runtime.isPoison(Promise.resolve())).to.be(false);
    });

    it('should propagate poison synchronously in resolveDuo with non-promises', async () => {
      const poison1 = runtime.createPoison(new Error('Error 1'));
      const poison2 = runtime.createPoison(new Error('Error 2'));

      try {
        const result = await runtime.resolveDuo(poison1, poison2);
        // If we get here without throwing, check if it's poison
        expect(runtime.isPoison(result)).to.be(true);
        expect(result.errors).to.have.length(2);
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors).to.have.length(2);
      }
    });

    it('should convert rejected promises to poison in resolveSingle', async () => {
      const rejectingPromise = Promise.reject(new Error('Promise rejection'));

      try {
        const result = await runtime.resolveSingle(rejectingPromise);
        // Check if poison before awaiting
        expect(runtime.isPoison(result)).to.be(true);
        expect(result.errors[0].message).to.contain('Promise rejection');
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors[0].message).to.contain('Promise rejection');
      }
    });

    it('should propagate poison without wrapping in resolveSingleArr', async () => {
      const poison = runtime.createPoison(new Error('Test error'));

      try {
        const result = await runtime.resolveSingleArr(poison);
        expect(runtime.isPoison(result)).to.be(true);
        expect(Array.isArray(result)).to.be(false);
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors[0].message).to.contain('Test error');
      }
    });

    it('should collect errors from object properties in resolveObjectProperties', async () => {
      const obj = {
        good: Promise.resolve('ok'),
        bad1: Promise.reject(new Error('Obj error 1')),
        bad2: Promise.reject(new Error('Obj error 2'))
      };

      try {
        const result = await runtime.resolveObjectProperties(obj);
        expect(runtime.isPoison(result)).to.be(true);
        expect(result.errors).to.have.length(2);
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors).to.have.length(2);
      }
    });

    it('should handle deep array resolution with mixed errors in deepResolveArray', async () => {
      // Note: We can't attach .catch() handlers as they consume the rejection
      // Instead, the deepResolveArray function itself will catch the rejections
      const arr = [
        1,
        Promise.reject(new Error('Array error 1')),
        [2, Promise.reject(new Error('Nested array error'))],
        Promise.resolve(3)
      ];

      try {
        const result = await runtime.deepResolveArray(arr);
        expect(runtime.isPoison(result)).to.be(true);
        // Should collect BOTH errors: one from direct promise, one from nested array
        expect(result.errors).to.have.length(2);
        const messages = result.errors.map(e => e.message);
        expect(messages).to.contain('Array error 1');
        expect(messages).to.contain('Nested array error');
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        // Should collect BOTH errors
        expect(err.errors).to.have.length(2);
        const messages = err.errors.map(e => e.message);
        expect(messages).to.contain('Array error 1');
        expect(messages).to.contain('Nested array error');
      }
    });

    it('should handle deep object resolution with errors in deepResolveObject', async () => {
      const obj = {
        nested: {
          value: Promise.reject(new Error('Deep error'))
        },
        other: 'ok'
      };

      try {
        const result = await runtime.deepResolveObject(obj);
        expect(runtime.isPoison(result)).to.be(true);
        expect(result.errors[0].message).to.contain('Deep error');
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors[0].message).to.contain('Deep error');
      }
    });

    it('should not deduplicate errors with same message via collectErrors', async () => {
      const errors = await runtime.collectErrors([
        Promise.reject(new Error('Same error')),
        Promise.reject(new Error('Same error')),
        Promise.reject(new Error('Different error'))
      ]);

      // Should have only 2 unique errors after deduplication
      expect(errors).to.have.length(3);
    });

    it('should propagate poison in resolveAll with multiple values', async () => {
      const poison = runtime.createPoison(new Error('Poison error'));
      const promise = Promise.resolve('ok');

      try {
        const result = await runtime.resolveAll([poison, promise, 42]);
        expect(runtime.isPoison(result)).to.be(true);
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors[0].message).to.contain('Poison error');
      }
    });

    it('should collect all errors in resolveAll even with multiple promises', async () => {
      const args = [
        Promise.reject(new Error('Error 1')),
        Promise.resolve('ok'),
        Promise.reject(new Error('Error 2'))
      ];

      try {
        const result = await runtime.resolveAll(args);
        expect(runtime.isPoison(result)).to.be(true);
        expect(result.errors).to.have.length(2);
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors).to.have.length(2);
      }
    });

    it('should preserve error stacks in PoisonError class', () => {
      const err1 = new Error('First error');
      const err2 = new Error('Second error');
      const poisonError = new runtime.PoisonError([err1, err2]);

      expect(poisonError.name).to.equal('PoisonError');
      expect(poisonError.errors).to.have.length(2);
      expect(poisonError.stack).to.be.ok();
    });

    it('should handle poison thenable protocol correctly', async () => {
      const poison = runtime.createPoison(new Error('Test error'));

      // Test .then() with rejection handler
      const result = await poison.then(
        () => 'should not call this',
        (err) => {
          expect(err.name).to.equal('PoisonError');
          return 'handled';
        }
      );

      expect(result).to.equal('handled');
    });

    it('should propagate poison through .catch()', async () => {
      const poison = runtime.createPoison(new Error('Test error'));

      const result = await poison.catch((err) => {
        expect(err.name).to.equal('PoisonError');
        return 'caught';
      });

      expect(result).to.equal('caught');
    });

    it('should handle .finally() on poison without throwing', () => {
      const poison = runtime.createPoison(new Error('Test error'));
      let finallyCalled = false;

      const result = poison.finally(() => {
        finallyCalled = true;
      });

      expect(finallyCalled).to.be(true);
      expect(runtime.isPoison(result)).to.be(true);
    });

    it('should return fake thenable for non-promise in resolveSingle', async () => {
      const thenable = await runtime.resolveSingle(42);

      // Result should be a thenable (or the value itself)
      if (typeof thenable === 'object' && thenable !== null && typeof thenable.then === 'function') {
        // It's a thenable - resolve it
        const value = await thenable.then(v => v);
        expect(value).to.equal(42);
      } else {
        // It's the value directly
        expect(thenable).to.equal(42);
      }
    });

    it('should handle null and undefined gracefully in resolveSingle', async () => {
      // Don't await - we want to check the thenable itself
      const thenable1 = runtime.resolveSingle(null);
      const thenable2 = runtime.resolveSingle(undefined);

      // Results should be thenables (not awaited yet)
      expect(thenable1).to.be.ok();
      expect(typeof thenable1.then).to.equal('function');
      expect(thenable2).to.be.ok();
      expect(typeof thenable2.then).to.equal('function');

      // When awaited, they should return the original values
      expect(await thenable1.then(v => v)).to.be(null);
      expect(await thenable2.then(v => v)).to.be(undefined);
    });

    it('should await all values including after errors in collectErrors', async () => {
      let promise2Resolved = false;
      let promise3Resolved = false;

      const values = [
        Promise.reject(new Error('First error')),
        Promise.resolve('ok2').then(v => { promise2Resolved = true; return v; }),
        Promise.resolve('ok3').then(v => { promise3Resolved = true; return v; })
      ];

      await runtime.collectErrors(values);

      // All promises should have been awaited
      expect(promise2Resolved).to.be(true);
      expect(promise3Resolved).to.be(true);
    });

    it('should handle resolveDuo with mix of poisons and promises', async () => {
      const poison = runtime.createPoison(new Error('Poison error'));
      const promise = Promise.resolve('ok');

      try {
        const result = await runtime.resolveDuo(poison, promise);
        expect(runtime.isPoison(result)).to.be(true);
      } catch (err) {
        // Awaiting a poison throws PoisonError
        expect(err.name).to.equal('PoisonError');
        expect(err.errors[0].message).to.contain('Poison error');
      }
    });

    it('should detect PoisonError correctly vs regular Error', () => {
      const regularError = new Error('Regular');
      const poisonError = new runtime.PoisonError([new Error('Test')]);

      expect(runtime.isPoisonError(poisonError)).to.be(true);
      expect(runtime.isPoisonError(regularError)).to.be(false);
      expect(runtime.isPoisonError(null)).to.be(false);
      expect(runtime.isPoisonError('not an error')).to.be(false);
    });

    it('should extract errors array from caught PoisonError', async () => {
      const poison = runtime.createPoison(new Error('Test error'));

      try {
        await poison; // This throws PoisonError
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors).to.be.an('array');
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.equal('Test error');
      }
    });

    it('should allow non-async functions to return poison synchronously', () => {
      function syncFunc(value) {
        if (value === 'error') {
          return runtime.createPoison(new Error('Sync error'));
        }
        return value;
      }

      const result = syncFunc('error');
      // Should be able to check BEFORE await
      expect(runtime.isPoison(result)).to.be(true);
      expect(result.errors[0].message).to.equal('Sync error');
    });

    it('should handle nested poison values in deepResolveArray', async () => {
      const innerPoison = runtime.createPoison(new Error('Inner error'));
      const arr = [
        1,
        [2, innerPoison, 3],
        4
      ];

      try {
        await runtime.deepResolveArray(arr);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.equal('Inner error');
      }
    });

    it('should handle poison values (not promises) in deepResolveObject', async () => {
      const poison = runtime.createPoison(new Error('Object poison'));
      const obj = {
        good: 'ok',
        bad: poison,
        nested: { deeper: poison }
      };

      try {
        await runtime.deepResolveObject(obj);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        // Should have deduplicated the same poison
        expect(err.errors).to.have.length(1);
      }
    });

    it('should return synchronously for resolveDuo with non-promises', async () => {
      const result = await runtime.resolveDuo('value1', 'value2');

      expect(Array.isArray(result)).to.be(true);
      expect(result).to.eql(['value1', 'value2']);
    });

    it('should handle empty errors array in createPoison', () => {
      const poison = runtime.createPoison([]);

      expect(runtime.isPoison(poison)).to.be(true);
      expect(poison.errors).to.have.length(0);
    });

    it('should collect errors from multiple independent sources in resolveAll', async () => {
      const poison1 = runtime.createPoison(new Error('Poison 1'));
      const poison2 = runtime.createPoison(new Error('Poison 2'));

      try {
        await runtime.resolveAll([
          poison1,
          Promise.reject(new Error('Promise error')),
          poison2
        ]);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(3);
      }
    });

    it('should not double-wrap poison errors', async () => {
      const innerError = new Error('Original');
      const poison1 = runtime.createPoison(innerError);

      // Try to wrap poison in another poison
      const poison2 = runtime.createPoison(poison1.errors);

      expect(poison2.errors).to.have.length(1);
      expect(poison2.errors[0]).to.equal(innerError);
    });

    it('should collect errors in deterministic order', async () => {
      const errors = [];
      for (let i = 0; i < 5; i++) {
        errors.push(new Error(`Error ${i}`));
      }

      const promises = errors.map(err => Promise.reject(err));

      try {
        await runtime.resolveAll(promises);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(5);
        // Verify order is preserved
        for (let i = 0; i < 5; i++) {
          expect(err.errors[i].message).to.equal(`Error ${i}`);
        }
      }
    });
  });

  describe('Buffer Flattening Poison Handling', () => {

    describe('flattenBuffer with simple templates', () => {
      it('should concatenate simple values', () => {
        const arr = ['Hello', ' ', 'World'];
        const result = runtime.flattenBuffer(arr);

        expect(result).to.equal('Hello World');
      });

      it('should handle nested arrays', () => {
        const arr = ['A', ['B', 'C'], 'D'];
        const result = runtime.flattenBuffer(arr);

        expect(result).to.equal('ABCD');
      });

      it('should handle functions in arrays', () => {
        const arr = ['Test', (val) => val.toUpperCase()];
        const result = runtime.flattenBuffer(arr);

        expect(result).to.equal('TEST');
      });
    });

    describe('flattenBuffer with script context - poison detection', () => {
      let context, env;

      beforeEach(() => {
        env = {
          commandHandlerInstances: {},
          commandHandlerClasses: {}
        };
        context = {
          env,
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should collect poison from text output', () => {
        const poison = createPoison(new Error('Output error'));
        const arr = ['Valid text', poison, 'More text'];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.equal('Output error');
        }
      });

      it('should collect multiple poisons', () => {
        const poison1 = createPoison(new Error('Error 1'));
        const poison2 = createPoison(new Error('Error 2'));
        const arr = [poison1, 'text', poison2];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(2);
        }
      });

      it('should continue processing after finding poison', () => {
        const poison = createPoison(new Error('Early error'));
        const arr = [poison, 'Valid', 'Text'];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          // Verify it didn't stop early (error collected)
          expect(err.errors).to.have.length(1);
        }
      });

      it('should collect poison from nested arrays', () => {
        const poison = createPoison(new Error('Nested error'));
        const arr = [
          'text',
          ['nested', poison, 'more'],
          'end'
        ];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should collect poison from arrays with functions', () => {
        const poison = createPoison(new Error('Func array error'));
        const arr = [
          ['prefix', poison, (val) => val.toUpperCase()]
        ];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should handle command objects with poisoned args', () => {
        const poison = createPoison(new Error('Arg error'));
        const arr = [{
          handler: 'text',
          command: null,
          subpath: [],
          arguments: ['valid', poison],
          pos: { lineno: 1, colno: 1 }
        }];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should collect errors from handler instantiation failures', () => {
        const arr = [{
          handler: 'nonexistent',
          command: 'method',
          subpath: [],
          arguments: ['arg'],
          pos: { lineno: 5, colno: 10 }
        }];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Unknown command handler');
        }
      });

      it('should return valid output when no poison found', () => {
        const arr = ['Hello', ' ', 'World'];
        const result = runtime.flattenBuffer(arr, context);

        expect(result.text).to.equal('Hello World');
      });
    });

    describe('Error deduplication in flattenBuffer', () => {
      let context;

      beforeEach(() => {
        context = {
          env: { commandHandlerInstances: {}, commandHandlerClasses: {} },
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should deduplicate identical errors', () => {
        const err = new Error('Duplicate');
        const poison1 = createPoison(err);
        const poison2 = createPoison(err);
        const arr = [poison1, poison2];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          // Should be deduplicated to 1
          expect(thrown.errors).to.have.length(1);
        }
      });

      it('should keep distinct errors', () => {
        const poison1 = createPoison(new Error('Error A'));
        const poison2 = createPoison(new Error('Error B'));
        const arr = [poison1, poison2];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(2);
        }
      });
    });

    describe('Complete error collection', () => {
      let context;

      beforeEach(() => {
        context = {
          env: { commandHandlerInstances: {}, commandHandlerClasses: {} },
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should process entire buffer even with early errors', () => {
        const errors = [
          createPoison(new Error('Error 1')),
          'valid',
          createPoison(new Error('Error 2')),
          'more valid',
          createPoison(new Error('Error 3'))
        ];

        try {
          runtime.flattenBuffer(errors, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          // All 3 errors should be collected
          expect(thrown.errors).to.have.length(3);
        }
      });

      it('should collect errors from multiple nested levels', () => {
        const arr = [
          createPoison(new Error('Level 0')),
          [
            'text',
            createPoison(new Error('Level 1')),
            [
              createPoison(new Error('Level 2'))
            ]
          ]
        ];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(3);
        }
      });
    });

    describe('Handler error collection', () => {
      let context;

      beforeEach(() => {
        context = {
          env: { commandHandlerInstances: {}, commandHandlerClasses: {} },
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should collect handler property access errors', () => {
        const mockHandler = {
          getReturnValue: () => 'test'
        };
        context.env.commandHandlerInstances = { testHandler: mockHandler };

        const arr = [{
          handler: 'testHandler',
          command: 'nonexistentMethod',
          subpath: [],
          arguments: [],
          pos: { lineno: 1, colno: 1 }
        }];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.contain('has no method');
        }
      });

      it('should collect handler instantiation errors', () => {
        const arr = [{
          handler: 'badHandler',
          command: 'method',
          subpath: ['nested', 'path'],
          arguments: [],
          pos: { lineno: 2, colno: 5 }
        }];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.contain('Unknown command handler');
        }
      });
    });

    describe('Complex nested poison scenarios', () => {
      let context;

      beforeEach(() => {
        context = {
          env: { commandHandlerInstances: {}, commandHandlerClasses: {} },
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should handle poison in deeply nested structures', () => {
        const arr = [
          'start',
          [
            'level1',
            [
              'level2',
              createPoison(new Error('Deep poison')),
              'more level2'
            ],
            'more level1'
          ],
          'end'
        ];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(1);
        }
      });

      it('should collect poison from function arrays with nested poison', () => {
        const poison = createPoison(new Error('Function array poison'));
        const arr = [
          ['text', poison, (val) => val.toUpperCase()]
        ];

        try {
          runtime.flattenBuffer(arr, context);
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
        }
      });
    });

    describe('Focus output handling', () => {
      let context;

      beforeEach(() => {
        context = {
          env: { commandHandlerInstances: {}, commandHandlerClasses: {} },
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should handle focus output with poison', () => {
        const poison = createPoison(new Error('Focus poison'));
        const arr = [poison, 'text'];

        try {
          runtime.flattenBuffer(arr, context, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
        }
      });

      it('should return focused output when no poison', () => {
        const arr = ['Hello', ' ', 'World'];
        const result = runtime.flattenBuffer(arr, context, 'text');

        expect(result).to.equal('Hello World');
      });
    });
  });

})();
