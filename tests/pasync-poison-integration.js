(function () {
  'use strict';

  var expect;
  let runtime;
  let AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../src/runtime');
    AsyncEnvironment = runtime.AsyncEnvironment;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  describe('Poisoning integration Tests', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should handle poisoned arguments passed to macros', async () => {
      const template = `
        {% macro double(x) %}
          {{ x * 2 }}
        {% endmacro %}

        {% set value = getValue() %}
        {{ double(value) }}
      `;

      const context = {
        async getValue() {
          throw new Error('Value fetch failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Value fetch failed');
      }
    });
  });

  describe('Error propagation in templates', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should propagate poison through template includes', async () => {
      const { StringLoader } = require('nunjucks');
      const loader = new StringLoader();
      const testEnv = new AsyncEnvironment(loader);

      loader.addTemplate('main.njk', `
        {% set items = getItems() %}
        {% include "inner.njk" %}
      `);

      loader.addTemplate('inner.njk', `
        {% for item in items %}
          {{ item }}
        {% endfor %}
      `);

      testEnv.addGlobal('getItems', async () => {
        throw new Error('Items failed');
      });

      try {
        await testEnv.renderAsync('main.njk', {});
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

    it('should handle poisoned arguments passed to macros', async () => {
      const template = `
        {% macro double(x) %}
          {{ x * 2 }}
        {% endmacro %}

        {% set value = getValue() %}
        {{ double(value) }}
      `;

      const context = {
        async getValue() {
          throw new Error('Value fetch failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Value fetch failed');
      }
    });
  });

  describe('Buffer Flattening Poison Integration', () => {
    let env;

    beforeEach(() => {
      env = new runtime.Environment();
    });

    it('should catch poison in output', async () => {
      const context = {
        async getData() {
          throw new Error('Data fetch failed');
        }
      };

      const template = `Result: {{ getData() }}`;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Data fetch failed');
      }
    });

    it('should collect multiple errors in output', async () => {
      const context = {
        async fail1() {
          throw new Error('First failure');
        },
        async fail2() {
          throw new Error('Second failure');
        }
      };

      const template = `{{ fail1() }} and {{ fail2() }}`;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        // Should contain information about errors
        expect(err.message).to.match(/First failure|Second failure/);
      }
    });

    it('should handle poison in nested output', async () => {
      const context = {
        async inner() {
          throw new Error('Inner error');
        }
      };

      const template = `
        {% macro test() %}
          Value: {{ inner() }}
        {% endmacro %}
        {{ test() }}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Inner error');
      }
    });

    it('should render successfully when no errors', async () => {
      const context = {
        async getValue() {
          return 'Success';
        }
      };

      const template = `Result: {{ getValue() }}`;
      const result = await env.renderTemplateString(template, context);

      expect(result).to.include('Success');
    });

    it('should handle poison in complex template structures', async () => {
      const context = {
        async getItems() {
          return [
            { name: 'Item 1', async getValue() { throw new Error('Item 1 error'); } },
            { name: 'Item 2', async getValue() { throw new Error('Item 2 error'); } }
          ];
        }
      };

      const template = `
        {% for item in getItems() %}
          {{ item.name }}: {{ item.getValue() }}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.match(/Item 1 error|Item 2 error/);
      }
    });

    it('should collect all errors in loop processing', async () => {
      const context = {
        async getItems() {
          return [
            { async getName() { throw new Error('Name error 1'); } },
            { async getName() { throw new Error('Name error 2'); } },
            { async getName() { throw new Error('Name error 3'); } }
          ];
        }
      };

      const template = `
        {% for item in getItems() %}
          {{ item.getName() }}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        // Should contain multiple error messages
        const message = err.message;
        expect(message).to.match(/Name error/);
      }
    });

    it('should handle poison in conditional blocks', async () => {
      const context = {
        async getCondition() {
          throw new Error('Condition error');
        },
        async getValue() {
          return 'Success';
        }
      };

      const template = `
        {% if getCondition() %}
          {{ getValue() }}
        {% endif %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Condition error');
      }
    });

    it('should handle poison in filter chains', async () => {
      const context = {
        async getValue() {
          throw new Error('Filter error');
        }
      };

      const template = `{{ getValue() | upper }}`;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Filter error');
      }
    });

    it('should handle mixed valid and poisoned content', async () => {
      const context = {
        async getValid() {
          return 'Valid content';
        },
        async getPoisoned() {
          throw new Error('Poisoned content');
        }
      };

      const template = `{{ getValid() }} and {{ getPoisoned() }}`;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Poisoned content');
      }
    });

    it('should handle poison in macro calls', async () => {
      const context = {
        async getData() {
          throw new Error('Macro data error');
        }
      };

      const template = `
        {% macro display(data) %}
          Data: {{ data }}
        {% endmacro %}
        {{ display(getData()) }}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Macro data error');
      }
    });

    it('should handle poison in nested macro calls', async () => {
      const context = {
        async getInnerData() {
          throw new Error('Inner macro error');
        }
      };

      const template = `
        {% macro inner() %}
          {{ getInnerData() }}
        {% endmacro %}
        {% macro outer() %}
          {{ inner() }}
        {% endmacro %}
        {{ outer() }}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Inner macro error');
      }
    });
  });

});
