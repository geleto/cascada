(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime');
    createPoison = runtime.createPoison;
    AsyncEnvironment = runtime.AsyncEnvironment;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  describe('Iterator Poison Integration with Templates', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Basic template integration', () => {
      it('should poison loop variables when iterable is poisoned', async () => {
        const context = {
          async getItems() {
            throw new Error('Failed to get items');
          }
        };

        const template = `
			{% set sum = 0 %}
			{% for item in getItems() %}
			{% set sum = sum + item %}
			{% endfor %}
			Sum: {{ sum }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Failed to get items');
        }
      });

      it('should execute else when iterable is poisoned', async () => {
        const context = {
          async getItems() {
            throw new Error('No items');
          }
        };

        const template = `
			{% for item in getItems() %}
			{{ item }}
			{% else %}
			No items available
			{% endfor %}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('No items');
        }
      });

      it('should handle loop body errors', async () => {
        const context = {
          items: [1, 2, 3],
          async process(x) {
            if (x === 2) {
              throw new Error('Cannot process 2');
            }
            return x * 2;
          }
        };

        const template = `
			{% for item in items %}
			{{ process(item) }}
			{% endfor %}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Cannot process 2');
        }
      });

      it('should collect all errors from async iterator', async () => {
        const context = {
          async *generate() {
            yield 1;
            throw new Error('Generator failed');
          }
        };

        const template = `
			{% for item in generate() %}
			{{ item }}
			{% endfor %}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Generator failed');
        }
      });
    });

    describe('Complex template scenarios', () => {
      it('should handle nested loops with poisoned inner iterable', async () => {
        const context = {
          outerItems: [1, 2, 3],
          async getInnerItems(x) {
            if (x === 2) {
              throw new Error('Inner items failed for ' + x);
            }
            return [x * 10, x * 20];
          }
        };

        const template = `
			{% set results = [] %}
			{% for outer in outerItems %}
			{% for inner in getInnerItems(outer) %}
				{% set results = results + [inner] %}
			{% endfor %}
			{% endfor %}
			Results: {{ results }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Inner items failed for 2');
        }
      });

      it('should handle async iterator with mixed valid and poisoned values', async () => {
        const context = {
          async *mixedGenerator() {
            yield 1;
            yield createPoison(new Error('Value 2 poisoned'));
            yield 3;
          }
        };

        const template = `
			{% set sum = 0 %}
			{% for item in mixedGenerator() %}
			{% set sum = sum + item %}
			{% endfor %}
			Sum: {{ sum }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Value 2 poisoned');
        }
      });

      it('should handle loop with async filter that fails', async () => {
        const context = {
          items: [1, 2, 3, 4, 5],
          async isEven(x) {
            if (x === 3) {
              throw new Error('Cannot check if 3 is even');
            }
            return x % 2 === 0;
          }
        };

        const template = `
			{% set evens = [] %}
			{% for item in items %}
			{% if isEven(item) %}
				{% set evens = evens + [item] %}
			{% endif %}
			{% endfor %}
			Evens: {{ evens }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Cannot check if 3 is even');
        }
      });

      it('should handle while loop with poisoned condition', async () => {
        const context = {
          async getCondition() {
            throw new Error('Condition check failed');
          }
        };

        const template = `
			{% set count = 0 %}
			{% while getCondition() %}
			{% set count = count + 1 %}
			{% endwhile %}
			Count: {{ count }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Condition check failed');
        }
      });

      it('should handle object iteration with poisoned values', async () => {
        const context = {
          async getObject() {
            throw new Error('Cannot get object');
          }
        };

        const template = `
			{% set keys = [] %}
			{% for key, value in getObject() %}
			{% set keys = keys + [key] %}
			{% endfor %}
			Keys: {{ keys }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Cannot get object');
        }
      });
    });

    describe('Error propagation in templates', () => {
      it('should propagate poison through template includes', async () => {
        const mainTemplate = `
			{% set items = getItems() %}
			{% include "inner.njk" %}
		`;

        env.addGlobal('getItems', async () => {
          throw new Error('Items failed');
        });

        try {
          await env.renderTemplateString(mainTemplate, {});
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Items failed');
        }
      });

      it('should handle macro calls with poisoned parameters', async () => {
        const template = `
			{% macro processItems(items) %}
			{% for item in items %}
				{{ item }}
			{% endfor %}
			{% endmacro %}

			{{ processItems(getItems()) }}
		`;

        const context = {
          async getItems() {
            throw new Error('Macro items failed');
          }
        };

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Macro items failed');
        }
      });

      it('should handle async filters in loop conditions', async () => {
        const context = {
          items: [1, 2, 3],
          async shouldProcess(x) {
            if (x === 2) {
              throw new Error('Cannot determine if should process 2');
            }
            return x > 1;
          }
        };

        const template = `
			{% for item in items %}
			{% if shouldProcess(item) %}
				Processing: {{ item }}
			{% endif %}
			{% endfor %}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Cannot determine if should process 2');
        }
      });
    });

    describe('Template error handling patterns', () => {
      it('should handle try/catch around loops', async () => {
        const context = {
          async getItems() {
            throw new Error('Items failed');
          }
        };

        const template = `
			{% try %}
			{% for item in getItems() %}
				{{ item }}
			{% endfor %}
			{% catch %}
			Error: {{ error.message }}
			{% endtry %}
		`;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Error: Items failed');
      });

      it('should handle loop with else and error in body', async () => {
        const context = {
          items: [1, 2, 3],
          async process(x) {
            if (x === 2) {
              throw new Error('Cannot process 2');
            }
            return x;
          }
        };

        const template = `
			{% for item in items %}
			{% if item == 2 %}
				{{ process(item) }}
			{% endif %}
			{% else %}
			No items
			{% endfor %}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Cannot process 2');
        }
      });

      it('should handle async iterator exhaustion with errors', async () => {
        const context = {
          async *problematicGenerator() {
            yield 1;
            yield 2;
            throw new Error('Generator exhausted with error');
          }
        };

        const template = `
			{% set results = [] %}
			{% for item in problematicGenerator() %}
			{% set results = results + [item] %}
			{% endfor %}
			Results: {{ results }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Generator exhausted with error');
        }
      });
    });

    describe('Performance and edge cases', () => {
      it('should handle large async iterator with early error', async () => {
        const context = {
          async *largeGenerator() {
            for (let i = 0; i < 1000; i++) {
              if (i === 100) {
                throw new Error('Error at iteration 100');
              }
              yield i;
            }
          }
        };

        const template = `
			{% set count = 0 %}
			{% for item in largeGenerator() %}
			{% set count = count + 1 %}
			{% endfor %}
			Count: {{ count }}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Error at iteration 100');
        }
      });

      it('should handle async iterator that yields promises', async () => {
        const context = {
          async *promiseGenerator() {
            yield Promise.resolve(1);
            yield Promise.reject(new Error('Promise rejected'));
            yield Promise.resolve(3);
          }
        };

        const template = `
			{% for item in promiseGenerator() %}
			{{ item }}
			{% endfor %}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Promise rejected');
        }
      });

      it('should handle mixed sync/async iteration', async () => {
        const context = {
          syncItems: [1, 2, 3],
          async getAsyncItems() {
            throw new Error('Async items failed');
          }
        };

        const template = `
			{% for item in syncItems %}
			Sync: {{ item }}
			{% endfor %}
			{% for item in getAsyncItems() %}
			Async: {{ item }}
			{% endfor %}
		`;

        try {
          await env.renderTemplateString(template, context);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.include('Async items failed');
        }
      });
    });
  });
});
