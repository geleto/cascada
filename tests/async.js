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

  describe('Async mode', () => {
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
    it('should correctly resolve an async Promise variable', async () => {
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

        const result = await env.renderStringAsync(template, context);
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
            return id === 1 ? 'John Doe' : 'Jane Doe';
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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
        {%- set department = fetchDepartment(2) %}
        {%- set report = generateReport(user, department) %}
        {{ report }}
        `;

        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal(`
        Report for John Doe in IT
        `);
      });
    });
  });
}());
