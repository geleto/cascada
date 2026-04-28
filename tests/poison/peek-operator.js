
(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var runtime;

  function esmDefault(module) {
    return module.default || module;
  }

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    runtime = esmDefault(require('../../src/runtime/runtime'));
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    runtime = nunjucks.runtime;
  }

  describe('Peek Operator (#)', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should peek at a synchronous PoisonedValue', async () => {
      const err = new Error('Basic Error');
      const poison = runtime.createPoison(err, { lineno: 1, colno: 1 });

      const template = `
        {% if val is error %}
          {% set err = val# %}
          {{ err.message }}
        {% endif %}
      `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.contain('Basic Error');
    });

    it('should peek at a rejected Promise', async () => {
      const p = Promise.reject(new Error('Async Fail'));

      const template = `
        {% if val is error %}
          {% set err = val# %}
          {{ err.message }}
        {% endif %}
      `;
      const output = await env.renderTemplateString(template, { val: p });
      expect(output.trim()).to.contain('Async Fail');
    });

    it('should return none when peeking at a healthy value', async () => {
      const template = `
        {% set val = "healthy" %}
        {% set peeked = val# %}
        {{ peeked == none }}
      `;
      const output = await env.renderTemplateString(template);
      expect(output.trim()).to.be('true');
    });

    it('should return none when peeking at a healthy Promise', async () => {
      const p = Promise.resolve('healthy');
      const template = `
        {% set peeked = val# %}
        {{ peeked == none }}
      `;
      const output = await env.renderTemplateString(template, { val: p });
      expect(output.trim()).to.be('true');
    });

    it('should access array of errors via #errors', async () => {
      const err = new Error('Sub Error');
      const poison = runtime.createPoison(err, { lineno: 1, colno: 1 });

      const template = `
        {% if val is error %}
          {{ val#errors[0].message }}
        {% endif %}
      `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.contain('Sub Error');
    });

    it('should detect marker-backed lazy arrays with is error', async () => {
      const template = `
        {% set val = [ok(), bad()] %}
        {{ val is error }}
      `;
      const output = await env.renderTemplateString(template, {
        ok: async () => 'ok',
        bad: async () => {
          throw new Error('Lazy array failure');
        }
      });
      expect(output.trim()).to.be('true');
    });

    it('should peek marker-backed lazy arrays', async () => {
      const template = `
        {% set val = [ok(), bad()] %}
        {{ val#errors[0].message }}
      `;
      const output = await env.renderTemplateString(template, {
        ok: async () => 'ok',
        bad: async () => {
          throw new Error('Lazy array peek failure');
        }
      });
      expect(output.trim()).to.contain('Lazy array peek failure');
    });

    it('should parse variable# correctly', async () => {
      const err = new Error('Traiing hash');
      const poison = runtime.createPoison(err, { lineno: 1, colno: 1 });
      const template = `
          {% if val is error %}
             {% set errinfo = val# %}
             {{ errinfo.message }}
          {% endif %}
        `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.contain('Traiing hash');
    });

    it('should work with chained property access on peek result', async () => {
      const err = new Error('Detail Error');
      err.name = 'CustomName';
      const poison = runtime.createPoison(err, { lineno: 1, colno: 1 });

      const template = `
        {{ val#errors[0].name }}
      `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.contain('CustomName');
    });

    it('should return none for nested peek on a healthy error object', async () => {
      const err = new Error('Root');
      const poison = runtime.createPoison(err);

      const template = `
            {% set errObj = val# %}
            {% set doublePeek = errObj# %}
            {{ doublePeek == none }}
        `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.be('true');
    });

    it('should allow peeking in standard JS expressions', async () => {
      const err = new Error('Expr Error');
      const poison = runtime.createPoison(err);

      const template = `
        {% set err = val# %}
        {{ err.message }}
      `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.contain('Expr Error');
    });
  });

  describe('Peek Operator (#) in Script Mode', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should peek at errors in script block', async () => {
      const err = new Error('Script Error');
      const poison = runtime.createPoison(err);

      const script = `
        var result = {}
        if val is error
          var err = val#
          result.msg = err.message
        endif

        return result`;
      const data = await env.renderScriptString(script, { val: poison });
      expect(data.msg).to.equal('Script Error');
    });

    it('should handle peeking assignments', async () => {
      const err = new Error('Assignment Error');
      const poison = runtime.createPoison(err);

      const script = `
        var result = {}
        var errInfo = val#
        result.msg = errInfo.message

        return result`;
      const data = await env.renderScriptString(script, { val: poison });
      expect(data.msg).to.equal('Assignment Error');
    });

    it('should respect sequencing rules when peeking', async () => {
      // Create a scenario where we peek at a sequenced path
      const err = new Error('Sequence Error');
      const poison = runtime.createPoison(err);
      const context = {
        service: {
          action: () => poison
        }
      };

      const script = `
        var result = {}
        var resultVal = service.action()
        if resultVal is error
          var err = resultVal#
          result.peeked = err.message
        endif

        return result`;
      const data = await env.renderScriptString(script, context);
      expect(data.peeked).to.contain('Sequence Error');
    });

    it('should detect marker-backed lazy objects in script is error', async () => {
      const script = `
        var result = {}
        var val = { nested: bad() }
        result.isErr = val is error
        if result.isErr
          result.msg = val#errors[0].message
        endif
        return result`;

      const data = await env.renderScriptString(script, {
        bad: async () => {
          throw new Error('Lazy object script failure');
        }
      });
      expect(data.isErr).to.be(true);
      expect(data.msg).to.contain('Lazy object script failure');
    });
  });
})();
