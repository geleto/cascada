(function() {
  'use strict';

  var expect;
  var unescape;
  var Environment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    Environment = require('../nunjucks/src/environment').Environment;
    unescape = require('he').unescape;
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal(`
          IT:
            - John (developer)
            - Jane (designer)
          HR:
            - Bob (recruiter)
            - Alice (manager)`
        );
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
        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('Admin');

        const template2 = '{% if isUserAdmin(2) %}Admin{% else %}Not admin{% endif %}';
        const result2 = await env.renderStringAsync(template2, context);
        expect(result2).to.equal('Not admin');
      });

      it('should handle async promise in if condition', async () => {
        const context = {
          userStatus: Promise.resolve('active')
        };

        const template = '{% if userStatus == "active" %}User is active{% else %}User is not active{% endif %}';
        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('User is active');
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

        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('Admin user');

        const template2 = `
        {%- if getUserRole(3) == "admin" -%}
          Admin user
        {%- elif getUserRole(2) == "moderator" -%}
          Moderator user
        {%- else -%}
          Regular user
        {%- endif -%}`;

        const result2 = await env.renderStringAsync(template2, context);
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

        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('Hello, Admin John!');

        const template2 = `
        {%- if isUserAdmin(2) -%}Hello, Admin {{ getUserName(2) }}!
        {%- else -%}Hello, User {{ getUserName(2) }}!
        {%- endif -%}`;

        const result2 = await env.renderStringAsync(template2, context);
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

        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('Inactive User');

        const template2 = `
          {%- if isUserActive(2) -%}
              {%- if getUserRole(2) == "admin" -%}Active Admin
              {%- else -%}Active User
              {%- endif -%}
          {%- else -%}Inactive User
          {%- endif -%}
          `;

        const result2 = await env.renderStringAsync(template2, context);
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
        const result = await env.renderStringAsync(template, context);
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
        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('Admin');
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
        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

        const result = await env.renderStringAsync(template, context);
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

    describe('Include async tests', () => {
      let loader;

      class StringLoader {
        constructor() {
          this.templates = new Map();
        }

        getSource(name) {
          if (!this.templates.has(name)) {
            throw new Error(`Template ${name} not found`);
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

      beforeEach(() => {
        loader = new StringLoader();
        env = new Environment(loader);
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
  });
}());
