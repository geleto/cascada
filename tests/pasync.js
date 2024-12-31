(function() {
  'use strict';

  var expect;
  var unescape;
  var AsyncEnvironment;
  //var Environment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../nunjucks/src/environment').AsyncEnvironment;
    //Environment = require('../nunjucks/src/environment').Environment;
    unescape = require('he').unescape;
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    //Environment = nunjucks.Environment;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Async mode', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Basic Async Rendering', () => {
      it('should correctly render a template with no context and async operations in async mode', async () => {
        const template = 'Hello World! 1 + 1 = {{ 1 + 1 }}';
        const result = await env.renderString(template);
        expect(result).to.equal('Hello World! 1 + 1 = 2');
      });

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
        const result = await env.renderString(template, context);
        expect(result).to.equal('Current time is: 2024-09-12T17:12:123Z');
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
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
        expect(result).to.equal('User: John Doe');
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

      it('should correctly resolve an async expression with set', async () => {
        const context = {
          async getValue(id) {
            await delay(5);
            return 1;
          }
        };

        const template = '{% set result = 1 + getValue() %}Result = {{ result }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Result = 2');
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
        {%- set department = fetchDepartment(2) %}
        {%- set report = generateReport(user, department) %}
        {{ report }}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
        Report for John Doe in IT
        `);
      });
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
        const result = await env.renderString(template, context);
        expect(result).to.equal('Admin');

        const template2 = '{% if isUserAdmin(2) %}Admin{% else %}Not admin{% endif %}';
        const result2 = await env.renderString(template2, context);
        expect(result2).to.equal('Not admin');
      });

      it('should handle async promise in if condition', async () => {
        const context = {
          userStatus: Promise.resolve('active')
        };

        const template = '{% if userStatus == "active" %}User is active{% else %}User is not active{% endif %}';
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
        expect(result).to.equal('Admin user');

        const template2 = `
        {%- if getUserRole(3) == "admin" -%}
          Admin user
        {%- elif getUserRole(2) == "moderator" -%}
          Moderator user
        {%- else -%}
          Regular user
        {%- endif -%}`;

        const result2 = await env.renderString(template2, context);
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

        const result = await env.renderString(template, context);
        expect(result).to.equal('Hello, Admin John!');

        const template2 = `
        {%- if isUserAdmin(2) -%}Hello, Admin {{ getUserName(2) }}!
        {%- else -%}Hello, User {{ getUserName(2) }}!
        {%- endif -%}`;

        const result2 = await env.renderString(template2, context);
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

        const result = await env.renderString(template, context);
        expect(result).to.equal('Inactive User');

        const template2 = `
          {%- if isUserActive(2) -%}
              {%- if getUserRole(2) == "admin" -%}Active Admin
              {%- else -%}Active User
              {%- endif -%}
          {%- else -%}Inactive User
          {%- endif -%}
          `;

        const result2 = await env.renderString(template2, context);
        expect(result2.trim()).to.equal('Active User');
      });
    });

    describe('Complex Async Scenarios', () => {
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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
          await env.renderString(template, context);
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
          await env.renderString(template, context);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Case expression error');
        }
      });
    });

    describe('Basic Set Tests', () => {
      it('should handle multiple targets with async expression', async () => {
        const context = {
          async getBase() {
            await delay(5);
            return 10;
          },
          async getMultiplier() {
            await delay(3);
            return 2;
          }
        };

        const template = `
          {% set x, y = getBase() * getMultiplier() %}
          {{ x }},{{ y }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('20,20');
      });

      it('should handle async values in set expressions with math operations', async () => {
        const context = {
          async getBase() {
            await delay(5);
            return 10;
          },
          async getMultiplier() {
            await delay(3);
            return 2;
          }
        };

        const template = `
          {% set result = getBase() * getMultiplier() + 5 %}
          {{ result }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('25');
      });

      it('should handle async values in set expressions with string operations', async () => {
        const context = {
          async getPrefix() {
            await delay(5);
            return 'Hello';
          },
          async getSuffix() {
            await delay(3);
            return 'World';
          }
        };

        const template = `
          {% set greeting = getPrefix() + ", " + getSuffix() + "!" %}
          {{ greeting }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hello, World!');
      });

      it('should handle async values in set expressions with comparisons', async () => {
        const context = {
          async getValue1() {
            await delay(5);
            return 10;
          },
          async getValue2() {
            await delay(3);
            return 20;
          }
        };

        const template = `
          {% set isGreater = getValue1() > getValue2() %}
          {{ isGreater }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('false');
      });

      it('should correctly resolve "is" operator with async left-hand side and arguments', async () => {
        const context = {
          testValue: (async () => {
            await delay(5);
            return 10;
          })(),
          testFunction: async (value, threshold) => {
            await delay(5);
            return value > threshold;
          },
          threshold: (async () => {
            await delay(5);
            return 5;
          })()
        };

        env.addTest('isGreaterThan', async (value, threshold) => {
          return await context.testFunction(value, threshold);
        });

        const template = '{% if testValue is isGreaterThan(threshold) %}Yes{% else %}No{% endif %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Yes');
      });

      it('should handle errors in async set expressions', async () => {
        const context = {
          async getValue() {
            await delay(5);
            throw new Error('Failed to get value');
          }
        };

        const template = `
          {% set result = getValue() * 2 %}
          {{ result }}
        `;

        try {
          await env.renderString(template, context);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Failed to get value');
        }
      });
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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
          await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
        expect(result.trim().replace(/\s+/g, ' ')).to.equal('Result: 20');
      });
    });

    describe('Async Functionality Tests', () => {
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

      describe('Binary Operations and Comparisons', () => {
        it('should perform addition with async operands resolved in parallel', async () => {
          const context = {
            async getNum1() {
              await delay(2);
              return 5;
            },
            async getNum2() {
              await delay(1);
              return 10;
            }
          };
          const template = '{{ getNum1() + getNum2() }}';
          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('15');
        });

        it('should handle comparisons where both sides are async expressions', async () => {
          const context = {
            async getValue1() {
              await delay(2);
              return 10;
            },
            async getValue2() {
              await delay(1);
              return 10;
            }
          };
          const template = '{% if getValue1() == getValue2() %}Equal{% else %}Not Equal{% endif %}';
          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('Equal');
        });

      });

      describe('Arrays, Dictionaries, and Nested Structures', () => {
        it('should handle arrays with elements resolved in parallel', async () => {
          const context = {
            async getItem1() {
              await delay(2);
              return 'Item1';
            },
            async getItem2() {
              await delay(1);
              return 'Item2';
            }
          };
          const template = '{% set myArray = [getItem1(), getItem2()] %}{{ myArray | join(", ") }}';
          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('Item1, Item2');
        });

        it('should handle dictionaries with values resolved in parallel', async () => {
          const context = {
            async getValue1() {
              await delay(2);
              return 'Value1';
            },
            async getValue2() {
              await delay(1);
              return 'Value2';
          }
          };
          const template = '{% set myDict = {"key1": getValue1(), "key2": getValue2()} %}{{ myDict["key1"] }}, {{ myDict["key2"] }}';
          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('Value1, Value2');
        });

        it('should handle nested arrays and dictionaries with async elements resolved in parallel', async () => {
          const context = {
            async getValueA() {
              await delay(3);
              return 'A';
            },
            async getValueB() {
              await delay(2);
              return 'B';
            },
            async getValueC() {
              await delay(1);
              return 'C';
            }
          };
          const template = `
            {%- set myData = {
              "list": [getValueA(), getValueB(), getValueC()],
              "dict": {
                "key1": getValueA(),
                "key2": getValueB(),
                "key3": getValueC()
              }
            } -%}
            List: {{ myData.list | join(", ") }}\nDict: {{ myData.dict.key1 }}, {{ myData.dict.key2 }}, {{ myData.dict.key3 }}
          `;
          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('List: A, B, C\nDict: A, B, C');
        });
      });
    });

    describe('Async Dictionary Template Operations', () => {

      it('should handle dictionary creation with async values in template', async () => {
        const context = {
          async getKetchupAmount() {
            await delay(5);
            return '5 tbsp';
          },
          async getMustardAmount() {
            await delay(3);
            return '1 tbsp';
          }
        };

        const template = `
          {%- set recipe = {
            ketchup: getKetchupAmount(),
            mustard: getMustardAmount(),
            pickle: '0 tbsp'
          } -%}
          {%- for ingredient, amount in recipe -%}
            {{ amount }} of {{ ingredient }}
          {%- endfor -%}
        `;
        const result = await env.renderString(template, context);
        expect(result).to.equal('5 tbsp of ketchup1 tbsp of mustard0 tbsp of pickle');
      });

      it('should handle array of dictionaries creation with async values', async () => {
        const context = {
          async getTitle1() {
            await delay(5);
            return 'foo';
          },
          async getTitle2() {
            await delay(3);
            return 'bar';
          }
        };

        const template = `
          {%- set items = [
            { title: getTitle1(), id: 1 },
            { title: getTitle2(), id: 2 }
          ] -%}
          {%- for item in items -%}
            {{ item.title }}:{{ item.id }}
          {%- endfor -%}
        `;
        const result = await env.renderString(template, context);
        expect(result).to.equal('foo:1bar:2');
      });

      it('should handle quoted string keys with async values', async () => {
        const context = {
          async getAmount1() {
            await delay(5);
            return '5 tbsp';
          },
          async getAmount2() {
            await delay(3);
            return '1 tbsp';
          }
        };

        const template = `
          {%- set recipe = {
            "ketchup": getAmount1(),
            'mustard': getAmount2(),
            pickle: '0 tbsp'
          } -%}
          {%- for ingredient, amount in recipe -%}
            {{ amount }} of {{ ingredient }}
          {%- endfor -%}
        `;
        const result = await env.renderString(template, context);
        expect(result).to.equal('5 tbsp of ketchup1 tbsp of mustard0 tbsp of pickle');
      });

    });

    describe('Function/keys/etc.. name stored in variable', () => {
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

      it('should handle async lookup keys', async () => {
        const context = {
          async getData() {
            await delay(5);
            return { theKey: 'value' };
          },
          async getKey() {
            await delay(5);
            return 'theKey';
          }
        };

        const template = '{% set key = getKey() %}{{ (getData())[key] }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('value');
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
  });
}());
