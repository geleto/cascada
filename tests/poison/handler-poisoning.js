(function () {
  'use strict';

  var expect;
  let AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  describe.only('Handler Poisoning for Conditional Branches', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it.only('should poison handlers when if condition fails with output only', async () => {
      const template = `{% if asyncReject() %}yes{% endif %}`;

      const context = {
        async asyncReject() {
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

    it('should poison handlers when if-else both have output', async () => {
      const template = `{% if asyncReject() %}yes{% else %}no{% endif %}`;

      const context = {
        async asyncReject() {
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

    it('should poison handlers with mixed variables and output', async () => {
      const template = `{% if asyncReject() %}{% set x = 5 %}{{ x }}{% endif %}Result: {{ x }}`;

      const context = {
        async asyncReject() {
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

    it('should handle nested conditionals with poisoned inner condition', async () => {
      const template = `{% if true %}{% if asyncReject() %}inner{% endif %}outer{% endif %}`;

      const context = {
        async asyncReject() {
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

    it('should handle empty branches gracefully', async () => {
      const template = `{% if asyncReject() %}{% endif %}done`;

      const context = {
        async asyncReject() {
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

    it('should handle multiple outputs in single branch', async () => {
      const template = `{% if asyncReject() %}{{ "first" }} {{ "second" }} {{ "third" }}{% endif %}`;

      const context = {
        async asyncReject() {
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

    it('should handle complex nested structure', async () => {
      const template = `
        {% if outerCondition() %}
          Outer start
          {% if asyncReject() %}
            Inner content
          {% endif %}
          Outer end
        {% endif %}
      `;

      const context = {
        async outerCondition() {
          return true;
        },
        async asyncReject() {
          throw new Error('Inner failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Inner failed');
      }
    });

    it('should handle if with only else branch having output', async () => {
      const template = `{% if asyncReject() %}{% set x = 1 %}{% else %}no{% endif %}`;

      const context = {
        async asyncReject() {
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
  });
})();

