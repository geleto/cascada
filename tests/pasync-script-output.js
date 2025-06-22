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
      @data.put("result.users", userList)
      @data.merge("result.config", appConfig)
      @data.put("result.config.loaded", true)
      @data.push("result.log", "Data fetch complete")
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
        @data.put("user.id", userData.id)
        @data.put("user.name", userData.name)
        @data.put("user.tasks", tasksData)
      endmacro

      // Call the macro for different users. These two calls are independent
      // and will execute in parallel.
      set report1 = buildUserReport(1)
      set report2 = buildUserReport(2)

      // The final assembly step for the main script. This block waits for
      // both 'report1' and 'report2' to be fully resolved before running.
      @data.put("reports.user1", report1.user)
      @data.put("reports.user2", report2.user)
      @data.put("reports.summary", "Generated 2 reports")
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
    it('should handle @data.put, @data.push, @data.merge, and @data.deepMerge', async () => {
      const script = `
        :data
        // Put creates/replaces values
        @data.put("user.name", "Alice")
        @data.put("user.role", "Admin")
        @data.put("user.role", "Super-Admin") // Overwrites previous put

        // Push adds to an array, creating it if needed
        @data.push("user.tags", "active")
        @data.push("user.tags", "new")

        // Merge combines objects
        @data.put("settings.profile", { theme: "light" })
        @data.merge("settings.profile", { notifications: true })

        // Deep merge combines nested objects
        @data.put("settings.deep", { a: { b: 1 } })
        @data.deepMerge("settings.deep", { a: { c: 2 }, d: 3 })
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

    it('should handle array manipulation with @data.pop, @data.shift, @data.unshift, and @data.reverse', async () => {
      const script = `
        :data
        @data.push("items", "a")
        @data.push("items", "b")
        @data.push("items", "c")
        @data.push("items", "d")

        @data.pop("items") // remove "d" -> [a, b, c]
        @data.shift("items") // remove "a" -> [b, c]
        @data.unshift("items", "x") // add "x" -> [x, b, c]
        @data.reverse("items") // -> [c, b, x]
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: ['c', 'b', 'x'] });
    });

    it('should handle array index targeting including last-item `[]`', async () => {
      const script = `
        :data
        @data.push("users", { name: 'Alice', tasks: ['task1', 'task2'] })
        @data.push("users", { name: 'Bob' })

        // Target specific index
        @data.put("users[0].role", "Admin")

        // Target last item pushed in script sequence
        @data.push("users", { name: 'Charlie' })
        @data.put("users[].role", "Guest") // Affects Charlie

        @data.put("users[1].status", "active") // Affects Bob
        @data.put("users[0].tasks[]", "task3") //change the last task of Alice
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
        @data.put("status", "ok")
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
        @data.put("log", "Log started. ")
        @data.append("log", "Event 1. ")
        @data.append("log", "Event 2.")
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
    });

    it('should focus the output to just the text stream with :text', async () => {
      const script = `
        :text
        @text("This is ")
        @text("the final text.")
        @data.put("status", "ignored")
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
        @data.push("users", { id: 1, name: "Alice", status: "active" })
        @data.push("users", { id: 2, name: "Bob" })
        @data.upsert("users", { id: 1, status: "inactive" }) // Updates Alice
        @data.upsert("users", { id: 3, name: "Charlie" })    // Adds Charlie
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
          @data.put("user.name", "Captured User")
          @text("hello from capture")
        endset
        @data.put("result", captured)
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
        @data.put("data.status", "ignored")
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
        @data.put("name", user.name)
        @data.put("role", user.role)
      endset

      @data.put("result.user", userData)
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
    // and value (e.g., `@data.put`, `@data.append`), it correctly transpiles
    // to a `statement_command` tag and modifies the `data` property of the result.
    // ========================================================================
    describe('Statement-style commands (modifies data output)', () => {
      it('should handle `@data.put` with a simple path and string value', async () => {
        const script = `
                :data
                @data.put("user.name", "Alice")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Alice' } });
      });

      it('should handle `@data.put` with a path and a variable value', async () => {
        const script = `
                :data
                set userId = 123
                @data.put("user.profile.id", userId)
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { profile: { id: 123 } } });
      });

      it('should handle `@data.push` with a numeric array index', async () => {
        const script = `
                :data
                @data.put("users", [{}, {}])
                @data.push("users[0].roles", "admin")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ users: [{ roles: ['admin'] }, {}] });
      });

      it('should handle `@data.put` with a complex expression in brackets', async () => {
        const script = `
                :data
                set key = "complex"
                @data.put("items[" + key + "_id]", "value")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ items: { complexId: 'value' } });
      });

      it('should handle statement-style `@data.append` to append to a data path', async () => {
        // Note: statement-style `@data.append` APPENDS, it doesn't set.
        const script = `
                :data
                @data.put("user.log", "Event: ")
                @data.append("user.log", "User Logged In")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { log: 'Event: User Logged In' } });
      });

      it('should handle command with path but no value argument (`@data.pop`)', async () => {
        const script = `
                :data
                @data.put("user.items", ["a", "b", "c"])
                @data.pop("user.items")
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
                @data.put("user.items", [1, 2, 3])
                @data.reverse("user.items")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: [3, 2, 1] } });
      });

      it('should ignore comments between command parts', async () => {
        const script = `
                :data
                @data.put(/* set user */ "user.name", /* to value */ "Heidi")
            `;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Heidi' } });
      });
    });
  });

});
