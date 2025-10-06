(function() {
  'use strict';

  var expect;
  var unescape;
  var AsyncEnvironment;
  var delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    //Environment = require('../../src/environment').Environment;
    unescape = require('he').unescape;
    delay = require('../util').delay;
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    //Environment = nunjucks.Environment;
    delay = window.util.delay;
  }

  describe('Async mode', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Async Set Block Tests', () => {
      // Basic set block functionality
      it('should handle basic set block with async content', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'John';
          }
        };

        const template = `
          {% set greeting %}
            Hello, {{ getName() }}!
            Welcome to our site.
          {% endset %}
          {{ greeting }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Hello, John!\n            Welcome to our site.');
      });

      // Multiple async values in set block
      it('should handle multiple async values in set block', async () => {
        const context = {
          async getFirstName() {
            await delay(5);
            return 'John';
          },
          async getLastName() {
            await delay(3);
            return 'Doe';
          }
        };

        const template = `
          {% set userInfo %}
            First Name: {{ getFirstName() }}
            Last Name: {{ getLastName() }}
          {% endset %}
          {{ userInfo }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('First Name: John\n            Last Name: Doe');
      });

      // Nested set blocks
      it('should handle nested set blocks with async content', async () => {
        const context = {
          async getHeader() {
            await delay(5);
            return 'Welcome';
          },
          async getFooter() {
            await delay(3);
            return 'Goodbye';
          }
        };

        const template = `
          {% set outer %}
            {% set inner %}
              {{ getHeader() }}
            {% endset %}
            {{ inner }}
            {% set footer %}
              {{ getFooter() }}
            {% endset %}
            {{ footer }}
          {% endset %}
          {{ outer }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim().replace(/\s+/g, ' ')).to.equal('Welcome Goodbye');
      });

      // Set block with control structures
      it('should handle set block with async values in control structures', async () => {
        const context = {
          async getUsers() {
            await delay(5);
            return ['Alice', 'Bob', 'Charlie'];
          },
          async getStatus(user) {
            await delay(3);
            return user === 'Alice' ? 'admin' : 'user';
          }
        };

        const template = `
          {% set userList %}
            {% for user in getUsers() %}
              {{ user }}: {{ getStatus(user) }}
            {% endfor %}
          {% endset %}
          {{ userList }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim().replace(/\s+/g, ' ')).to.equal('Alice: admin Bob: user Charlie: user');
      });

      // Set block with macros
      it('should handle set block with async values in macros', async () => {
        const context = {
          async getTitle() {
            await delay(5);
            return 'Welcome';
          }
        };

        const template = `
          {% macro header(title) %}
            <h1>{{ title }}</h1>
          {% endmacro %}

          {% set pageHeader %}
            {{ header(getTitle()) }}
          {% endset %}
          {{ pageHeader }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(unescape(result.trim())).to.equal('<h1>Welcome</h1>');
      });

      // Set block with filters
      it('should handle set block with async filters', async () => {
        env.addFilter('uppercase', async (str) => {
          await delay(5);
          return str.toUpperCase();
        });

        const context = {
          async getName() {
            await delay(3);
            return 'john';
          }
        };

        const template = `
          {% set greeting %}
            Hello, {{ getName() | uppercase }}!
          {% endset %}
          {{ greeting }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Hello, JOHN!');
      });

      // Error handling in set blocks
      it('should handle errors in async content within set blocks', async () => {
        const context = {
          async getName() {
            await delay(5);
            throw new Error('Failed to get name');
          }
        };

        const template = `
          {% set greeting %}
            Hello, {{ getName() }}!
          {% endset %}
          {{ greeting }}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Failed to get name');
        }
      });

      // Complex nested structures
      it('should handle complex nested structures with set blocks and async values', async () => {
        const context = {
          async getUsers() {
            await delay(5);
            return [
              { name: 'Alice', role: 'admin' },
              { name: 'Bob', role: 'user' }
            ];
          },
          async getPermissions(role) {
            await delay(3);
            return role === 'admin' ? ['read', 'write'] : ['read'];
          }
        };

        const template = `
          {% set userList %}
            {% for user in getUsers() %}
              {% set permissions %}
                {% for perm in getPermissions(user.role) %}
                  {{ perm }}
                {% endfor %}
              {% endset %}
              {{ user.name }}: {{ permissions }}
            {% endfor %}
          {% endset %}
          {{ userList }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim().replace(/\s+/g, ' ')).to.equal('Alice: read write Bob: read');
      });

      // Set block with async expressions
      it('should handle set block with async expressions', async () => {
        const context = {
          async getValue() {
            await delay(5);
            return 10;
          },
          async getMultiplier() {
            await delay(3);
            return 2;
          }
        };

        const template = `
          {% set calculation %}
            {{ getValue() * getMultiplier() }}
          {% endset %}
          Result: {{ calculation }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim().replace(/\s+/g, ' ')).to.equal('Result: 20');
      });
    });
  });
}());
