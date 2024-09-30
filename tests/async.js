(function() {
  'use strict';

  var expect;
  var Environment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    Environment = require('../nunjucks/src/environment').Environment;
  } else {
    expect = window.expect;
    Environment = nunjucks.Environment;
  }

  describe('Async env', () => {
    let env;
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    beforeEach(() => {
      env = new Environment();
    });
    describe('Basic Async Rendering', () => {
      // Test for async getter
      it('should correctly render an async getter', async () => {
        const context = {
          get currentTime() {
            return (async () => {
              await delay(5);
              return '2024-09-12T17:12:123Z';
            })();
          }
        };

        const template = 'Current time is: {{ currentTime }}';
        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('Current time is: 2024-09-12T17:12:123Z');
      });
    });
  });
}());
