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

    // Test for async promise variable
    it.only('should correctly resolve an async Promise variable', async () => {
      const context = {
        weatherPromise: (async () => {
          await delay(5);
          return { temp: 22, condition: 'Sunny' };
        })()
      };

      const template = 'The weather is {{ weatherPromise.temp }}°C and {{ weatherPromise.condition }}.';
      const result = await env.renderStringAsync(template, context);
      expect(result).to.equal('The weather is 22°C and Sunny.');
    });

    // Test for async function
    it('should correctly resolve an async function in output', async () => {
      const context = {
        async fetchUserName(id) {
          await delay(5);
          return 'John Doe';
        }
      };

      const template = 'User: {{ fetchUserName() }}';
      const result = await env.renderStringAsync(template, context);
      expect(result).to.equal('User: John Doe');
    });

    it('should correctly resolve an async function followed by member resolution in output', async () => {
      const context = {
        async fetchUser(id) {
          await delay(5);
          return { id, name: 'John Doe', email: 'john@example.com' };
        }
      };

      const template = 'User: {{ fetchUser(1).name }}';
      const result = await env.renderStringAsync(template, context);
      expect(result).to.equal('User: John Doe');
    });

    it('should correctly resolve an async function with set', async () => {
      const context = {
        async fetchUser(id) {
          await delay(5);
          return { id, name: 'John Doe', email: 'john@example.com' };
        }
      };

      const template = '{% set user = fetchUser(1) %}User: {{ user.name }} ({{ user.email }})';
      const result = await env.renderStringAsync(template, context);
      expect(result).to.equal('User: John Doe (john@example.com)');
    });
  });
}());
