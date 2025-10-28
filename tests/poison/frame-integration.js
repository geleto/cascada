(function () {
  'use strict';

  var expect;
  let AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }


  describe('Frame Poison Integration with Templates', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Fetch failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Inner failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Operation failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Cannot fetch items');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Data fetch failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Value fetch failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Nested failure');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Condition evaluation failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Number fetch failed');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Object fetch failed');
      }
    });
  });

})();

