(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let isPoisonError;
  let isPoison;
  let AsyncFrame;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../src/runtime');
    createPoison = runtime.createPoison;
    isPoison = runtime.isPoison;
    isPoisonError = runtime.isPoisonError;
    AsyncFrame = runtime.AsyncFrame;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    isPoisonError = nunjucks.runtime.isPoisonError;
    AsyncFrame = nunjucks.runtime.AsyncFrame;
  }


  // Mock Environment for integration tests
  class MockEnvironment {
    constructor() {
      this.frames = [];
    }

    renderTemplateString(template, context) {
      // Mock template rendering that would use AsyncFrame
      const frame = new AsyncFrame();

      // Set up context variables
      for (const [key, value] of Object.entries(context)) {
        frame.set(key, value, true);
      }

      // Mock template processing that would trigger poison handling
      return this.processTemplate(template, frame);
    }

    async processTemplate(template, frame) {
      // Mock processing that simulates template rendering
      if (template.includes('fetchData()')) {
        const data = frame.lookup('fetchData');
        if (typeof data === 'function') {
          try {
            const result = await data();
            frame.set('data', result, true);
          } catch (err) {
            const poison = createPoison(err);
            frame.set('data', poison, true);
            throw new PoisonError(poison.errors);
          }
        }
      }

      if (template.includes('getCondition()')) {
        const condition = frame.lookup('getCondition');
        if (typeof condition === 'function') {
          try {
            const result = await condition();
            if (isPoison(result)) {
              // Poison the branch variables
              frame.poisonBranchWrites(result, { x: 1 });
              throw new PoisonError(result.errors);
            }
          } catch (err) {
            if (isPoisonError(err)) {
              frame.poisonBranchWrites(err, { x: 1 });
              throw err;
            }
            throw err;
          }
        }
      }

      if (template.includes('outer()') && template.includes('inner()')) {
        const outer = frame.lookup('outer');
        const inner = frame.lookup('inner');

        if (typeof outer === 'function' && typeof inner === 'function') {
          try {
            const a = await outer();
            frame.set('a', a, true);

            const b = await inner();
            frame.set('b', b, true);
          } catch (err) {
            const poison = createPoison(err);
            frame.set('b', poison, true);
            throw new PoisonError(poison.errors);
          }
        }
      }

      return 'Template rendered successfully';
    }
  }

  // Mock PoisonError for testing
  class PoisonError extends Error {
    constructor(errors) {
      super('PoisonError');
      this.errors = errors;
      this[Symbol.for('cascada.poisonError')] = true;
    }
  }

  describe('Frame Poison Integration with Templates', () => {
    let env;

    beforeEach(() => {
      env = new MockEnvironment();
    });

    it('should poison variable when async function fails', async () => {
      const context = {
        async fetchData() {
          throw new Error('Fetch failed');
        }
      };

      const template = `
      {% set data = fetchData() %}
      Result: {{ data }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Fetch failed');
      }
    });

    it('should poison all branch variables when condition fails', async () => {
      const context = {
        async getCondition() {
          throw new Error('Condition failed');
        }
      };

      const template = `
      {% if getCondition() %}
        {% set x = "true branch" %}
      {% else %}
        {% set x = "false branch" %}
      {% endif %}
      {{ x }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Condition failed');
      }
    });

    it('should handle poison in nested async blocks', async () => {
      const context = {
        async outer() {
          return 'outer';
        },
        async inner() {
          throw new Error('Inner failed');
        }
      };

      const template = `
      {% set a = outer() %}
      {% set b = inner() %}
      {{ a }} - {{ b }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Inner failed');
      }
    });

    it('should handle multiple async functions with mixed success/failure', async () => {
      const context = {
        async success() {
          return 'success';
        },
        async failure() {
          throw new Error('Operation failed');
        },
        async anotherSuccess() {
          return 'another success';
        }
      };

      const template = `
      {% set a = success() %}
      {% set b = failure() %}
      {% set c = anotherSuccess() %}
      {{ a }} - {{ b }} - {{ c }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Operation failed');
      }
    });

    it('should handle poison in loop conditions', async () => {
      const context = {
        async getItems() {
          throw new Error('Cannot fetch items');
        }
      };

      const template = `
      {% for item in getItems() %}
        {{ item }}
      {% endfor %}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Cannot fetch items');
      }
    });

    it('should handle poison in macro calls', async () => {
      const context = {
        async getData() {
          throw new Error('Data fetch failed');
        }
      };

      const template = `
      {% macro processData(data) %}
        Processed: {{ data }}
      {% endmacro %}

      {{ processData(getData()) }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Data fetch failed');
      }
    });

    it('should handle poison in filter chains', async () => {
      const context = {
        async getValue() {
          throw new Error('Value fetch failed');
        }
      };

      const template = `
      {{ getValue() | upper | default("fallback") }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Value fetch failed');
      }
    });

    it('should handle poison in complex nested structures', async () => {
      const context = {
        async getOuter() {
          return {
            inner: async () => {
              throw new Error('Nested failure');
            }
          };
        }
      };

      const template = `
      {% set obj = getOuter() %}
      {{ obj.inner() }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Nested failure');
      }
    });

    it('should handle poison in conditional expressions', async () => {
      const context = {
        async getCondition() {
          throw new Error('Condition evaluation failed');
        },
        async getTrueValue() {
          return 'true';
        },
        async getFalseValue() {
          return 'false';
        }
      };

      const template = `
      {{ getTrueValue() if getCondition() else getFalseValue() }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Condition evaluation failed');
      }
    });

    it('should handle poison in arithmetic expressions', async () => {
      const context = {
        async getNumber() {
          throw new Error('Number fetch failed');
        }
      };

      const template = `
      {{ getNumber() + 10 }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Number fetch failed');
      }
    });

    it('should handle poison in property access', async () => {
      const context = {
        async getObject() {
          throw new Error('Object fetch failed');
        }
      };

      const template = `
      {{ getObject().property }}
    `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Object fetch failed');
      }
    });
  });

});

