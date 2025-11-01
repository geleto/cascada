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

  describe('Poisoning Tests', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should test for error', async () => {
      const p = Promise.reject(new Error('REJECTED'));
      const output = await env.renderTemplateString('{{ val is error }}', { val: p });
      expect(output).to.equal('true');
    });

    it('should test for error (negative case)', async () => {
      const p = Promise.resolve('hello');
      const output = await env.renderTemplateString('{{ val is error }}', {
        val: p
      });
      expect(output).to.equal('false');
    });

    it('should test for error (poisoned)', async () => {
      function CustomError(message) {
        this.name = 'CustomError';
        this.message = message;
      }
      CustomError.prototype = new Error();
      const err = new CustomError('test error');
      const p = runtime.createPoison(err, { lineno: 1, colno: 1 });

      const output = await env.renderTemplateString('{{ val is error }}', { val: p });
      expect(output).to.equal('true');
    });

    it('should test for error (non-error)', async () => {
      const output = await env.renderTemplateString('{{ val is error }}', {
        val: 'hello'
      });
      expect(output).to.equal('false');
    });

    it('should poison render if LHS of "is" is poisoned', async () => {
      const err = new Error('test error');
      const p = runtime.createPoison(err, { lineno: 1, colno: 1 });
      try {
        await env.renderTemplateString('{{ val is defined }}', { val: p });
        expect().fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.contain('test error');
      }
    });

    it('should poison render if RHS of "is" is poisoned', async () => {
      const p = Promise.reject(new Error('REJECTED'));
      try {
        await env.renderTemplateString('{{ 8 is divisibleby(val) }}', { val: p });
        expect().fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.contain('REJECTED');
      }
    });
  });
}());
