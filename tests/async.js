(function() {
  'use strict';

  var expect;
  var unescape;
  var Environment;
  // var Lexer;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    Environment = require('../nunjucks/src/environment').Environment;
    // Lexer = require('../nunjucks/src/lexer');
    unescape = require('he').unescape;
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    Environment = nunjucks.Environment;
    // Lexer = nunjucks.Lexer;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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


  describe('Async mode', () => {
    let env;
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

    describe('Complex Async Scenarios', () => {
      beforeEach(() => {
        env = new Environment();
      });
      it('should handle async functions returning complex objects', async () => {
        const context = {
          async getUser() {
            await delay(5);
            return { name: 'John', roles: ['admin', 'user'] };
          }
        };
        const template = '{{ getUser().name }} is {{ getUser().roles[0] }}';
        const result = await env.renderStringAsync(template, context);
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
          await env.renderStringAsync(template, context);
          noError = true;
        } catch (error) {
          expect(error instanceof Error).to.equal(true);
          expect(error.message).to.contain('Async error');
        }
        expect(noError).to.equal(false);
      });
    });

    describe('Async Nunjucks Expressions', () => {
      beforeEach(() => {
        env = new Environment();
      });

      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

      it('should handle mixed parameter types in expressions', async () => {
        const context = {
          async textFunc() { await pause(10); return 'Hello'; },
          async numFunc() { await pause(6); return 42; },

          get asyncList() { return pause(8).then(() => [1, 2, 'three'].toString()); },
          get asyncObj() { return pause(2).then(() => ({a: 1, b: 2})); },

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
        const result = await env.renderStringAsync(template, context);
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
          async addAsync(a, b) { await pause(5); return a + b; },

          get asyncNum() { return pause(6).then(() => 5); },

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
        const result = await env.renderStringAsync(template, context);
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
          async asyncGreaterThan(a, b) { await pause(10); return a > b; },

          get asyncX() { return pause(2).then(() => 5); },

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
        const result = await env.renderStringAsync(template, context);
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
          async asyncTrue() { await pause(3); return true; },

          get asyncFalse() { return pause(2).then(() => false); },

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
        const result = await env.renderStringAsync(template, context);
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
            await pause(5);
            return [
              { name: 'Alice', age: 30 },
              { name: 'Bob', age: 25 },
              { name: 'Charlie', age: 35 }
            ];
          },

          get asyncDiscount() { return pause(5).then(() => 0.1); },

          isAdult: (age) => age >= 18,

          adultAge: 18,
        };
        const template = `
          {% for user in fetchUsers() -%}
            {{ user.name }}: {{ ("Adult" if isAdult(user.age) else "Minor") }} (Age: {{ user.age }}, Discount: {{ (asyncDiscount * 100 if user.age > adultAge else 0) }}%)
          {% endfor %}
        `;
        const result = await env.renderStringAsync(template, context);
        expect(result.trim()).to.equal(`
          Alice: Adult (Age: 30, Discount: 10%)
          Bob: Adult (Age: 25, Discount: 10%)
          Charlie: Adult (Age: 35, Discount: 10%)
        `.trim());
      });
    });

    describe('Async Block Tag Tests', () => {
      let loader;
      beforeEach(() => {;
        loader = new StringLoader();
        env = new Environment(loader);
      });

      it('should render a simple block with async content', async () => {
        const context = {
          async getMessage() {
            await delay(1);
            return 'Hello, World!';
          }
        };
        const template = '{% block content %}{{ getMessage() }}{% endblock %}';
        const result = await env.renderStringAsync(template, context);
        expect(result.trim()).to.equal('Hello, World!');
      });

      it('should handle template inheritance with blocks and async content', async () => {
        const context = {
          async getContent() {
            await delay(1);
            return 'Async Child Content';
          }
        };
        loader.addTemplate('base.njk', '<div>{% block content %}Base Content{% endblock %}</div>');
        const childTemplate = '{% extends "base.njk" %}{% block content %}{{ getContent() }}{% endblock %}';
        const result = await env.renderStringAsync(childTemplate, context);
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
        const result = await env.renderStringAsync(template, context);
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
        const result = await env.renderStringAsync(template, context);
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
        const result = await env.renderStringAsync(template, context);
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
        const result = await env.renderStringAsync(childTemplate, context);
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
        const result = await env.renderStringAsync(childTemplate, context);
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

        const result = await env.renderStringAsync(template, context);
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
        const result = await env.renderStringAsync(template, context);
        expect(result.trim()).to.equal('Conditional Content');
      });
    });

    describe('Async Custom Extensions', () => {
      beforeEach(() => {
        env = new Environment();
      });

      class AsyncExtension {
        constructor(tagName, method) {
          this.tags = [tagName];
          this.method = method;
        }

        parse(parser, nodes) {
          const tok = parser.nextToken(); // Get the tag token
          const args = parser.parseSignature(null, true); // Parse arguments
          parser.advanceAfterBlockEnd(tok.value); // Move parser past the block end

          // Since we're handling inline tags, we don't need to parse any body content
          return new nodes.CallExtension(this, 'run', args);
        }

        async run(context, ...args) {
          // Combine the context and arguments to pass to the method
          const methodArgs = [context, ...args];

          // Call the method and return its result
          return await this.method(...methodArgs);
        }
      }

      it('should handle a simple async extension function', async () => {
        const greetExtension = new AsyncExtension('greet', async (context, name) => {
          await delay(5);
          return `Hello, ${name}!`;
        });

        env.addExtension('GreetExtension', greetExtension);

        const template = '{% greet "John" %}';
        const result = await env.renderStringAsync(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle a simple callback extension function (old async)', async () => {
        env.addExtension('getName', {
          tags: ['greet'],
          parse(parser, nodes, lexer) {
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
        const result = await env.renderStringAsync(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle a simple old-style extension function (old sync)', async () => {
        env.addExtension('getName', {
          tags: ['greet'],
          parse(parser, nodes, lexer) {
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
        const result = await env.renderStringAsync(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle an async extension function with multiple arguments', async () => {
        const addExtension = new AsyncExtension('add', async (context, a, b) => {
          await delay(5);
          return a + b;
        });

        env.addExtension('AddExtension', addExtension);

        const template = '{% add 5, 3 %}';
        const result = await env.renderStringAsync(template);
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

        const result = await env.renderStringAsync(template);
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
          await env.renderStringAsync(template);
          // If we reach this point, the test should fail
          expect.fail('Expected an error to be thrown');
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
        const result = await env.renderStringAsync(template, context);
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
        const result = await env.renderStringAsync(template, context);
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
        const result = await env.renderStringAsync(template, context);
        expect(result).to.equal('Charlie, aged 30, lives in New York.');
      });
    });

  });
}());
