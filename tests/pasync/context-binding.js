(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var StringLoader;
  var path;
  var util;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    path = require('path');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    StringLoader = require('../util').StringLoader;
    util = require('../util');
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    StringLoader = window.util.StringLoader;
    // eslint-disable-next-line no-unused-vars
    path = {
      join: function () {
        return Array.prototype.join.call(arguments, '/');
      }
    };
    // eslint-disable-next-line no-unused-vars
    util = window.util;
  }

  describe('Async mode - context binding', function () {
    var env;
    beforeEach(function () {
      env = new AsyncEnvironment(new StringLoader());
    });

    it('should maintain correct context for global functions', async () => {
      env.addGlobal('myGlobal', function () {
        return this.lookup('foo');
      });
      const result = await env.renderTemplateString('{{ myGlobal() }}', { foo: 'bar' });
      expect(result).to.equal('bar');
    });

    it('should maintain correct context for data methods', async () => {
      const context = {
        foo: 'bar',
        myFunc: function () {
          return this.foo;
        }
      };
      const result = await env.renderTemplateString('{{ myFunc() }}', context);
      expect(result).to.equal('bar');
    });

    it('should maintain correct context for nested data methods', async () => {
      const context = {
        data: {
          foo: 'bar',
          myFunc: function () {
            return this.foo;
          }
        }
      };
      const result = await env.renderTemplateString('{{ data.myFunc() }}', context);
      expect(result).to.equal('bar');
    });

    it('should preserve this context for imported regular functions', async () => {
      var loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      loader.addTemplate('context-export-func-lib.njk', '{% set myExport = myFunc %}');
      loader.addTemplate('context-export-func-main.njk', '{% import "context-export-func-lib.njk" as lib with context %}{{ lib.myExport() }}');

      const myObj = {
        foo: 'bar',
        getFoo: function () {
          return this.foo;
        }
      };
      const context = {
        myFunc: myObj.getFoo.bind(myObj)
      };
      const result = await env.renderTemplate('context-export-func-main.njk', context);
      expect(result).to.equal('bar');
    });

    describe('Async Loop Context', function () {
      beforeEach(() => {
        env = new AsyncEnvironment(new StringLoader());
      });

      it('should have correct `this` context in async for loop', async () => {
        const context = {
          items: [1, 2],
          myMethod: function () {
            return this.items.length;
          }
        };
        const result = await env.renderTemplateString(
          '{% for item in items %}{{ myMethod() }}{% endfor %}',
          context
        );
        expect(result).to.equal('22');
      });

      it('should have correct `this` context in async while loop', async () => {
        const context = {
          i: 0,
          async shouldContinue() {
            this.i++;
            return this.i <= 2;
          },
          myMethod: function () {
            return 'method called';
          }
        };
        const result = await env.renderTemplateString(
          '{% while shouldContinue() %}{{ myMethod() }};{% endwhile %}',
          context
        );
        expect(result).to.equal('method called;method called;');
      });

      it('should have correct `this` context in else block of async for loop', async () => {
        const context = {
          items: [],
          myMethod: function () {
            return 'method called';
          }
        };
        const result = await env.renderTemplateString(
          '{% for item in items %}{{ item }}{% else %}{{ myMethod() }}{% endfor %}',
          context
        );
        expect(result).to.equal('method called');
      });
    });
  });
})();
