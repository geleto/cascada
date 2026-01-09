(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var runtime;
  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    runtime = require('../../src/runtime/runtime');
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
          {{ val#message }}
        {% endif %}
      `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.contain('Basic Error');
    });

    it('should peek at a rejected Promise', async () => {
      const p = Promise.reject(new Error('Async Fail'));

      const template = `
        {% if val is error %}
          {{ val#message }}
        {% endif %}
      `;
      const output = await env.renderTemplateString(template, { val: p });
      expect(output.trim()).to.contain('Async Fail');
    });

    it('should return poison when peeking at a healthy value', async () => {
      const template = `
        {% set val = "healthy" %}
        {% set peeked = val#message %}
        {{ peeked is error }}
      `;
      // The peek itself shouldn't throw, but return a PoisonedValue
      const output = await env.renderTemplateString(template);
      expect(output.trim()).to.contain('true');
    });

    it('should return poison when peeking at a healthy Promise', async () => {
      const p = Promise.resolve('healthy');
      const template = `
        {% set peeked = val#message %}
        {{ peeked is error }}
      `;
      const output = await env.renderTemplateString(template, { val: p });
      expect(output.trim()).to.contain('true');
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

    it('should handle nested peek (peeking at the result of a peek if it is an error)', async () => {
      // Technically peeking at an Error Value (returned by peek) isn't peeking at a Poison,
      // passing a raw object to peek# shouldn't crash but might return poison if the object isn't poison or promise.
      // But let's check normal behavior:
      // val# returns a PoisonError object (which is just an object, not a PoisonedValue).
      // So val## -> peeking at a plain object -> returns Poison (because it's healthy).

      const err = new Error('Root');
      const poison = runtime.createPoison(err);

      const template = `
            {% set errObj = val# %}
            {% set doublePeek = errObj# %}
            {{ doublePeek is error }}
        `;
      const output = await env.renderTemplateString(template, { val: poison });
      expect(output.trim()).to.contain('true');
    });

    it('should allow peeking in standard JS expressions', async () => {
      const err = new Error('Expr Error');
      const poison = runtime.createPoison(err);

      const template = `
        {{ val#message }}
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
        :data
        if val is error
          @data.msg = val#message
        endif
      `;
      const data = await env.renderScriptString(script, { val: poison });
      expect(data.msg).to.equal('Script Error');
    });

    it('should handle peeking assignments', async () => {
      const err = new Error('Assignment Error');
      const poison = runtime.createPoison(err);

      const script = `
        :data
        var errInfo = val#
        @data.msg = errInfo.message
      `;
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
        :data
        var result = service.action()
        if result is error
          @data.peeked = result#message
        endif
      `;
      const data = await env.renderScriptString(script, context);
      expect(data.peeked).to.equal('Sequence Error');
    });
  });
})();
