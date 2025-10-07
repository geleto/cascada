(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let isPoison;
  let isPoisonError;
  let AsyncFrame;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime');
    createPoison = runtime.createPoison;
    isPoisonError = runtime.isPoisonError;
    isPoison = runtime.isPoison;
    AsyncFrame = runtime.AsyncFrame;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    isPoisonError = nunjucks.runtime.isPoisonError;
    AsyncFrame = nunjucks.runtime.AsyncFrame;
  }
  describe('Iterator Functions Poison Handling', () => {

    describe('iterate - poisoned iterable', () => {
      it('should poison branch writes when array is poisoned', async () => {
        const frame = new AsyncFrame();
        frame.set('sum', 0, true);

        const poison = createPoison(new Error('Array poisoned'));

        const loopBody = (item, i) => {
          frame.set('sum', frame.lookup('sum') + item, true);
        };

        const didIterate = await runtime.iterate(
          poison,
          loopBody,
          null,
          frame,
          { sum: 3 }, // Would write 3 times if not poisoned
          ['item'],
          false,
          false,
          { lineno: 1, colno: 1, path: '/test.html' }
        );

        expect(didIterate).to.be.false;
        expect(isPoison(frame.lookup('sum'))).to.be.true;
      });

      it('should execute else branch when iterable is poisoned', async () => {
        let elseCalled = false;
        const poison = createPoison(new Error('No data'));

        const loopBody = () => { };
        const loopElse = async () => {
          elseCalled = true;
        };

        await runtime.iterate(
          poison,
          loopBody,
          loopElse,
          null,
          null,
          ['item'],
          false,
          false,
          { lineno: 1, colno: 1 }
        );

        expect(elseCalled).to.be.true;
      });

      it('should handle normal iteration when array is valid', async () => {
        const frame = new AsyncFrame();
        frame.set('count', 0, true);

        const arr = [1, 2, 3];

        const loopBody = () => {
          const current = frame.lookup('count');
          frame.set('count', current + 1, true);
        };

        await runtime.iterate(
          arr,
          loopBody,
          null,
          frame,
          { count: 3 },
          ['item'],
          true, // sequential
          false,
          { lineno: 1, colno: 1 }
        );

        expect(frame.lookup('count')).to.equal(3);
      });

      it('should handle object iteration when object is poisoned', async () => {
        const frame = new AsyncFrame();
        frame.set('keys', [], true);

        const poison = createPoison(new Error('Object poisoned'));

        const loopBody = (key, value) => {
          const current = frame.lookup('keys');
          frame.set('keys', [...current, key], true);
        };

        const didIterate = await runtime.iterate(
          poison,
          loopBody,
          null,
          frame,
          { keys: 2 }, // Would write 2 times if not poisoned
          ['key', 'value'],
          false,
          false,
          { lineno: 1, colno: 1 }
        );

        expect(didIterate).to.be.false;
        expect(isPoison(frame.lookup('keys'))).to.be.true;
      });
    });

    describe('iterateAsyncSequential - error collection', () => {
      it('should collect all errors from poisoned values', async () => {
        async function* generator() {
          yield createPoison(new Error('Error 1'));
          yield 'valid';
          yield createPoison(new Error('Error 2'));
        }

        const loopBody = (value) => { };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors).to.have.length(2);
          expect(err.errors[0].message).to.equal('Error 1');
          expect(err.errors[1].message).to.equal('Error 2');
        }
      });

      it('should collect errors from loop body execution', async () => {
        async function* generator() {
          yield 1;
          yield 2;
          yield 3;
        }

        let iteration = 0;
        const loopBody = (value) => {
          iteration++;
          if (iteration === 2) {
            throw new Error('Body failed at iteration 2');
          }
        };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors[0].message).to.equal('Body failed at iteration 2');
        }
      });

      it('should continue iteration after finding error', async () => {
        let iterationCount = 0;

        async function* generator() {
          yield 1;
          yield createPoison(new Error('Middle error'));
          yield 3;
        }

        const loopBody = (value) => {
          iterationCount++;
        };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          // Should have processed all 3 items
          expect(iterationCount).to.equal(2); // Poison skipped body execution
          expect(isPoisonError(err)).to.be.true;
        }
      });

      it('should handle mixed poison and promise rejections', async () => {
        async function* generator() {
          yield createPoison(new Error('Poison error'));
          yield 'valid';
          yield Promise.reject(new Error('Promise error'));
        }

        const loopBody = async (value) => {
          if (typeof value === 'string') return;
          await value; // This will throw for rejected promise
        };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          // Should have both errors
          expect(err.errors.length).to.be.at.least(1);
        }
      });

      it('should handle loop body returning poison', async () => {
        async function* generator() {
          yield 1;
          yield 2;
        }

        const loopBody = (value) => {
          if (value === 2) {
            return createPoison(new Error('Body returned poison'));
          }
          return value;
        };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors[0].message).to.equal('Body returned poison');
        }
      });

      it('should handle destructuring with poisoned values', async () => {
        async function* generator() {
          yield [1, 2];
          yield createPoison(new Error('Array poisoned'));
          yield [3, 4];
        }

        const loopBody = (a, b) => {
          return a + b;
        };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['a', 'b'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors[0].message).to.equal('Array poisoned');
        }
      });
    });

    describe('iterateAsyncParallel - error collection', () => {
      it('should collect all errors from poisoned values', async () => {
        async function* generator() {
          yield createPoison(new Error('Error 1'));
          yield 'valid';
          yield createPoison(new Error('Error 2'));
        }

        const loopBody = (value) => { };

        try {
          await runtime.iterateAsyncParallel(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('Error 1');
        }
      });

      it('should collect errors from parallel body execution', async () => {
        async function* generator() {
          yield 1;
          yield 2;
          yield 3;
        }

        const loopBody = async (value, i) => {
          if (i === 1) {
            throw new Error('Failed at index 1');
          }
        };

        try {
          await runtime.iterateAsyncParallel(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('Failed at index 1');
        }
      });

      it('should process all iterations even after error', async () => {
        const processed = [];

        async function* generator() {
          yield 1;
          yield createPoison(new Error('Middle error'));
          yield 3;
        }

        const loopBody = (value) => {
          if (!isPoison(value)) {
            processed.push(value);
          }
        };

        try {
          await runtime.iterateAsyncParallel(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          // Should have processed valid values
          expect(processed).to.contain(1);
          expect(processed).to.contain(3);
          expect(isPoisonError(err) || err.message.includes('Middle error')).to.be.true;
        }
      });

      it('should handle multiple parallel errors', async () => {
        async function* generator() {
          yield 1;
          yield 2;
          yield 3;
          yield 4;
        }

        const loopBody = async (value, i) => {
          if (i === 1 || i === 3) {
            throw new Error(`Failed at index ${i}`);
          }
        };

        try {
          await runtime.iterateAsyncParallel(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          // Should have collected multiple errors
          expect(err.message).to.match(/Failed at index (1|3)/);
        }
      });

      it('should handle mixed poison and async errors', async () => {
        async function* generator() {
          yield createPoison(new Error('Poison error'));
          yield 2;
          yield 3;
        }

        const loopBody = async (value, i) => {
          if (i === 2) {
            throw new Error('Async error');
          }
        };

        try {
          await runtime.iterateAsyncParallel(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.match(/(Poison error|Async error)/);
        }
      });
    });

    describe('Deterministic error collection', () => {
      it('should collect same errors regardless of timing', async () => {
        // Run the same scenario multiple times
        const runs = [];

        for (let run = 0; run < 3; run++) {
          async function* generator() {
            yield createPoison(new Error('Error A'));
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            yield createPoison(new Error('Error B'));
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            yield createPoison(new Error('Error C'));
          }

          try {
            await runtime.iterateAsyncSequential(
              generator(),
              () => { },
              ['item'],
              { lineno: 1, colno: 1 }
            );
          } catch (err) {
            runs.push(err.errors.map(e => e.message).sort());
          }
        }

        // All runs should have same errors
        expect(runs[0]).to.deep.equal(runs[1]);
        expect(runs[1]).to.deep.equal(runs[2]);
      });

      it('should handle empty async iterator', async () => {
        async function* emptyGenerator() {
          // Empty generator
        }

        const loopBody = () => { };
        const didIterate = await runtime.iterateAsyncSequential(
          emptyGenerator(),
          loopBody,
          ['item'],
          { lineno: 1, colno: 1 }
        );

        expect(didIterate).to.be.false;
      });

      it('should handle single poisoned value', async () => {
        async function* singleGenerator() {
          yield createPoison(new Error('Single error'));
        }

        const loopBody = () => { };

        try {
          await runtime.iterateAsyncSequential(
            singleGenerator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors).to.have.length(1);
          expect(err.errors[0].message).to.equal('Single error');
        }
      });

      it('should handle all values being poisoned', async () => {
        async function* allPoisonGenerator() {
          yield createPoison(new Error('Error 1'));
          yield createPoison(new Error('Error 2'));
          yield createPoison(new Error('Error 3'));
        }

        const loopBody = () => { };

        try {
          await runtime.iterateAsyncSequential(
            allPoisonGenerator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors).to.have.length(3);
          expect(err.errors.map(e => e.message)).to.include.members(['Error 1', 'Error 2', 'Error 3']);
        }
      });
    });

    describe('Error deduplication', () => {
      it('should deduplicate identical errors', async () => {
        const sameError = new Error('Same error');

        async function* generator() {
          yield createPoison(sameError);
          yield createPoison(sameError);
          yield createPoison(sameError);
        }

        const loopBody = () => { };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors).to.have.length(1);
          expect(err.errors[0].message).to.equal('Same error');
        }
      });

      it('should preserve different errors', async () => {
        async function* generator() {
          yield createPoison(new Error('Error A'));
          yield createPoison(new Error('Error B'));
          yield createPoison(new Error('Error C'));
        }

        const loopBody = () => { };

        try {
          await runtime.iterateAsyncSequential(
            generator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be.true;
          expect(err.errors).to.have.length(3);
        }
      });
    });

    describe('Edge cases', () => {
      it('should handle null/undefined iterable', async () => {
        const loopBody = () => { };
        const loopElse = async () => { };

        // Test null
        const didIterateNull = await runtime.iterate(
          null,
          loopBody,
          loopElse,
          null,
          null,
          ['item'],
          false,
          false,
          { lineno: 1, colno: 1 }
        );
        expect(didIterateNull).to.be.false;

        // Test undefined
        const didIterateUndefined = await runtime.iterate(
          undefined,
          loopBody,
          loopElse,
          null,
          null,
          ['item'],
          false,
          false,
          { lineno: 1, colno: 1 }
        );
        expect(didIterateUndefined).to.be.false;
      });

      it('should handle empty array', async () => {
        const frame = new AsyncFrame();
        frame.set('count', 0, true);

        const loopBody = () => {
          const current = frame.lookup('count');
          frame.set('count', current + 1, true);
        };

        let elseCalled = false;
        const loopElse = async () => {
          elseCalled = true;
        };

        const didIterate = await runtime.iterate(
          [],
          loopBody,
          loopElse,
          frame,
          { count: 0 },
          ['item'],
          true,
          false,
          { lineno: 1, colno: 1 }
        );

        expect(didIterate).to.be.false;
        expect(elseCalled).to.be.true;
        expect(frame.lookup('count')).to.equal(0);
      });

      it('should handle empty object', async () => {
        const frame = new AsyncFrame();
        frame.set('keys', [], true);

        const loopBody = (key, value) => {
          const current = frame.lookup('keys');
          frame.set('keys', [...current, key], true);
        };

        let elseCalled = false;
        const loopElse = async () => {
          elseCalled = true;
        };

        const didIterate = await runtime.iterate(
          {},
          loopBody,
          loopElse,
          frame,
          { keys: 0 },
          ['key', 'value'],
          true,
          false,
          { lineno: 1, colno: 1 }
        );

        expect(didIterate).to.be.false;
        expect(elseCalled).to.be.true;
        expect(frame.lookup('keys')).to.deep.equal([]);
      });

      it('should handle async iterator that throws during iteration', async () => {
        async function* throwingGenerator() {
          yield 1;
          yield 2;
          throw new Error('Iterator failed');
        }

        const loopBody = () => { };

        try {
          await runtime.iterateAsyncSequential(
            throwingGenerator(),
            loopBody,
            ['item'],
            { lineno: 1, colno: 1 }
          );
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('Iterator failed');
        }
      });
    });
  });
})();

