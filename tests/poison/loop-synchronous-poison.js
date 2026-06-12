
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {createPoison, isPoisonError, PoisonError} from '../../src/runtime/runtime.js';

(function () {
  const TEST_EC = [1, 1, 'LoopPoison.TestInput', 'loop-synchronous-poison.js', null, null];
  const createTestPoison = (error) => createPoison(PoisonError.wrap(error, TEST_EC, 'UserCallThrew'));

  describe('Loop synchronous poison detection', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Synchronous poison in array expression with else block', () => {
      it('should not execute loop body and execute else block', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createTestPoison(new Error('Array fetch failed'));
        });

        const script = `
          data result
          var executed = false
          for item in getPoisonedArray()
            executed = true
            result.items.push(item)
          else
            result.elseCalled = true
          endfor

          return result.snapshot()`;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(1);
          expect(err.errors[0].message).to.contain('Array fetch failed');
        }
      });
    });

    describe('Synchronous poison with body writes', () => {
      it('should poison outer variable instead of leaving unchanged', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createTestPoison(new Error('Cannot fetch items'));
        });

        const script = `
          var result = {}
          var total = 0
          for item in getPoisonedArray()
            total = total + item
          endfor
          result.total = total

          return result`;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          // The error should indicate poisoned writes
          expect(err.errors[0].message).to.contain('Cannot fetch items');
        }
      });
    });

    describe('Synchronous poison with handlers', () => {
      it('should add poison markers to buffer', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createTestPoison(new Error('Data unavailable'));
        });

        const script = `
          data result
          for item in getPoisonedArray()
            result.results.push(item)
            text("Item: " + item)
          endfor

          return result.snapshot()`;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          // Should have error from poison marker in buffer
          expect(err.errors.length).to.be.greaterThan(0);
        }
      });
    });

    describe('Synchronous poison with both writes and handlers', () => {
      it('should handle both poisoning mechanisms', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createTestPoison(new Error('Complete failure'));
        });

        const script = `
          data result
          var count = 0
          for item in getPoisonedArray()
            count = count + 1
            result.items.push(item)
          else
            result.fallback = true
          endfor

          return result.snapshot()`;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Complete failure');
        }
      });
    });

    describe('Thrown error in array expression', () => {
      it('should catch and handle like poison', async () => {
        env.addGlobal('throwingFunc', () => {
          throw new Error('Sync throw in evaluation');
        });

        const script = `
          var result = {}
          var total = 0
          for item in throwingFunc()
            total = total + item
          else
            result.elseCalled = true
          endfor

          return result`;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Sync throw in evaluation');
        }
      });
    });

    describe('Normal array after poison handling', () => {
      it('should still execute normally with valid data', async () => {
        env.addGlobal('getArray', () => [1, 2, 3]);

        const script = `
          var result = {}
          var total = 0
          for item in getArray()
            total = total + item
          endfor
          result.total = total

          return result`;

        const result = await env.renderScriptString(script);
        expect(result.total).to.be(6);
      });

      it('should handle empty array else block', async () => {
        const script = `
          data result
          for item in []
            result.items.push(item)
          else
            result.isEmpty = true
          endfor

          return result.snapshot()`;

        const result = await env.renderScriptString(script);
        expect(result.isEmpty).to.be(true);
      });
    });

  });
})();
