(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
  var AsyncTemplate;
  //var StringLoader;
  //var Environment;
  //var lexer;
  var delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    const envModule = require('../../src/environment/environment');
    AsyncEnvironment = envModule.AsyncEnvironment;
    AsyncTemplate = envModule.AsyncTemplate;
    //Environment = require('../../src/environment/environment').Environment;
    //lexer = require('../../src/lexer');
    //unescape = require('he').unescape;
    //StringLoader = require('./pasync-loader');
    delay = require('../util').delay;
  } else {
    expect = window.expect;
    //unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    AsyncTemplate = nunjucks.AsyncTemplate;
    //StringLoader = window.StringLoader;
    //Environment = nunjucks.Environment;
    //lexer = nunjucks.lexer;
    delay = window.util.delay;
  }

  describe('Async tags', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('compiled template metadata', () => {
      it('should not expose legacy blockContracts on compiled async templates', () => {
        const tmpl = new AsyncTemplate('{% block content(user) with context %}{{ user }}{% endblock %}', env);
        tmpl.compile();
        expect(tmpl).not.to.have.property('blockContracts');
      });
    });

    describe('reserved names', () => {
      it('should reject reserved async declaration name context for template vars', async () => {
        try {
          await env.renderTemplateString('{% set context = 1 %}{{ context }}', {});
          expect().fail('Expected reserved-name validation to fail');
        } catch (err) {
          expect(err.message).to.contain(`Identifier 'context' is reserved`);
        }
      });
    });

    describe('"Do" tag', () => {
      it('should evaluate a single expression for side effects', async () => {
        let called = false;
        const context = {
          sideEffect: () => { called = true; }
        };
        const template = `{% do sideEffect() %}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('');
        expect(called).to.equal(true);
      });

      it('should evaluate multiple expressions for side effects', async () => {
        let a = 0, b = 0;
        const context = {
          incA: () => { a++; },
          incB: () => { b += 2; }
        };
        const template = `{% do [incA(), incB()] %}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('');
        expect(a).to.equal(1);
        expect(b).to.equal(2);
      });

      it('should not output the result of the expression', async () => {
        const context = {
          return42: async () => { await delay(10); return 42; }
        };
        const template = `{% do return42() %}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('');
      });

      it('should fire async functions without waiting for completion (fire-and-forget)', async () => {
        let called = false;
        const context = {
          asyncSideEffect: async () => { await delay(10); called = true; }
        };
        const template = `{% do asyncSideEffect() %}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('');
        // do is fire-and-forget: async side effects may not complete before render returns
        expect(called).to.equal(false);
      });

      it('should allow do tag inside control structures', async () => {
        let called = false;
        const context = {
          sideEffect: () => { called = true; }
        };
        const template = `{% if true %}{% do sideEffect() %}{% endif %}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('');
        expect(called).to.equal(true);
      });
    });
  });
})();
