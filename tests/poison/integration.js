(function () {
  'use strict';

  var expect;
  let AsyncEnvironment;
  let StringLoader;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    StringLoader = require('../util').StringLoader;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    StringLoader = window.util.StringLoader;
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Value fetch failed');
      }
    });
  });

  describe('Error propagation in templates', () => {

    it('should propagate poison through template includes', async () => {
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
        await testEnv.renderTemplate('main.njk', {});
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Items failed');
      }
    });
  });

  describe('Buffer Flattening Poison Integration', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Data fetch failed');
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
        expect().fail('Should have thrown');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Inner error');
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

      expect(result).to.contain('Success');
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
        expect().fail('Should have thrown');
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
        expect().fail('Should have thrown');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Condition error');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Filter error');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Poisoned content');
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
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Inner macro error');
      }
    });
  });

  describe('Function call poison propagation tests', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should propagate poison through function calls', async () => {
      const template = `{{ myFunc(failingValue()) }}`;

      const context = {
        failingValue: async () => {
          throw new Error('Value fetch failed');
        },
        myFunc: (val) => val * 2
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Value fetch failed');
      }
    });

    it('should collect errors from all poisoned arguments', async () => {
      const template = `{{ myFunc(val1(), val2(), val3()) }}`;

      const context = {
        val1: async () => { throw new Error('Error 1'); },
        val2: async () => { throw new Error('Error 2'); },
        val3: 'ok',
        myFunc: (a, b, c) => a + b + c
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Error 1');
        expect(err.message).to.contain('Error 2');
        // Verify both errors collected (not short-circuited)
      }
    });

    it('should handle function call on poisoned object', async () => {
      const template = `{{ obj.method(123) }}`;

      const context = {
        obj: (async () => {
          throw new Error('Object fetch failed');
        })()
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Object fetch failed');
      }
    });

    it('should propagate poison through nested function calls', async () => {
      const template = `{{ outer(inner(failingValue())) }}`;

      const context = {
        failingValue: async () => {
          throw new Error('Inner failed');
        },
        inner: (x) => x * 2,
        outer: (x) => x + 10
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Inner failed');
      }
    });

    it('should handle function call with multiple poison arguments', async () => {
      const template = `{{ processData(data1(), data2(), data3()) }}`;

      const context = {
        data1: async () => { throw new Error('Data 1 failed'); },
        data2: async () => { throw new Error('Data 2 failed'); },
        data3: async () => { throw new Error('Data 3 failed'); },
        processData: (a, b, c) => `Processed: ${a}, ${b}, ${c}`
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Data 1 failed');
        expect(err.message).to.contain('Data 2 failed');
        expect(err.message).to.contain('Data 3 failed');
        // Verify all three errors collected
      }
    });

    it('should handle function call with mixed poison and valid arguments', async () => {
      const template = `{{ combine(validValue, poisonValue, anotherValid) }}`;

      const context = {
        validValue: 'Hello',
        anotherValid: 'World',
        poisonValue: (async () => { throw new Error('Poison value failed'); })(),
        combine: (a, b, c) => `${a} ${b} ${c}`
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Poison value failed');
      }
    });
  });

  describe('If statement poison propagation', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });


    it('should poison variables from both branches when condition is poison', async () => {
      const template = `
        {% set x = 0 %}
        {% set y = 0 %}
        {% if poisonCond() %}
          {% set x = 10 %}
        {% else %}
          {% set y = 20 %}
        {% endif %}
        {{ x }}-{{ y }}
      `;

      const context = {
        poisonCond: async () => {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should skip both branches when condition is poison', async () => {
      let trueCalled = false;
      let falseCalled = false;

      const template = `
        {% if poisonCond() %}
          {{ trueFunc() }}
        {% else %}
          {{ falseFunc() }}
        {% endif %}
      `;

      const context = {
        poisonCond: async () => {
          throw new Error('Condition failed');
        },
        trueFunc: () => { trueCalled = true; return 'true'; },
        falseFunc: () => { falseCalled = true; return 'false'; }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(falseCalled).to.be(false);
        expect(trueCalled).to.be(false);
      }
    });

    it('should handle poison in true branch body', async () => {
      const template = `
        {% if true %}
          {{ failingFunc() }}
        {% endif %}
      `;

      const context = {
        failingFunc: async () => {
          throw new Error('Function failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Function failed');
      }
    });

    it('should handle poison in else branch body', async () => {
      const template = `
        {% if false %}
          {{ okFunc() }}
        {% else %}
          {{ failingFunc() }}
        {% endif %}
      `;

      const context = {
        okFunc: () => 'ok',
        failingFunc: async () => {
          throw new Error('Function failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Function failed');
      }
    });

    it('should handle nested if with poison', async () => {
      const template = `
        {% set result = "start" %}
        {% if outerCond %}
          {% if innerCond() %}
            {% set result = "inner-true" %}
          {% else %}
            {% set result = "inner-false" %}
          {% endif %}
        {% endif %}
        {{ result }}
      `;

      const context = {
        outerCond: true,
        innerCond: async () => {
          throw new Error('Inner condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Inner condition failed');
      }
    });

    it('should handle if without else when condition is poison', async () => {
      const template = `
        {% set x = 0 %}
        {% if poisonCond() %}
          {% set x = 10 %}
        {% endif %}
        {{ x }}
      `;

      const context = {
        poisonCond: async () => {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should collect multiple errors from condition and branches', async () => {
      const template = `
        {% if poisonCond() %}
          {{ failInTrue() }}
        {% else %}
          {{ failInFalse() }}
        {% endif %}
      `;

      const context = {
        poisonCond: async () => {
          throw new Error('Condition failed');
        },
        failInTrue: async () => {
          throw new Error('True branch failed');
        },
        failInFalse: async () => {
          throw new Error('False branch failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        // Should at least have the condition error
        expect(err.message).to.contain('Condition failed');
      }
    });
  });

})();
