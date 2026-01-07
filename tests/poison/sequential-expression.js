'use strict';
/**
 * Integration tests for sequential operations with poisoning system
 *
 * Test organization:
 * 1. Basic Sequential Operations (Success Cases)
 * 2. Sequential Operations with Failures
 * 3. Mixed Success/Failure in Expressions
 * 4. Operations on Already Poisoned Paths
 * 5. Complex Expression Patterns
 * 6. Edge Cases and Error Aggregation
 */

let expect;
let runtime;
let createPoison;
let isPoisonError;
let AsyncEnvironment;
let isPoison;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  runtime = require('../../src/runtime/runtime');
  createPoison = runtime.createPoison;
  isPoisonError = runtime.isPoisonError;
  isPoison = runtime.isPoison;
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
} else {
  expect = window.expect;
  createPoison = nunjucks.runtime.createPoison;
  isPoisonError = nunjucks.runtime.isPoisonError;
  isPoison = nunjucks.runtime.isPoison;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
}

describe('Sequential Expression Poisoning', function () {
  let env;

  beforeEach(function () {
    env = new AsyncEnvironment();
  });

  // ============================================================================
  // 1. BASIC SEQUENTIAL OPERATIONS (Success Cases)
  // ============================================================================

  describe('Basic Sequential Operations - Success', function () {
    it('should handle simple sequential method call', async function () {
      const context = {
        account: {
          async getValue() {
            return 100;
          }
        }
      };

      const template = `
        {%- set balance = account!.getValue() -%}
        Balance: {{ balance }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Balance: 100');
    });

    it('should poison a sequential path with poison argument', async () => {
      const context = {
        processed: [],
        async errorFunc() {
          throw new Error('Transient error');
        },
      };
      const template = `
      {%- do processed!.push(errorFunc()) -%}
      {{- processed -}}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(context.processed).to.eql([]);
      }
    });

    it('should not execute calls on poisoned path', async () => {
      const context = {
        processed: [],
        async errorFunc() {
          throw new Error('Transient error');
        },
      };
      const template = `
      {%- do processed!.push('A') -%}
      {%- do processed!.push(errorFunc()) -%}
      {%- do processed!.push('B') -%}
      {{- processed -}}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(context.processed).to.eql(['A']);
      }
    });

    it('should poison sequential path from loop', async () => {
      const context = {
        processed: [],
        async *myGenerator() {
          yield 'A';
          yield new Error('Transient error');
          yield 'B';
        }
      };
      const template = `
      {% for item in myGenerator() %}
      {% do processed!.push(item) %}
      {% endfor %}
      {{ processed }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    //@todo - is error not yet implemented
    it.skip('should continue processing valid items after a poison value is yielded', async () => {
      const context = {
        processed: [],
        async *myGenerator() {
          yield 'A';
          yield new Error('Transient error');
          yield 'B';
        }
      };
      const template = `
      {% for item in myGenerator() %}
      {% item is not error %}
        {% do processed!.push(item) %}
      {% endif %}
      {% endfor %}
      {{ processed[1] }}:{{ processed[0] }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result).to.equal('B:A');
    });

    // TODO - sequential side-effect access is not supported yet
    // poisoning shall happen on all further operations at the critical path
    it.skip('should process iterations with sequential side-effect access and collect multiple errors', async () => {
      const context = {
        processed: [],
        async *myGenerator() {
          yield 1;
          yield 2;
          yield 3;
          yield 4;
        },
        async failingFunc(val) {
          if (val === 2 || val === 4) {
            throw new Error(`Failure on ${val}`);
          }
          return val;
        }
      };
      const template = `
      {% for item in myGenerator() %}
      {% set result = failingFunc(item) %}
      {% do processed!.push(result) %}
      {% endfor %}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(2);
        const messages = err.errors.map(e => e.message).sort();
        expect(messages).to.eql(['Failure on 2', 'Failure on 4']);

        const successfulResults = await Promise.all(
          context.processed.filter(p => !isPoison(p))
        );
        expect(successfulResults).to.eql([1, 3]);
      }
    });

    it('should handle sequential method chain', async function () {
      const context = {
        data: {
          async process() {
            return {
              async getValue() {
                return 42;
              }
            };
          }
        }
      };

      const template = `
        {%- set result = data!.process().getValue() -%}
        Result: {{ result }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Result: 42');
    });

    it('should handle multiple sequential operations in sequence', async function () {
      const context = {
        counter: {
          value: 0,
          async increment() {
            this.value++;
            return this.value;
          }
        }
      };

      const template = `
        {%- set a = counter!.increment() -%}
        {%- set b = counter!.increment() -%}
        {%- set c = counter!.increment() -%}
        Values: {{ a }}, {{ b }}, {{ c }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Values: 1, 2, 3');
    });
  });

  // ============================================================================
  // 2. SEQUENTIAL OPERATIONS WITH FAILURES
  // ============================================================================

  describe('Sequential Operations with Failures', function () {
    it('should poison sequential path when operation fails', async function () {
      const context = {
        account: {
          async getValue() {
            throw new Error('Database connection failed');
          }
        }
      };

      const template = `
        {%- set balance = account!.getValue() -%}
        Balance: {{ balance }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors.length).to.be.greaterThan(0);
        expect(err.message).to.contain('Database connection failed');
      }
    });

    it('should poison when sequential operation argument fails', async function () {
      const context = {
        processor: {
          async process(value) {
            return value * 2;
          }
        },
        async failingFunc() {
          throw new Error('Argument error');
        }
      };

      const template = `
        {%- set result = processor!.process(failingFunc()) -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Argument error');
      }
    });

    it('should poison when method in sequential chain fails', async function () {
      const context = {
        data: {
          async step1() {
            return {
              async step2() {
                throw new Error('Step 2 failed');
              }
            };
          }
        }
      };

      const template = `
        {%- set result = data!.step1().step2() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Step 2 failed');
      }
    });

    it('should poison when array push with sequential path fails', async function () {
      const context = {
        items: [],
        async errorFunc() {
          throw new Error('Item creation failed');
        }
      };

      const template = `
        {%- do items!.push(errorFunc()) -%}
        Items: {{ items }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Item creation failed');
      }
    });
  });

  // ============================================================================
  // 3. MIXED SUCCESS/FAILURE IN EXPRESSIONS
  // ============================================================================

  describe('Mixed Success/Failure in Expressions', function () {
    it('should handle sequential success + regular failure', async function () {
      const context = {
        account: {
          async getValue() {
            return 100;
          }
        },
        failFunc() {
          throw new Error('Regular failure');
        }
      };

      // Expression: path!.successFunc() + failFunc()
      const template = `
        {%- set sum = account!.getValue() + failFunc() -%}
        Sum: {{ sum }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Regular failure');
      }
    });

    it('should handle sequential failure + regular success', async function () {
      const context = {
        account: {
          async getValue() {
            throw new Error('Sequential failure');
          }
        },
        getBonus() {
          return 50;
        }
      };

      const template = `
        {%- set sum = account!.getValue() + getBonus() -%}
        Sum: {{ sum }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Sequential failure');
      }
    });

    it('should handle both sequential, different paths, one fails', async function () {
      const context = {
        account1: {
          async getValue() {
            return 100;
          }
        },
        account2: {
          async getValue() {
            throw new Error('Account2 error');
          }
        }
      };

      const template = `
        {%- set sum = account1!.getValue() + account2!.getValue() -%}
        Sum: {{ sum }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Account2 error');
      }
    });

    it('should handle both sequential, same path accessed twice, one fails', async function () {
      const context = {
        account: {
          async getBalance() {
            return 100;
          },
          async getBonus() {
            throw new Error('Bonus calculation failed');
          }
        }
      };

      // Both sides touch account!, creating async block due to contention
      const template = `
        {%- set total = account!.getBalance() + account!.getBonus() -%}
        Total: {{ total }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Bonus calculation failed');
      }
    });

    it('should collect errors from both sides when both fail', async function () {
      const context = {
        account1: {
          async getValue() {
            throw new Error('Account1 error');
          }
        },
        account2: {
          async getValue() {
            throw new Error('Account2 error');
          }
        }
      };

      const template = `
        {%- set sum = account1!.getValue() + account2!.getValue() -%}
        Sum: {{ sum }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Should collect both errors (never miss any error)
        expect(err.errors.length).to.be.greaterThan(1);
        const messages = err.errors.map(e => e.message).join(' ');
        expect(messages).to.contain('Account1 error');
        expect(messages).to.contain('Account2 error');
      }
    });

    it('should handle three-way expression with mixed success/failure', async function () {
      const context = {
        a: {
          async getValue() {
            return 10;
          }
        },
        b: {
          async getValue() {
            throw new Error('B failed');
          }
        },
        c: {
          async getValue() {
            return 30;
          }
        }
      };

      const template = `
        {%- set sum = a!.getValue() + b!.getValue() + c!.getValue() -%}
        Sum: {{ sum }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('B failed');
      }
    });

    it('should verify basic locking inside output handler', async function () {
      const script = `
      :data
      api.users!.fail()
      @data.u = api.users!.success() is error
    `;

      const context = {
        api: {
          users: {
            fail: () => { throw new Error('Users Error'); },
            success: () => 'Users Success'
          }
        }
      };

      const result = await env.renderScriptString(script, context);
      expect(result.u).to.be(true);
    });
  });

  // ============================================================================
  // 4. OPERATIONS ON ALREADY POISONED PATHS
  // ============================================================================

  describe('Operations on Already Poisoned Paths', function () {
    it('should propagate poison when reading from poisoned sequential path', async function () {
      const context = {
        account: {
          async getValue() {
            throw new Error('Initial error');
          }
        }
      };

      const template = `
        {%- set balance1 = account!.getValue() -%}
        {%- set balance2 = account -%}
        Balance: {{ balance2 }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Initial error');
      }
    });

    it('should propagate poison when writing to poisoned sequential path', async function () {
      const context = {
        data: {
          items: [],
          async failInit() {
            throw new Error('Init failed');
          }
        }
      };

      const template = `
        {%- do data!.failInit() -%}
        {%- do data!.items.push('new item') -%}
        Items: {{ data.items }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Init failed');
      }
    });

    it('should propagate poison through expression using poisoned path', async function () {
      const context = {
        x: {
          async getValue() {
            throw new Error('X error');
          }
        },
        y: {
          getValue() {
            return 10;
          }
        }
      };

      const template = `
        {%- set val1 = x!.getValue() -%}
        {%- set result = x + y.getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('X error');
      }
    });

    it('should handle multiple reads from poisoned sequential path', async function () {
      const context = {
        config: {
          async load() {
            throw new Error('Config load failed');
          }
        }
      };

      const template = `
        {%- set cfg = config!.load() -%}
        {%- set val1 = config -%}
        {%- set val2 = config -%}
        {%- set val3 = config -%}
        Config: {{ val1 }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Config load failed');
      }
    });

    it('should propagate poison when chaining on poisoned path', async function () {
      const context = {
        obj: {
          async getChild() {
            throw new Error('Child access failed');
          }
        }
      };

      const template = `
        {%- set child = obj!.getChild() -%}
        {%- set grandchild = obj!.getChild().getValue() -%}
        Value: {{ grandchild }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Child access failed');
      }
    });
  });

  // ============================================================================
  // 5. COMPLEX EXPRESSION PATTERNS
  // ============================================================================

  describe('Complex Expression Patterns', function () {
    it('should handle nested expressions with sequential', async function () {
      const context = {
        a: {
          async getValue() {
            return 5;
          }
        },
        b: {
          async getValue() {
            return 10;
          }
        },
        c: {
          getValue() {
            return 2;
          }
        }
      };

      const template = `
        {%- set result = (a!.getValue() + b!.getValue()) * c.getValue() -%}
        Result: {{ result }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Result: 30');
    });

    it('should handle nested expressions with failure', async function () {
      const context = {
        a: {
          async getValue() {
            return 5;
          }
        },
        b: {
          async getValue() {
            throw new Error('Inner failure');
          }
        },
        c: {
          getValue() {
            return 2;
          }
        }
      };

      const template = `
        {%- set result = (a!.getValue() + b!.getValue()) * c.getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Inner failure');
      }
    });

    it('should handle sequential in ternary operator', async function () {
      const context = {
        condition: true,
        success: {
          async getValue() {
            return 100;
          }
        },
        failure: {
          async getValue() {
            throw new Error('Should not be called');
          }
        }
      };

      const template = `
        {%- set result = success!.getValue() if condition else failure!.getValue() -%}
        Result: {{ result }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Result: 100');
    });

    it('should handle sequential in ternary with failure in taken branch', async function () {
      const context = {
        condition: true,
        branch: {
          async getValue() {
            throw new Error('Taken branch failed');
          }
        },
        other: {
          async getValue() {
            return 100;
          }
        }
      };

      const template = `
        {%- set result = branch!.getValue() if condition else other!.getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Taken branch failed');
      }
    });

    it('should handle sequential in logical AND operator', async function () {
      const context = {
        check: {
          async isValid() {
            return true;
          }
        },
        value: {
          async getValue() {
            return 42;
          }
        }
      };

      const template = `
        {%- set result = check!.isValid() and value!.getValue() -%}
        Result: {{ result }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Result: 42');
    });

    it('should handle sequential in logical OR with failure', async function () {
      const context = {
        first: {
          async getValue() {
            throw new Error('First option failed');
          }
        },
        second: {
          async getValue() {
            return 100;
          }
        }
      };

      const template = `
        {%- set result = first!.getValue() or second!.getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('First option failed');
      }
    });

    it('should handle multiple sequential paths in single expression', async function () {
      const context = {
        account: {
          async getBalance() {
            return 1000;
          }
        },
        fee: {
          async calculate() {
            return 50;
          }
        },
        tax: {
          async calculate() {
            return 100;
          }
        }
      };

      const template = `
        {%- set net = account!.getBalance() - fee!.calculate() - tax!.calculate() -%}
        Net: {{ net }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Net: 850');
    });

    it('should handle multiple sequential paths with one failure', async function () {
      const context = {
        account: {
          async getBalance() {
            return 1000;
          }
        },
        fee: {
          async calculate() {
            throw new Error('Fee calculation failed');
          }
        },
        tax: {
          async calculate() {
            return 100;
          }
        }
      };

      const template = `
        {%- set net = account!.getBalance() - fee!.calculate() - tax!.calculate() -%}
        Net: {{ net }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Fee calculation failed');
      }
    });
  });

  // ============================================================================
  // 6. EDGE CASES AND ERROR AGGREGATION
  // ============================================================================

  describe('Edge Cases and Error Aggregation', function () {
    it('should aggregate multiple synchronous errors', async function () {
      const context = {
        func1() {
          throw new Error('Sync error 1');
        },
        func2() {
          throw new Error('Sync error 2');
        },
        path: {
          getValue() {
            return 10;
          }
        }
      };

      const template = `
        {%- set result = func1() + func2() + path!.getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Should collect both sync errors
        const messages = err.errors.map(e => e.message).join(' ');
        expect(messages).to.contain('Sync error 1');
        expect(messages).to.contain('Sync error 2');
      }
    });

    it('should aggregate sync and async errors', async function () {
      const context = {
        syncFunc() {
          throw new Error('Sync error');
        },
        async asyncFunc() {
          throw new Error('Async error');
        },
        path: {
          async getValue() {
            return 10;
          }
        }
      };

      const template = `
        {%- set result = syncFunc() + asyncFunc() + path!.getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        const messages = err.errors.map(e => e.message).join(' ');
        expect(messages).to.contain('Sync error');
        expect(messages).to.contain('Async error');
      }
    });

    it('should handle deeply nested sequential operations', async function () {
      const context = {
        level1: {
          async getLevel2() {
            return {
              async getLevel3() {
                return {
                  async getValue() {
                    return 'deep value';
                  }
                };
              }
            };
          }
        }
      };

      const template = `
        {%- set result = level1!.getLevel2().getLevel3().getValue() -%}
        Result: {{ result }}`;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Result: deep value');
    });

    it('should handle deeply nested sequential operations with failure', async function () {
      const context = {
        level1: {
          async getLevel2() {
            return {
              async getLevel3() {
                throw new Error('Deep failure');
              }
            };
          }
        }
      };

      const template = `
        {%- set result = level1!.getLevel2().getLevel3().getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Deep failure');
      }
    });

    it('should handle sequential operation returning promise that resolves to poison', async function () {
      const context = {
        obj: {
          async getValue() {
            // Simulate an internal operation that returns poison
            return createPoison(new Error('Internal poison'));
          }
        }
      };

      const template = `
        {%- set result = obj!.getValue() -%}
        Result: {{ result }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Internal poison');
      }
    });

    it('should not deadlock when sequential path accessed after failure', async function () {
      const context = {
        data: {
          async process() {
            throw new Error('Processing failed');
          }
        }
      };

      const template = `
        {%- set r1 = data!.process() -%}
        {%- set r2 = data -%}
        {%- set r3 = data -%}
        Result: {{ r3 }}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Processing failed');
        // Test passes if it doesn't hang
      }
    });
  });
});
