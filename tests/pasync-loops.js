(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
  //var Environment;
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

  describe('Async mode - loops', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
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

      // @todo - the compileFor sets near _addDeclaredVar
      it('should support destructured looping in async mode', async () => {
        const context = { arr: [['x', 'y', 'z'], ['1', '2', '3']] };
        const template = '{% for a, b, c in arr %}' +
          '{{ a }},{{ b }},{{ c }}.{% endfor %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('x,y,z.1,2,3.');
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

      it('should correctly resolve loop variable inside its own async iteration block', async () => {
        const context = {
          getAsyncFruits: async function* () {
            await delay(1);
            yield 'Apple';
            await delay(1);
            yield 'Banana';
          }
        };

        const template = `{% for fruit in getAsyncFruits() %}{{ fruit }};{% endfor %}`;

        const result = await env.renderString(template, context);

        expect(result.trim()).to.equal('Apple;Banana;');
      });

      it('should correctly resolve loop variable when its value is a promise inside its own async iteration block', async () => {
        const context = {
          // getAsyncFruits returns an async iterator that yields Promises
          getAsyncFruits: async function* () {
            await delay(1);
            yield Promise.resolve('Apple'); // Yield a Promise
            await delay(1);
            yield Promise.resolve('Banana'); // Yield another Promise
          }
        };

        const template = `{% for fruit in getAsyncFruits() %}{{ fruit }};{% endfor %}`;
        // Expected output: "Apple;Banana;"

        const result = await env.renderString(template, context);

        expect(result.trim()).to.equal('Apple;Banana;');
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

  });

  describe('Loops Modifying Outer Scope Variables (Sequential Behavior)', () => {

    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should correctly accumulate value using async operation (Sequential)', async () => {
      const context = {
        items: [1, 2, 3],
        async getValue(id) {
          await delay(5);
          return id * 10; // Async calculation
        }
      };
      const template = `
        {% set total = 0 %}
        {%- for item in items -%}
          {% set total = total + getValue(item) %}
        {%- endfor -%}
        Final Total: {{ total }}
        `;
      // Expected: 0 + getValue(1) -> 10
      //           10 + getValue(2) -> 30
      //           30 + getValue(3) -> 60
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Final Total: 60');
    });

    it('should correctly modify outer object property using async operation (Sequential)', async () => {
      const context = {
        config: { enabled: false, count: 0 },
        async updateConfig(cfg, index) {
          await delay(5);
          // Return a *new* object to avoid mutation issues if config was passed around
          return { enabled: index % 2 !== 0, count: cfg.count + index };
        }
      };
      const template = `
        {% set currentConfig = config %}
        {%- for i in [1, 2, 3] -%}
          {% set currentConfig = updateConfig(currentConfig, i) %}
        {%- endfor -%}
        Final Config: Enabled={{ currentConfig.enabled }}, Count={{ currentConfig.count }}
        `;
      // Iter 1: update({e:f,c:0}, 1) -> {e:t, c:1}
      // Iter 2: update({e:t,c:1}, 2) -> {e:f, c:3}
      // Iter 3: update({e:f,c:3}, 3) -> {e:t, c:6}
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Final Config: Enabled=true, Count=6');
    });

    it('should handle nested loops modifying the same outer variable (Sequential)', async () => {
      const context = {
        outer: [1, 2],
        inner: ['a', 'b'],
        async getIncrement(o, i) {
          await delay(3);
          return o * (i === 'a' ? 1 : 10);
        }
      };
      const template = `
        {% set counter = 100 %}
        {%- for o in outer -%}
          {%- for i in inner -%}
            {% set counter = counter + getIncrement(o, i) %}
          {%- endfor -%}
        {%- endfor -%}
        Final Counter: {{ counter }}
        `;
      // Start: 100
      // o=1, i='a': 100 + get(1,'a') = 100 + 1 = 101
      // o=1, i='b': 101 + get(1,'b') = 101 + 10 = 111
      // o=2, i='a': 111 + get(2,'a') = 111 + 2 = 113
      // o=2, i='b': 113 + get(2,'b') = 113 + 20 = 133
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Final Counter: 133');
    });

    it('should handle modification within conditional inside loop (Sequential)', async () => {
      const context = {
        items: [10, 5, 20],
        async processValue(val) {
          await delay(5);
          return val * 2;
        }
      };
      const template = `
         {% set score = 0 %}
         {%- for item in items -%}
           {% if item > 7 %}
             {% set score = score + processValue(item) %}
           {% endif %}
         {%- endfor -%}
         Final Score: {{ score }}
         `;
      // Start: 0
      // item=10 (>7): 0 + process(10) = 0 + 20 = 20
      // item=5 (<=7): score remains 20
      // item=20 (>7): 20 + process(20) = 20 + 40 = 60
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Final Score: 60');
    });

    it('should correctly modify using async iterator (Sequential)', async () => {
      const context = {
        async *numberGenerator() {
          yield 1; await delay(5);
          yield 2; await delay(5);
          yield 3; await delay(5);
        },
        async doubler(n) {
          await delay(3);
          return n * 2;
        }
      };
      const template = `
            {% set sum = 0 %}
            {%- for num in numberGenerator() -%}
                {% set sum = sum + doubler(num) %}
            {%- endfor -%}
            Sum: {{ sum }}
            `;
      // Start: 0
      // num=1: 0 + double(1) = 0 + 2 = 2
      // num=2: 2 + double(2) = 2 + 4 = 6
      // num=3: 6 + double(3) = 6 + 6 = 12
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Sum: 12');
    });

    it('should handle else block correctly when outer var modification exists but loop is empty (Sequential)', async () => {
      const context = {
        items: [], // Empty list
        async getDefault() {
          await delay(5);
          return -1;
        },
        async process(v) { // This won't be called, but shows modification intent
          await delay(1); return v * 2;
        }
      };
      const template = `
        {% set finalValue = 100 %}
        {% for item in items %}
          {% set finalValue = process(item) %} {# This part won't run #}
        {% else %}
          {% set finalValue = getDefault() %}
        {% endfor %}
        Value: {{ finalValue }}
        `;
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Value: -1');
    });

    it('should handle read-modify-write on outer var correctly (Sequential)', async () => {
      const context = {
        items: [2, 3, 4],
        async transform(current, item) {
          await delay(5);
          return current * item;
        }
      };
      const template = `
          {% set product = 1 %}
          {%- for item in items -%}
              {# Read outer 'product', use async 'transform', write back #}
              {% set product = transform(product, item) %}
          {%- endfor -%}
          Product: {{ product }}
      `;
      // Start: 1
      // item=2: transform(1, 2) -> 2
      // item=3: transform(2, 3) -> 6
      // item=4: transform(6, 4) -> 24
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Product: 24');
    });


    it('should allow independent async calls alongside sequential modification (Sequential loop)', async () => {
      const context = {
        items: ['a', 'b'],
        logs: [], // Use a mutable object passed by reference
        async logIndependent(item) {
          await delay(10); // Longer delay
          context.logs.push(`Logged ${item}`); // Side effect
          return true;
        },
        async getIncrement(_sumsofar, item) {
          await delay(2); // Shorter delay
          return item === 'a' ? 1 : 10;
        }
      };
      const template = `
          {% set sum = 0 %}
          {%- for item in items -%}
              {%- set sum = sum + getIncrement(sum, item) -%} {# Depends on previous sum #}
              {%- set logged = logIndependent(item) -%} {# Runs async, but loop waits #}
              {{- sum + ':' + logged }}  {# We must output logged or it will not be resolved during the template rendering #}
          {%- endfor -%}
          Sum: {{ sum }}
      `;
      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal(`1:true  11:true  Sum: 11`);
      // Verify side effect order confirms sequential execution
      expect(context.logs).to.eql(['Logged a', 'Logged b']);
    });

  }); // End Loops Modifying Outer Scope

  describe.only('While Loops', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should handle basic while loop with async condition', async () => {
      const context = {
        state: {
          counter: 0,
          async shouldContinue() {
            await delay(5);
            this.counter++;
            return this.counter <= 3;
          },
          async getValue() {
            await delay(3);
            return this.counter;
          }
        }
      };

      const template = `
        {% while state!.shouldContinue() -%}
          Iteration {{ state.getValue() }}
        {% endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Iteration 1\n        Iteration 2\n        Iteration 3');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(4);
    });

    it('should handle while loop with sequential execution operator before loop', async () => {
      const context = {
        state: {
          counter: 0,
          async initialize() {
            await delay(5);
            this.counter = 10;
            return true;
          },
          async shouldContinue() {
            await delay(3);
            this.counter--;
            return this.counter > 7;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        }
      };

      const template = `
        {% set initialized = state!.initialize() %}
        {% while state!.shouldContinue() -%}
          Count: {{ state.getValue() }}
        {% endwhile %}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Count: 9\n        Count: 8');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(7);
    });

    it('should handle while loop with sequential execution operator in condition', async () => {
      const context = {
        state: {
          counter: 0,
          async incrementAndCheck() {
            await delay(5);
            this.counter++;
            return this.counter <= 3;
          },
          async getValue() {
            await delay(3);
            return this.counter;
          }
        }
      };

      const template = `
        {% while state!.incrementAndCheck() %}
          Value: {{ state.getValue() }}
        {%- endwhile %}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Value: 1\n          Value: 2\n          Value: 3');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(4);
    });

    it('should handle while loop with sequential execution operator in loop body', async () => {
      const context = {
        state: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            return this.counter < 3;
          },
          async increment() {
            await delay(5);
            this.counter++;
            return this.counter;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        }
      };

      const template = `
        {% while state.shouldContinue() %}
          {%- set newValue = state!.increment() -%}
          Current: {{ state.getValue() }}
        {% endwhile %}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Current: 1\n        Current: 2\n        Current: 3');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(3);
    });

    it('should handle while loop with sequential execution operator after loop', async () => {
      const context = {
        state: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async finalize() {
            await delay(5);
            return this.counter * 10;
          }
        }
      };

      const template = `
        {% while state!.shouldContinue() %}
          Iteration {{ state.counter }}
        {%- endwhile -%}
        {%- set result = state!.finalize() %}
        Result: {{ result }}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Iteration 1\n          Iteration 2\n        Result: 30');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(3);
    });

    it('should handle while loop with complex sequential operations', async () => {
      const context = {
        state: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async processValue(val) {
            await delay(5);
            return val * 2;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        }
      };

      const template = `
        {% set total = 0 %}
        {%- while state!.shouldContinue() -%}
          {%- set processed = state.processValue(state.getValue()) -%}
          {% set total = total + processed %}
          Current total: {{ total }}
        {%- endwhile %}
        Final total: {{ total }}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Current total: 2\n          Current total: 6\n        Final total: 6');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(3);
    });

    it('should handle while loop with async generator condition', async () => {
      const context = {
        async *numberGenerator() {
          yield 1; await delay(5);
          yield 2; await delay(5);
          yield 3; await delay(5);
        },
        currentValue: null,
        generator: null,
        async getNextValue() {
          if (!this.generator) {
            this.generator = this.numberGenerator();
          }
          this.currentValue = await this.generator.next();
          return !this.currentValue.done;
        },
        async getValue() {
          await delay(3);
          return this.currentValue.value;
        }
      };

      const template = `
        {%- while getNextValue() -%}
          Generated: {{ getValue() }},
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Generated: 1,Generated: 2,Generated: 3,');
    });

    it('should handle while loop with nested async operations', async () => {
      const context = {
        state: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async innerOperation(val) {
            await delay(5);
            return val * 3;
          },
          async outerOperation(val) {
            await delay(2);
            const inner = await this.innerOperation(val);
            return inner + 1;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        }
      };

      const template = `
        {%- while state!.shouldContinue() -%}
          {%- set result = state.outerOperation(state.getValue()) -%}
          Processed: {{ result }},
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Processed: 4,Processed: 7,');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(3);
    });


    it('should handle while loop with empty body', async () => {
      const context = {
        state: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 3;
          }
        }
      };

      const template = `
        {% while state!.shouldContinue() %}
        {% endwhile %}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(4);
    });

    it('should handle while loop with empty body, no sequence operator', async () => {
      const context = {
        state: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 3;
          }
        }
      };

      const template = `
        {% while state.shouldContinue() %}
        {% endwhile %}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('');
      // Check context.counter manually after rendering
      expect(context.state.counter).to.equal(4);
    });

    it('should handle while loop with immediate false condition', async () => {
      const context = {
        async shouldContinue() {
          await delay(3);
          return false;
        },
        async getValue() {
          await delay(2);
          return 'should not execute';
        }
      };

      const template = `
        {% while shouldContinue() %}
          {{ getValue() }}
        {% endwhile %}
        Loop completed
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Loop completed');
    });

    it('should handle nested while loops without sequential operators', async () => {
      const context = {
        async getOuterMax() {
          await delay(3);
          return 2;
        },
        async getInnerMax() {
          await delay(2);
          return 3;
        },
        async getOuterValue(iteration) {
          await delay(2);
          return iteration;
        },
        async getInnerValue(iteration) {
          await delay(1);
          return iteration;
        }
      };

      const template = `
        {% set outerMax = getOuterMax() %}
        {% set innerMax = getInnerMax() %}
        {% set outerIter = 1 %}
        {%- while outerIter <= outerMax -%}
          Outer:{{ getOuterValue(outerIter) }},
          {%- set innerIter = 1 -%}
          {%- while innerIter <= innerMax -%}
            Inner:{{ getInnerValue(innerIter) }},
            {%- set innerIter = innerIter + 1 -%}
          {%- endwhile -%}
          {%- set outerIter = outerIter + 1 -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:1,Inner:2,Inner:3,Outer:2,Inner:1,Inner:2,Inner:3,');
    });

    it('should handle nested while loops with pure async functions', async () => {
      const context = {
        async getOuterCount() {
          await delay(3);
          return 2;
        },
        async getInnerCount() {
          await delay(2);
          return 3;
        },
        async getOuterValue(iteration) {
          await delay(1);
          return iteration;
        },
        async getInnerValue(iteration) {
          await delay(1);
          return iteration;
        }
      };

      const template = `
        {% set outerMax = getOuterCount() %}
        {% set innerMax = getInnerCount() %}
        {% set outerIter = 1 %}
        {%- while outerIter <= outerMax -%}
          Outer:{{ getOuterValue(outerIter) }},
          {%- set innerIter = 1 -%}
          {%- while innerIter <= innerMax -%}
            Inner:{{ getInnerValue(innerIter) }},
            {%- set innerIter = innerIter + 1 -%}
          {%- endwhile -%}
          {%- set outerIter = outerIter + 1 -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:1,Inner:2,Inner:3,Outer:2,Inner:1,Inner:2,Inner:3,');
    });

    it('should handle nested while loops with async iterators', async () => {
      const context = {
        async getOuterValues() {
          await delay(3);
          return [1, 2];
        },
        async getInnerValues(outerVal) {
          await delay(2);
          return [outerVal * 10, outerVal * 20];
        }
      };

      const template = `
        {% set outerValues = getOuterValues() %}
        {%- set outerIndex = 0 -%}
        {%- while outerIndex < outerValues.length -%}
          {%- set outerVal = outerValues[outerIndex] -%}
          Outer:{{ outerVal }},
          {%- set innerValues = getInnerValues(outerVal) -%}
          {%- set innerIndex = 0 -%}
          {%- while innerIndex < innerValues.length -%}
            Inner:{{ innerValues[innerIndex] }},
            {%- set innerIndex = innerIndex + 1 -%}
          {%- endwhile -%}
          {%- set outerIndex = outerIndex + 1 -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:10,Inner:20,Outer:2,Inner:20,Inner:40,');
    });

    it('should handle nested while loops with async data fetching', async () => {
      const context = {
        async getUsers() {
          await delay(3);
          return [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
        },
        async getUserPosts(userId) {
          await delay(2);
          if (userId === 1) {
            return [{ id: 1, title: 'Post 1' }, { id: 2, title: 'Post 2' }];
          } else {
            return [{ id: 3, title: 'Post 3' }];
          }
        },
        async getPostComments(postId) {
          await delay(1);
          return [{ id: 1, text: 'Comment 1' }, { id: 2, text: 'Comment 2' }];
        }
      };

      const template = `
        {% set users = getUsers() %}
        {% set userIndex = 0 %}
        {%- while userIndex < users.length -%}
          User:{{ users[userIndex].name }},
          {%- set posts = getUserPosts(users[userIndex].id) -%}
          {%- set postIndex = 0 -%}
          {%- while postIndex < posts.length -%}
            Post:{{ posts[postIndex].title }},
            {%- set comments = getPostComments(posts[postIndex].id) -%}
            {%- set commentIndex = 0 -%}
            {%- while commentIndex < comments.length -%}
              Comment:{{ comments[commentIndex].text }},
              {%- set commentIndex = commentIndex + 1 -%}
            {%- endwhile -%}
            {%- set postIndex = postIndex + 1 -%}
          {%- endwhile -%}
          {%- set userIndex = userIndex + 1 -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('User:Alice,Post:Post 1,Comment:Comment 1,Comment:Comment 2,Post:Post 2,Comment:Comment 1,Comment:Comment 2,User:Bob,Post:Post 3,Comment:Comment 1,Comment:Comment 2,');
    });

    it('should handle nested while loops with async calculations', async () => {
      const context = {
        async calculateOuter(iteration) {
          await delay(3);
          return iteration * 10;
        },
        async calculateInner(outerVal, iteration) {
          await delay(2);
          return outerVal + iteration;
        },
        async getOuterMax() {
          await delay(1);
          return 2;
        },
        async getInnerMax() {
          await delay(1);
          return 3;
        }
      };

      const template = `
        {% set outerMax = getOuterMax() %}
        {% set innerMax = getInnerMax() %}
        {% set outerIter = 1 %}
        {%- while outerIter <= outerMax -%}
          {%- set outerVal = calculateOuter(outerIter) -%}
          Outer:{{ outerVal }},
          {%- set innerIter = 1 -%}
          {%- while innerIter <= innerMax -%}
            {%- set innerVal = calculateInner(outerVal, innerIter) -%}
            Inner:{{ innerVal }},
            {%- set innerIter = innerIter + 1 -%}
          {%- endwhile -%}
          {%- set outerIter = outerIter + 1 -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:10,Inner:11,Inner:12,Inner:13,Outer:20,Inner:21,Inner:22,Inner:23,');
    });

    it.only('should handle nested while loops with async condition checks', async () => {
      const context = {
        async checkOuterCondition(iteration) {
          await delay(3);
          return iteration <= 2;
        },
        async checkInnerCondition(outerIter, innerIter) {
          await delay(2);
          return innerIter <= 3;
        },
        async getOuterValue(iteration) {
          await delay(1);
          return `O${iteration}`;
        },
        async getInnerValue(outerIter, innerIter) {
          await delay(1);
          return `I${outerIter}_${innerIter}`;
        }
      };

      const template = `
        {% set outerIter = 1 %}
        {%- while checkOuterCondition(outerIter) -%}
          {%- set outerVal = getOuterValue(outerIter) -%}
          {{ outerVal }},
          {%- set innerIter = 1 -%}
          {%- while checkInnerCondition(outerIter, innerIter) -%}
            {%- set innerVal = getInnerValue(outerIter, innerIter) -%}
            {{ innerVal }},
            {%- set innerIter = innerIter + 1 -%}
          {%- endwhile -%}
          {%- set outerIter = outerIter + 1 -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('O1,I1_1,I1_2,I1_3,O2,I2_1,I2_2,I2_3,');
    });

    it.only('should handle nested for loops with async condition checks', async () => {
      const context = {
        async checkOuterCondition(iteration) {
          await delay(3);
          return iteration <= 2;
        },
        async checkInnerCondition(outerIter, innerIter) {
          await delay(2);
          return innerIter <= 3;
        },
        async getOuterValue(iteration) {
          await delay(1);
          return `O${iteration}`;
        },
        async getInnerValue(outerIter, innerIter) {
          await delay(1);
          return `I${outerIter}_${innerIter}`;
        }
      };

      const template = `
        {% set outerIter = 1 %}
        {%- for _ in range(1, 3) -%}
          {%- set outerVal = getOuterValue(outerIter) -%}
          {{ outerVal }},
          {%- set innerIter = 1 -%}
          {%- for _ in range(1, 4) -%}
            {%- set innerVal = getInnerValue(outerIter, innerIter) -%}
            {{ innerVal }},
            {%- set innerIter = innerIter + 1 -%}
          {%- endfor -%}
          {%- set outerIter = outerIter + 1 -%}
        {%- endfor -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('O1,I1_1,I1_2,I1_3,O2,I2_1,I2_2,I2_3,');
    });

    it('should handle nested while loops with async conditions', async () => {
      const context = {
        outer: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        },
        inner: {
          counter: 0,
          async shouldContinue() {
            await delay(2);
            this.counter++;
            return this.counter <= 3;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        }
      };

      const template = `
        {%- while outer!.shouldContinue() -%}
          Outer:{{ outer.getValue() }},
          {%- while inner!.shouldContinue() -%}
            Inner:{{ inner.getValue() }},
          {%- endwhile -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:1,Inner:2,Inner:3,Outer:2,Inner:1,Inner:2,Inner:3,');
      expect(context.outer.counter).to.equal(3);
      expect(context.inner.counter).to.equal(6);
    });

    it('should handle nested while loops with sequential operators in both loops', async () => {
      const context = {
        outer: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        },
        inner: {
          counter: 0,
          async shouldContinue() {
            await delay(2);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        }
      };

      const template = `
        {%- while outer!.shouldContinue() -%}
          Outer:{{ outer!.getValue() }},
          {%- while inner!.shouldContinue() -%}
            Inner:{{ inner!.getValue() }},
          {%- endwhile -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:1,Inner:2,Outer:2,Inner:1,Inner:2,');
      expect(context.outer.counter).to.equal(3);
      expect(context.inner.counter).to.equal(4);
    });

    it('should handle nested while loops with sequential operator only in inner loop', async () => {
      const context = {
        outer: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        },
        inner: {
          counter: 0,
          async shouldContinue() {
            await delay(2);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        }
      };

      const template = `
        {%- while outer.shouldContinue() -%}
          Outer:{{ outer.getValue() }},
          {%- while inner!.shouldContinue() -%}
            Inner:{{ inner!.getValue() }},
          {%- endwhile -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:1,Inner:2,Outer:2,Inner:1,Inner:2,');
      expect(context.outer.counter).to.equal(3);
      expect(context.inner.counter).to.equal(4);
    });

    it('should handle nested while loops with sequential operator only in outer loop', async () => {
      const context = {
        outer: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        },
        inner: {
          counter: 0,
          async shouldContinue() {
            await delay(2);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        }
      };

      const template = `
        {%- while outer!.shouldContinue() -%}
          Outer:{{ outer!.getValue() }},
          {%- while inner.shouldContinue() -%}
            Inner:{{ inner.getValue() }},
          {%- endwhile -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:1,Inner:2,Outer:2,Inner:1,Inner:2,');
      expect(context.outer.counter).to.equal(3);
      expect(context.inner.counter).to.equal(4);
    });

    it('should handle deeply nested while loops with sequential operators', async () => {
      const context = {
        level1: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        },
        level2: {
          counter: 0,
          async shouldContinue() {
            await delay(2);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        },
        level3: {
          counter: 0,
          async shouldContinue() {
            await delay(1);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        }
      };

      const template = `
        {%- while level1!.shouldContinue() -%}
          L1:{{ level1!.getValue() }},
          {%- while level2!.shouldContinue() -%}
            L2:{{ level2!.getValue() }},
            {%- while level3!.shouldContinue() -%}
              L3:{{ level3!.getValue() }},
            {%- endwhile -%}
          {%- endwhile -%}
        {%- endwhile -%}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('L1:1,L2:1,L3:1,L3:2,L2:2,L3:1,L3:2,L1:2,L2:1,L3:1,L3:2,L2:2,L3:1,L3:2,');
      expect(context.level1.counter).to.equal(3);
      expect(context.level2.counter).to.equal(4);
      expect(context.level3.counter).to.equal(8);
    });

    it('should handle nested while loops with variable modification', async () => {
      const context = {
        outer: {
          counter: 0,
          async shouldContinue() {
            await delay(3);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(2);
            return this.counter;
          }
        },
        inner: {
          counter: 0,
          async shouldContinue() {
            await delay(2);
            this.counter++;
            return this.counter <= 2;
          },
          async getValue() {
            await delay(1);
            return this.counter;
          }
        }
      };

      const template = `
        {% set total = 0 %}
        {%- while outer!.shouldContinue() -%}
          {% set outerVal = outer!.getValue() %}
          Outer:{{ outerVal }},
          {%- while inner!.shouldContinue() -%}
            {% set innerVal = inner!.getValue() %}
            {% set total = total + outerVal + innerVal %}
            Inner:{{ innerVal }},
          {%- endwhile -%}
        {%- endwhile -%}
        Total:{{ total }}
      `;

      const result = await env.renderString(template, context);
      expect(result.trim()).to.equal('Outer:1,Inner:1,Inner:2,Outer:2,Inner:1,Inner:2,Total:12');
      expect(context.outer.counter).to.equal(3);
      expect(context.inner.counter).to.equal(4);
    });

  }); // End While Loops

})();
