(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
  //var StringLoader;
  //var Environment;
  //var lexer;
  var delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    //Environment = require('../../src/environment/environment').Environment;
    //lexer = require('../../src/lexer');
    //unescape = require('he').unescape;
    //StringLoader = require('./pasync-loader');
    delay = require('../util').delay;
  } else {
    expect = window.expect;
    //unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
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
          incA: async () => { await delay(10); a++; },
          incB: async () => { await delay(10); b += 2; }
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

      it('should work with async functions in context', async () => {
        let called = false;
        const context = {
          asyncSideEffect: async () => { await delay(10); called = true; }
        };
        const template = `{% do asyncSideEffect() %}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('');
        expect(called).to.equal(true);
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

