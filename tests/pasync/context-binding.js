import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';

(function () {
  'use strict';

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
      loader.addTemplate('context-export-func-lib.njk', '{% macro callFunc(fn) %}{{ fn() }}{% endmacro %}');
      loader.addTemplate('context-export-func-main.njk', '{% import "context-export-func-lib.njk" as lib %}{{ lib.callFunc(myFunc) }}');

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
