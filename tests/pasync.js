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

    describe('Loops', () => {
      // @todo - for else
      it('should correctly handle async functions inside a for loop', async () => {
        const context = {
          ids: [1, 2, 3],
          async fetchData(id) {
            await delay(7 - (2 * id));
            return `Data for ID ${id}`;
          }
        };

        const template = `
        {%- for id in ids %}
          - {{ fetchData(id) }}
        {%- endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          - Data for ID 1
          - Data for ID 2
          - Data for ID 3
        `);
      });

      it('should correctly resolve async functions with dependent arguments inside a for loop', async () => {
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
            await delay(7);
            return { id, name: 'John Doe' };
          },
          async fetchUserPosts(userId) {
            await delay(5);
            if (userId < 0 || userId >= userPosts.length) {
              throw new Error('User if out of range');
            }
            return userPosts[userId];
          }
        };

        const template = `
        {%- set user = fetchUser(1) %}
        User: {{ user.name }}
        Posts:
        {%- for post in fetchUserPosts(user.id) %}
          - {{ post.title }}: {{ post.content }}
        {%- endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
        User: John Doe
        Posts:
          - First post: Hello world!
          - Second post: Async is awesome!
        `);
      });

      it('should handle async functions inside a simple for loop', async () => {
        const context = {
          items: [1, 2, 3],
          async getData(id) {
            await delay(7 - (2 * id));
            return `Item ${id}`;
          }
        };

        const template = `
        {%- for item in items %}
          - {{ getData(item) }}
        {%- endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          - Item 1
          - Item 2
          - Item 3
        `);
      });

      it('should handle async functions with loop.index', async () => {
        const context = {
          items: ['a', 'b', 'c'],
          async transform(item, index) {
            await delay(5 - index);
            return `${item.toUpperCase()}-${index}`;
          }
        };

        const template = `
        {%- for item in items %}
          {{ transform(item, loop.index) }}
        {%- endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          A-1
          B-2
          C-3
        `);
      });

      it('should handle nested for loops with async functions', async () => {
        const context = {
          users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
          async getPosts(userId) {
            await delay(5);
            return [`Post 1 by User ${userId}`, `Post 2 by User ${userId}`];
          }
        };

        const template = `
        {%- for user in users %}
          {{ user.name }}:
          {%- for post in getPosts(user.id) %}
          - {{ post }}
          {%- endfor %}
        {%- endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          Alice:
          - Post 1 by User 1
          - Post 2 by User 1
          Bob:
          - Post 1 by User 2
          - Post 2 by User 2
        `);
      });

      it('should handle async functions in for...in...async loops', async () => {
        const context = {
          async getUsers() {
            await delay(5);
            return [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
          },
          async getRole(userId) {
            await delay(3);
            return userId === 1 ? 'Admin' : 'User';
          }
        };

        const template = `
        {%- for user in getUsers() %}
          {{ user.name }}: {{ getRole(user.id) }}
        {%- endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          Alice: Admin
          Bob: User
        `);
      });

      it('should handle async functions with loop variables', async () => {
        const context = {
          items: ['a', 'b', 'c'],
          async processItem(item, index, first, last) {
            await delay(7 - index);
            let result = `${item.toUpperCase()}-${index}`;
            if (first) result += ' (First)';
            if (last) result += ' (Last)';
            return result;
          }
        };

        const template = `
        {%- for item in items %}
          {{ processItem(item, loop.index, loop.first, loop.last) }}
        {%- endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          A-1 (First)
          B-2
          C-3 (Last)
        `);
      });

      it('should handle array unpacking with async function in loop body', async () => {
        const context = {
          users: [
            ['John', 30],
            ['Jane', 25],
            ['Bob', 35]
          ],
          async processUser(name, age) {
            await delay(age / 10);
            return `${name} is ${age} years old`;
          }
        };

        const template = `
        {%- for name, age in users %}
          {{ processUser(name, age) }}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          John is 30 years old
          Jane is 25 years old
          Bob is 35 years old`
        );
      });

      it('should handle object unpacking with async function in loop body', async () => {
        const context = {
          userAges: {
            John: 30,
            Jane: 25,
            Bob: 35
          },
          async formatUserAge(name, age) {
            await delay(age / 10);
            return `${name}: ${age} years`;
          }
        };

        const template = `
        {%- for name, age in userAges %}
          {{ formatUserAge(name, age) }}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          John: 30 years
          Jane: 25 years
          Bob: 35 years`
        );
      });

      it('should handle array unpacking with multiple async functions in loop body', async () => {
        const context = {
          employees: [
            ['John', 'IT'],
            ['Jane', 'HR'],
            ['Bob', 'Finance']
          ],
          async getTitle(department) {
            await delay(department.length);
            const titles = { IT: 'Engineer', HR: 'Manager', Finance: 'Analyst' };
            return titles[department] || 'Employee';
          },
          async formatEmployee(name, title) {
            await delay(name.length);
            return `${name} - ${title}`;
          }
        };

        const template = `
        {%- for name, dept in employees %}
          {{ formatEmployee(name, getTitle(dept)) }}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          John - Engineer
          Jane - Manager
          Bob - Analyst`
        );
      });

      it('should handle array unpacking with async function and conditional in loop body', async () => {
        const context = {
          users: [
            ['John', 'admin'],
            ['Jane', 'user'],
            ['Bob', 'moderator']
          ],
          async getUserPermissions(role) {
            await delay(role.length);
            const permissions = {
              admin: ['read', 'write', 'delete'],
              moderator: ['read', 'write'],
              user: ['read']
            };
            return permissions[role] || [];
          }
        };

        const template = `
        {%- for name, role in users %}
          {{ name }} :
          {%- set permissions = getUserPermissions(role) -%}
          {%- if 'write' in permissions -%}
            Can write
          {%- else -%}
            Cannot write
          {%- endif -%}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          John :Can write
          Jane :Cannot write
          Bob :Can write`
        );
      });

      it('should handle nested loops with unpacking and async functions', async () => {
        const context = {
          departments: {
            IT: [['John', 'developer'], ['Jane', 'designer']],
            HR: [['Bob', 'recruiter'], ['Alice', 'manager']]
          },
          async getEmployeeDetails(name, role) {
            await delay(name.length);
            return `${name} (${role})`;
          }
        };

        const template = `
        {%- for dept, employees in departments %}
          {{ dept }}:
          {%- for name, role in employees %}
            - {{ getEmployeeDetails(name, role) }}
          {%- endfor %}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          IT:
            - John (developer)
            - Jane (designer)
          HR:
            - Bob (recruiter)
            - Alice (manager)`
        );
      });

      it('should handle object iterations with nested async calls', async () => {
        const context = {
          data: {
            products: { milk: 2.99, bread: 1.99, eggs: 3.99 },
            async getDescription(item, price) {
              await delay(10);
              return `${item} costs $${price}`;
            }
          }
        };

        const template = `
        {%- for item, price in data.products %}
          {{ data.getDescription(item, price) }}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          milk costs $2.99
          bread costs $1.99
          eggs costs $3.99`);
      });

      it('should handle object iteration with async functions', async () => {
        const context = {
          inventory: {
            milk: 10,
            bread: 5,
            eggs: 0
          },
          async checkAvailability(item, quantity) {
            await delay(10);
            if (quantity === 0) {
              return `${item} - out of stock`;
            }
            return `${item} - ${quantity} in stock`;
          }
        };

        const template = `
        {%- for item, qty in inventory %}
          {{ checkAvailability(item, qty) }}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          milk - 10 in stock
          bread - 5 in stock
          eggs - out of stock`);
      });

      it('should handle object iteration with nested async calls and array unpacking', async () => {
        const context = {
          staffByDept: {
            IT: [['John', 'senior'], ['Jane', 'junior']],
            HR: [['Bob', 'manager'], ['Alice', 'intern']]
          },
          async getDeptSummary(dept, staff) {
            await delay(10);
            const details = await Promise.all(staff.map(async ([name, level]) => {
              await delay(5);
              return `${name} (${level})`;
            }));
            return `${dept}: ${details.join(', ')}`;
          }
        };

        const template = `
        {%- for dept, staff in staffByDept %}
          {{ getDeptSummary(dept, staff) }}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          IT: John (senior), Jane (junior)
          HR: Bob (manager), Alice (intern)`);
      });

      it('should handle iterating objects with promise values', async () => {
        const context = {
          async getInventory() {
            await delay(10);
            return {
              milk: Promise.resolve(10),
              bread: Promise.resolve(5)
            };
          },
          async format(item, qty) {
            await delay(5);
            return `${item}: ${qty}`;
          }
        };

        const template = `
        {%- for item, qty in getInventory() %}
          {{ format(item, qty) }}
        {%- endfor %}`;

        const result = await env.renderString(template, context);
        expect(result).to.equal(`
          milk: 10
          bread: 5`);
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

    describe('Async Functions in Expressions', () => {
      it('should handle async functions in filter expressions', async () => {
        env.addFilter('uppercase', async (str) => {
          await delay(5);
          return str.toUpperCase();
        });// note that this is not declared as async filter with
        // the regular callback method, it just returns a promise

        const context = {
          async uppercase(str) {
            await delay(5);
            return str.toUpperCase();
          }
        };
        const template = '{{ "hello" | uppercase }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('HELLO');
      });

      it('should handle async functions in if expressions', async () => {
        const context = {
          async isAdmin() {
            await delay(5);
            return true;
          }
        };
        const template = '{{ "Admin" if isAdmin() else "User" }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Admin');
      });

      it('should handle async values in "in" operator', async () => {
        const context = {
          list: (async () => {
            await delay(5);
            return [1, 2, 3];
          })(),
          item: (async () => {
            await delay(5);
            return 2;
          })()
        };

        const result = await env.renderString('{{ item in list }}', context);
        expect(result).to.equal('true');
      });

      it('should calculate power with async values', async () => {
        const context = {
          base: (async () => {
            await delay(5);
            return 2;
          })(),
          exp: (async () => {
            await delay(5);
            return 3;
          })()
        };

        const result = await env.renderString('{{ base ** exp }}', context);
        expect(result).to.equal('8');
      });

      it('should perform floor division with async values', async () => {
        const context = {
          dividend: (async () => {
            await delay(5);
            return 7;
          })(),
          divisor: (async () => {
            await delay(5);
            return 2;
          })()
        };

        const result = await env.renderString('{{ dividend // divisor }}', context);
        expect(result).to.equal('3');
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

    describe('Async Nunjucks Expressions', () => {
      it('should handle mixed parameter types in expressions', async () => {
        const context = {
          async textFunc() { await delay(10); return 'Hello'; },
          async numFunc() { await delay(6); return 42; },

          get asyncList() { return delay(8).then(() => [1, 2, 'three'].toString()); },
          get asyncObj() { return delay(2).then(() => ({a: 1, b: 2})); },

          staticFlag: true,
          regularFunc: () => 'Regular',
        };
        const template = `
          Async function (String): {{ textFunc() }}
          Async function (Number): {{ numFunc() }}
          Async getter (Array): {{ asyncList }}
          Async getter (Object): {{ asyncObj }}
          Static value: {{ staticFlag }}
          Regular function: {{ regularFunc() }}
          Inline value: {{ "Inline" }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`
          Async function (String): Hello
          Async function (Number): 42
          Async getter (Array): 1,2,three
          Async getter (Object): [object Object]
          Static value: true
          Regular function: Regular
          Inline value: Inline
        `.trim());
      });

      it('should handle mixed parameter types in math operations', async () => {
        const context = {
          async addAsync(a, b) { await delay(5); return a + b; },

          get asyncNum() { return delay(6).then(() => 5); },

          subtractSync: (a, b) => a - b,

          staticNum: 3,
        };
        const template = `
          Async function: {{ addAsync(2, 3) }}
          Async getter: {{ asyncNum }}
          Non-async function: {{ subtractSync(10, 5) }}
          Static value: {{ staticNum }}
          Mixed: {{ addAsync(asyncNum, subtractSync(staticNum, 1)) }}
          With inline: {{ addAsync(2, 3) + 5 }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`
          Async function: 5
          Async getter: 5
          Non-async function: 5
          Static value: 3
          Mixed: 7
          With inline: 10
        `.trim());
      });

      it('should handle mixed parameter types in comparisons and logic', async () => {
        const context = {
          async asyncGreaterThan(a, b) { await delay(10); return a > b; },

          get asyncX() { return delay(2).then(() => 5); },

          syncEqual: (a, b) => a === b,

          staticY: 10,
        };
        const template = `
          Async function: {{ asyncGreaterThan(staticY, asyncX) }}
          Async getter: {{ asyncX > 3 }}
          Non-async function: {{ syncEqual(asyncX, 5) }}
          Static value comparison: {{ staticY < 15 }}
          Mixed: {{ asyncGreaterThan(asyncX, 3) and syncEqual(staticY, 10) }}
          With inline: {{ asyncX > 3 and 7 < staticY }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`
          Async function: true
          Async getter: true
          Non-async function: true
          Static value comparison: true
          Mixed: true
          With inline: true
        `.trim());
      });

      it('should handle mixed parameter types in if expressions', async () => {
        const context = {
          async asyncTrue() { await delay(3); return true; },

          get asyncFalse() { return delay(2).then(() => false); },

          syncTrue: () => true,

          staticFalse: false,
        };
        const template = `
          Async function: {{ "yes" if asyncTrue() else "no" }}
          Async getter: {{ "yes" if asyncFalse else "no" }}
          Non-async function: {{ "yes" if syncTrue() else "no" }}
          Static value: {{ "yes" if staticFalse else "no" }}
          Mixed: {{ "yes" if (asyncTrue() and not staticFalse) else "no" }}
          With inline: {{ "yes" if (asyncTrue() and true) else "no" }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`
          Async function: yes
          Async getter: no
          Non-async function: yes
          Static value: no
          Mixed: yes
          With inline: yes
        `.trim());
      });

      it('should handle mixed parameter types in complex nested expressions', async () => {
        const context = {
          async fetchUsers() {
            await delay(5);
            return [
              { name: 'Alice', age: 30 },
              { name: 'Bob', age: 25 },
              { name: 'Charlie', age: 35 }
            ];
          },

          get asyncDiscount() { return delay(5).then(() => 0.1); },

          isAdult: (age) => age >= 18,

          adultAge: 18,
        };
        const template = `
          {% for user in fetchUsers() -%}
            {{ user.name }}: {{ ("Adult" if isAdult(user.age) else "Minor") }} (Age: {{ user.age }}, Discount: {{ (asyncDiscount * 100 if user.age > adultAge else 0) }}%)
          {% endfor %}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`
          Alice: Adult (Age: 30, Discount: 10%)
          Bob: Adult (Age: 25, Discount: 10%)
          Charlie: Adult (Age: 35, Discount: 10%)
        `.trim());
      });

      it('should handle simple arithmetic groups', async () => {
        const context = {
          async fetchNumber() { await delay(5); return 2; },
        };

        const template = `
          Result: {{ (1 + 2) * fetchNumber() }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Result: 6`)
      });

      it('should handle simple group with async values', async () => {
        const context = {
          fetchA: new Promise(resolve =>
            setTimeout(() => resolve(1), 3)
          ),
          fetchB: new Promise(resolve =>
            setTimeout(() => resolve(2), 5)
          )
        };

        const template = `
          Result: {{ (fetchA + fetchB) + 1 }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Result: 4`);
      });

      it('should handle groups with async and static values', async () => {
        const context = {
          async fetchValue() { await delay(5); return 10; },
          staticValue: 5,
        };

        const template = `
          Result: {{ (fetchValue() + staticValue) * 2 }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Result: 30`);
      });

      it('should handle groups with commas and operations', async () => {
        const context = {
          async fetchNumber() { await delay(5); return 3; },
          staticValue: 4,
        };

        const template = `
          Result: {{ (1 + fetchNumber(), staticValue, 5) + 1 }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Result: 6`);
      });

      //
      it('should handle nested groups with async dependencies', async () => {
        const context = {
          async fetchA() { await delay(3); return 1; },
          async fetchB() { await delay(5); return 2; },
          async fetchC() { await delay(7); return 3; },
        };

        const template = `
          Result: {{ ((fetchA() + fetchB()) * fetchC()) + 1 }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Result: 10`);
      });

      it('should handle groups in conditional logic', async () => {
        const context = {
          async fetchFlag() { await delay(3); return true; },
          staticValue: 5,
        };

        const template = `
          Result: {{ ("yes" if (fetchFlag() and staticValue > 3) else "no") }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Result: yes`);
      });

      it('should handle groups with commas and multiple values', async () => {
        const context = {
          async fetchValue() { await delay(5); return 4; },
          staticValue: 2,
        };

        const template = `
          Result: {{ (fetchValue(), staticValue, fetchValue() + staticValue) }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Result: 6`);
      });

      it('should handle errors inside groups gracefully', async () => {
        const context = {
          async fetchError() { throw new Error('Test group error'); },
          staticValue: 3,
        };

        const template = `Result: {{ (1 + fetchError(), staticValue + 2) }}`;
        try {
          await env.renderString(template, context);
          // If we reach this point, the test should fail
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error instanceof Error).to.equal(true);
          expect(error.message).to.contain('Test group error');
        }

      });

      it('should handle groups in loops', async () => {
        const context = {
          async fetchValues() {
            await delay(5);
            return [1, 2, 3];
          },
          async increment(x) {
            await delay(2);
            return x + 1;
          },
        };

        const template = `
          {% for val in fetchValues() %}
          Result: {{ (val, increment(val), val * 2) }}
          {%- endfor %}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`
          Result: 2
          Result: 4
          Result: 6
        `.trim());
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

    describe('For Loop with Else Tests', () => {
      it('should handle else in for loop with async empty array', async () => {
        const context = {
          async getItems() {
            await delay(5);
            return [];
          }
        };

        const template = `
          {% for item in getItems() %}
            {{ item }}
          {% else %}
            no items
          {% endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('no items');
      });

      it('should not execute else in for loop with async non-empty array', async () => {
        const context = {
          async getItems() {
            await delay(5);
            return ['a', 'b', 'c'];
          }
        };

        const template = `
          {%- for item in getItems() -%}
            {{ item }}
          {%- else -%}
            no items
          {%- endfor -%}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('abc');
      });

      it('should handle async values inside for-else loop body', async () => {
        const context = {
          async getItems() {
            await delay(5);
            return [];
          },
          async getEmptyMessage() {
            await delay(3);
            return 'The list is empty';
          }
        };

        const template = `
          {% for item in getItems() %}
            {{ item }}
          {% else %}
            {{ getEmptyMessage() }}
          {% endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('The list is empty');
      });

      it('should handle nested for-else loops with async values', async () => {
        const context = {
          async getOuterItems() {
            await delay(5);
            return ['a', 'b'];
          },
          async getInnerItems(outer) {
            await delay(3);
            return outer === 'a' ? ['1', '2'] : [];
          }
        };

        const template = `
          {% for outer in getOuterItems() %}
            {{ outer }}:
            {% for inner in getInnerItems(outer) %}
              {{ inner }}
            {% else %}
              empty
            {% endfor %}
          {% else %}
            no outer items
          {% endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim().replace(/\s+/g, ' ')).to.equal('a: 1 2 b: empty');
      });

      it('should handle errors in async for-else loops', async () => {
        const context = {
          async getItems() {
            await delay(5);
            throw new Error('Failed to get items');
          }
        };

        const template = `
          {% for item in getItems() %}
            {{ item }}
          {% else %}
            no items
          {% endfor %}
        `;

        try {
          await env.renderString(template, context);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Failed to get items');
        }
      });

      it('should handle async functions in loop and else conditions', async () => {
        const context = {
          items: [],
          async shouldShowItems() {
            await delay(5);
            return false;
          },
          async getEmptyMessage() {
            await delay(3);
            return 'No items to display';
          }
        };

        const template = `
          {% if shouldShowItems() %}
            {% for item in items %}
              {{ item }}
            {% else %}
              {{ getEmptyMessage() }}
            {% endfor %}
          {% else %}
            Items hidden
          {% endif %}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Items hidden');
      });

      it('should handle for-else with async filter in the loop sequence', async () => {
        env.addFilter('asyncFilter', (arr, callback) => {
          setTimeout(() => {
            callback(null, arr.filter(x => x > 2));
          }, 5);
        }, true);

        const context = {
          async getNumbers() {
            await delay(5);
            return [1, 2, 3, 4];
          }
        };

        const template = `
          {%- for num in getNumbers() | asyncFilter -%}
            {{ num }}
          {%- else -%}
            no numbers > 2
          {%- endfor -%}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('34');
      });
    });

    describe('Async Iterator Tests', () => {
      it('should correctly handle async iterators in a for loop', async () => {
        const context = {
          async *asyncGenerator() {
            for (let i = 1; i <= 3; i++) {
              await delay(5);
              yield i;
            }
          }
        };
        const template = `{%- for num in asyncGenerator() %} - Number {{ num }}
        {%- else %}
          No numbers
        {%- endfor %}`;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(
          '- Number 1 - Number 2 - Number 3'
        );
      });

      it('should execute else block when async iterator is empty', async () => {
        const context = {
          async *emptyAsyncGenerator() {
            // No items yielded
          }
        };
        const template = `{%- for item in emptyAsyncGenerator() %}
          - Item {{ item }}
        {%- else %}
          No items
        {%- endfor %}`;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('No items');
      });

      it('should correctly handle loop variables in async iterators', async () => {
        const context = {
          async *asyncGenerator() {
            for (let i = 1; i <= 3; i++) {
              await delay(5);
              yield i;
            }
          }
        };
        const template = `{%- for num in asyncGenerator() %} - Index: {{ loop.index }}, First: {{ loop.first }}, Last: {{ loop.last }}
        {%- endfor %}`;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(
          '- Index: 1, First: true, Last: false' +
          ' - Index: 2, First: false, Last: false' +
          ' - Index: 3, First: false, Last: true'
        );
      });

      it('should correctly handle nested async iterators', async () => {
        const context = {
          async *outerGenerator() {
            for (let i = 1; i <= 2; i++) {
              await delay(5);
              yield i;
            }
          },
          async *innerGenerator(num) {
            for (let j = 1; j <= num; j++) {
              await delay(5);
              yield j;
            }
          }
        };
        const template =
        `{%- for outer in outerGenerator() -%}
          >Outer {{ outer }}:
          {%- for inner in innerGenerator(outer) %} - Inner {{ inner }} {% endfor -%}
        {%- endfor %}`;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(
          `>Outer 1: - Inner 1 >Outer 2: - Inner 1  - Inner 2`
        );
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
