(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
  var delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../src/environment').AsyncEnvironment;
    //Environment = require('../src/environment').Environment;
    //unescape = require('he').unescape;
    delay = require('./util').delay;
  } else {
    expect = window.expect;
    //unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    //Environment = nunjucks.Environment;
    delay = window.util.delay;
  }

  describe('Async mode - if and switch', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Conditional Statements', () => {
      it('should handle async function in if condition', async () => {
        const context = {
          async isUserAdmin(id) {
            await delay(5 - id);
            return id === 1;
          }
        };

        const template = '{% if isUserAdmin(1) %}Admin{% else %}Not admin{% endif %}';
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('Admin');

        const template2 = '{% if isUserAdmin(2) %}Admin{% else %}Not admin{% endif %}';
        const result2 = await env.renderTemplateString(template2, context);
        expect(result2).to.equal('Not admin');
      });

      it('should handle async promise in if condition', async () => {
        const context = {
          userStatus: Promise.resolve('active')
        };

        const template = '{% if userStatus == "active" %}User is active{% else %}User is not active{% endif %}';
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('User is active');
      });

      it('should correctly resolve multiple async compare operations', async () => {
        const context = {
          value1: (async () => {
            await delay(5);
            return 5;
          })(),
          value2: (async () => {
            await delay(5);
            return 10;
          })(),
          value3: (async () => {
            await delay(5);
            return 15;
          })()
        };

        const template = '{% if value1 < value2 < value3 %}Yes{% else %}No{% endif %}';
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('Yes');
      });

      it('should handle multiple async conditions in if/else if/else', async () => {
        const context = {
          async getUserRole(id) {
            await delay(5 - id);
            if (id === 1) return 'admin';
            if (id === 2) return 'moderator';
            return 'user';
          }
        };

        const template = `
		  {%- if getUserRole(1) == "admin" -%}Admin user
		  {%- elif getUserRole(2) == "moderator" -%}Moderator user
		  {%- else -%}Regular user
		  {%- endif -%}`;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('Admin user');

        const template2 = `
		  {%- if getUserRole(3) == "admin" -%}
			Admin user
		  {%- elif getUserRole(2) == "moderator" -%}
			Moderator user
		  {%- else -%}
			Regular user
		  {%- endif -%}`;

        const result2 = await env.renderTemplateString(template2, context);
        expect(result2).to.equal('Moderator user');
      });

      it('should handle async functions inside if blocks', async () => {
        const context = {
          async isUserAdmin(id) {
            await delay(5 - id);
            return id === 1;
          },
          async getUserName(id) {
            await delay(5 - id);
            return id === 1 ? 'John' : 'Jane';
          }
        };

        const template = `
		  {%- if isUserAdmin(1) -%}Hello, Admin {{ getUserName(1) }}!
		  {%- else -%}Hello, User {{ getUserName(2) }}!
		  {%- endif -%}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('Hello, Admin John!');

        const template2 = `
		  {%- if isUserAdmin(2) -%}Hello, Admin {{ getUserName(2) }}!
		  {%- else -%}Hello, User {{ getUserName(2) }}!
		  {%- endif -%}`;

        const result2 = await env.renderTemplateString(template2, context);
        expect(result2).to.equal('Hello, User Jane!');
      });

      it('should handle nested if statements with async functions', async () => {
        const context = {
          async isUserActive(id) {
            await delay(5);
            return id % 2 === 0;
          },
          async getUserRole(id) {
            await delay(3);
            return id === 1 ? 'admin' : 'user';
          }
        };

        const template = `
			{%- if isUserActive(1) -%}
				{%- if getUserRole(1) == "admin" -%}Active Admin
				{%- else -%}Active User
				{%- endif -%}
			{%- else -%}Inactive User
			{%- endif -%}
			`;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('Inactive User');

        const template2 = `
			{%- if isUserActive(2) -%}
				{%- if getUserRole(2) == "admin" -%}Active Admin
				{%- else -%}Active User
				{%- endif -%}
			{%- else -%}Inactive User
			{%- endif -%}
			`;

        const result2 = await env.renderTemplateString(template2, context);
        expect(result2.trim()).to.equal('Active User');
      });
    });

    describe('Async Switch Statement Tests', () => {

      // Basic switch functionality
      it('should handle basic switch with async switch value', async () => {
        const context = {
          async getValue() {
            await delay(5);
            return 'B';
          }
        };

        const template = `
			{% switch getValue() %}
			  {% case 'A' %}
				Alpha
			  {% case 'B' %}
				Beta
			  {% case 'C' %}
				Charlie
			  {% default %}
				Unknown
			{% endswitch %}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Beta');
      });

      // Test multiple matching cases
      it('should execute first matching case with async values', async () => {
        const context = {
          async getValue() {
            await delay(5);
            return 'B';
          },
          async getCaseValue() {
            await delay(3);
            return 'B';
          }
        };

        const template = `
			{% switch getValue() %}
			  {% case 'A' %}
				Alpha
			  {% case getCaseValue() %}
				First B
			  {% case 'B' %}
				Second B
			  {% default %}
				Unknown
			{% endswitch %}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('First B');
      });

      // Test default case
      it('should execute default case when no match found with async values', async () => {
        const context = {
          async getValue() {
            await delay(5);
            return 'X';
          }
        };

        const template = `
			{% switch getValue() %}
			  {% case 'A' %}
				Alpha
			  {% case 'B' %}
				Beta
			  {% default %}
				No match
			{% endswitch %}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('No match');
      });

      // Test async content in case blocks
      it('should handle async content within case blocks', async () => {
        const context = {
          switchValue: 'A',
          async getContent() {
            await delay(5);
            return 'Dynamic Content';
          }
        };

        const template = `
			{% switch switchValue %}
			  {% case 'A' %}
				{{ getContent() }}
			  {% case 'B' %}
				Static Content
			  {% default %}
				Default Content
			{% endswitch %}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Dynamic Content');
      });

      // Test nested structures
      it('should handle switch inside loops with async values', async () => {
        const context = {
          async getItems() {
            await delay(5);
            return ['A', 'B', 'C'];
          },
          async getValue(item) {
            await delay(3);
            return item;
          }
        };

        const template = `
			{%- for item in getItems() -%}
			  {%- switch getValue(item) -%}
				{%- case 'A' -%}A{%- case 'B' %}B{% case 'C' %}C{% default -%}X
			  {%- endswitch -%}
			{%- endfor -%}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('ABC');
      });

      // Test switch inside switch
      it('should handle nested switch statements with async values', async () => {
        const context = {
          async getOuter() {
            await delay(5);
            return 'A';
          },
          async getInner() {
            await delay(3);
            return '1';
          }
        };

        const template = `
			{%- switch getOuter() -%}
			  {%- case 'A' -%}
				Outer A:
				{%- switch getInner() -%}
				  {%- case '1' -%}Inner 1{%- case '2' -%}Inner 2{%- default -%}Inner D
				{%- endswitch -%}
			  {%- case 'B' -%}
				Outer B
			  {%- default -%}
				Outer D
			{%- endswitch -%}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Outer A:Inner 1');
      });

      // Test async case expressions
      it('should handle async expressions in case statements', async () => {
        const context = {
          value: 'test',
          async getCaseValue1() {
            await delay(5);
            return 'test';
          },
          async getCaseValue2() {
            await delay(3);
            return 'other';
          }
        };

        const template = `
			{% switch value %}
			  {% case getCaseValue1() %}
				Match 1
			  {% case getCaseValue2() %}
				Match 2
			  {% default %}
				No Match
			{% endswitch %}
		  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Match 1');
      });

      // Test error handling
      it('should handle errors in async switch expressions', async () => {
        const context = {
          async getValue() {
            await delay(5);
            throw new Error('Switch expression error');
          }
        };

        const template = `
			{% switch getValue() %}
			  {% case 'A' %}Alpha{% default %}Default
			{% endswitch %}
		  `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Switch expression error');
        }
      });

      // Test error handling in case expressions
      it('should handle errors in async case expressions', async () => {
        const context = {
          value: 'test',
          async getCaseValue() {
            await delay(5);
            throw new Error('Case expression error');
          }
        };

        const template = `
			{% switch value %}
			  {% case getCaseValue() %}Match{% default %}Default
			{% endswitch %}
		  `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Case expression error');
        }
      });
    });

  });
}());
