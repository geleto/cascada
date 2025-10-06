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
});
