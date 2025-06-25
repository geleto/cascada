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

      // These two 'set' statements are independent and will run in parallel.
      set userList = fetchData('users')
      set appConfig = fetchData('config')

      // The '@' commands are buffered. They run sequentially AFTER the parallel
      // operations above complete, using their now-resolved values.
      @data.set(result.users, userList)
      @data.merge(result.config, appConfig)
      @data.set(result.config.loaded, true)
      @data.push(result.log, "Data fetch complete")
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
        set userData = fetchUser(id)
        set tasksData = fetchTasks(id)

        // Assemble the macro's own return value. This happens after
        // its internal fetches are complete.
        @data.set(user.id, userData.id)
        @data.set(user.name, userData.name)
        @data.set(user.tasks, tasksData)
      endmacro

      // Call the macro for different users. These two calls are independent
      // and will execute in parallel.
      set report1 = buildUserReport(1)
      set report2 = buildUserReport(2)

      // The final assembly step for the main script. This block waits for
      // both 'report1' and 'report2' to be fully resolved before running.
      @data.set(reports.user1, report1.user)
      @data.set(reports.user2, report2.user)
      @data.set(reports.summary, "Generated 2 reports")
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
    it('should handle @data.set, @data.push, @data.merge, and @data.deepMerge', async () => {
      const script = `
        :data
        // Set creates/replaces values
        @data.set(user.name, "Alice")
        @data.set(user.role, "Admin")
        @data.set(user.role, "Super-Admin") // Overwrites previous set

        // Push adds to an array, creating it if needed
        @data.push(user.tags, "active")
        @data.push(user.tags, "new")

        // Merge combines objects
        @data.set(settings.profile, { theme: "light" })
        @data.merge(settings.profile, { notifications: true })

        // Deep merge combines nested objects
        @data.set(settings.deep, { a: { b: 1 } })
        @data.deepMerge(settings.deep, { a: { c: 2 }, d: 3 })
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
        @data.set(null, { name: 'George', age: 30 })

        // This should replace the entire object, not add to it
        @data.set(null, { status: 'active', role: 'user' })
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
        @data.set(user.name, "Alice")
        @data.set(user.role, "Admin")

        // Merge new data into the root object
        @data.deepMerge(null, { user: { status: "active" }, config: { theme: "dark" } })
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
        @data.set(user.profile.name, "Bob")
        @data.set(user.profile.settings.theme, "light")

        // Deep merge new data into the root object
        @data.deepMerge(null, {
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
        @data.push(items, "a")
        @data.push(items, "b")
        @data.push(items, "c")
        @data.push(items, "d")

        @data.pop(items) // remove "d" -> [a, b, c]
        @data.shift(items) // remove "a" -> [b, c]
        @data.unshift(items, "x") // add "x" -> [x, b, c]
        @data.reverse(items) // -> [c, b, x]
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: ['c', 'b', 'x'] });
    });

    it('should handle array index targeting including last-item `[]`', async () => {
      const script = `
        :data
        @data.push(users, { name: 'Alice', tasks: ['task1', 'task2'] })
        @data.push(users, { name: 'Bob' })

        // Target specific index
        @data.set(users[0].role, "Admin")

        // Target last item pushed in script sequence
        @data.push(users, { name: 'Charlie' })
        @data.set(users[].role, "Guest") // Affects Charlie

        @data.set(users[1].status, "active") // Affects Bob
        @data.set(users[0].tasks[], "task3") //change the last task of Alice
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
  });

  describe('@text command', function() {
    it('should append to global text stream and return in the text property', async () => {
      const script = `
        @text("Hello")
        @text(", ")
        @text("World!")
        @data.set(status, "ok")
      `;
      // No focus, so we get the full result object
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        data: { status: 'ok' },
        text: 'Hello, World!'
      });
    });

    it('should append to a path in the data object with `@data.append`', async () => {
      const script = `
        :data
        @data.set(log, "Log started. ")
        @data.append(log, "Event 1. ")
        @data.append(log, "Event 2.")
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
    });

    it('should focus the output to just the text stream with :text', async () => {
      const script = `
        :text
        @text("This is ")
        @text("the final text.")
        @data.set(status, "ignored")
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
        @data.push(users, { id: 1, name: "Alice", status: "active" })
        @data.push(users, { id: 2, name: "Bob" })
        @data.upsert(users, { id: 1, status: "inactive" }) // Updates Alice
        @data.upsert(users, { id: 3, name: "Charlie" })    // Adds Charlie
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
    it('should use a set block to capture output without focusing', async () => {
      const script = `
        :data
        set captured
          @data.set(user.name, "Captured User")
          @text("hello from capture")
        endset
        @data.set(result, captured)
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
        @data.set(status, "ignored")
      `;
      const result = await env.renderScriptString(script);
      // The result is just the turtle object, not the full result container
      expect(result).to.be.a(Turtle);
      expect(result.x).to.equal(100);
      expect(result.data).to.be(undefined);
    });
  });

  it('should allow input focusing in set blocks', async () => {
    const script = `
      // The set block's output is focused to just the data object
      :data
      set userData :data
        set user = { name: "Bob", role: "user" }
        @data.set(name, user.name)
        @data.set(role, user.role)
      endset

      @data.set(result.user, userData)
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

  it(`should not allow input focusing after the '=' in set assignments`, async () => {
    const script = `
      // This should throw an error since :data cannot be used
      // with direct assignment
      set userData = :data { name: "Charlie" }
    `;

    try {
      await env.renderScriptString(script, {});
      throw new Error('Expected an error to be thrown');
    } catch (error) {
      expect(error.message).to.contain('unexpected token: :');
    }
  });

  it('should not allow input focusing at the end of set assignments', async () => {
    const script = `
      // This should throw an error since :data cannot be used
      // with direct assignment
      set userData = { name: "Charlie" } :data
    `;

    try {
      await env.renderScriptString(script, {});
      throw new Error('Expected an error to be thrown');
    } catch (error) {
      expect(error.message).to.contain('expected block end in set statement');
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
      it('should handle `@data.set` with a simple path and string value', async () => {
        const script = `
                :data
                @data.set(user.name, "Alice")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Alice' } });
      });

      it('should handle `@data.set` with a path and a variable value', async () => {
        const script = `
                :data
                set userId = 123
                @data.set(user.profile.id, userId)
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { profile: { id: 123 } } });
      });

      it('should handle `@data.push` with a numeric array index', async () => {
        const script = `
                :data
                @data.set(users, [{}, {}])
                @data.push(users[0].roles, "admin")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ users: [{ roles: ['admin'] }, {}] });
      });

      it('should handle `@data.set` with a complex expression in brackets', async () => {
        const script = `
                :data
                set key = "complex"
                @data.set(items[key + "Id"], "value")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ items: { complexId: 'value' } });
      });

      it('should handle statement-style `@data.append` to append to a data path', async () => {
        // Note: statement-style `@data.append` APPENDS, it doesn't set.
        const script = `
                :data
                @data.set(user.log, "Event: ")
                @data.append(user.log, "User Logged In")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { log: 'Event: User Logged In' } });
      });

      it('should handle command with path but no value argument (`@data.pop`)', async () => {
        const script = `
                :data
                @data.set(user.items, ["a", "b", "c"])
                @data.pop(user.items)
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: ['a', 'b'] } });
      });

      it('should handle command with no arguments (`@data.reverse`) on a path', async () => {
        // Note: The built-in `@data.reverse` command requires a path.
        // A command like `@data.reverse` with no args is valid syntax but would
        // throw an error in the handler. Here we test a valid use case.
        const script = `
                :data
                @data.set(user.items, [1, 2, 3])
                @data.reverse(user.items)
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: [3, 2, 1] } });
      });

      it('should ignore comments between command parts', async () => {
        const script = `
                :data
                @data.set(/* set user */ user.name, /* to value */ "Heidi")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Heidi' } });
      });
    });

    describe('Dynamic path commands (function calls and expressions in paths)', () => {
      it('should handle @data.set with function call in array index', async () => {
        const script = `
          :data
          @data.set(company, companyData)
          @data.set(company.users[getUserId()].name, "Alice")
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

      it('should handle @data.set with function call returning string key', async () => {
        const script = `
          :data
          @data.set(company, companyData)
          @data.set(company.users[getUserKey()].status, "active")
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

      it('should handle @data.set with expression in array index', async () => {
        const script = `
          :data
          @data.set(items, itemsData)
          set index = 1
          @data.set(items[index + 1].name, "Item C")
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

      it('should handle @data.set with complex expression in object key', async () => {
        const script = `
          :data
          @data.set(data, dataSource)
          set prefix = "user"
          set suffix = "Profile"
          @data.set(data[prefix + suffix].name, "Dynamic User")
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
          @data.set(users, usersData)
          @data.push(users[getUserIndex()].roles, "editor")
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
          @data.set(company, companyData)
          @data.merge(company.departments[getDeptId()], { budget: 50000 })
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
          @data.set(company, companyData)
          @data.deepMerge(company.users[getUserId()].profile.settings, { theme: "dark" })
        `;
        const context = {
          getUserId: () => 1,
          companyData: {
            users: [
              { profile: { settings: { theme: 'light' } } },
              { profile: { settings: { notifications: true } } }
            ]
          }
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            users: [
              { profile: { settings: { theme: 'light' } } },
              { profile: { settings: { notifications: true, theme: 'dark' } } }
            ]
          }
        });
      });

      it('should handle @data.append with dynamic path', async () => {
        const script = `
          :data
          @data.set(company, companyData)
          @data.append(company.users[getUserId()].log, " - User logged in")
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
          @data.set(users, usersData)
          @data.pop(users[getUserIndex()].items)
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
          @data.set(users, usersData)
          @data.shift(users[getUserIndex()].tasks)
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
          @data.set(users, usersData)
          @data.unshift(users[getUserIndex()].tasks, "urgent")
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
          @data.set(users, usersData)
          @data.reverse(users[getUserIndex()].items)
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
          @data.set(company, companyData)
          @data.set(company.users[getUserId()].name, "Updated User")
          @data.push(company.users[getUserId()].roles, "manager")
          @data.set(company.departments[getDeptId()].head, getUserId())
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
          @data.set(users, usersData)
          set userId = getUserIdAsync()
          @data.set(users[userId].status, "active")
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
          @data.set(users, usersData)
          set isAdmin = true
          @data.set(users[0 if isAdmin else 1].role, "admin")
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
          @data.set(items, itemsData)
          set baseIndex = 2
          @data.set(items[baseIndex * 2 - 1].priority, "high")
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
          @data.set(company, companyData)
          @data.set(company.users[getNestedUserId()].profile.settings[getSettingKey()], "enabled")
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
          @data.set(users, usersData)
          @data.set(users[getUserIndex()].name, "Updated Name")
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

});
