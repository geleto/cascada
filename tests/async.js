(function() {
  'use strict';

  var expect;
  var unescape;
  var AsyncEnvironment;
  var Environment;
  var lexer;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../nunjucks/src/environment').AsyncEnvironment;
    Environment = require('../nunjucks/src/environment').Environment;
    lexer = require('../nunjucks/src/lexer');
    unescape = require('he').unescape;
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    Environment = nunjucks.Environment;
    lexer = nunjucks.lexer;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  class StringLoader {
    constructor() {
      this.templates = new Map();
    }

    getSource(name) {
      if (!this.templates.has(name)) {
        return null;// return null rather than throw an error so that ignore missing works
      }

      return {
        src: this.templates.get(name),
        path: name,
        noCache: false
      };
    }

    addTemplate(name, content) {
      this.templates.set(name, content);
    }
  }


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

    describe('Include async tests', () => {
      let loader;

      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      it('should handle async functions in include statements', async () => {
        const context = {
          async getTemplateName() {
            await delay(5);
            return 'greeting.njk';
          },
          name: 'World'
        };

        const greetingTemplate = 'Hello, {{ name }}!';
        loader.addTemplate('greeting.njk', greetingTemplate);

        const mainTemplate = '{% include getTemplateName() %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
        expect(result).to.equal('Hello, World!');
      });

      it('should handle async functions in includeed template', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'World';
          },
          async getPlace() {
            await delay(3);
            return 'London';
          }
        };

        const greetingTemplate = 'Hello, {{ getName() }}, welcome to';
        loader.addTemplate('greeting.njk', greetingTemplate);

        const mainTemplate = '{% include "greeting.njk" %} {{ getPlace() }}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
        expect(result).to.equal('Hello, World, welcome to London');
      });

      it('should handle nested includes with async functions', async () => {
        const context = {
          async getUser() {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { name: 'John', role: 'admin' };
          }
        };

        const userTemplate = '{{ getUser().name }} ({{ getUser().role }})';
        loader.addTemplate('user.njk', userTemplate);

        const greetingTemplate = 'Welcome, {% include "user.njk" %}!';
        loader.addTemplate('greeting.njk', greetingTemplate);

        const mainTemplate = 'Hello! {% include "greeting.njk" %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
        expect(result).to.equal('Hello! Welcome, John (admin)!');
      });

      it('should handle async functions in included template using frame variables', async () => {
        const context = {
          async getUserInfo(id) {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { name: `User ${id}`, role: id % 2 === 0 ? 'admin' : 'user' };
          }
        };

        const userTemplate = '{% set user = getUserInfo(userId) %}{{ user.name }} ({{ user.role }})';
        loader.addTemplate('user.njk', userTemplate);

        const mainTemplate = '{% set userId = 1 %}{% include "user.njk" %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
        expect(result).to.equal('User 1 (user)');
      });

      it('should handle async functions in included template using for loop variables', async () => {
        const context = {
          getUserInfo(id) {
            // await new Promise(resolve => setTimeout(resolve, 50));
            return { name: `User ${id}`, role: id % 2 === 0 ? 'admin' : 'user' };
          }
        };

        const userTemplate = '{% set user = getUserInfo(userId) %}{{ user.name }} ({{ user.role }})';
        loader.addTemplate('user.njk', userTemplate);

        const mainTemplate = '{%- for userId in [1, 2] -%}{% include "user.njk" %}\n{% endfor -%}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
        expect(result).to.equal('User 1 (user)\nUser 2 (admin)\n');
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

    describe('Async Block Tag Tests', () => {
      let loader;
      beforeEach(() => {;
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      it('should render a simple block with async content', async () => {
        const context = {
          async getMessage() {
            await delay(1);
            return 'Hello, World!';
          }
        };
        const template = '{% block content %}{{ getMessage() }}{% endblock %}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hello, World!');
      });

      /*it('should handle template inheritance with blocks and async content - non-async', (done) => {
        const context = {
          getContent() {
            return 'Async Child Content';
          }
        };
        let senv = new Environment(loader);

        loader.addTemplate('base.njk', '<div>{% block content %}Base Content{% endblock %}</div>');
        const childTemplate = '{% extends "base.njk" %}{% block content %}{{ getContent() }}{% endblock %}';
        senv.renderString(childTemplate, context, function(err, result){
          expect(result.trim()).to.equal('<div>Async Child Content</div>');
          done();
        });
      });*/

      it('should handle template inheritance with blocks and async content', async () => {
        const context = {
          async getContent() {
            await delay(1);
            return 'Async Child Content';
          }
        };
        loader.addTemplate('base.njk', '<div>{% block content %}Base Content{% endblock %}</div>');
        const childTemplate = '{% extends "base.njk" %}{% block content %}{{ getContent() }}{% endblock %}';
        const result = await env.renderString(childTemplate, context);
        expect(result.trim()).to.equal('<div>Async Child Content</div>');
      });

      it('should handle nested blocks with async content', async () => {
        const context = {
          async getOuter() {
            await delay(2);
            return 'Async Outer';
          },
          async getInner() {
            await delay(1);
            return 'Async Inner';
          }
        };
        const template = '{% block outer %}{{ getOuter() }} {% block inner %}{{ getInner() }}{% endblock %}{% endblock %}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Async Outer Async Inner');
      });

      it('should handle blocks within loops with async data', async () => {
        const context = {
          async getItems() {
            await delay(3);
            return ['a', 'b', 'c'];
          },
          async processItem(item) {
            await delay(1);
            return `Processed ${item.toUpperCase()}`;
          }
        };
        const template = '{% for item in getItems() %}{% block item %}{{ processItem(item) }}{% endblock %}{% endfor %}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Processed AProcessed BProcessed C');
      });

      it('should handle async functions within blocks and as block parameters', async () => {
        const context = {
          async getName() {
            await delay(4);
            return 'John';
          },
          async getGreeting(name) {
            await delay(2);
            return `Hello, ${name}!`;
          }
        };
        const template = '{% block greeting %}{{ getGreeting(getName()) }}{% endblock %}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hello, John!');
      });

      it('should handle the super function in blocks with async content', async () => {
        const context = {
          async getBaseContent() {
            await delay(3);
            return 'Async Base Content';
          },
          async getChildContent() {
            await delay(1);
            return 'Async Child Content';
          }
        };
        loader.addTemplate('base.njk', '{% block content %}{{ getBaseContent() }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content %}{{ super() }} + {{ getChildContent() }}{% endblock %}';
        const result = await env.renderString(childTemplate, context);
        expect(result.trim()).to.equal('Async Base Content + Async Child Content');
      });

      it('should handle multiple levels of inheritance with blocks and async content', async () => {
        const context = {
          async getA() {
            await delay(3);
            return 'Async A';
          },
          async getB() {
            await delay(2);
            return 'Async B';
          },
          async getC() {
            await delay(5);
            return 'Async C';
          }
        };
        loader.addTemplate('grand.njk', '{% block a %}{{ getA() }}{% endblock %}{% block b %}{{ getB() }}{% endblock %}{% block c %}{{ getC() }}{% endblock %}');
        loader.addTemplate('parent.njk', '{% extends "grand.njk" %}{% block b %}Modified {{ getB() }}{% endblock %}');
        const childTemplate = '{% extends "parent.njk" %}{% block c %}Modified {{ getC() }}{% endblock %}';
        const result = await env.renderString(childTemplate, context);
        expect(result.trim()).to.equal('Async AModified Async BModified Async C');
      });

      it('should handle blocks inside a for loop with async content', async () => {
        const context = {
          async getItems() {
            await delay(4);
            return ['apple', 'banana', 'cherry'];
          },
          async processItem(item) {
            await delay(5);
            return item.toUpperCase();
          },
          async getPrefix() {
            await delay(3);
            return 'Item:';
          }
        };

        const template = `
          {% for item in getItems() -%}
            {%- block item_block -%}
              {{ getPrefix() }} {{ processItem(item) }}
            {% endblock -%}
          {% endfor %}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Item: APPLE
            Item: BANANA
            Item: CHERRY`);
      });

      it('should handle async conditionals within blocks', async () => {
        const context = {
          async shouldRender() {
            await delay(10);
            return true;
          },
          async getContent() {
            await delay(5);
            return 'Conditional Content';
          }
        };
        const template = '{% block content %}{% if shouldRender() %}{{ getContent() }}{% endif %}{% endblock %}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Conditional Content');
      });
    });

    describe('Async Custom Extensions', () => {

      class AsyncExtension {
        constructor(tagName, method, options = {}) {
          this.tags = [tagName, 'separator'];
          this.method = method;
          this.supportsBody = options.supportsBody || false;
          this.doNotResolveArgs = options.doNotResolveArgs || false;
          this.oldAsync = options.oldAsync || false;
          this.numContentArgs = 0; // Will be set during parsing
        }

        parse(parser, nodes) {
          const tok = parser.nextToken(); // Get the tag token

          if (tok.value === this.tags[0]) {
            // Parsing the main tag (e.g., 'wrap')
            return this.parseMainTag(parser, nodes, tok);
          } else {
            parser.fail(`Unexpected tag: ${tok.value}`, tok.lineno, tok.colno);
            return undefined;
          }
        }

        parseMainTag(parser, nodes, tok) {
          const args = parser.parseSignature(null, true); // Parse arguments
          parser.advanceAfterBlockEnd(tok.value); // Move parser past the block end

          let contentArgs = [];
          if (this.supportsBody) {
            contentArgs = this.parseBody(parser, nodes, tok.value);
            this.numContentArgs = contentArgs.length;
          }

          // Return a CallExtension node with arguments and optional content bodies
          if (this.oldAsync) {
            return new nodes.CallExtensionAsync(this, 'run', args, contentArgs, !this.doNotResolveArgs);
          } else {
            return new nodes.CallExtension(this, 'run', args, contentArgs, !this.doNotResolveArgs);
          }
        }

        parseBody(parser, nodes, tagName) {
          const bodies = [];

          while (true) {
            const body = parser.parseUntilBlocks('separator', 'end' + tagName);
            bodies.push(body);

            // After parseUntilBlocks, the parser is at the tag name token (TOKEN_SYMBOL)
            const tagTok = parser.nextToken(); // Should be TOKEN_SYMBOL

            if (tagTok.type !== lexer.TOKEN_SYMBOL) {
              parser.fail('Expected tag name', tagTok.lineno, tagTok.colno);
            }

            const tagNameValue = tagTok.value;

            // Advance after block end (this moves past '%}')
            parser.advanceAfterBlockEnd(tagNameValue);

            if (tagNameValue === 'separator') {
              // Continue parsing the next body
              continue;
            } else if (tagNameValue === 'end' + tagName) {
              // End of the tag block
              break;
            } else {
              parser.fail(
                `Unexpected tag "${tagNameValue}" in extension`,
                tagTok.lineno,
                tagTok.colno
              );
            }
          }

          return bodies; // Return array of bodies
        }

        async run(context, ...args) {
          if(this.doNotResolveArgs) {
            await Promise.all(args);
          }

          let callback = null;
          if(this.oldAsync) {
            //the old async uses a callback as the last argument
            callback = args.pop();
          }

          const bodies = [];
          for(let i=0; i<this.numContentArgs; i++) {
            let body = args.pop();
            if(!this.doNotResolveArgs) {
              // Render the body content if it's a function
              body = await new Promise((resolve, reject) => {
                body((err, res) => {
                  if (err) reject(err);
                  else resolve(res);
                });
              });
            }
            else {
              body = await body;
            }
            bodies.unshift(body);
          }

          const bodyContent = await this.method(context, ...args, bodies.length > 1 ? bodies : bodies[0]);

          if(callback) {
            callback(null, bodyContent);
            return undefined;
          }
          else {
            return bodyContent;
          }

          /*if (this.supportsBody && typeof args[args.length - 1] === 'function') {
            const body = args.pop();

            if(this.parallel) {
              bodyContent = body;
            }
            else {
              // Render the body content if it's a function
              bodyContent = await new Promise((resolve, reject) => {
                body((err, res) => {
                  if (err) reject(err);
                  else resolve(res);
                });
              });
            }
          }*/

          // Call the method with arguments and the rendered body content
          //const result = await this.method(context, ...args, bodyContent);

        }
      }

      it('should handle a simple async extension function', async () => {
        const greetExtension = new AsyncExtension('greet', async (context, name) => {
          await delay(5);
          return `Hello, ${name}!`;
        });

        env.addExtension('GreetExtension', greetExtension);

        const template = '{% greet "John" %}';
        const result = await env.renderString(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle a simple callback extension function (old async)', async () => {
        env.addExtension('getName', {
          tags: ['greet'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtensionAsync(this, 'run', args);
          },
          run(context, name, callback) {
            setTimeout(() => {
              callback(null, `Hello, ${name}!`);
            }, 5);
          }
        });

        const template = '{% greet "John" %}';
        const result = await env.renderString(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle a simple old-style extension function (old sync)', async () => {
        env.addExtension('getName', {
          tags: ['greet'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtension(this, 'run', args);
          },
          run(context, name) {
            return `Hello, ${name}!`;
          }
        });

        const template = '{% greet "John" %}';
        const result = await env.renderString(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle an async extension function with multiple arguments', async () => {
        const addExtension = new AsyncExtension('add', async (context, a, b) => {
          await delay(5);
          return a + b;
        });

        env.addExtension('AddExtension', addExtension);

        const template = '{% add 5, 3 %}';
        const result = await env.renderString(template);
        expect(result).to.equal('8');
      });

      it('should handle async extension tags in loops', async () => {
        const getNameExtension = new AsyncExtension('getName', async (context, number) => {
          await delay(5-number);
          const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
          return names[number % names.length];
        });

        env.addExtension('GetNameExtension', getNameExtension);

        const template = `
          <ul>
            {%- for i in range(5) %}
              <li>{% getName i -%}</li>
            {%- endfor %}
          </ul>`;

        const result = await env.renderString(template);
        const expected = `
          <ul>
              <li>Alice</li>
              <li>Bob</li>
              <li>Charlie</li>
              <li>David</li>
              <li>Eve</li>
          </ul>`;

        expect(result).to.equal(expected);
      });

      it('should handle sync extension tags in loops (old sync)', async () => {
        env.addExtension('getNameSync', {
          tags: ['getName'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtension(this, 'run', args);
          },
          run(context, number) {
            const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
            return names[number % names.length];
          }
        });

        const template = `
          <ul>
            {%- for i in range(5) %}
              <li>{% getName i -%}</li>
            {%- endfor %}
          </ul>`;

        const result = await env.renderString(template);
        const expected = `
          <ul>
              <li>Alice</li>
              <li>Bob</li>
              <li>Charlie</li>
              <li>David</li>
              <li>Eve</li>
          </ul>`;

        expect(result.trim()).to.equal(expected.trim());
      });

      it('should handle async extension tags in loops (old async)', async () => {
        env.addExtension('getNameAsync', {
          tags: ['getName'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtensionAsync(this, 'run', args);
          },
          run(context, number, callback) {
            const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
            setTimeout(() => {
              const result = names[number % names.length];
              callback(null, result); // Pass the result back via the callback
            }, 5); // Simulate a small asynchronous delay
          }
        });

        const template = `
          <ul>
            {%- for i in range(5) %}
              <li>{% getName i -%}</li>
            {%- endfor %}
          </ul>`;

        const result = await env.renderString(template);
        const expected = `
          <ul>
              <li>Alice</li>
              <li>Bob</li>
              <li>Charlie</li>
              <li>David</li>
              <li>Eve</li>
          </ul>`;

        expect(result).to.equal(expected);
      });


      it('should properly handle errors thrown in async extension tags', async () => {
        const asyncErrorExtension = new AsyncExtension('asyncError', async () => {
          await delay(10); // Simulate some async operation
          throw new Error('Async extension error');
        });

        env.addExtension('AsyncErrorExtension', asyncErrorExtension);

        const template = '{% asyncError %}';

        try {
          await env.renderString(template);
          // If we reach this point, the test should fail
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error instanceof Error).to.equal(true);
          expect(error.message).to.contain('Async extension error');
        }
      });

      it('should handle an extension tag with one async parameter', async () => {
        const greetExtension = new AsyncExtension('greet', async (context, namePromise) => {
          const name = await namePromise;
          await delay(5); // simulate some async operation
          return `Hello, ${name}!`;
        });

        env.addExtension('GreetExtension', greetExtension);

        const context = {
          getName: async () => {
            await delay(10);
            return 'Alice';
          },
        };

        const template = '{% greet getName() %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Hello, Alice!');
      });

      it('should handle an extension tag with two async parameters', async () => {
        const introduceExtension = new AsyncExtension(
          'introduce',
          async (context, namePromise, rolePromise) => {
            const name = await namePromise;
            const role = await rolePromise;
            await delay(5); // simulate some async operation
            return `This is ${name}, our ${role}.`;
          }
        );

        env.addExtension('IntroduceExtension', introduceExtension);

        const context = {
          getName: async () => {
            await delay(10);
            return 'Bob';
          },
          getRole: async () => {
            await delay(15);
            return 'manager';
          },
        };

        const template = '{% introduce getName(), getRole() %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('This is Bob, our manager.');
      });

      it('should handle an extension tag with mixed async and non-async parameters', async () => {
        const describeUserExtension = new AsyncExtension(
          'describeUser',
          async (context, namePromise, age, cityPromise) => {
            const name = await namePromise;
            const city = await cityPromise;
            await delay(5); // simulate some async operation
            return `${name}, aged ${age}, lives in ${city}.`;
          }
        );

        env.addExtension('DescribeUserExtension', describeUserExtension);

        const context = {
          getName: async () => {
            await delay(10);
            return 'Charlie';
          },
          getCity: async () => {
            await delay(15);
            return 'New York';
          },
        };

        const template = '{% describeUser getName(), 30, getCity() %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Charlie, aged 30, lives in New York.');
      });

      it('should handle an extension with a single content block', async () => {
        const options = [
          {supportsBody: true, extName: 'wrap'},//the old API, but returning async value
          {supportsBody: true, extName: 'pwrap', doNotResolveArgs: true},
          {supportsBody: true, extName: 'awrap', oldAsync: true},
          {supportsBody: true, extName: 'apwrap', oldAsync: true, doNotResolveArgs: true},
        ]
        for(const option of options) {
          const extName = option.extName;
          const wrapExtension = new AsyncExtension(
            extName,
            async (context, tagName, bodyContent) => {
              if( option.doNotResolveArgs ) {
                bodyContent = await bodyContent;
              }
              await delay(5);
              return `<${tagName}>${bodyContent}</${tagName}>`;
            },
            option
          );

          env.addExtension(extName, wrapExtension);

          const context = {
            getExtName: async () => {
              await delay(3);
              return extName;
            }
          };

          const template = `
            {% ${extName} "section" %}
              This is some content in {{getExtName()}}.
            {% end${extName} %}
          `;

          const result = await env.renderString(template, context);
          const expected = `
            <section>
              This is some content in ${extName}.
            </section>
          `;

          expect(unescape(result.trim())).to.equal(expected.trim());
        }
      });

      it('should handle an extension with multiple content blocks', async () => {
        const options = [
          { supportsBody: true, extName: 'wrap' },
          { supportsBody: true, extName: 'pwrap', doNotResolveArgs: true },
          { supportsBody: true, extName: 'awrap', oldAsync: true },
        ];
        for (const option of options) {
          const extName = option.extName;
          const wrapExtension = new AsyncExtension(
            extName,
            async (context, tagName, contentBlocks) => {

              await delay(5);

              // Join the content blocks with a separator if alternative content exists
              const mainContent = contentBlocks[0];
              const altContent = contentBlocks[1] || '';
              const result = `<${tagName}>${mainContent}</${tagName}>` +
                             (altContent ? `<alt>${altContent}</alt>` : '');

              return result;
            },
            option
          );

          env.addExtension(extName, wrapExtension);

          const context = {
            getExtName: async () => {
              await delay(3);
              return extName;
            }
          };

          const template = `
            {% ${extName} "section" %}
              This is main content in {{getExtName()}}.
            {% separator %}
              This is alternative content in {{getExtName()}}.
            {% end${extName} %}
          `;

          const result = await env.renderString(template, context);
          const expected = `
            <section>
              This is main content in ${extName}.
            </section><alt>
              This is alternative content in ${extName}.
            </alt>
          `;

          expect(unescape(result.trim())).to.equal(expected.trim());
        }
      });
    });

    describe('Async Import Tests', () => {
      let loader;
      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      describe('Basic Import', () => {
        beforeEach(() => {
          // Add template with macros
          loader.addTemplate('forms.njk', `
            {%- macro field(name, value='', type='text') -%}
            <div class="field">
              <input type="{{ type }}" name="{{ name }}" value="{{ value | escape }}" />
            </div>
            {%- endmacro -%}

            {%- macro label(text) -%}
            <div>
              <label>{{ text }}</label>
            </div>
            {%- endmacro -%}
          `);
        });

        it('should handle import with async values in macro calls', async () => {
          const context = {
            async getFieldName() {
              await delay(5);
              return 'username';
            },
            async getFieldValue() {
              await delay(3);
              return 'john_doe';
            }
          };

          const template = `
            {%- import "forms.njk" as forms -%}
            {{ forms.field(getFieldName(), getFieldValue()) }}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<div class="field">
              <input type="text" name="username" value="john_doe" />
            </div>`
          );
        });

        it('should handle from import with async values', async () => {
          const context = {
            async getLabelText() {
              await delay(5);
              return 'Enter Username:';
            }
          };

          const template = `
            {% from "forms.njk" import field, label %}
            {{ label(getLabelText()) }}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<div>
              <label>Enter Username:</label>
            </div>`
          );
        });
      });

      describe('Import with Context', () => {
        beforeEach(() => {
          // Add template that uses context variables
          loader.addTemplate('context-forms.njk', `
            {%- macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}

            {%- macro statusLabel() -%}
            <label>Status: {{ status }}</label>
            {%- endmacro -%}
          `);
        });

        it('should handle import with async context values', async () => {
          const context = {
            username: Promise.resolve('john_doe'),
            status: Promise.resolve('active')
          };

          const template = `
            {% import "context-forms.njk" as forms with context %}
            {{ forms.userField() }}
            {{ forms.statusLabel() }}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<input name="user" value="john_doe" />
            <label>Status: active</label>`
          );
        });

        it('should not have access to context without with context', async () => {
          const context = {
            username: Promise.resolve('john_doe')
          };

          const template = `
            {% import "context-forms.njk" as forms %}
            {{ forms.userField() }}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            '<input name="user" value="" />'
          );
        });
      });

      describe('Dynamic Import Names', () => {
        beforeEach(() => {
          loader.addTemplate('form1.njk', `
            {%- macro field() -%}Form 1 Field{%- endmacro -%}
          `);
          loader.addTemplate('form2.njk', `
            {%- macro field() -%}Form 2 Field{%- endmacro -%}
          `);
        });

        it('should handle async template names in import', async () => {
          const context = {
            async getFormNumber() {
              await delay(5);
              return 1;
            }
          };

          const template = `
            {% import "form" + getFormNumber() + ".njk" as form %}
            {{ form.field() }}
          `;

          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('Form 1 Field');
        });
      });

      describe('Complex Import Scenarios', () => {
        beforeEach(() => {
          // Template with async operations using its own local set variables
          loader.addTemplate('async-forms.njk', `
              {%- set greeting = "Hello" -%}

              {%- macro delayedGreeting(name) -%}
                  {{- greeting }}, {{ name }} (delayed)!
              {%- endmacro -%}

              {%- macro counter(count) -%}
                  {%- for i in range(count) -%}
                      Count: {{ i }}
                  {%- endfor -%}
              {%- endmacro -%}
          `);

          // Template with nested imports
          loader.addTemplate('layout.njk', `
              {%- macro page(content) -%}
                  <main>{{ content }}</main>
              {%- endmacro -%}
          `);

          loader.addTemplate('nested-template.njk', `
              {%- import "layout.njk" as layout -%}
              {%- import "async-forms.njk" as forms -%}

              {%- macro wrapper(name, count) -%}
                  {{ layout.page(forms.delayedGreeting(name)) }}
                  {{ forms.counter(count) }}
              {%- endmacro -%}
          `);

          // Template with list rendering
          loader.addTemplate('async-loop.njk', `
              {%- macro listItems(items) -%}
                  <ul>
                      {%- for item in items -%}
                      <li>{{ item }}</li>
                      {%- endfor -%}
                  </ul>
              {%- endmacro -%}
          `);
        });

        it('should handle async values passed to imported macros', async () => {
          const context = {
            async getName() {
              await delay(5);
              return 'Alice';
            }
          };

          const template = `
              {%- import "async-forms.njk" as forms -%}
              {{- forms.delayedGreeting(getName()) -}}
          `;

          const result = await env.renderString(template, context);
          expect(result).to.equal('Hello, Alice (delayed)!');
        });

        it('should handle async variables and functions in imported macros', async () => {
          // Add the template to the loader
          loader.addTemplate('greeting_macros.njk', `
            {%- macro greetWithContext() -%}
              {{ getName() }}
            {%- endmacro -%}
          `);

          const context = {
            async getName() {
              await delay(5);
              return 'Alice';
            }
          };

          const template = `
            {% import "greeting_macros.njk" as gm with context %}
            {{ gm.greetWithContext() }}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal('Alice');
        });

        it('should handle nested imports with async values - simplified', async () => {
          const context = {
            nameValue: 'Bob'
          };

          loader.addTemplate('nested.njk', `
            {%- macro greeting(name) -%}
                {{ name }}!
            {%- endmacro -%}

            {%- macro page(content) -%}
                {{ content }}
            {%- endmacro -%}

            {%- macro wrapper(name) -%}
                {{ page(greeting(name)) }}
            {%- endmacro -%}
        `);

          const template = `
              {%- import "nested.njk" as macros -%}
              {{- macros.wrapper(nameValue) -}}
          `;

          const result = await env.renderString(template, context);
          expect(result).to.equal(`Bob!`);
        });

        it('should handle nested imports with async values', async () => {
          const context = {
            async getName() {
              await delay(5);
              return 'Bob';
            },
            async getCount() {
              await delay(3);
              return 2;
            }
          };

          const template = `
              {%- import "nested-template.njk" as templates -%}{{- templates.wrapper(getName(), getCount()) -}}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
                  `<main>Hello, Bob (delayed)!</main>
                  Count: 0Count: 1`);
        });

        it('should handle async values in imported macro loops', async () => {
          const context = {
            async getItems() {
              await delay(5);
              return ['one', 'two', 'three'];
            }
          };

          const template = `
              {%- import "async-loop.njk" as loop -%}
              {{- loop.listItems(getItems()) -}}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result)).to.equal(
            '<ul><li>one</li><li>two</li><li>three</li></ul>');
        });
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

        it('should handle async function in imported macro', async () => {
          loader.addTemplate('greet_macro.njk', `
            {%- macro greet(name) -%}
              Hello, {{ name }}!
            {%- endmacro -%}
          `);

          const context = {
            async getName() {
              await delay(5);
              return 'Charlie';
            }
          };

          const template = `
            {% import "greet_macro.njk" as macros %}
            {{ macros.greet(getName()) }}
          `;

          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('Hello, Charlie!');
        });

        it('should handle async function called within imported macro with context', async () => {
          loader.addTemplate('greet_macro_with_context.njk', `
            {%- macro greet() -%}
              Hello, {{ getName() }}!
            {%- endmacro -%}
          `);

          const context = {
            async getName() {
              await delay(5);
              return 'Diana';
            }
          };

          const template = `
            {% import "greet_macro_with_context.njk" as macros with context %}
            {{ macros.greet() }}
          `;

          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('Hello, Diana!');
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

      // Let's also fix the Dependencies section
      describe('Import with Dependencies', () => {
        beforeEach(() => {
          // Template with async set variables that receives the functions it needs
          loader.addTemplate('config.njk', `
            {%- macro init(getUrlFunc, getKeyFunc) -%}
              {% set apiUrl = getUrlFunc() %}
              {% set apiKey = getKeyFunc() %}
              {{ apiUrl }}/{{ caller() }}?key={{ apiKey }}
            {%- endmacro -%}
          `);

          // Template that depends on imported values
          loader.addTemplate('api-forms.njk', `
            {% import "config.njk" as config %}

            {%- macro userEndpoint(getUrlFunc, getKeyFunc, userId) -%}
              {%- call config.init(getUrlFunc, getKeyFunc) -%}
                users/{{ userId }}
              {%- endcall -%}
            {%- endmacro -%}
          `);
        });

        it('should handle async dependencies in nested imports', async () => {
          const context = {
            async getApiUrl() {
              await delay(5);
              return 'https://api.example.com';
            },
            async getApiKey() {
              await delay(3);
              return 'secret-key-123';
            }
          };

          const template = `
            {% import "api-forms.njk" as api -%}
            {{ api.userEndpoint(getApiUrl, getApiKey, "123") }}
          `;

          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal(
            'https://api.example.com/users/123?key=secret-key-123'
          );
        });

      });

      describe('Import with Async Filter Usage', () => {
        beforeEach(() => {
          // Add async filter
          env.addFilter('uppercase', async (str) => {
            await delay(5);
            return str.toUpperCase();
          });

          // Template using async filter
          loader.addTemplate('filtered-forms.njk', `
            {%- macro formattedField(name, value) -%}
            <input name="{{ name }}" value="{{ value | uppercase }}" />
            {%- endmacro -%}
          `);
        });

        it('should handle async filters in imported macros', async () => {
          const context = {
            async getName() {
              await delay(3);
              return 'username';
            }
          };

          const template = `
            {% import "filtered-forms.njk" as forms %}
            {{ forms.formattedField(getName(), "john_doe") }}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            '<input name="username" value="JOHN_DOE" />'
          );
        });
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
      let loader;

      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

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
      let loader;

      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

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

      // Set block in imported templates
      it('should handle set block in imported templates with async values', async () => {
        loader.addTemplate('header.njk', `
          {% macro render(title) %}
            {% set header %}
              <header>{{ title }}</header>
            {% endset %}
            {{ header }}
          {% endmacro %}
        `);

        const context = {
          async getTitle() {
            await delay(5);
            return 'Welcome';
          }
        };

        const template = `
          {% import "header.njk" as headers %}
          {{ headers.render(getTitle()) }}
        `;

        const result = await env.renderString(template, context);
        expect(unescape(result.trim())).to.equal('<header>Welcome</header>');
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

    describe('Regular Nunjucks Async Filter Tests', () => {
      beforeEach(() => {
        // Add async filter using the standard Nunjucks callback-style API
        env.addFilter('asyncUppercase', (str, callback) => {
          setTimeout(() => {
            callback(null, str.toUpperCase());
          }, 5);
        }, true); // true flag indicates this is an async filter

        env.addFilter('asyncReverse', (str, callback) => {
          setTimeout(() => {
            callback(null, str.split('').reverse().join(''));
          }, 3);
        }, true);
      });

      it('should handle standard async filter', async () => {
        const template = '{{ "hello" | asyncUppercase }}';
        const result = await env.renderString(template);
        expect(result).to.equal('HELLO');
      });

      it('should handle chained standard async filters', async () => {
        const template = '{{ "hello" | asyncUppercase | asyncReverse }}';
        const result = await env.renderString(template);
        expect(result).to.equal('OLLEH');
      });

      it('should handle standard async filter with async value', async () => {
        const context = {
          async getText() {
            await delay(5);
            return 'hello';
          }
        };

        const template = '{{ getText() | asyncUppercase }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('HELLO');
      });

      it('should handle expression with concatenation and multiple filters', async () => {
        const context = {
          async getText() {
            await delay(5);
            return 'hello';
          },
          suffix: 'world'
        };

        // Template that combines async function, string concatenation, and multiple filters
        const template = '{{ getText() | asyncUppercase + " " + suffix | asyncReverse }}';

        const result = await env.renderString(template, context);
        expect(result).to.equal('HELLO dlrow');  // Fixed expectation
      });

      it('should handle expression with concatenation and multiple filters and grouping', async () => {
        const context = {
          async getText() {
            await delay(5);
            return 'hello';
          },
          suffix: 'world'
        };

        // Template that uses parentheses to group the concatenation before applying the reverse filter
        const template = '{{ (getText() | asyncUppercase + " " + suffix) | asyncReverse }}';

        const result = await env.renderString(template, context);
        expect(result).to.equal('dlrow OLLEH');
      });

      it('should handle errors in standard async filters', async () => {
        env.addFilter('asyncError', (str, callback) => {
          setTimeout(() => {
            callback(new Error('Filter error'));
          }, 5);
        }, true);

        const template = '{{ "test" | asyncError }}';

        try {
          await env.renderString(template);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Filter error');
        }
      });

      it('should handle standard async filters in set statements', async () => {
        const template = `
          {% set result = "hello" | asyncUppercase %}
          {{ result }}
        `;

        const result = await env.renderString(template);
        expect(result.trim()).to.equal('HELLO');
      });

      it('should handle standard async filters in if conditions', async () => {
        const template = `
          {% if "yes" | asyncUppercase == "YES" %}
            correct
          {% else %}
            incorrect
          {% endif %}
        `;

        const result = await env.renderString(template);
        expect(result.trim()).to.equal('correct');
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
      let loader;

      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      describe('Parallel Argument Resolution', () => {
        beforeEach(() => {
          env = new AsyncEnvironment(loader);
        });
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

      describe('Import multiple items', () => {

        beforeEach(() => {
          loader = new StringLoader();
          env = new AsyncEnvironment(loader);
        });

        it('should "import as" multiple async macros and use them', async () => {
          loader.addTemplate('macros.njk', `
            {% macro asyncMacro1() -%}
              {%- set result1 = getAsyncValue1() -%}
              [Macro1: {{ result1 }}]
            {%- endmacro %}
            {% macro asyncMacro2() -%}
              {%- set result2 = getAsyncValue2() -%}
              [Macro2: {{ result2 }}]
            {%- endmacro %}
          `);

          const context = {
            async getAsyncValue1() {
              await delay(2);
              return 'Value1';
            },
            async getAsyncValue2() {
              await delay(1);
              return 'Value2';
            }
          };

          const template = `
            {%- import "macros.njk" as macros with context -%}
            {{ macros.asyncMacro1() }} {{ macros.asyncMacro2() }}
          `;
          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('[Macro1: Value1] [Macro2: Value2]');
        });

        it('should "from import" multiple async macros and use them', async () => {
          loader.addTemplate('macros.njk', `
            {% macro asyncMacro1() %}
              {%- set result1 = getAsyncValue1() -%}
              [Macro1: {{ result1 }}]
            {%- endmacro -%}

            {%- macro asyncMacro2() -%}
              {%- set result2 = getAsyncValue2() -%}
              [Macro2: {{ result2 }}]
            {% endmacro %}
          `);

          const context = {
            async getAsyncValue1() {
              await delay(2);
              return 'Value1';
            },
            async getAsyncValue2() {
              await delay(1);
              return 'Value2';
            }
          };

          const template = `
            {% from "macros.njk" import asyncMacro1, asyncMacro2 with context %}
            {{ asyncMacro1() }} {{ asyncMacro2() }}
          `;

          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('[Macro1: Value1] [Macro2: Value2]');
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

    describe('Function/input/etc.. name stored in variable', () => {
      let loader;

      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
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

      it('should handle from-import with an async template name', async () => {
        // Add the dynamic template to the loader
        loader.addTemplate('async_template.njk', `
          {% macro greet(name) %}
            Hello, {{ name }}!
          {% endmacro %}
        `);

        const context = {
          async getTemplateName() {
            await delay(5); // Simulate async operation
            return 'async_template.njk';
          },
        };

        const template = `
          {% from getTemplateName() import greet %}
          {{ greet("World") }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Hello, World!');
      });

      it('should handle import with an async template name', async () => {
        // Add the dynamic template to the loader
        loader.addTemplate('async_library.njk', `
          {% macro getData() %}
            Async Fetched Data
          {% endmacro %}
        `);

        const context = {
          async getLibraryName() {
            await delay(5); // Simulate async operation
            return 'async_library.njk';
          },
        };

        const template = `
          {% import getLibraryName() as lib %}
          {{ lib.getData() }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Async Fetched Data');
      });

    });

    describe('Simple race conditions with sets', () => {
      let loader;
      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      it('should correctly handle assignments in order irrespective of block delays ', async () => {
        const context = {
          slowCondition: (async () => {
            await delay(5);
            return true;
          })()
        };

        const template = `
          {%- set value = 1 -%}
          {%- if slowCondition -%}
            {%- set value = 2 -%}
          {%- endif -%}
          {{ value }}`;
        const result = await env.renderString(template, context);
        expect(result).to.equal('2');
      });

      it('Frame snapshot should get values that still have not been assigned ', async () => {
        const context = {
          slowCondition: (async () => {
            await delay(6);
            return true;
          })(),
          anotherSlowCondition: (async () => {
            await delay(3);
            return true;
          })()
        };

        const template = `
          {%- set value = 1 -%}
          {%- if slowCondition -%}
            {%- set value = 2 -%}
          {%- endif -%}
          {%- if anotherSlowCondition -%}
            {{ value }}
          {%- endif -%}
          {%- set value = 3 -%}`
        const result = await env.renderString(template, context);
        expect(result).to.equal('2');
      });
    });


    describe('Race conditions: Async Template Inheritance, Macros, and Super', () => {

      let loader;
      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      it('should handle extends with async super() and set', async () => {
        const template = `
          {%- extends "base_for_super.njk" -%}
          {%- block content -%}
            {%- set val = getPreSuperVal() -%}
            {{ super()}}
            {%- set val = getPostSuperVal() -%}
            {{ val }}
          {%- endblock -%}
        `;

        loader.addTemplate('base_for_super.njk', `
          Base Content:
          {%- block content -%}
          Base Block: {{ val }}
          {%- endblock -%}
          `);

        const context = {
          async getPreSuperVal() {
            await delay(5);
            return 'PreSuperVal';
          },
          async getPostSuperVal() {
            await delay(10);
            return 'PostSuperVal';
          }
        };

        // If sync worked:
        // "Base Content:
        //  Base Block: PreSuperVal
        //  PostSuperVal"
        expect((await env.renderString(template, context)).trim()).to.equal('Base Content:Base Block: PreSuperVal PostSuperVal');
      })


      // Macro with caller.
      // Outside: val=1
      // If condition async => sets val='OuterVal'
      // Caller block sets val='InnerVal'
      // Inside macro we see 'OuterVal' then 'InnerVal', after macro call val should be 'OuterVal' again.
      // Without sync, these scoping rules won't hold.


      it('should handle macro with async caller block', async () => {
        const template = `
          {%- import "macros_caller.njk" as m -%}
          {%- set val = 1 -%}
          {%- if slowCondition -%}
            {%- set val = getOuterVal() -%}
          {%- endif -%}
          {%- call m.show(val) -%}
            {%- set val = getInnerVal() -%}
            Inner: {{ val }}
          {%- endcall -%}
          Final val: {{ val }}`;

        loader.addTemplate('macros_caller.njk', `
          {%- macro show(value) -%}
          Macro Start: {{ value }} {{ caller() }} Macro End
          {%- endmacro -%}
          `);

        const context = {
          slowCondition: (async () => { await delay(2); return true; })(),
          async getOuterVal() {
            await delay(5);
            return 'OuterVal';
          },
          async getInnerVal() {
            await delay(3);
            return 'InnerVal';
          }
        };

        // If sync worked:
        // Macro sees "OuterVal" then caller sets val='InnerVal'
        // Inside macro: "Macro Start: OuterVal Inner: InnerVal Macro End"
        // Outside macro: val should still be 'OuterVal'
        // "Final val: OuterVal"
        expect((await env.renderString(template, context)).trim()).to.equal('Macro Start: OuterVal Inner: InnerVal Macro End Final val: OuterVal');
      });


      // Parent template and child override with async val.
      // Child sets val before super() is called.
      // If sync worked, parent sees updated val.
      // Without sync, parent might see old/undefined val.


      it('should handle async extends with delayed parent template and block overrides', async () => {
        const template = `
          {% extends "parent_delayed.njk" %}
          {% block content %}
            {% set val = getVal() %}
            {{ super() }}
            Child sees value: {{ val }}
          {% endblock %}
        `;

        loader.addTemplate('parent_delayed.njk', `
          Parent Start
          {% block content %}
          Parent sees value: {{ val }}
          {% endblock %}
          Parent End
          `);

        const context = {
          async getVal() {
            await delay(8);
            return 'ChildVal';
          }
        };

        // If sync worked:
        // "Parent Start
        //  Parent sees value: ChildVal
        //  Child sees value: ChildVal
        //  Parent End"
        expect((await env.renderString(template, context)).replace(/\s+/g,' ')).to.equal('Parent Start Parent sees value: ChildVal Child sees value: ChildVal Parent End');
      });

    });

    describe('Non-async tests in AsyncEnvironment', () => {
      let loader;
      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      it.only('Var lookup optimization: Should correctly set a variable from a child frame ', () => {
        const template = `
          {%- set x = 42 -%}
            {%- if true -%}
            {%- set x = x + 1 -%}
          {%- endif -%}
          {{ x }}`;

          const result = env.renderString(template);
          expect(result).to.equal('43');
      });
    });

  });

}());
