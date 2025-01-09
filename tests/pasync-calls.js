(function () {
  'use strict';

  var expect;
  //var unescape;
  var PAsyncEnvironment;
  //var Environment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    PAsyncEnvironment = require('../nunjucks/src/environment').PAsyncEnvironment;
    //Environment = require('../nunjucks/src/environment').Environment;
    //unescape = require('he').unescape;
  } else {
    expect = window.expect;
    //unescape = window.he.unescape;
    PAsyncEnvironment = nunjucks.PAsyncEnvironment;
    //Environment = nunjucks.Environment;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Async mode - calls and arguments', () => {
    let env;
    beforeEach(() => {
      env = new PAsyncEnvironment();
    });

    describe('Async Function Tests', () => {
      it('should correctly resolve an async function in output', async () => {
        const context = {
          async fetchUserName(id) {
            await delay(5);
            return 'John Doe';
          }
        };

        const template = 'User: {{ fetchUserName() }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('User: John Doe');
      });

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
        const result = await env.renderString(template, context);
        expect(result).to.equal('Current time is: 2024-09-12T17:12:123Z');
      });

      it('should correctly resolve an async Promise variable', async () => {
        const context = {
          weatherPromise: (async () => {
            await delay(5);
            return { temp: 22, condition: 'Sunny' };
          })()
        };

        const template = 'The weather is {{ weatherPromise.temp }}°C and {{ weatherPromise.condition }}.';
        const result = await env.renderString(template, context);
        expect(result).to.equal('The weather is 22°C and Sunny.');
      });

      it('should correctly resolve a dynamic function name', async () => {
        const context = {
          dynamicFunction: async (arg) => {
            await delay(5);
            return `Hello, ${arg}!`;
          },
          argPromise: (async () => {
            await delay(5);
            return 'World';
          })()
        };

        const template = '{{ dynamicFunction(argPromise) }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Hello, World!');
      });

      it('should correctly call a function with 2 async arguments', async () => {
        const context = {
          add: async (a, b) => {
            await delay(5);
            return a + b;
          },
          arg1: (async () => {
            await delay(5);
            return 3;
          })(),
          arg2: (async () => {
            await delay(5);
            return 7;
          })()
        };

        const template = '{{ add(arg1, arg2) }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('10');
      });

      it('should correctly call a function with 3 async arguments', async () => {
        const context = {
          multiplyAndAdd: async (a, b, c) => {
            await delay(5);
            return a * b + c;
          },
          arg1: (async () => {
            await delay(5);
            return 2;
          })(),
          arg2: (async () => {
            await delay(5);
            return 5;
          })(),
          arg3: (async () => {
            await delay(5);
            return 3;
          })()
        };

        const template = '{{ multiplyAndAdd(arg1, arg2, arg3) }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('13');
      });

      it('should correctly resolve an async function followed by member resolution in output', async () => {
        const context = {
          async fetchUser(id) {
            await delay(5);
            return { id, name: 'John Doe', email: 'john@example.com' };
          }
        };

        const template = 'User: {{ fetchUser(1).name }}';
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
        expect(result).to.equal('User: John Doe (john@example.com)');
      });

      it('should handle function calls with promise and async function arguments', async () => {
        const context = {
          // A regular function that expects resolved values
          processUserData(name, age, city) {
            return `${name} (${age}) from ${city}`;
          },

          // Returns a promise directly
          namePromise: Promise.resolve('John'),

          // An async function that returns age
          async getAge() {
            await delay(5);
            return 25;
          },

          // An async function that returns city
          async getLocation() {
            await delay(3);
            return 'New York';
          }
        };

        const template = '{{ processUserData(namePromise, getAge(), getLocation()) }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('John (25) from New York');
      });

      it('should handle async functions returning complex objects', async () => {
        const context = {
          async getUser() {
            await delay(5);
            return { name: 'John', roles: ['admin', 'user'] };
          }
        };
        const template = '{{ getUser().name }} is {{ getUser().roles[0] }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('John is admin');
      });

      it('should handle error propagation in async calls', async () => {
        const context = {
          async errorFunc() {
            await delay(5);
            throw new Error('Async error');
          }
        };
        const template = '{{ errorFunc() }}';

        let noError = false;
        try {
          await env.renderString(template, context);
          noError = true;
        } catch (error) {
          expect(error instanceof Error).to.equal(true);
          expect(error.message).to.contain('Async error');
        }
        expect(noError).to.equal(false);
      });

      it('should handle async function calls from variables', async () => {
        const context = {
          async greet(name) {
            await delay(5);
            return `Hello, ${name}!`;
          }
        };

        const template = '{% set myFunc = greet %}{{ myFunc("World") }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Hello, World!');
      });

      it('should handle function calls with async symbols', async () => {
        const context = {
          async fetchGreeting() {
            await delay(5);
            return (name) => `Hello, ${name}!`;
          }
        };

        const template = `
          {% set greetFunc = fetchGreeting() %}
          {{ greetFunc("World") }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hello, World!');
      });

    });

    describe('Dependent Async Functions', () => {
      // Test for dependent async functions (user and user's posts)
      it('should correctly resolve async functions with dependent arguments', async () => {
        const userPosts =
          [
            [
              { id: 1, title: 'User #0 first post', content: 'Hello from user 0!' },
            ],
            [
              { id: 1, title: 'First post', content: 'Hello world!' },
              { id: 2, title: 'Second post', content: 'Async is awesome!' }
            ]
          ];
        const context = {
          async fetchUser(id) {
            await delay(10);
            return { id, name: 'John Doe' };
          },
          async fetchUserPostsFirstTitle(userId) {
            await delay(5);
            if (userId < 0 || userId >= userPosts.length) {
              throw new Error('userId out of range');
            }
            return userPosts[userId][0].title;
          }
        };

        const template = `
          {%- set user = fetchUser(1) %}
          User: {{ user.name }}
          First title: {{ fetchUserPostsFirstTitle(user.id) }}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          User: John Doe
          First title: First post
        `);
      });

      it('should handle a chain of dependent async functions', async () => {
        const context = {
          async fetchUserId() {
            await delay(5);
            return 1;
          },
          async fetchUserName(id) {
            await delay(4);
            return id === 1 ? 'John Doe' : 'Marry Jane';
          },
          async fetchUserPosts(name) {
            await delay(3);
            return name === 'John Doe' ? ['Post 1', 'Post 2'] : ['Post A', 'Post B'];
          }
        };

        const template = `
          {%- set userId = fetchUserId() %}
          {%- set userName = fetchUserName(userId) %}
          {%- set userPosts = fetchUserPosts(userName) %}
          User: {{ userName }}
          Posts: {{ userPosts | join(', ') }}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          User: John Doe
          Posts: Post 1, Post 2
        `);
      });

      // New test: Complex dependent async functions
      it('should handle complex dependent async functions', async () => {
        const context = {
          async fetchUserId() {
            await delay(5);
            return 1;
          },
          async fetchUserName(id) {
            await delay(4);
            return id === 1 ? 'John Doe' : 'Jane Doe';
          },
          async fetchUserRole(name) {
            await delay(3);
            return name === 'John Doe' ? 'Admin' : 'User';
          },
          async fetchPermissions(role) {
            await delay(2);
            return role === 'Admin' ? ['read', 'write', 'delete'] : ['read'];
          }
        };

        const template = `
          {%- set userId = fetchUserId() %}
          {%- set userName = fetchUserName(userId) %}
          {%- set userRole = fetchUserRole(userName) %}
          {%- set permissions = fetchPermissions(userRole) %}
          User: {{ userName }}
          Role: {{ userRole }}
          Permissions: {{ permissions | join(', ') }}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          User: John Doe
          Role: Admin
          Permissions: read, write, delete
        `);
      });

      // New test: Handling async functions with multiple dependencies
      it('should handle async functions with multiple dependencies', async () => {
        const context = {
          async fetchUser(id) {
            await delay(5);
            return { id, name: 'John Doe' };
          },
          async fetchDepartment(id) {
            await delay(4);
            return { id, name: 'IT' };
          },
          async generateReport(user, department) {
            await delay(3);
            return `Report for ${user.name} in ${department.name}`;
          }
        };

        const template = `
          {%- set user = fetchUser(1) %}
          {%- set department = fetchDepartment(2) -%}
          {%- set report = generateReport(user, department) -%}
          {{ report }}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`Report for John Doe in IT`);
      });
    });

    describe('Parallel Argument Resolution', () => {
      it('should handle function calls with multiple async arguments resolved in parallel', async () => {
        const context = {
          async getFirst() {
            await delay(2);
            return 'First';
          },
          async getSecond() {
            await delay(1);
            return 'Second';
          },
          combine(a, b) {
            return `${a} and ${b}`;
          }
        };
        const template = '{{ combine(getFirst(), getSecond()) }}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('First and Second');
      });

      it('should handle macros where arguments are async and resolved in parallel', async () => {
        const context = {
          async getArg1() {
            await delay(2);
            return 'Arg1';
          },
          async getArg2() {
            await delay(1);
            return 'Arg2';
          }
        };
        const template = `
          {% macro combine(a, b) %}
            {{ a }} and {{ b }}
          {% endmacro %}
          {{ combine(getArg1(), getArg2()) }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Arg1 and Arg2');
      });

      it('should handle filters with multiple async arguments resolved', async () => {
        env.addFilter('append', async (base, ...args) => {
          await delay(2);
          return base + args.join('');
        });

        const context = {
          async getFirst() {
            await delay(2);
            return 'First';
          },
          async getSecond() {
            await delay(1);
            return 'Second';
          },
          async getThird() {
            await delay(3);
            return 'Third';
          }
        };
        const template = '{{ "Values: " | append(getFirst(), getSecond(), getThird()) }}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Values: FirstSecondThird');
      });

    });
  });
}());
