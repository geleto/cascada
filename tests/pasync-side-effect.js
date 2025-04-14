(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
  //var Environment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../nunjucks/src/environment').AsyncEnvironment;
    //Environment = require('../nunjucks/src/environment').Environment;
    //unescape = require('he').unescape;
  } else {
    expect = window.expect;
    //unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    //Environment = nunjucks.Environment;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Side effects', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Side effects - variables', () => {

      it('Should not wait resolution for unused variable inside loop', async () => {
        const context = {
          items: ['a', 'b'],
          logs: [],
          async log(item) {
            await delay(10);
            context.logs.push(`Logged ${item}`); // Side effect
            return true;
          },
        };
        const template = `
            {%- for item in items -%}
                {% set _logged = log(item) %}
            {%- endfor -%}`;
        await env.renderString(template, context);
        // Verify side effect order confirms sequential execution
        expect(context.logs).to.eql([]);
      });
    }); // End Side effects
  });
})();
