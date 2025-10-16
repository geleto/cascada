'use strict';

const expect = require('expect.js');
const { AsyncEnvironment } = require('../src/environment');
const { createPoison, isPoisonError } = require('../src/runtime');

describe('Phase 5: While Loop Generator Error Handling', () => {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Test 5.1: Condition evaluates to poison', () => {
    it('should handle poison condition by yielding PoisonError to runtime', async () => {
      const context = {
        getPoisonedCondition: () => createPoison(new Error('Condition failed'))
      };

      const script = `
        :data
        var count = 0
        while getPoisonedCondition()
          count = count + 1
        endwhile
        @data.count = count
      `;

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Condition failed');
        // Loop never executed - count would be poisoned if checked
      }
    });

    it('should handle poison from async function condition', async () => {
      const context = {
        getPoisonedCondition: async () => {
          await Promise.resolve();
          return createPoison(new Error('Async condition failed'));
        }
      };

      const script = `
        :data
        var total = 0
        while getPoisonedCondition()
          total = total + 1
        endwhile
        @data.total = total
      `;

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Async condition failed');
      }
    });
  });

  describe('Test 5.2: Condition throws error', () => {
    it('should stop immediately when condition evaluation throws', async () => {
      let callCount = 0;
      const context = {
        throwingCondition: () => {
          callCount++;
          throw new Error('Condition threw error');
        }
      };

      const script = `
        :data
        var count = 0
        while throwingCondition()
          count = count + 1
        endwhile
      `;

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Condition threw error');
        expect(callCount).to.be(1); // Called once, then stopped
      }
    });

    it('should handle async function throwing error', async () => {
      let callCount = 0;
      const context = {
        throwingCondition: async () => {
          callCount++;
          await Promise.resolve();
          throw new Error('Async throw');
        }
      };

      const script = `
        :data
        var total = 0
        while throwingCondition()
          total = total + 1
        endwhile
        @data.total = total
      `;

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Async throw');
        expect(callCount).to.be(1);
      }
    });
  });

  describe('Test 5.3: Sequential operations in condition', () => {
    it('should handle sequential operations in condition', async () => {
      const context = {
        counter: {
          value: 0,
          incrementAndCheck: function() {
            this.value++;
            return this.value < 3;
          }
        }
      };

      const script = `
        :data
        var total = 0
        while counter!.incrementAndCheck()
          total = total + 1
        endwhile
        @data.total = total
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.total).to.be(2); // Increments to 1, 2, stops at 3
    });

    it('should handle poison in sequential condition', async () => {
      const context = {
        obj: createPoison(new Error('Object is poisoned'))
      };

      const script = `
        :data
        var count = 0
        while obj!.method()
          count = count + 1
        endwhile
      `;

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Object is poisoned');
      }
    });
  });

  describe('Test 5.4: Normal boolean condition', () => {
    it('should work with normal boolean condition', async () => {
      const context = {
        shouldContinue: true,
        checkCondition: function() {
          const result = this.shouldContinue;
          this.shouldContinue = false;
          return result;
        }
      };

      const script = `
        :data
        var count = 0
        while checkCondition()
          count = count + 1
        endwhile
        @data.count = count
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.count).to.be(1);
    });

    it('should handle multiple iterations with normal condition', async () => {
      let counter = 0;
      const context = {
        getCondition: () => {
          counter++;
          return counter <= 5;
        }
      };

      const script = `
        :data
        var total = 0
        while getCondition()
          total = total + 1
        endwhile
        @data.total = total
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.total).to.be(5);
    });
  });

  describe('Test 5.5: Multiple iterations then condition error', () => {
    it('should iterate several times then handle condition error as soft error', async () => {
      let callCount = 0;
      const context = {
        checkCondition: () => {
          callCount++;
          if (callCount <= 3) return true;
          // After 3 iterations, condition fails
          throw new Error('Condition failed after 3 iterations');
        }
      };

      const script = `
        :data
        var total = 0
        while checkCondition()
          total = total + 1
        endwhile
        @data.total = total
      `;

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Condition failed after 3 iterations');
        expect(callCount).to.be(4); // Called 4 times: 3 true, 1 throw
        // Note: The 3 successful iterations completed before error
      }
    });

    it('should handle poison after several iterations', async () => {
      const context = {
        callCount: 0,
        checkCondition: function() {
          this.callCount++;
          if (this.callCount <= 2) return true;
          // Return poison instead of throwing
          return createPoison(new Error(`Condition poisoned after ${this.callCount - 1} iterations`));
        }
      };

      const script = `
        :data
        var items = []
        while checkCondition()
          @data.items.push(callCount)
        endwhile
      `;

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Condition poisoned after 2 iterations');
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle condition that never executes', async () => {
      const context = {
        alwaysFalse: () => false
      };

      const script = `
        :data
        var ran = false
        while alwaysFalse()
          ran = true
        endwhile
        @data.bodyRan = ran
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.bodyRan).to.be(false);
    });

    it('should handle async condition function', async () => {
      let count = 0;
      const context = {
        asyncCondition: async () => {
          count++;
          await Promise.resolve();
          return count <= 3;
        }
      };

      const script = `
        :data
        var total = 0
        while asyncCondition()
          total = total + 1
        endwhile
        @data.total = total
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.total).to.be(3);
    });

    it('should handle complex condition with async calls', async () => {
      let callCount = 0;
      const context = {
        checkCondition: async () => {
          callCount++;
          await Promise.resolve();
          return callCount <= 3;
        }
      };

      const script = `
        :data
        var total = 0
        while checkCondition()
          total = total + 1
        endwhile
        @data.total = total
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.total).to.be(3);
      expect(callCount).to.be(4); // Called 4 times, last one returned false
    });

    it('should handle zero iterations with immediate false condition', async () => {
      const context = {
        alwaysFalse: async () => {
          await Promise.resolve();
          return false;
        }
      };

      const script = `
        :data
        var executed = false
        while alwaysFalse()
          executed = true
        endwhile
        @data.executed = executed
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.executed).to.be(false);
    });
  });
});

