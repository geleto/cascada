'use strict';

let expect;
let AsyncEnvironment;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../src/environment').AsyncEnvironment;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
}

describe('Cascada Script: Output commands', function () {
  let env;

  // For each test, create a fresh environment.
  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  /**
   * This test demonstrates the core "Collect, Execute, Assemble" model.
   * - Independent `set` operations (data fetching) run in parallel.
   * - All `@` commands are buffered and executed sequentially *after* the parallel fetches complete.
   * - The `:data` directive focuses the final output on the assembled data object.
   */
  it('should run independent operations in parallel and assemble the result object', async () => {
    const context = {
      // Simulate async data fetching for different resources.
      fetchData: async (source) => {
        if (source === 'users') return [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
        if (source === 'config') return { theme: 'dark', version: '1.5' };
        return null;
      }
    };

    const script = `
      // Focus the script's return value to be just the data object.
      :data

      // These two 'var' declarations are independent and will run in parallel.
      var userList = fetchData('users')
      var appConfig = fetchData('config')

      // The '@' commands are buffered. They run sequentially AFTER the parallel
      // operations above complete, using their now-resolved values.
      @data.result.users.set(userList)
      @data.result.config.merge(appConfig)
      @data.result.config.loaded.set(true)
      @data.result.log.push("Data fetch complete")
    `;

    const result = await env.renderScriptString(script, context);

    // The final result should be the assembled data object, not a string.
    expect(result).to.eql({
      result: {
        users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        config: { theme: 'dark', version: '1.5', loaded: true },
        log: ['Data fetch complete']
      }
    });
  });

  /**
   * This test demonstrates using macros as reusable, parallel components.
   * - A macro defines a self-contained unit of work with its own parallel operations.
   * - The `:data` directive on the macro ensures it returns a clean data object.
   * - Multiple calls to the same macro run concurrently.
   * - The main script assembles its final output only after all macro calls have completed.
   */
  it('should execute macros in parallel and use their focused results for final assembly', async () => {
    const context = {
      fetchUser: async (id) => {
        const users = {
          1: { id: 1, name: 'Alice' },
          2: { id: 2, name: 'Bob' },
        };
        return users[id];
      },
      fetchTasks: async (userId) => {
        const tasks = {
          1: ['Review PR', 'Update docs'],
          2: ['Deploy to staging'],
        };
        return tasks[userId];
      }
    };

    const script = `
      // The main script will also return only its data object.
      :data

      // Define a reusable component. The ':data' directive ensures
      // this macro returns a clean data object, not { data: {...} }.
      macro buildUserReport(id) : data
        // These two fetches inside the macro also run in parallel.
        var userData = fetchUser(id)
        var tasksData = fetchTasks(id)

        // Assemble the macro's own return value. This happens after
        // its internal fetches are complete.
        @data.user.id = userData.id
        @data.user.name = userData.name
        @data.user.tasks = tasksData
      endmacro

      // Call the macro for different users. These two calls are independent
      // and will execute in parallel.
      var report1 = buildUserReport(1)
      var report2 = buildUserReport(2)

      // The final assembly step for the main script. This block waits for
      // both 'report1' and 'report2' to be fully resolved before running.
      @data.reports.user1 = report1.user
      @data.reports.user2 = report2.user
      @data.reports.summary = "Generated 2 reports"
    `;

    const result = await env.renderScriptString(script, context);

    // The final result combines the outputs of the parallel macro calls.
    expect(result).to.eql({
      reports: {
        user1: {
          id: 1,
          name: 'Alice',
          tasks: ['Review PR', 'Update docs']
        },
        user2: {
          id: 2,
          name: 'Bob',
          tasks: ['Deploy to staging']
        },
        summary: 'Generated 2 reports'
      }
    });
  });

  describe('Built-in Data Commands', function() {
    it('should handle @data assignment, @data.push, @data.merge, and @data.deepMerge', async () => {
      const script = `
        :data
        // Set creates/replaces values
        @data.user.name = "Alice"
        @data.user.role = "Admin"
        @data.user.role = "Super-Admin" // Overwrites previous set

        // Push adds to an array, creating it if needed
        @data.user.tags.push("active")
        @data.user.tags.push("new")

        // Merge combines objects
        @data.settings.profile = { theme: "light" }
        @data.settings.profile.merge({ notifications: true })

        // Deep merge combines nested objects
        @data.settings.deep = { a: { b: 1 } }
        @data.settings.deep.deepMerge({ a: { c: 2 }, d: 3 })
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        user: { name: 'Alice', role: 'Super-Admin', tags: ['active', 'new'] },
        settings: {
          profile: { theme: 'light', notifications: true },
          deep: { a: { b: 1, c: 2 }, d: 3 }
        }
      });
    });

    it('should handle null path to work on the root of the data object', async () => {
      const script = `
        :data
        // Set the entire data object to a new value
        @data = { name: 'George', age: 30 }

        // This should replace the entire object, not add to it
        @data = { status: 'active', role: 'user' }
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        status: 'active',
        role: 'user'
      });
    });

    it('should handle null path with merge to combine with existing root data', async () => {
      const script = `
        :data
        // Start with some initial data
        @data.user.name = "Alice"
        @data.user.role = "Admin"

        // Merge new data into the root object
        @data.deepMerge({ user: { status: "active" }, config: { theme: "dark" } })
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        user: { name: 'Alice', role: 'Admin', status: 'active' },
        config: { theme: 'dark' }
      });
    });

    it('should handle null path with deepMerge for nested object merging', async () => {
      const script = `
        :data
        // Start with nested data
        @data.user.profile.name = "Bob"
        @data.user.profile.settings.theme = "light"

        // Deep merge new data into the root object
        @data.deepMerge({
          user: {
            profile: {
              settings: { notifications: true },
              email: "bob@example.com"
            }
          }
        })
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        user: {
          profile: {
            name: 'Bob',
            settings: { theme: 'light', notifications: true },
            email: 'bob@example.com'
          }
        }
      });
    });

    it('should handle array manipulation with @data.pop, @data.shift, @data.unshift, and @data.reverse', async () => {
      const script = `
        :data
        @data.items.push("a")
        @data.items.push("b")
        @data.items.push("c")
        @data.items.push("d")

        @data.items.pop() // remove "d" -> [a, b, c]
        @data.items.shift() // remove "a" -> [b, c]
        @data.items.unshift("x") // add "x" -> [x, b, c]
        @data.items.reverse() // -> [c, b, x]
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: ['c', 'b', 'x'] });
    });

    it('should handle array index targeting including last-item `[]`', async () => {
      const script = `
        :data
        @data.users.push({ name: 'Alice', tasks: ['task1', 'task2'] })
        @data.users.push({ name: 'Bob' })

        // Target specific index
        @data.users[0].role = "Admin"

        // Target last item pushed in script sequence
        @data.users.push({ name: 'Charlie' })
        @data.users[].role = "Guest" // Affects Charlie

        @data.users[1].status = "active" // Affects Bob
        @data.users[0].tasks[] = "task3" //change the last task of Alice
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        users: [
          { name: 'Alice', role: 'Admin', tasks: ['task1', 'task3'] },
          { name: 'Bob', status: 'active' },
          { name: 'Charlie', role: 'Guest' }
        ]
      });
    });

    it('should handle @data.push with function call in array index', async () => {
      const script = `
        :data
        @data.users = usersData
        @data.users[getUserIndex()].roles.push("editor")
      `;
      const context = {
        getUserIndex: () => 0,
        usersData: [
          { name: 'Alice', roles: ['admin'] },
          { name: 'Bob', roles: ['user'] }
        ]
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        users: [
          { name: 'Alice', roles: ['admin', 'editor'] },
          { name: 'Bob', roles: ['user'] }
        ]
      });
    });

    it('should handle @data.merge with dynamic path', async () => {
      const script = `
        :data
        @data.company = companyData
        @data.company.departments[getDeptId()].merge({ budget: 50000 })
      `;
      const context = {
        getDeptId: () => 'engineering',
        companyData: {
          departments: {
            engineering: { name: 'Engineering', staff: 10 },
            marketing: { name: 'Marketing', staff: 5 }
          }
        }
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        company: {
          departments: {
            engineering: { name: 'Engineering', staff: 10, budget: 50000 },
            marketing: { name: 'Marketing', staff: 5 }
          }
        }
      });
    });

    it('should handle @data assignment with nested dynamic paths', async () => {
      const script = `
        :data
        @data.company = companyData
        @data.company.users[getUserId()].profile.settings[getSettingKey()] = "enabled"
      `;
      const context = {
        getUserId: () => 0,
        getSettingKey: () => 'notifications',
        companyData: {
          users: [
            {
              name: 'Alice',
              profile: {
                settings: {
                  theme: 'dark'
                }
              }
            }
          ]
        }
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        company: {
          users: [
            {
              name: 'Alice',
              profile: {
                settings: {
                  theme: 'dark',
                  notifications: 'enabled'
                }
              }
            }
          ]
        }
      });
    });

    it('should handle @data.append with dynamic path', async () => {
      const script = `
        :data
        @data.company = companyData
        @data.company.users[getUserId()].log.append(" - User logged in")
      `;
      const context = {
        getUserId: () => 0,
        companyData: {
          users: [
            { name: 'Alice', log: 'Session started' },
            { name: 'Bob', log: 'Session started' }
          ]
        }
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        company: {
          users: [
            { name: 'Alice', log: 'Session started - User logged in' },
            { name: 'Bob', log: 'Session started' }
          ]
        }
      });
    });

    it('should handle @data.pop with dynamic array index', async () => {
      const script = `
        :data
        @data.users = usersData
        @data.users[getUserIndex()].items.pop()
      `;
      const context = {
        getUserIndex: () => 1,
        usersData: [
          { name: 'Alice', items: ['item1', 'item2'] },
          { name: 'Bob', items: ['item3', 'item4', 'item5'] }
        ]
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        users: [
          { name: 'Alice', items: ['item1', 'item2'] },
          { name: 'Bob', items: ['item3', 'item4'] }
        ]
      });
    });

    it('should handle @data.shift with dynamic array index', async () => {
      const script = `
        :data
        @data.users = usersData
        @data.users[getUserIndex()].tasks.shift()
      `;
      const context = {
        getUserIndex: () => 0,
        usersData: [
          { name: 'Alice', tasks: ['task1', 'task2', 'task3'] },
          { name: 'Bob', tasks: ['task4'] }
        ]
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        users: [
          { name: 'Alice', tasks: ['task2', 'task3'] },
          { name: 'Bob', tasks: ['task4'] }
        ]
      });
    });

    it('should handle @data.unshift with dynamic array index', async () => {
      const script = `
        :data
        @data.users = usersData
        @data.users[getUserIndex()].tasks.unshift("urgent")
      `;
      const context = {
        getUserIndex: () => 1,
        usersData: [
          { name: 'Alice', tasks: ['task1'] },
          { name: 'Bob', tasks: ['task2', 'task3'] }
        ]
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        users: [
          { name: 'Alice', tasks: ['task1'] },
          { name: 'Bob', tasks: ['urgent', 'task2', 'task3'] }
        ]
      });
    });

    it('should handle @data.reverse with dynamic array index', async () => {
      const script = `
        :data
        @data.users = usersData
        @data.users[getUserIndex()].items.reverse()
      `;
      const context = {
        getUserIndex: () => 0,
        usersData: [
          { name: 'Alice', items: ['a', 'b', 'c'] },
          { name: 'Bob', items: ['x', 'y'] }
        ]
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        users: [
          { name: 'Alice', items: ['c', 'b', 'a'] },
          { name: 'Bob', items: ['x', 'y'] }
        ]
      });
    });
  });

  describe('@text command', function() {
    it('should append to global text stream and return in the text property', async () => {
      const script = `
        @text("Hello")
        @text(", ")
        @text("World!")
        @data.status = "ok"
      `;
      // No focus, so we get the full result object
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        data: { status: 'ok' },
        text: 'Hello, World!'
      });
    });

    it('should append to a path in the data object with @data.append', async () => {
      const script = `
        :data
        @data.log = "Log started. "
        @data.log.append("Event 1. ")
        @data.log.append("Event 2.")
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
    });

    it('should focus the output to just the text stream with :text', async () => {
      const script = `
        :text
        @text("This is ")
        @text("the final text.")
        @data.status = "ignored"
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.equal('This is the final text.');
    });
  });

  describe('Customization and Extension', function() {
    it('should support custom data methods via addDataMethods', async () => {
      env.addDataMethods({
        upsert: (target, data) => {
          if (!Array.isArray(target)) return;
          const index = target.findIndex(item => item.id === data.id);
          if (index > -1) Object.assign(target[index], data);
          else target.push(data);
          return target;
        }
      });
      const script = `
        :data
        @data.users.push({ id: 1, name: "Alice", status: "active" })
        @data.users.push({ id: 2, name: "Bob" })
        @data.users.upsert({ id: 1, status: "inactive" }) // Updates Alice
        @data.users.upsert({ id: 3, name: "Charlie" })    // Adds Charlie
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        users: [
          { id: 1, name: 'Alice', status: 'inactive' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Charlie' }
        ]
      });
    });

    it('should support custom handlers with the Factory pattern (addCommandHandlerClass)', async () => {
      class Turtle {
        constructor() { this.x = 0; this.y = 0; }
        forward(dist) { this.x += dist; }
        turn(deg) { this.y += deg; } // simplified for test
      }
      env.addCommandHandlerClass('turtle', Turtle);
      const script = `
        @turtle.forward(50)
        @turtle.turn(90)
        @turtle.forward(10)
      `;
      const result = await env.renderScriptString(script);
      // The final state of the handler instance is added to the result object
      expect(result.turtle).to.be.a(Turtle);
      expect(result.turtle.x).to.equal(60);
      expect(result.turtle.y).to.equal(90);
    });

    it('Supports callable callable command handlers - no path', async () => {
      class Logger {
        constructor() {
          this.logs = [];
          const callable = (...args) => this._call(...args);
          callable.logs = this.logs;
          return callable;
        }
        _call(text) {
          this.logs.push(text);
        }
      };

      env.addCommandHandler('log', new Logger());
      const script = `
        @log("user1 logged in")
        @log("user2 logged in")
      `;
      const result = await env.renderScriptString(script);
      // The same logger instance is modified
      expect(result.log.logs).to.eql(['user1 logged in', 'user2 logged in']);
    });

    it('should support custom handlers with the Singleton pattern (addCommandHandler) - 1 segment path', async () => {
      const logger = {
        log: [],
        login: function(user) {
          this.log.push(`login(${user})`);
        },
        action: function(action, doc) {
          this.log.push(`action(${action},${doc})`);
        },
      };
      env.addCommandHandler('audit', logger);
      const script = `
        @audit.login("user1")
        @audit.action("read", "doc1")
      `;
      await env.renderScriptString(script);
      // The same logger instance is modified
      expect(logger.log).to.eql(['login(user1)', 'action(read,doc1)']);
    });

    it('should support multi-segment path handlers - 2 segments path', async () => {
      // Create a utility object with nested structure
      class OutputLogger {
        constructor() {
          this.logs = [];
          this.errors = [];
          this.warnings = [];
        }
        log(message) {
          this.logs.push(message);
        }
        error(message) {
          this.errors.push(message);
        }
        warn(message) {
          this.warnings.push(message);
        }
      }
      const util = {
        output: new OutputLogger()
      };
      env.addCommandHandler('util', util);

      const script = `
        @util.output.log("User logged in")
        @util.output.error("Connection failed")
        @util.output.warn("Deprecated feature used")
      `;

      const result = await env.renderScriptString(script);

      // Verify the multi-segment handler is accessible and functional
      expect(result.util).to.equal(util);
      expect(result.util.output).to.be.an(OutputLogger);
      expect(result.util.output.logs).to.eql(['User logged in']);
      expect(result.util.output.errors).to.eql(['Connection failed']);
      expect(result.util.output.warnings).to.eql(['Deprecated feature used']);
    });
  });

  describe('Scoping and Control', function() {
    it('should use a capture block to capture output without focusing', async () => {
      const script = `
        :data
        var captured = capture
          @data.user.name = "Captured User"
          @text("hello from capture")
        endcapture
        @data.result = captured
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        result: {
          data: { user: { name: 'Captured User' } },
          text: 'hello from capture'
        }
      });
    });

    it('should focus the output to a custom handler result with :handlerName', async () => {
      class Turtle {
        constructor() { this.x = 0; this.y = 0; }
        forward(dist) { this.x += dist; }
      }
      env.addCommandHandlerClass('turtle', Turtle);
      const script = `
        :turtle // Focus the script's return value on the 'turtle' handler
        @turtle.forward(100)
        @data.status = "ignored"
      `;
      const result = await env.renderScriptString(script);
      // The result is just the turtle object, not the full result container
      expect(result).to.be.a(Turtle);
      expect(result.x).to.equal(100);
      expect(result.data).to.be(undefined);
    });

    it('should allow input focusing in capture blocks', async () => {
      const script = `
        // The capture block's output is focused to just the data object
        :data
        var userData = capture :data
          var user = { name: "Bob", role: "user" }
          @data.name = user.name
          @data.role = user.role
        endcapture

        @data.result.user = userData
      `;

      const result = await env.renderScriptString(script, {});

      expect(result).to.eql({
        result: {
          user: {
            name: 'Bob',
            role: 'user'
          }
        }
      });
    });
  });

  it('should allow input focusing in capture blocks', async () => {
    const script = `
      // The set block's output is focused to just the data object
      :data
      var captured = capture
        @data.user.name = "Captured User"
        @text("hello from capture")
      endcapture
      @data.result = captured
    `;

    const result = await env.renderScriptString(script, {});

    expect(result).to.eql({
      result: {
        data: { user: { name: 'Captured User' } },
        text: 'hello from capture'
      }
    });
  });

  it(`should not allow input focusing after the '=' in var assignments`, async () => {
    const script = `
      // This should throw an error since :data cannot be used
      // with direct assignment
      var userData = :data { name: "Charlie" }
    `;

    try {
      await env.renderScriptString(script, {});
      throw new Error('Expected an error to be thrown');
    } catch (error) {
      expect(error.message).to.contain('unexpected token: :');
    }
  });

  it('should not allow input focusing at the end of var assignments', async () => {
    const script = `
      // This should throw an error since :data cannot be used
      // with direct assignment
      var userData = { name: "Charlie" } :data
    `;

    try {
      await env.renderScriptString(script, {});
      throw new Error('Expected an error to be thrown');
    } catch (error) {
      expect(error.message).to.contain('expected block end in var statement');
    }
  });

  describe('Script Transpiler: @-Command Integration Tests', () => {
    beforeEach(() => {
      // Create a fresh environment for each test to ensure isolation
      env = new AsyncEnvironment();
    });

    // ========================================================================
    // Group 1: Expression-style @text() -> {{ expression }} -> result.text
    //
    // These tests verify that when `@text()` is used with a single argument
    // or a complex expression, it correctly transpiles to a Nunjucks
    // output tag `{{ ... }}` and contributes to the `text` property of the result.
    // ========================================================================
    describe('Expression-style @text() (generates text output)', () => {

      it('should handle a simple path-like expression', async () => {
        const script = '@text(user.name)';
        const context = { user: { name: 'Alice' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Alice');
      });

      it('should handle a simple path-like expression with trailing whitespace', async () => {
        const script = '@text(user.name)  ';
        const context = { user: { name: 'Alice' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Alice');
      });

      it('should handle an expression with a binary operator', async () => {
        const script = '@text("Hello, " + user.name)';
        const context = { user: { name: 'Bob' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Hello, Bob');
      });

      it('should handle an expression starting with a string literal', async () => {
        const script = '@text("Hello World")';
        const result = await env.renderScriptString(script, {});
        expect(result.text).to.equal('Hello World');
      });

      it('should handle an expression that is a function call', async () => {
        const script = '@text(format(user.name))';
        const context = {
          user: { name: 'charlie' },
          format: (str) => str.toUpperCase()
        };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('CHARLIE');
      });

      it('should handle a path-like expression broken by a filter', async () => {
        const script = '@text(user.name|title)';
        const context = { user: { name: 'dave' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Dave');
      });

      it('should handle a path-like expression broken by a math operator', async () => {
        const script = '@text(user.id + 1)';
        const context = { user: { id: 99 } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('100');
      });

      it('should handle a path-like expression broken by parenthesis', async () => {
        const script = '@text((user.name))';
        const context = { user: { name: 'Eve' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Eve');
      });

      it('should handle an expression with multiple path-like parts', async () => {
        const script = '@text(user.name + " " + user.lastName)';
        const context = { user: { name: 'Frank', lastName: 'Castle' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Frank Castle');
      });

      it('should handle an expression with a path broken by internal whitespace', async () => {
        // Transpiles to `{{ user. firstName }}`, where `user.` is undefined.
        // Nunjucks treats `undefined` as an empty string in concatenation.
        const script = '@text(user. firstName)';
        const context = { user: {firstName: 'Grace'} };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Grace');
      });

      it('should handle an object as an expression', async () => {
        const script = '@text(user)';
        const context = {user: 'John'};
        const result = await env.renderScriptString(script, context);
        // Nunjucks default object stringification
        expect(result.text).to.equal('John');
      });
    });


    // ========================================================================
    // Group 2: Statement-style Commands -> {% ... %} -> result.data
    //
    // These tests verify that when a command is used with a distinct path
    // and value (e.g., `@data.set`, `@data.append`), it correctly transpiles
    // to a `statement_command` tag and modifies the `data` property of the result.
    // ========================================================================
    describe('Statement-style commands (modifies data output)', () => {
      it('should handle @data assignment with a simple path and string value', async () => {
        const script = `
                :data
                @data.user.name = "Alice"
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Alice' } });
      });

      it('should handle @data assignment with a path and a variable value', async () => {
        const script = `
                :data
                var userId = 123
                @data.user.profile.id = userId
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { profile: { id: 123 } } });
      });

      it('should handle @data assignment with a complex expression in brackets', async () => {
        const script = `
                :data
                var key = "complex"
                @data.items[key + "Id"] = "value"
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ items: { complexId: 'value' } });
      });

      it('should handle statement-style @data.append to append to a data path', async () => {
        // Note: statement-style @data.append APPENDS, it doesn't set.
        const script = `
                :data
                @data.log = "Log started. "
                @data.log.append("Event 1. ")
                @data.log.append("Event 2.")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
      });

      it('should handle command with path but no value argument (@data.pop)', async () => {
        const script = `
                :data
                @data.user.items = ["a", "b", "c"]
                @data.user.items.pop()
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: ['a', 'b'] } });
      });

      it('should handle command with no arguments (@data.reverse) on a path', async () => {
        // Note: The built-in @data.reverse command requires a path.
        // A command like @data.reverse with no args is valid syntax but would
        // throw an error in the handler. Here we test a valid use case.
        const script = `
                :data
                @data.user.items = [1, 2, 3]
                @data.user.items.reverse()
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: [3, 2, 1] } });
      });

      it('should ignore comments between command parts', async () => {
        const script = `
                :data
                @data.user.name = "Heidi"
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Heidi' } });
      });
    });

    describe('Dynamic path commands (function calls and expressions in paths)', () => {
      it('should handle @data assignment with function call in array index', async () => {
        const script = `
          :data
          @data.company = companyData
          @data.company.users[getUserId()].name = "Alice"
        `;
        const context = {
          getUserId: () => 0,
          companyData: {
            users: [
              { name: 'Bob' },
              { name: 'Charlie' }
            ]
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            users: [
              { name: 'Alice' },
              { name: 'Charlie' }
            ]
          }
        });
      });

      it('should handle @data assignment with function call returning string key', async () => {
        const script = `
          :data
          @data.company = companyData
          @data.company.users[getUserKey()].status = "active"
        `;
        const context = {
          getUserKey: () => 'admin',
          companyData: {
            users: {
              admin: { name: 'Admin User' },
              guest: { name: 'Guest User' }
            }
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            users: {
              admin: { name: 'Admin User', status: 'active' },
              guest: { name: 'Guest User' }
            }
          }
        });
      });

      it('should handle @data assignment with expression in array index', async () => {
        const script = `
          :data
          @data.items = itemsData
          var index = 1
          @data.items[index + 1].name = "Item C"
        `;
        const context = {
          itemsData: [
            { name: 'Item A' },
            { name: 'Item B' },
            { name: 'Item D' }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          items: [
            { name: 'Item A' },
            { name: 'Item B' },
            { name: 'Item C' }
          ]
        });
      });

      it('should handle @data assignment with complex expression in object key', async () => {
        const script = `
          :data
          @data.data = dataSource
          var prefix = "user"
          var suffix = "Profile"
          @data.data[prefix + suffix].name = "Dynamic User"
        `;
        const context = {
          dataSource: {
            userProfile: { id: 1 },
            otherProfile: { id: 2 }
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          data: {
            userProfile: { id: 1, name: 'Dynamic User' },
            otherProfile: { id: 2 }
          }
        });
      });

      it('should handle @data.push with function call in array index', async () => {
        const script = `
          :data
          @data.users = usersData
          @data.users[getUserIndex()].roles.push("editor")
        `;
        const context = {
          getUserIndex: () => 0,
          usersData: [
            { name: 'Alice', roles: ['admin'] },
            { name: 'Bob', roles: ['user'] }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice', roles: ['admin', 'editor'] },
            { name: 'Bob', roles: ['user'] }
          ]
        });
      });

      it('should handle @data.merge with dynamic path', async () => {
        const script = `
          :data
          @data.company = companyData
          @data.company.departments[getDeptId()].merge({ budget: 50000 })
        `;
        const context = {
          getDeptId: () => 'engineering',
          companyData: {
            departments: {
              engineering: { name: 'Engineering', staff: 10 },
              marketing: { name: 'Marketing', staff: 5 }
            }
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            departments: {
              engineering: { name: 'Engineering', staff: 10, budget: 50000 },
              marketing: { name: 'Marketing', staff: 5 }
            }
          }
        });
      });

      it('should handle @data.deepMerge with nested dynamic paths', async () => {
        const script = `
          :data
          @data.company = companyData
          @data.company.users[0].profile.settings.notifications = "enabled"
          @data.company.users[getUserId()].profile.settings.deepMerge({ theme: "dark" })
        `;
        const context = {
          getUserId: () => 0,
          getSettingKey: () => 'notifications',
          companyData: {
            users: [
              {
                name: 'Alice',
                profile: {
                  settings: {
                    theme: 'dark'
                  }
                }
              }
            ]
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            users: [
              {
                name: 'Alice',
                profile: {
                  settings: {
                    theme: 'dark',
                    notifications: 'enabled'
                  }
                }
              }
            ]
          }
        });
      });

      it('should handle @data.append with dynamic path', async () => {
        const script = `
          :data
          @data.company = companyData
          @data.company.users[getUserId()].log.append(" - User logged in")
        `;
        const context = {
          getUserId: () => 0,
          companyData: {
            users: [
              { name: 'Alice', log: 'Session started' },
              { name: 'Bob', log: 'Session started' }
            ]
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            users: [
              { name: 'Alice', log: 'Session started - User logged in' },
              { name: 'Bob', log: 'Session started' }
            ]
          }
        });
      });

      it('should handle @data.pop with dynamic array index', async () => {
        const script = `
          :data
          @data.users = usersData
          @data.users[getUserIndex()].items.pop()
        `;
        const context = {
          getUserIndex: () => 1,
          usersData: [
            { name: 'Alice', items: ['item1', 'item2'] },
            { name: 'Bob', items: ['item3', 'item4', 'item5'] }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice', items: ['item1', 'item2'] },
            { name: 'Bob', items: ['item3', 'item4'] }
          ]
        });
      });

      it('should handle @data.shift with dynamic array index', async () => {
        const script = `
          :data
          @data.users = usersData
          @data.users[getUserIndex()].tasks.shift()
        `;
        const context = {
          getUserIndex: () => 0,
          usersData: [
            { name: 'Alice', tasks: ['task1', 'task2', 'task3'] },
            { name: 'Bob', tasks: ['task4'] }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice', tasks: ['task2', 'task3'] },
            { name: 'Bob', tasks: ['task4'] }
          ]
        });
      });

      it('should handle @data.unshift with dynamic array index', async () => {
        const script = `
          :data
          @data.users = usersData
          @data.users[getUserIndex()].tasks.unshift("urgent")
        `;
        const context = {
          getUserIndex: () => 1,
          usersData: [
            { name: 'Alice', tasks: ['task1'] },
            { name: 'Bob', tasks: ['task2', 'task3'] }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice', tasks: ['task1'] },
            { name: 'Bob', tasks: ['urgent', 'task2', 'task3'] }
          ]
        });
      });

      it('should handle @data.reverse with dynamic array index', async () => {
        const script = `
          :data
          @data.users = usersData
          @data.users[getUserIndex()].items.reverse()
        `;
        const context = {
          getUserIndex: () => 0,
          usersData: [
            { name: 'Alice', items: ['a', 'b', 'c'] },
            { name: 'Bob', items: ['x', 'y'] }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice', items: ['c', 'b', 'a'] },
            { name: 'Bob', items: ['x', 'y'] }
          ]
        });
      });

      it('should handle multiple dynamic paths in sequence', async () => {
        const script = `
          :data
          @data.company = companyData
          @data.company.users[getUserId()].name = "Updated User"
          @data.company.users[getUserId()].roles.push("manager")
          @data.company.departments[getDeptId()].head = getUserId()
        `;
        const context = {
          getUserId: () => 1,
          getDeptId: () => 'engineering',
          companyData: {
            users: [
              { name: 'Alice', roles: ['admin'] },
              { name: 'Bob', roles: ['user'] }
            ],
            departments: {
              engineering: { name: 'Engineering' },
              marketing: { name: 'Marketing' }
            }
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            users: [
              { name: 'Alice', roles: ['admin'] },
              { name: 'Updated User', roles: ['user', 'manager'] }
            ],
            departments: {
              engineering: { name: 'Engineering', head: 1 },
              marketing: { name: 'Marketing' }
            }
          }
        });
      });

      it('should handle dynamic path with async function call', async () => {
        const script = `
          :data
          @data.users = usersData
          var userId = getUserIdAsync()
          @data.users[userId].status = "active"
        `;
        const context = {
          getUserIdAsync: async () => 0,
          usersData: [
            { name: 'Alice' },
            { name: 'Bob' }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice', status: 'active' },
            { name: 'Bob' }
          ]
        });
      });

      it('should handle dynamic path with conditional expression', async () => {
        const script = `
          :data
          @data.users = usersData
          var isAdmin = true
          @data.users[0 if isAdmin else 1].role = "admin"
        `;
        const context = {
          usersData: [
            { name: 'Alice' },
            { name: 'Bob' }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice', role: 'admin' },
            { name: 'Bob' }
          ]
        });
      });

      it('should handle dynamic path with mathematical expression', async () => {
        const script = `
          :data
          @data.items = itemsData
          var baseIndex = 2
          @data.items[baseIndex * 2 - 1].priority = "high"
        `;
        const context = {
          itemsData: [
            { name: 'Item 1' },
            { name: 'Item 2' },
            { name: 'Item 3' },
            { name: 'Item 4' },
            { name: 'Item 5' }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          items: [
            { name: 'Item 1' },
            { name: 'Item 2' },
            { name: 'Item 3' },
            { name: 'Item 4', priority: 'high' },
            { name: 'Item 5' }
          ]
        });
      });

      it('should handle dynamic path with nested function calls', async () => {
        const script = `
          :data
          @data.company = companyData
          @data.company.users[getNestedUserId()].profile.settings[getSettingKey()] = "enabled"
        `;
        const context = {
          getNestedUserId: () => 0,
          getSettingKey: () => 'notifications',
          companyData: {
            users: [
              {
                name: 'Alice',
                profile: {
                  settings: {
                    theme: 'dark'
                  }
                }
              }
            ]
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            users: [
              {
                name: 'Alice',
                profile: {
                  settings: {
                    theme: 'dark',
                    notifications: 'enabled'
                  }
                }
              }
            ]
          }
        });
      });

      it('should handle dynamic path with array method call result', async () => {
        const script = `
          :data
          @data.users = usersData
          @data.users[getUserIndex()].name = "Updated Name"
        `;
        const context = {
          getUserIndex: () => {
            return 1;
          },
          usersData: [
            { name: 'Alice' },
            { name: 'Bob' },
            { name: 'Charlie' }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          users: [
            { name: 'Alice' },
            { name: 'Updated Name' },
            { name: 'Charlie' }
          ]
        });
      });
    });
  });

  describe('New Arithmetic and Logical @data Commands', function() {
    describe('Arithmetic Operations', function() {
      it('should handle @data.add with numbers', async () => {
        const script = `
          :data
          @data.counter = 10
          @data.counter += 5
          @data.counter += 3
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 18
        });
      });

      it('should handle @data.add with strings', async () => {
        const script = `
          :data
          @data.message = "Hello"
          @data.message += " World"
          @data.message += "!"
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          message: 'Hello World!'
        });
      });

      it('should handle @data.add with undefined target', async () => {
        const script = `
          :data
          @data.counter += 10
          @data.message += "Hello"
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'add\' cannot be undefined or null');
        }
      });

      it('should handle @data.subtract', async () => {
        const script = `
          :data
          @data.counter = 20
          @data.counter -= 5
          @data.counter -= 3
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 12
        });
      });

      it('should handle @data.subtract with undefined target', async () => {
        const script = `
          :data
          @data.counter -= 10
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'subtract\' cannot be undefined or null');
        }
      });

      it('should handle @data.increment', async () => {
        const script = `
          :data
          @data.counter = 5
          @data.counter++
          @data.counter++
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 7
        });
      });

      it('should handle @data.increment with undefined target', async () => {
        const script = `
          :data
          @data.counter++
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'increment\' cannot be undefined or null');
        }
      });

      it('should handle @data.decrement', async () => {
        const script = `
          :data
          @data.counter = 10
          @data.counter--
          @data.counter--
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 8
        });
      });

      it('should handle @data.decrement with undefined target', async () => {
        const script = `
          :data
          @data.counter--
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'decrement\' cannot be undefined or null');
        }
      });

      it('should handle @data.multiply', async () => {
        const script = `
          :data
          @data.counter = 5
          @data.counter *= 3
          @data.counter *= 2
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 30
        });
      });

      it('should handle @data.multiply with undefined target', async () => {
        const script = `
          :data
          @data.counter *= 5
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'multiply\' cannot be undefined or null');
        }
      });

      it('should handle @data.divide', async () => {
        const script = `
          :data
          @data.counter = 100
          @data.counter /= 2
          @data.counter /= 5
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 10
        });
      });

      it('should handle @data.divide with undefined target', async () => {
        const script = `
          :data
          @data.counter /= 2
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'divide\' cannot be undefined or null');
        }
      });

      it('should throw error on division by zero', async () => {
        const script = `
          :data
          @data.counter = 10
          @data.counter /= 0
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Division by zero is not allowed');
        }
      });

      it('should handle arithmetic operations with dynamic paths', async () => {
        const script = `
          :data
          @data.company.people = peopleData
          @data.company.people[0].salary += 100
          @data.company.people[1].age++
          @data.company.people[2].bonus *= 1.5
        `;
        const context = {
          peopleData: [
            { name: 'Alice', salary: 50000 },
            { name: 'Bob', age: 30 },
            { name: 'Charlie', bonus: 1000 }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            people: [
              { name: 'Alice', salary: 50100 },
              { name: 'Bob', age: 31 },
              { name: 'Charlie', bonus: 1500 }
            ]
          }
        });
      });

      it('should handle arithmetic operations with array index []', async () => {
        const script = `
          :data
          @data.company.people.push({ name: 'Alice', salary: 50000 })
          @data.company.people.push({ name: 'Bob', age: 30, salary: 100 })
          @data.company.people[].salary += 100
          @data.company.people[].age++
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          company: {
            people: [
              { name: 'Alice', salary: 50000 },
              { name: 'Bob', age: 31, salary: 200 }
            ]
          }
        });
      });
    });

    describe('Logical Operations', function() {
      it('should handle @data.and with truthy values', async () => {
        const script = `
          :data
          @data.result = true
          @data.result &= true
          @data.result &= "hello"
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: 'hello'
        });
      });

      it('should handle @data.and with falsy values', async () => {
        const script = `
          :data
          @data.result = true
          @data.result &= false
          @data.result &= "hello"
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: false
        });
      });

      it('should handle @data.and with undefined target', async () => {
        const script = `
          :data
          @data.result &= true
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'and\' cannot be undefined or null');
        }
      });

      it('should handle @data.or with truthy values', async () => {
        const script = `
          :data
          @data.result = false
          @data.result |= true
          @data.result |= "hello"
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: true
        });
      });

      it('should handle @data.or with falsy values', async () => {
        const script = `
          :data
          @data.result = false
          @data.result |= false
          @data.result |= "hello"
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: 'hello'
        });
      });

      it('should handle @data.or with undefined target', async () => {
        const script = `
          :data
          @data.result |= "hello"
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'or\' cannot be undefined or null');
        }
      });

      it('should handle logical operations with complex values', async () => {
        const script = `
          :data
          var permissions = ['read', 'write']
          var user = { name: 'Alice', active: true }
          @data.user = user
          @data.permissions = permissions
          @data.result = true
          @data.result &= user.active
          @data.result |= permissions.length > 0
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: { name: 'Alice', active: true },
          permissions: ['read', 'write'],
          result: true
        });
      });
    });

    describe('Delete Operation', function() {
      it('should handle @data.delete to return undefined', async () => {
        const script = `
          :data
          @data.user = { name: 'Alice', oldName: 'Bob' }
          @data.user.oldName.delete()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: { name: 'Alice' }
        });
      });

      it('should handle @data.delete with undefined target', async () => {
        const script = `
          :data
          @data.user.name.delete()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: {}
        });
      });

      it('should handle @data.delete with dynamic paths', async () => {
        const script = `
          :data
          @data.company.people = peopleData
          @data.company.people[0].oldEmail.delete()
          @data.company.people[1].tempData.delete()
        `;
        const context = {
          peopleData: [
            { name: 'Alice', email: 'alice@example.com', oldEmail: 'alice@old.com' },
            { name: 'Bob', email: 'bob@example.com', tempData: 'temp' }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            people: [
              { name: 'Alice', email: 'alice@example.com' },
              { name: 'Bob', email: 'bob@example.com' }
            ]
          }
        });
      });
    });

    describe('Error Handling', function() {
      it('should throw error when using arithmetic operations on non-numbers', async () => {
        const script = `
          :data
          @data.value = "hello"
          @data.value -= 5
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'subtract\' must be a number');
        }
      });

      it('should throw error when using increment on non-numbers', async () => {
        const script = `
          :data
          @data.value = "hello"
          @data.value++
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'increment\' must be a number');
        }
      });

      it('should throw error when using decrement on non-numbers', async () => {
        const script = `
          :data
          @data.value = "hello"
          @data.value--
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'decrement\' must be a number');
        }
      });

      it('should throw error when using multiply on non-numbers', async () => {
        const script = `
          :data
          @data.value = "hello"
          @data.value *= 2
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'multiply\' must be a number');
        }
      });

      it('should throw error when using divide on non-numbers', async () => {
        const script = `
          :data
          @data.value = "hello"
          @data.value /= 2
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'divide\' must be a number');
        }
      });

      it('should throw error when using add on non-number and non-string', async () => {
        const script = `
          :data
          @data.value = { name: 'Alice' }
          @data.value += "hello"
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'add\' must be a number or string');
        }
      });
    });

    describe('Complex Scenarios', function() {
      it('should handle mixed arithmetic and logical operations', async () => {
        const script = `
          :data
          @data.counter = 10
          @data.counter += 5
          @data.counter *= 2
          @data.counter -= 3
          @data.counter++
          @data.counter /= 2

          @data.flag = true
          @data.flag &= finished
          @data.flag |= finished
        `;
        const result = await env.renderScriptString(script, {finished: true});
        expect(result).to.eql({
          counter: 14,
          flag: true
        });
      });

      it('should handle operations in loops', async () => {
        const script = `
          :data
          @data.total = 0
          @data.count = 0
          for i in range(5)
            @data.total += i
            @data.count++
          endfor
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          total: 10, // 0+1+2+3+4
          count: 5
        });
      });

      it('should handle operations in macros', async () => {
        const script = `
          :data
          macro processUser(name, salary) : data
            @data.name = name
            @data.salary = salary
            @data.salary += 1000
            @data.bonus = salary * 0.1
          endmacro

          var user1 = processUser("Alice", 50000)
          var user2 = processUser("Bob", 60000)

          @data.users.push(user1)
          @data.users.push(user2)
          @data.totalSalary = 0
          @data.totalSalary += user1.salary
          @data.totalSalary += user2.salary
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          users: [
            { name: 'Alice', salary: 51000, bonus: 5000 },
            { name: 'Bob', salary: 61000, bonus: 6000 }
          ],
          totalSalary: 112000
        });
      });

      it('should handle operations with async data', async () => {
        const script = `
          :data
          var userData = fetchUser(1)
          var salaryData = fetchSalary(1)

          @data.user.name = userData.name
          @data.user.salary = salaryData.base
          @data.user.salary += salaryData.bonus
          @data.user.salary *= 1.05
        `;
        const context = {
          fetchUser: async (id) => ({ name: 'Alice' }),
          fetchSalary: async (id) => ({ base: 50000, bonus: 5000 })
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          user: {
            name: 'Alice',
            salary: 57750 // (50000 + 5000) * 1.05
          }
        });
      });
    });
  });
});
