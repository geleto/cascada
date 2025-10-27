(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var createPoison;
  var isPoisonError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    const runtime = require('../../src/runtime/runtime');
    createPoison = runtime.createPoison;
    isPoisonError = runtime.isPoisonError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    createPoison = nunjucks.runtime.createPoison;
    isPoisonError = nunjucks.runtime.isPoisonError;
  }

  describe('Phase 2: Loop Synchronous Poison Detection', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Test 2.1: Synchronous poison in array expression [DEFERRED: Phase 6]', () => {
      it('should not execute loop body and execute else block', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createPoison(new Error('Array fetch failed'));
        });

        const script = `
          :data
          var executed = false
          for item in getPoisonedArray()
            executed = true
            @data.items.push(item)
          else
            @data.elseCalled = true
          endfor
        `;

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

    describe('Test 2.2: Synchronous poison with body writes', () => {
      it('should poison outer variable instead of leaving unchanged', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createPoison(new Error('Cannot fetch items'));
        });

        const script = `
          :data
          var total = 0
          for item in getPoisonedArray()
            total = total + item
          endfor
          @data.total = total
        `;

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

    describe('Test 2.3: Synchronous poison with handlers', () => {
      it('should add poison markers to buffer', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createPoison(new Error('Data unavailable'));
        });

        const script = `
          :data
          for item in getPoisonedArray()
            @data.results.push(item)
            @text("Item: " + item)
          endfor
        `;

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

    describe('Test 2.4: Synchronous poison with both writes and handlers [DEFERRED: Phase 6]', () => {
      it('should handle both poisoning mechanisms', async () => {
        env.addGlobal('getPoisonedArray', () => {
          return createPoison(new Error('Complete failure'));
        });

        const script = `
          :data
          var count = 0
          for item in getPoisonedArray()
            count = count + 1
            @data.items.push(item)
          else
            @data.fallback = true
          endfor
        `;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Complete failure');
        }
      });
    });

    describe('Test 2.5: Thrown error in array expression [DEFERRED: Phase 6]', () => {
      it('should catch and handle like poison', async () => {
        env.addGlobal('throwingFunc', () => {
          throw new Error('Sync throw in evaluation');
        });

        const script = `
          :data
          var total = 0
          for item in throwingFunc()
            total = total + item
          else
            @data.elseCalled = true
          endfor
        `;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Sync throw in evaluation');
        }
      });
    });

    describe('Test 2.6: Normal array after poison handling added', () => {
      it('should still execute normally with valid data', async () => {
        env.addGlobal('getArray', () => [1, 2, 3]);

        const script = `
          :data
          var total = 0
          for item in getArray()
            total = total + item
          endfor
          @data.total = total
        `;

        const result = await env.renderScriptString(script);
        expect(result.total).to.be(6);
      });

      it('should handle empty array else block', async () => {
        const script = `
          :data
          for item in []
            @data.items.push(item)
          else
            @data.isEmpty = true
          endfor
        `;

        const result = await env.renderScriptString(script);
        expect(result.isEmpty).to.be(true);
      });
    });

  });
})();

