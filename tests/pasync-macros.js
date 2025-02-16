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

  describe('Async mode - macros', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Nunjucks Async Macro Handling Tests', () => {
      it('should handle async function passed as argument to macro', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'Alice';
          }
        };

        const template = `
        {%- macro greet(name) -%}
          Hello, {{ name }}!
        {%- endmacro -%}
        {{ greet(getName()) }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hello, Alice!');
      });

      it('should handle async function called within macro', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'Bob';
          }
        };

        const template = `
        {%- macro greet() -%}
          Hello, {{ getName() }}!
        {%- endmacro -%}
        {{ greet() }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hello, Bob!');
      });

      it('should handle macro using async variable from context', async () => {
        const context = {
          async greeting() {
            await delay(2);
            return 'Hi';
          },
          async name() {
            await delay(3);
            return 'Eve';
          }
        };

        const template = `
        {%- macro greet() -%}
          {{ greeting() }}, {{ name() }}!
        {%- endmacro -%}
        {{ greet() }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hi, Eve!');
      });

      it('should handle async logic inside macro', async () => {
        const context = {
          async getGreeting() {
            await delay(2);
            return 'Greetings';
          },
          async getName() {
            await delay(3);
            return 'Frank';
          }
        };

        const template = `
        {%- macro greet() -%}
          {{ getGreeting() }}, {{ getName() }}!
        {%- endmacro -%}
        {{ greet() }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Greetings, Frank!');
      });
    });

    describe('Async operations in macros', () => {
      it('should handle async functions in macro calls', async () => {
        const context = {
          async fetchTitle(id) {
            await delay(5);
            return id === 1 ? 'Hello' : 'World';
          }
        };
        const template = `
        {%- macro header(id) -%}
          H:{{ fetchTitle(id) }}
        {%- endmacro -%}
        {{ header(1) }} {{ header(2) }}`;
        const result = await env.renderString(template, context);
        expect(result).to.equal(`H:Hello H:World`);
      });

      it('should handle async functions in macro call arguments', async () => {
        const context = {
          async fetchTitle() {
            await delay(5);
            return 'Async Title';
          },
          async fetchContent() {
            await delay(3);
            return 'Async Content';
          }
        };

        const template = `
        {% macro article(title, content) %}
        <article>
          <h1>{{ title }}</h1>
          <p>{{ content }}</p>
        </article>
        {% endmacro %}

        {{ article(fetchTitle(), fetchContent()) }}
        `;

        const result = await env.renderString(template, context);
        expect(unescape(result.trim())).to.equal(`
        <article>
          <h1>Async Title</h1>
          <p>Async Content</p>
        </article>
        `.trim());
      });

      it('should handle async macro call arguments with dependent function in macro body', async () => {
        const context = {
          async fetchUser(id) {
            await delay(5);
            return { id, name: `User ${id}` };
          },
          async fetchUserPosts(userId) {
            await delay(3);
            return [`Post 1 by User ${userId}`, `Post 2 by User ${userId}`];
          }
        };

        const template = `
        {%- macro userProfile(user) -%}
        <div class="user-profile">
          <h2>{{ user.name }}</h2>
          <h3>Posts:</h3>
          <ul>
          {%- for post in fetchUserPosts(user.id) %}
            <li>{{ post }}</li>
          {%- endfor %}
          </ul>
        </div>
        {%- endmacro %}

        {{ userProfile(fetchUser(1)) }}
        `;

        const result = await env.renderString(template, context);
        expect(unescape(result.trim())).to.equal(`
        <div class="user-profile">
          <h2>User 1</h2>
          <h3>Posts:</h3>
          <ul>
            <li>Post 1 by User 1</li>
            <li>Post 2 by User 1</li>
          </ul>
        </div>
        `.trim());
      });

      it('should handle multiple async macro call arguments', async () => {
        const context = {
          async fetchHeader() {
            await delay(5);
            return 'Async Header';
          },
          async fetchFooter() {
            await delay(4);
            return 'Async Footer';
          },
          async fetchContent() {
            await delay(3);
            return 'Async Content';
          }
        };

        const template = `
        {% macro page(header, content, footer) %}
        <div class="page">
          <header>{{ header }}</header>
          <main>{{ content }}</main>
          <footer>{{ footer }}</footer>
        </div>
        {% endmacro %}

        {{ page(fetchHeader(), fetchContent(), fetchFooter()) }}
        `;

        const result = await env.renderString(template, context);
        expect(unescape(result.trim())).to.equal(`
        <div class="page">
          <header>Async Header</header>
          <main>Async Content</main>
          <footer>Async Footer</footer>
        </div>
        `.trim());
      });

      it('should handle nested async macro calls', async () => {
        const context = {
          async fetchUser(id) {
            await delay(5);
            return { id, name: `User ${id}` };
          },
          async fetchUserRole(userId) {
            await delay(3);
            return userId % 2 === 0 ? 'Admin' : 'User';
          }
        };

        const template = `
        {%- macro userRole(userId) -%}
        {{ fetchUserRole(userId) }}
        {%- endmacro -%}

        {%- macro userProfile(user) -%}
        <div class="user-profile">
          <h2>{{ user.name }}</h2>
          <p>Role: {{ userRole(user.id) }}</p>
        </div>
        {%- endmacro %}
        {{ userProfile(fetchUser(1)) }}
        {{ userProfile(fetchUser(2)) }}
        `;

        const result = await env.renderString(template, context);
        expect(unescape(result.trim())).to.equal(`
        <div class="user-profile">
          <h2>User 1</h2>
          <p>Role: User</p>
        </div>
        <div class="user-profile">
          <h2>User 2</h2>
          <p>Role: Admin</p>
        </div>
        `.trim());
      });
    });

    describe('Async Nunjucks Caller Functionality', () => {

      describe('Async Caller Basic Usage', () => {
        it('should handle async value in caller content', async () => {
          const template = `
          {% macro wrapper() %}
          {{ caller() }}
          {% endmacro %}

          {% call wrapper() %}
          {{ asyncValue }}
          {% endcall %}
        `;

          const context = {
            asyncValue: Promise.resolve('async result')
          };

          const rendered = await env.renderString(template, context);
          expect(rendered.trim()).to.equal('async result');
        });

        it('caller should work in ternary condition', async () => {
          const template = `
          {% macro add(x, y) %}
          {{ caller() if caller else 0 }}: {{ x + y }}
          {% endmacro%}

          {% call add(1, 2) -%}
          The result is
          {%- endcall %}
        `;

          const result = await env.renderString(template);
          expect(result.trim()).to.equal('The result is: 3');
        });

        it('should handle multiple async values in caller', async () => {
          const template = `
          {%- macro format() -%}
          Results: {{ caller() }}
          {%- endmacro -%}

          {%- call format() -%}
          {{ firstValue }}, {{ secondValue }}
          {%- endcall -%}
        `;

          const context = {
            firstValue: Promise.resolve('first'),
            secondValue: Promise.resolve('second')
          };

          const rendered = await env.renderString(template, context);
          expect(rendered.trim()).to.equal('Results: first, second');
        });
      });

      describe('Nested Async Callers', () => {
        it('should handle nested async callers', async () => {
          const template = `
          {%- macro outer() -%}
          Outer({{ caller() }})
          {%- endmacro -%}

          {%- macro inner() -%}
          Inner({{ caller() }})
          {%- endmacro -%}

          {%- call outer() -%}
          {%- call inner() -%}
            {{ asyncValue }}
          {%- endcall -%}
          {%- endcall -%}
        `;

          const context = {
            asyncValue: Promise.resolve('content')
          };

          const rendered = await env.renderString(template, context);
          expect(rendered.trim()).to.equal('Outer(Inner(content))');
        });
      });

      describe('Async Caller with Control Structures', () => {
        it('should handle async values in if conditions within caller', async () => {
          const template = `
          {% macro wrapper() %}
          {{ caller() }}
          {% endmacro %}

          {% call wrapper() %}
          {% if asyncCondition %}
            {{ asyncValue }}
          {% endif %}
          {% endcall %}
        `;

          const context = {
            asyncCondition: Promise.resolve(true),
            asyncValue: Promise.resolve('shown')
          };

          const rendered = await env.renderString(template, context);
          expect(rendered.trim()).to.equal('shown');
        });

        it('should handle async values in for loops within caller', async () => {
          const template = `
          {% macro wrapper() %}
          {{ caller() }}
          {% endmacro %}

          {% call wrapper() %}
          {% for item in asyncItems %}
            {{ item }}
          {% endfor %}
          {% endcall %}
        `;

          const context = {
            asyncItems: Promise.resolve(['a', 'b', 'c'])
          };

          const rendered = await env.renderString(template, context);
          expect(rendered.trim().replace(/\s+/g, ' ')).to.equal('a b c');
        });
      });

      describe('Async Caller with Macro Arguments', () => {
        it('should handle async values in macro arguments', async () => {
          const template = `
          {%- macro format(prefix) -%}
          {{ prefix }}: {{ caller() }}
          {%- endmacro -%}

          {%- call format(asyncPrefix) -%}
          {{ asyncContent }}
          {%- endcall -%}
        `;

          const context = {
            asyncPrefix: Promise.resolve('Result'),
            asyncContent: Promise.resolve('42')
          };

          const rendered = await env.renderString(template, context);
          expect(rendered.trim()).to.equal('Result: 42');
        });
      });

      describe('Async Caller Error Cases', () => {
        it('should properly handle rejected promises in caller content', async () => {
          const template = `
          {% macro wrapper() %}
          {{ caller() }}
          {% endmacro %}

          {% call wrapper() %}
          {{ getAsyncError() }}
          {% endcall %}
        `;

          const context = {
            //asyncError: Promise.reject(new Error('Async error'))
            async getAsyncError() {
              await delay(5);
              throw new Error('Async error');
            }
          };

          try {
            await env.renderString(template, context);
          } catch (error) {
            expect(error.message).to.contain('Async error');
          }
        });

        it('should handle async errors in nested callers', async () => {
          const template = `
          {% macro outer() %}
          {{ caller() }}
          {% endmacro %}

          {% macro inner() %}
          {{ caller() }}
          {% endmacro %}

          {% call outer() %}
          {% call inner() %}
            {{ asyncError }}
          {% endcall %}
          {% endcall %}
        `;

          const context = {
            asyncError: Promise.reject(new Error('Nested async error'))
          };

          try {
            await env.renderString(template, context);
          }
          catch (error) {
            expect(error.message).to.contain('Nested async error');
          }
        });
      });
    });
  });
})();
