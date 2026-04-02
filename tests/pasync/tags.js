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

    describe('"Extern" tag', () => {
      it('should initialize root externs from the render context', async () => {
        const result = await env.renderTemplateString('{% extern user %}{{ user }}', { user: 'Ava' });
        expect(result).to.equal('Ava');
      });

      it('should use extern fallbacks when no render value is provided', async () => {
        const result = await env.renderTemplateString('{% extern theme = "light" %}{{ theme }}', {});
        expect(result).to.equal('light');
      });

      it('should allow local mutation of initialized extern bindings', async () => {
        const result = await env.renderTemplateString('{% extern user %}{% set user = user ~ "!" %}{{ user }}', { user: 'Ava' });
        expect(result).to.equal('Ava!');
      });

      it('should fail clearly when a required extern is missing', async () => {
        try {
          await env.renderTemplateString('{% extern user %}{{ user }}', {});
          expect().fail('Expected missing extern validation to fail');
        } catch (err) {
          expect(err.message).to.contain('Missing required extern: user');
        }
      });

      it('should reject nested extern declarations before async lowering', async () => {
        try {
          await env.renderTemplateString('{% if true %}{% extern user %}{% endif %}', { user: 'Ava' });
          expect().fail('Expected nested extern validation to fail');
        } catch (err) {
          expect(err.message).to.contain('extern declarations are only allowed at the root scope');
        }
      });

      it('should expose externSpec on compiled async templates', () => {
        const tmpl = new AsyncTemplate('{% extern user %}{% extern theme = "light" %}', env);
        tmpl.compile();
        expect(tmpl.externSpec).to.eql([
          { names: ['user'], required: true, hasFallback: false },
          { names: ['theme'], required: false, hasFallback: true }
        ]);
      });

      it('should reject extern fallbacks that reference later externs', async () => {
        try {
          await env.renderTemplateString('{% extern a = b %}{% extern b = "later" %}{{ a }}', {});
          expect().fail('Expected later-extern dependency validation to fail');
        } catch (err) {
          expect(err.message).to.contain(`extern fallback for 'a' cannot reference later extern 'b'`);
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
