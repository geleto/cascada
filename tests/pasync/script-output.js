'use strict';

let expect;
let AsyncEnvironment;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
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

  it('scripts throw error when accessing properties of null/undefined (unlike templates)', async () => {
    const script = `
        data data
        var obj = none
        data.value = obj.prop
        return {data: data.snapshot() }`;

    try {
      await env.renderScriptString(script);
      throw new Error('Expected an error to be thrown');
    } catch (error) {
      // Accommodate for slight variations in the JS engine's error message
      expect(error.message).to.match(/Cannot read propert(y|ies)/);
    }
  });

  /**
   * This test demonstrates the core "Collect, Execute, Assemble" model.
   * - Independent `set` operations (data fetching) run in parallel.
   * - All `@` commands are buffered and executed sequentially *after* the parallel fetches complete.
   * - The explicit return uses the assembled data object.
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
      // These two 'var' declarations are independent and will run in parallel.
      data data
      var userList = fetchData('users')
      var appConfig = fetchData('config')

      // The '@' commands are buffered. They run sequentially AFTER the parallel
      // operations above complete, using their now-resolved values.
      data.result.users.set(userList)
      data.result.config.merge(appConfig)
      data.result.config.loaded.set(true)
      data.result.log.push("Data fetch complete")

      return data.snapshot()`;

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
   * - The macro returns a clean data object explicitly.
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

      // Define a reusable component that returns a clean data object.
      data data
      macro buildUserReport(id)
        data data
        // These two fetches inside the macro also run in parallel.
        var userData = fetchUser(id)
        var tasksData = fetchTasks(id)

        // Assemble the macro's own return value. This happens after
        // its internal fetches are complete.
        data.user.id = userData.id
        data.user.name = userData.name
        data.user.tasks = tasksData
        return data.snapshot()
      endmacro

      // Call the macro for different users. These two calls are independent
      // and will execute in parallel.
      var report1 = buildUserReport(1)
      var report2 = buildUserReport(2)

      // The final assembly step for the main script. This block waits for
      // both 'report1' and 'report2' to be fully resolved before running.
      data.reports.user1 = report1.user
      data.reports.user2 = report2.user
      data.reports.summary = "Generated 2 reports"

      return data.snapshot()`;

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

  describe('Built-in Data Commands', function () {
    it('should handle @data assignment, @data.push, @data.merge, and @data.deepMerge', async () => {
      const script = `
        // Set creates/replaces values
        data data
        data.user.name = "Alice"
        data.user.role = "Admin"
        data.user.role = "Super-Admin" // Overwrites previous set

        // Push adds to an array, creating it if needed
        data.user.tags.push("active")
        data.user.tags.push("new")

        // Merge combines objects
        data.settings.profile = { theme: "light" }
        data.settings.profile.merge({ notifications: true })

        // Deep merge combines nested objects
        data.settings.deep = { a: { b: 1 } }
        data.settings.deep.deepMerge({ a: { c: 2 }, d: 3 })

        return data.snapshot()`;
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
        // Set the entire data object to a new value
        data data
        data = { name: 'George', age: 30 }

        // This should replace the entire object, not add to it
        data = { status: 'active', role: 'user' }

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        status: 'active',
        role: 'user'
      });
    });

    it('should correctly handle nested macro calls with different filters', async () => {
      const script = `

        text text
        macro dataProducer()
            data data
            data.value = "produced data"
            text("ignored text in data macro")
            return data.snapshot()
        endmacro

        macro generic()
            data data
            text text
            data.foo = "bar"
            text("Generic text")
            return {data: data.snapshot(), text: text.snapshot() }
        endmacro

        macro textConsumer()
            text text
            text("Start consumer. ")

            // Case 1: Calling macro (returns unwrapped data object)
            var dataRes = dataProducer()
            if (dataRes.value)
                 text("Data: " + dataRes.value + ". ")
            endif

            // Case 2: Calling no-filter macro (returns full Result Object)
            var genRes = generic()
            text("Inner text: " + genRes.text)
            return text.snapshot()
        endmacro

        call textConsumer()
          text text
          return text.snapshot()
        endcall

        return text.snapshot()`;

      const result = await env.renderScriptString(script);
      expect(result).to.contain('Start consumer.');
      expect(result).to.contain('Data: produced data.');
      expect(result).to.contain('Inner text: Generic text');
    });

    it('should support explicit callbacks with parameters and return focus', async () => {
      const script = `
        data data
        macro recursive(list, initial)
          data data
          var acc = initial
          for item in list
            acc = caller(acc, item)
          endfor
          data.value = acc
          return data.snapshot()
        endmacro

        var result = call recursive([1, 2, 3], 0) (sum, num)
          data data
          data = sum + num
          return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 6 });
    });

    it('should support explicit callbacks with no arguments, only focusing', async () => {
      const script = `
        data data
        macro recursive(list)
          data data
          var acc = 0
          for item in list
            var res = caller()
            acc = acc + res.value
          endfor
          data.value = acc
          return data.snapshot()
        endmacro

        var result = call recursive([1, 2, 3])
          data data
          data.value = 1
          return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 3 });
    });

    it('should support explicit callbacks with arguments but no focusing', async () => {
      const script = `
        data data
        macro recursive(list)
          data data
          var acc = 0
          for item in list
            var res = caller(item)
            acc = acc + res.val
          endfor
          data.value = acc
          return data.snapshot()
        endmacro

        var result = call recursive([1, 2, 3]) (item)
          data data
          data.val = item * 2
          return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 12 });
    });

    it('should support explicit callbacks with no arguments and no focusing', async () => {
      const script = `
        data data
        macro recursive(list)
          data data
          var acc = 0
          for item in list
             var res = caller()
             acc = acc + res.val
          endfor
          data.value = acc
          return data.snapshot()
        endmacro

        var result = call recursive([1, 2, 3])
          data data
          data.val = 1
          return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 3 });
    });

    it('should support explicit callbacks with empty arguments and focusing', async () => {
      const script = `
        data data
        macro runner()
          data data
          var res = caller()
          data.value = res.val
          return data.snapshot()
        endmacro

        var result = call runner() ()
           data data
           data.val = 42
           return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 42 });
    });

    it('should access outer variables in call block', async () => {
      const script = `
        data data
        var outer = 10
        macro runner()
          data data
          var res = caller()
          data.val = res.val
          return data.snapshot()
        endmacro

        var result = call runner()
          data data
          data.val = outer
          return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ val: 10 });
    });

    it('should resolve variables from caller site (lexical scope)', async () => {
      const script = `
        data data
        var x = "outer"
        macro runner()
          data data
          var x = "inner"
          var res = caller()
          data.val = res.val
          return data.snapshot()
        endmacro

        var result = call runner()
          data data
          data.val = x
          return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ val: 'outer' });
    });

    it('should allow call arguments to shadow outer variables', async () => {
      const script = `
        data data
        var x = "outer"
        macro runner()
          data data
          var res = caller("arg")
          data.val = res.val
          return data.snapshot()
        endmacro

        var result = call runner() (x)
          data data
          data.val = x
          return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ val: 'arg' });
    });

    it('should fail to access variables defined purely inside the macro (isolation)', async () => {
      const script = `
        data data
        macro runner()
          data data
          var secret = "inner"
          var res = caller()
          data.val = res.val
          return data.snapshot()
        endmacro

        var result = call runner()
           data data
           data.val = secret
           return data.snapshot()
        endcall
        data = result

        return data.snapshot()`;
      try {
        await env.renderScriptString(script);
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e.message).to.contain('secret');
      }
    });

    it('should handle null path with merge to combine with existing root data', async () => {
      const script = `
        // Start with some initial data
        data data
        data.user.name = "Alice"
        data.user.role = "Admin"

        // Merge new data into the root object
        data.deepMerge({ user: { status: "active" }, config: { theme: "dark" } })

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        user: { name: 'Alice', role: 'Admin', status: 'active' },
        config: { theme: 'dark' }
      });
    });

    it('should handle null path with deepMerge for nested object merging', async () => {
      const script = `
        // Start with nested data
        data data
        data.user.profile.name = "Bob"
        data.user.profile.settings.theme = "light"

        // Deep merge new data into the root object
        data.deepMerge({
          user: {
            profile: {
              settings: { notifications: true },
              email: "bob@example.com"
            }
          }
        })

        return data.snapshot()`;
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
        data data
        data.items.push("a")
        data.items.push("b")
        data.items.push("c")
        data.items.push("d")

        data.items.pop() // remove "d" -> [a, b, c]
        data.items.shift() // remove "a" -> [b, c]
        data.items.unshift("x") // add "x" -> [x, b, c]
        data.items.reverse() // -> [c, b, x]

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: ['c', 'b', 'x'] });
    });

    it('should handle array index targeting including last-item `[]`', async () => {
      const script = `
        data data
        data.users.push({ name: 'Alice', tasks: ['task1', 'task2'] })
        data.users.push({ name: 'Bob' })

        // Target specific index
        data.users[0].role = "Admin"

        // Target last item pushed in script sequence
        data.users.push({ name: 'Charlie' })
        data.users[].role = "Guest" // Affects Charlie

        data.users[1].status = "active" // Affects Bob
        data.users[0].tasks[] = "task3" // append task to Alice

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        users: [
          { name: 'Alice', role: 'Admin', tasks: ['task1', 'task2', 'task3'] },
          { name: 'Bob', status: 'active' },
          { name: 'Charlie', role: 'Guest' }
        ]
      });
    });

    it('should handle @data.push with function call in array index', async () => {
      const script = `
        data data
        data.users = usersData
        data.users[getUserIndex()].roles.push("editor")

        return data.snapshot()`;
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
        data data
        data.company = companyData
        data.company.departments[getDeptId()].merge({ budget: 50000 })

        return data.snapshot()`;
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

    it('should handle @data.assignment with nested dynamic paths', async () => {
      const script = `
        data data
        data.company = companyData
        data.company.users[getUserId()].profile.settings[getSettingKey()] = "enabled"

        return data.snapshot()`;
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
        data data
        data.company = companyData
        data.company.users[getUserId()].log.append(" - User logged in")

        return data.snapshot()`;
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
        data data
        data.users = usersData
        data.users[getUserIndex()].items.pop()

        return data.snapshot()`;
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
        data data
        data.users = usersData
        data.users[getUserIndex()].tasks.shift()

        return data.snapshot()`;
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
        data data
        data.users = usersData
        data.users[getUserIndex()].tasks.unshift("urgent")

        return data.snapshot()`;
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
        data data
        data.users = usersData
        data.users[getUserIndex()].items.reverse()

        return data.snapshot()`;
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

  describe('@text command', function () {
    it('should append to global text stream and return in the text property', async () => {
      const script = `
        text text
        data data
        text("Hello")
        text(", ")
        text("World!")
        data.status = "ok"

        return { text: text.snapshot(), data: data.snapshot() }`;
      // No focus, so we get the full result object
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        data: { status: 'ok' },
        text: 'Hello, World!'
      });
    });

    it('should append to a path in the data object with @data.append', async () => {
      const script = `
        data data
        data.log = "Log started. "
        data.log.append("Event 1. ")
        data.log.append("Event 2.")

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
    });

    it('should focus the output to just the text stream with', async () => {
      const script = `
        text text
        data data
        text("This is ")
        text("the final text.")
        data.status = "ignored"

        return text.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.equal('This is the final text.');
    });
  });

  describe('Customization and Extension', function () {
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
        data data
        data.users.push({ id: 1, name: "Alice", status: "active" })
        data.users.push({ id: 2, name: "Bob" })
        data.users.upsert({ id: 1, status: "inactive" }) // Updates Alice
        data.users.upsert({ id: 3, name: "Charlie" })    // Adds Charlie

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        users: [
          { id: 1, name: 'Alice', status: 'inactive' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Charlie' }
        ]
      });
    });

    it('should support custom handlers with the Factory pattern (sink)', async () => {
      class Turtle {
        constructor() { this.x = 0; this.y = 0; }
        forward(dist) { this.x += dist; }
        turn(deg) { this.y += deg; } // simplified for test
        snapshot() { return this; }
      }
      const context = {
        makeTurtle: () => new Turtle()
      };
      const script = `
        sink turtle = makeTurtle()
        turtle.forward(50)
        turtle.turn(90)
        turtle.forward(10)
        return turtle.snapshot()
      `;
      const result = await env.renderScriptString(script, context);
      expect(result).to.be.a(Turtle);
      expect(result.x).to.equal(60);
      expect(result.y).to.equal(90);
    });

    it('supports sink snapshot of callable command handler (no path)', async () => {
      class Logger {
        constructor() {
          this.logs = [];
          const callable = (...args) => this._call(...args);
          callable.logs = this.logs;
          callable.snapshot = () => callable;
          return callable;
        }
        _call(text) {
          this.logs.push(text);
        }
      };

      const logHandler = new Logger();
      const script = `
        sink log = logHandler
        log("user1 logged in")
        log("user2 logged in")
        return { log: log.snapshot() }
      `;
      const result = await env.renderScriptString(script, { logHandler });
      // The same logger instance is modified
      expect(result.log.logs).to.eql(['user1 logged in', 'user2 logged in']);
    });

    it('should support sink handlers with a singleton instance - 1 segment path', async () => {
      const logger = {
        log: [],
        login: function (user) {
          this.log.push(`login(${user})`);
        },
        action: function (action, doc) {
          this.log.push(`action(${action},${doc})`);
        },
      };
      const script = `
        sink audit = logger
        audit.login("user1")
        audit.action("read", "doc1")
        return`;
      await env.renderScriptString(script, { logger });
      // The same logger instance is modified
      expect(logger.log).to.eql(['login(user1)', 'action(read,doc1)']);
    });

    it('should support sink snapshot of multi-segment command handler (2 segments path)', async () => {
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
      util.snapshot = () => util;

      const script = `
        sink utilSink = utilRef.output
        utilSink.log("User logged in")
        utilSink.error("Connection failed")
        utilSink.warn("Deprecated feature used")
        return { util: utilSink.snapshot() }
      `;

      const result = await env.renderScriptString(script, { utilRef: util });

      // Verify the multi-segment handler is accessible and functional
      expect(result.util).to.be.an(OutputLogger);
      expect(result.util.logs).to.eql(['User logged in']);
      expect(result.util.errors).to.eql(['Connection failed']);
      expect(result.util.warnings).to.eql(['Deprecated feature used']);
    });
  });

  describe('Scoping and Control', function () {
    it('should use a capture block to capture output without focusing', async () => {
      const script = `
        data data
        var captured = capture
          data data
          text text
          data.user.name = "Captured User"
          text("hello from capture")
          return {data: data.snapshot(), text: text.snapshot() }
        endcapture
        data.result = captured

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        result: {
          data: { user: { name: 'Captured User' } },
          text: 'hello from capture'
        }
      });
    });

    it('should return a custom handler result with explicit return', async () => {
      class Turtle {
        constructor() { this.x = 0; this.y = 0; }
        forward(dist) { this.x += dist; }
        snapshot() { return this; }
      }
      const context = {
        makeTurtle: () => new Turtle()
      };
      const script = `
        data data
        sink turtle = makeTurtle()
        turtle.forward(100)
        data.status = "ignored"
        return turtle.snapshot()
      `;
      const result = await env.renderScriptString(script, context);
      expect(result).to.be.a(Turtle);
      expect(result.x).to.equal(100);
    });

    it('should allow input focusing in capture blocks', async () => {
      const script = `
        // The capture block's output is focused to just the data object
        data data
        var userData = capture
          data data
          var user = { name: "Bob", role: "user" }
          data.name = user.name
          data.role = user.role
          return data.snapshot()
        endcapture

        data.result.user = userData

        return data.snapshot()`;

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

    it('should support capture in assignment to existing variables', async () => {
      const script = `

        // 1. Declare variable
        data data
        var capturedContent = "initial"

        // 2. Assign using capture (must work on existing variable)
        capturedContent = capture
             data data
             data.status = "updated"
             data.value = 123
             return data.snapshot()
        endcapture

        data.result = capturedContent

        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        result: {
          status: `updated`,
          value: 123
        }
      });
    });
  });

  it('should allow input focusing in capture blocks', async () => {
    const script = `
      // The set block's output is focused to just the data object
      data data
      var captured = capture
        data data
        text text
        data.user.name = "Captured User"
        text("hello from capture")
        return {data: data.snapshot(), text: text.snapshot() }
      endcapture
      data.result = captured

      return data.snapshot()`;

    const result = await env.renderScriptString(script, {});

    expect(result).to.eql({
      result: {
        data: { user: { name: 'Captured User' } },
        text: 'hello from capture'
      }
    });
  });

  it(`should allow var assignments without focusing`, async () => {
    const script = `
        var userData = { name: "Charlie" }
        return userData
      `;

    const result = await env.renderScriptString(script, {});
    expect(result).to.eql({ name: 'Charlie' });
  });

  it('should allow var assignments without trailing focus', async () => {
    const script = `
        var userData = { name: "Charlie" }
        return userData
      `;

    const result = await env.renderScriptString(script, {});
    expect(result).to.eql({ name: 'Charlie' });
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
        const script = `
          text text
          text(user.name)
          return { text: text.snapshot() }
        `;
        const context = { user: { name: 'Alice' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Alice');
      });

      it('should handle a simple path-like expression with trailing whitespace', async () => {
        const script = `
          text text
          text(user.name)
          return { text: text.snapshot() }
        `;
        const context = { user: { name: 'Alice' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Alice');
      });

      it('should handle an expression with a binary operator', async () => {
        const script = `
          text text
          text("Hello, " + user.name)
          return { text: text.snapshot() }
        `;
        const context = { user: { name: 'Bob' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Hello, Bob');
      });

      it('should handle an expression starting with a string literal', async () => {
        const script = `
          text text
          text("Hello World")
          return { text: text.snapshot() }
        `;
        const result = await env.renderScriptString(script, {});
        expect(result.text).to.equal('Hello World');
      });

      it('should handle an expression that is a function call', async () => {
        const script = `
          text text
          text(format(user.name))
          return { text: text.snapshot() }
        `;
        const context = {
          user: { name: 'charlie' },
          format: (str) => str.toUpperCase()
        };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('CHARLIE');
      });

      it('should handle a path-like expression broken by a filter', async () => {
        const script = `
          text text
          text(user.name|title)
          return { text: text.snapshot() }
        `;
        const context = { user: { name: 'dave' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Dave');
      });

      it('should handle a path-like expression broken by a math operator', async () => {
        const script = `
          text text
          text(user.id + 1)
          return { text: text.snapshot() }
        `;
        const context = { user: { id: 99 } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('100');
      });

      it('should handle a path-like expression broken by parenthesis', async () => {
        const script = `
          text text
          text((user.name))
          return { text: text.snapshot() }
        `;
        const context = { user: { name: 'Eve' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Eve');
      });

      it('should handle an expression with multiple path-like parts', async () => {
        const script = `
          text text
          text(user.name + " " + user.lastName)
          return { text: text.snapshot() }
        `;
        const context = { user: { name: 'Frank', lastName: 'Castle' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Frank Castle');
      });

      it('should handle an expression with a path broken by internal whitespace', async () => {
        // Transpiles to `{{ user. firstName }}`, where `user.` is undefined.
        // Nunjucks treats `undefined` as an empty string in concatenation.
        const script = `
          text text
          text(user. firstName)
          return { text: text.snapshot() }
        `;
        const context = { user: { firstName: 'Grace' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Grace');
      });

      it('should handle an object as an expression', async () => {
        const script = `
          text text
          text(user)
          return { text: text.snapshot() }
        `;
        const context = { user: 'John' };
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
                data data
                data.user.name = "Alice"

                return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Alice' } });
      });

      it('should handle @data assignment with a path and a variable value', async () => {
        const script = `
                data data
                var userId = 123
                data.user.profile.id = userId

                return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { profile: { id: 123 } } });
      });

      it('should handle @data assignment with a complex expression in brackets', async () => {
        const script = `
                data data
                var key = "complex"
                data.items[key + "Id"] = "value"

                return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ items: { complexId: 'value' } });
      });

      it('should handle statement-style @data.append to append to a data path', async () => {
        // Note: statement-style @data.append APPENDS, it doesn't set.
        const script = `
                data data
                data.log = "Log started. "
                data.log.append("Event 1. ")
                data.log.append("Event 2.")

                return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
      });

      it('should handle command with path but no value argument (@data.pop)', async () => {
        const script = `
                data data
                data.user.items = ["a", "b", "c"]
                data.user.items.pop()

                return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: ['a', 'b'] } });
      });

      it('should handle command with no arguments (@data.reverse) on a path', async () => {
        // Note: The built-in @data.reverse command requires a path.
        // A command like @data.reverse with no args is valid syntax but would
        // throw an error in the handler. Here we test a valid use case.
        const script = `
                data data
                data.user.items = [1, 2, 3]
                data.user.items.reverse()

                return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: [3, 2, 1] } });
      });

      it('should ignore comments between command parts', async () => {
        const script = `
                data data
                data.user.name = "Heidi"

                return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Heidi' } });
      });

      it('should resolve promises in data handler objects', async () => {
        const context = {
          async getData() {
            return { id: 42, name: 'Test' };
          }
        };

        const script = `
      data data
      var obj = getData()
      data.result = { id: obj.id, name: obj.name }

      return data.snapshot()`;

        const result = await env.renderScriptString(script, context);
        expect(result.result.id).to.equal(42);
        expect(result.result.name).to.equal('Test');
      });
    });

    describe('Dynamic path commands (function calls and expressions in paths)', () => {
      it('should handle @data assignment with function call in array index', async () => {
        const script = `
          data data
          data.company = companyData
          data.company.users[getUserId()].name = "Alice"

          return data.snapshot()`;
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
          data data
          data.company = companyData
          data.company.users[getUserKey()].status = "active"

          return data.snapshot()`;
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
          data data
          data.items = itemsData
          var index = 1
          data.items[index + 1].name = "Item C"

          return data.snapshot()`;
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
          data data
          data.data = dataSource
          var prefix = "user"
          var suffix = "Profile"
          data.data[prefix + suffix].name = "Dynamic User"

          return data.snapshot()`;
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
          data data
          data.users = usersData
          data.users[getUserIndex()].roles.push("editor")

          return data.snapshot()`;
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
          data data
          data.company = companyData
          data.company.departments[getDeptId()].merge({ budget: 50000 })

          return data.snapshot()`;
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
          data data
          data.company = companyData
          data.company.users[0].profile.settings.notifications = "enabled"
          data.company.users[getUserId()].profile.settings.deepMerge({ theme: "dark" })

          return data.snapshot()`;
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
          data data
          data.company = companyData
          data.company.users[getUserId()].log.append(" - User logged in")

          return data.snapshot()`;
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
          data data
          data.users = usersData
          data.users[getUserIndex()].items.pop()

          return data.snapshot()`;
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
          data data
          data.users = usersData
          data.users[getUserIndex()].tasks.shift()

          return data.snapshot()`;
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
          data data
          data.users = usersData
          data.users[getUserIndex()].tasks.unshift("urgent")

          return data.snapshot()`;
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
          data data
          data.users = usersData
          data.users[getUserIndex()].items.reverse()

          return data.snapshot()`;
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
          data data
          data.company = companyData
          data.company.users[getUserId()].name = "Updated User"
          data.company.users[getUserId()].roles.push("manager")
          data.company.departments[getDeptId()].head = getUserId()

          return data.snapshot()`;
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
          data data
          var userData = fetchUser(1)
          var salaryData = fetchSalary(1)

          data.user.name = userData.name
          data.user.salary = salaryData.base
          data.user.salary += salaryData.bonus
          data.user.salary *= 1.05

          return data.snapshot()`;
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

      it('should handle dynamic path with conditional expression', async () => {
        const script = `
          data data
          data.users = usersData
          var isAdmin = true
          data.users[0 if isAdmin else 1].role = "admin"

          return data.snapshot()`;
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
          data data
          data.items = itemsData
          var baseIndex = 2
          data.items[baseIndex * 2 - 1].priority = "high"

          return data.snapshot()`;
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
          data data
          data.company = companyData
          data.company.users[getNestedUserId()].profile.settings[getSettingKey()] = "enabled"

          return data.snapshot()`;
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
          data data
          data.users = usersData
          data.users[getUserIndex()].name = "Updated Name"

          return data.snapshot()`;
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

  describe('New Arithmetic and Logical @data Commands', function () {
    describe('Arithmetic Operations', function () {
      it('should handle @data.add with numbers', async () => {
        const script = `
          data data
          data.counter = 10
          data.counter += 5
          data.counter += 3

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 18
        });
      });

      it('should handle @data.add with strings', async () => {
        const script = `
          data data
          data.message = "Hello"
          data.message += " World"
          data.message += "!"

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          message: 'Hello World!'
        });
      });

      it('should handle @data.add with undefined target', async () => {
        const script = `
          data data
          data.counter += 10
          data.message += "Hello"

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'add\' cannot be undefined or null');
        }
      });

      // Removed invalid focus tests: focus will be deprecated in favor of explicit returns.

      it('should handle @data.subtract', async () => {
        const script = `
          data data
          data.counter = 20
          data.counter -= 5
          data.counter -= 3

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 12
        });
      });

      it('should handle @data.subtract with undefined target', async () => {
        const script = `
          data data
          data.counter -= 10

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'subtract\' cannot be undefined or null');
        }
      });

      it('should handle @data.increment', async () => {
        const script = `
          data data
          data.counter = 5
          data.counter++
          data.counter++

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 7
        });
      });

      it('should handle @data.increment with undefined target', async () => {
        const script = `
          data data
          data.counter++

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'increment\' cannot be undefined or null');
        }
      });

      it('should handle @data.decrement', async () => {
        const script = `
          data data
          data.counter = 10
          data.counter--
          data.counter--

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 8
        });
      });

      it('should handle @data.decrement with undefined target', async () => {
        const script = `
          data data
          data.counter--

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'decrement\' cannot be undefined or null');
        }
      });

      it('should handle @data.multiply', async () => {
        const script = `
          data data
          data.counter = 5
          data.counter *= 3
          data.counter *= 2

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 30
        });
      });

      it('should handle @data.multiply with undefined target', async () => {
        const script = `
          data data
          data.counter *= 5

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'multiply\' cannot be undefined or null');
        }
      });

      it('should handle @data.divide', async () => {
        const script = `
          data data
          data.counter = 100
          data.counter /= 2
          data.counter /= 5

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 10
        });
      });

      it('should handle @data.divide with undefined target', async () => {
        const script = `
          data data
          data.counter /= 2

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'divide\' cannot be undefined or null');
        }
      });

      it('should throw error on division by zero', async () => {
        const script = `
          data data
          data.counter = 10
          data.counter /= 0

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Division by zero is not allowed');
        }
      });

      it('should handle arithmetic operations with dynamic paths', async () => {
        const script = `
          data data
          data.company.people = peopleData
          data.company.people[0].salary += 100
          data.company.people[1].age++
          data.company.people[2].bonus *= 1.5

          return data.snapshot()`;
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
          data data
          data.company.people.push({ name: 'Alice', salary: 50000 })
          data.company.people.push({ name: 'Bob', age: 30, salary: 100 })
          data.company.people[].salary += 100
          data.company.people[].age++

          return data.snapshot()`;
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

      it('should handle root-level array index targeting with @data[]', async () => {
        const script = `
          // Initialize the root as an array
          data data
          data = []

          // Push items to the root array
          data.push({ name: 'Alice' })
          data.push({ name: 'Bob' })

          // Target the last item pushed (Bob) and modify it
          data[].status = "active"

          // Push another item
          data.push({ name: 'Charlie' })

          // Target the new last item (Charlie)
          data[].role = "guest"

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql([
          { name: 'Alice' },
          { name: 'Bob', status: 'active' },
          { name: 'Charlie', role: 'guest' }
        ]);
      });

      it('should handle root-level array index targeting with @data[0]', async () => {
        const script = `
          // Initialize the root as an array
          data data
          data = []

          // Push items to the root array
          data.push({ name: 'Alice' })
          data.push({ name: 'Bob' })

          // Target a specific index and modify it
          data[0].status = "inactive"

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql([
          { name: 'Alice', status: 'inactive' },
          { name: 'Bob' }
        ]);
      });

      it('should handle root-level dynamic indexing with function call', async () => {
        const script = `
          data data
          data = [{ name: 'A' }, { name: 'B' }, { name: 'C' }]
          data[getIndex()].flag = "reviewed"

          return data.snapshot()`;
        const context = {
          getIndex: () => 1
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql([
          { name: 'A' },
          { name: 'B', flag: 'reviewed' },
          { name: 'C' }
        ]);
      });

      it('should allow property writes after @data[]', async () => {
        const script = `
          data data
          data = []
          data.push({ name: 'Alice' })
          data.push({ name: 'Bob' })
          data[].tags.push("new")         // affects Bob
          data[].meta.role = "guest"      // affects Bob

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql([
          { name: 'Alice' },
          { name: 'Bob', tags: ['new'], meta: { role: 'guest' } }
        ]);
      });

      it('should allow complex property paths after @data[] with dynamic key', async () => {
        const script = `
          data data
          data = []
          data.push({ name: 'Alice' })
          data.push({ name: 'Bob' })
          data[].profile[getKey()].score = 10

          return data.snapshot()`;
        const context = {
          getKey: () => 'year2025'
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql([
          { name: 'Alice' },
          { name: 'Bob', profile: { year2025: { score: 10 } } }
        ]);
      });

      it('should support arithmetic operations after @data[]', async () => {
        const script = `
          data data
          data = []
          data.push({ name: 'A', count: 0 })
          data[].count++
          data.push({ name: 'B', count: 1 })
          data[].count += 4

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql([
          { name: 'A', count: 1 },
          { name: 'B', count: 5 }
        ]);
      });

      it('should throw when using @data[] on an empty root array', async () => {
        const script = `
          data data
          data = []
          data[].value = 1

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain(`Cannot set last element ('[]') on empty array.`);
        }
      });

      it('should throw when using @data[] and root is not an array', async () => {
        const script = `
          data data
          data = { a: 1 }
          data[].x = 2

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain(`Path target for '[]' is not an array.`);
        }
      });
    });

    describe('Logical Operations', function () {
      it('should handle @data.and with truthy values', async () => {
        const script = `
          data data
          data.result = true
          data.result &&= true
          data.result &&= "hello"

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: 'hello'
        });
      });

      it('should handle @data.and with falsy values', async () => {
        const script = `
          data data
          data.result = true
          data.result &&= false
          data.result &&= "hello"

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: false
        });
      });

      it('should handle @data.and with undefined target', async () => {
        const script = `
          data data
          data.result &&= true

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'and\' cannot be undefined or null');
        }
      });

      it('should handle @data.or with truthy values', async () => {
        const script = `
          data data
          data.result = false
          data.result ||= true
          data.result ||= "hello"

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: true
        });
      });

      it('should handle @data.or with falsy values', async () => {
        const script = `
          data data
          data.result = false
          data.result ||= false
          data.result ||= "hello"

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: 'hello'
        });
      });

      it('should handle @data.or with undefined target', async () => {
        const script = `
          data data
          data.result ||= "hello"

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'or\' cannot be undefined or null');
        }
      });

      it('should handle logical operations with complex values', async () => {
        const script = `
          data data
          var permissions = ['read', 'write']
          var user = { name: 'Alice', active: true }
          data.user = user
          data.permissions = permissions
          data.result = true
          data.result &&= user.active
          data.result ||= permissions.length > 0

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: { name: 'Alice', active: true },
          permissions: ['read', 'write'],
          result: true
        });
      });

      it('should handle @data.bitAnd with numbers', async () => {
        const script = `
          data data
          data.flags = 15  // 1111 in binary
          data.flags &= 10  // 1010 in binary

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          flags: 10  // 1010 in binary
        });
      });

      it('should handle @data.bitAnd with undefined target', async () => {
        const script = `
          data data
          data.flags &= 10

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitAnd\' cannot be undefined or null');
        }
      });

      it('should handle @data.bitAnd with non-number target', async () => {
        const script = `
          data data
          data.flags = "hello"
          data.flags &= 10

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitAnd\' must be a number');
        }
      });

      it('should handle @data.bitOr with numbers', async () => {
        const script = `
          data data
          data.flags = 5   // 0101 in binary
          data.flags |= 10  // 1010 in binary

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          flags: 15  // 1111 in binary
        });
      });

      it('should handle @data.bitOr with undefined target', async () => {
        const script = `
          data data
          data.flags |= 10

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitOr\' cannot be undefined or null');
        }
      });

      it('should handle @data.bitOr with non-number target', async () => {
        const script = `
          data data
          data.flags = "hello"
          data.flags |= 10

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitOr\' must be a number');
        }
      });

      it('should handle @data.bitNot with numbers', async () => {
        const script = `
          data data
          data.flags = 15  // 1111 in binary
          data.flags.bitNot()

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          flags: -16  // ~15 = -16
        });
      });

      it('should handle @data.bitNot with undefined target', async () => {
        const script = `
          data data
          data.flags.bitNot()

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitNot\' cannot be undefined or null');
        }
      });

      it('should handle @data.bitNot with non-number target', async () => {
        const script = `
          data data
          data.flags = "hello"
          data.flags.bitNot()

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitNot\' must be a number');
        }
      });

      it('should handle @data.not with truthy values', async () => {
        const script = `
          data data
          data.result = true
          data.result.not()

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: false
        });
      });

      it('should handle @data.not with falsy values', async () => {
        const script = `
          data data
          data.result = false
          data.result.not()

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          result: true
        });
      });

      it('should handle @data.not with undefined target', async () => {
        const script = `
          data data
          data.result.not()

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'not\' cannot be undefined or null');
        }
      });

      it('should handle @data.not with various value types', async () => {
        const script = `
          data data
          data.truthy = "hello"
          data.falsy = ""
          data.zero = 0
          data.nonZero = 42
          data.nullValue = null

          var truthyVal = "hello"
          var falsyVal = ""
          var zeroVal = 0
          var nonZeroVal = 42

          data.notTruthy = truthyVal
          data.notFalsy = falsyVal
          data.notZero = zeroVal
          data.notNonZero = nonZeroVal

          data.notTruthy.not()
          data.notFalsy.not()
          data.notZero.not()
          data.notNonZero.not()

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          truthy: 'hello',
          falsy: '',
          zero: 0,
          nonZero: 42,
          nullValue: null,
          notTruthy: false,
          notFalsy: true,
          notZero: true,
          notNonZero: false
        });
      });

      it('should handle bitwise operations with dynamic paths', async () => {
        const script = `
          data data
          data.company.people = peopleData
          data.company.people[0].permissions &= 3
          data.company.people[1].flags |= 8
          data.company.people[2].mask.bitNot()

          return data.snapshot()`;
        const context = {
          peopleData: [
            { name: 'Alice', permissions: 15 },
            { name: 'Bob', flags: 1 },
            { name: 'Charlie', mask: 255 }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            people: [
              { name: 'Alice', permissions: 3 },  // 15 & 3 = 3
              { name: 'Bob', flags: 9 },          // 1 | 8 = 9
              { name: 'Charlie', mask: -256 }     // ~255 = -256
            ]
          }
        });
      });
    });

    describe('Delete Operation', function () {
      it('should handle @data.delete', async () => {
        const script = `
          data data
          data.user = { name: 'Alice', oldName: 'Bob' }
          data.user.oldName.delete()

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: { name: 'Alice' }
        });
      });

      it('should handle @data.delete with undefined target', async () => {
        const script = `
          data data
          data.user.name.delete()

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: {}
        });
      });

      it('should handle @data.delete with dynamic paths', async () => {
        const script = `
          data data
          data.company.people = peopleData
          data.company.people[0].oldEmail.delete()
          data.company.people[1].tempData.delete()

          return data.snapshot()`;
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

    describe('Array Concatenation', function () {
      it('should handle @data.concat with arrays', async () => {
        const script = `
          data data
          data.items = [1, 2, 3]
          data.items.concat([4, 5, 6])

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3, 4, 5, 6]
        });
      });

      it('should handle @data.concat with single values', async () => {
        const script = `
          data data
          data.items = [1, 2, 3]
          data.items.concat(4)
          data.items.concat("hello")

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3, 4, 'hello']
        });
      });

      it('should handle @data.concat with undefined target', async () => {
        const script = `
          data data
          data.items.concat([1, 2, 3])

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3]
        });
      });

      it('should handle @data.concat with non-array target', async () => {
        const script = `
          data data
          data.items = "hello"
          data.items.concat([1, 2, 3])

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'concat\' must be an array');
        }
      });

      it('should handle @data.concat with mixed array and non-array values', async () => {
        const script = `
          data data
          data.items = [1, 2]
          data.items.concat([3, 4])
          data.items.concat(5)
          data.items.concat([6, 7])
          data.items.concat("eight")

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3, 4, 5, 6, 7, 'eight']
        });
      });

      it('should handle @data.concat with dynamic paths', async () => {
        const script = `
          data data
          data.company.people = peopleData
          data.company.people[0].tags.concat(["admin", "active"])
          data.company.people[1].skills.concat(["JavaScript", "Python"])

          return data.snapshot()`;
        const context = {
          peopleData: [
            { name: 'Alice', tags: ['user'] },
            { name: 'Bob', skills: ['HTML', 'CSS'] }
          ]
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          company: {
            people: [
              { name: 'Alice', tags: ['user', 'admin', 'active'] },
              { name: 'Bob', skills: ['HTML', 'CSS', 'JavaScript', 'Python'] }
            ]
          }
        });
      });

      it('should handle @data.concat with objects in arrays', async () => {
        const script = `
          data data
          data.users = [{ name: 'Alice', id: 1 }]
          data.users.concat([{ name: 'Bob', id: 2 }, { name: 'Charlie', id: 3 }])

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          users: [
            { name: 'Alice', id: 1 },
            { name: 'Bob', id: 2 },
            { name: 'Charlie', id: 3 }
          ]
        });
      });
    });

    describe('Error Handling', function () {
      it('should throw error when using arithmetic operations on non-numbers', async () => {
        const script = `
          data data
          data.value = "hello"
          data.value -= 5

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'subtract\' must be a number');
        }
      });

      it('should throw error when using increment on non-numbers', async () => {
        const script = `
          data data
          data.value = "hello"
          data.value++

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'increment\' must be a number');
        }
      });

      it('should throw error when using decrement on non-numbers', async () => {
        const script = `
          data data
          data.value = "hello"
          data.value--

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'decrement\' must be a number');
        }
      });

      it('should throw error when using multiply on non-numbers', async () => {
        const script = `
          data data
          data.value = "hello"
          data.value *= 2

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'multiply\' must be a number');
        }
      });

      it('should throw error when using divide on non-numbers', async () => {
        const script = `
          data data
          data.value = "hello"
          data.value /= 2

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'divide\' must be a number');
        }
      });

      it('should throw error when using add on non-number and non-string', async () => {
        const script = `
          data data
          data.value = { name: 'Alice' }
          data.value += "hello"

          return data.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'add\' must be a number or string');
        }
      });
    });

    describe('Complex Scenarios', function () {
      it('should handle mixed arithmetic and logical operations', async () => {
        const script = `
          data data
          data.counter = 10
          data.counter += 5
          data.counter *= 2
          data.counter -= 3
          data.counter++
          data.counter /= 2

          data.flag = true
          data.flag &&= finished
          data.flag ||= finished

          return data.snapshot()`;
        const result = await env.renderScriptString(script, { finished: true });
        expect(result).to.eql({
          counter: 14,
          flag: true
        });
      });

      it('should handle operations in loops', async () => {
        const script = `
          data data
          data.total = 0
          data.count = 0
          for i in range(5)
            data.total += i
            data.count++
          endfor

          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          total: 10, // 0+1+2+3+4
          count: 5
        });
      });

      it('should handle operations in macros', async () => {
        const script = `
          data data
          macro processUser(name, salary)
            data data
            data.name = name
            data.salary = salary
            data.salary += 1000
            data.bonus = salary * 0.1
            return data.snapshot()
          endmacro

          var user1 = processUser("Alice", 50000)
          var user2 = processUser("Bob", 60000)

          data.users.push(user1)
          data.users.push(user2)
          data.totalSalary = 0
          data.totalSalary += user1.salary
          data.totalSalary += user2.salary

          return data.snapshot()`;
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
          data data
          var userData = fetchUser(1)
          var salaryData = fetchSalary(1)

          data.user.name = userData.name
          data.user.salary = salaryData.base
          data.user.salary += salaryData.bonus
          data.user.salary *= 1.05

          return data.snapshot()`;
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

  it('should create multiple levels of nested objects and arrays automatically', async () => {
    const script = `
      // This command should create the 'a', 'b', and 'c' objects,
      // and then the 'd' array before pushing the value.
      data data
      data.a.b.c.d.push(100)
      data.a.b.anotherProp = "hello"

      return data.snapshot()`;
    const result = await env.renderScriptString(script);
    expect(result).to.eql({
      a: {
        b: {
          c: {
            d: [100]
          },
          anotherProp: 'hello'
        }
      }
    });
  });

  it('should handle root-level array index targeting with @data[]', async () => {
    const script = `
      // Initialize the root as an array
      data data
      data = []

      // Push items to the root array
      data.push({ name: 'Alice' })
      data.push({ name: 'Bob' })

      // Target the last item pushed (Bob) and modify it
      data[].status = "active"

      // Push another item
      data.push({ name: 'Charlie' })

      // Target the new last item (Charlie)
      data[].role = "guest"

      return data.snapshot()`;
    const result = await env.renderScriptString(script);
    expect(result).to.eql([
      { name: 'Alice' },
      { name: 'Bob', status: 'active' },
      { name: 'Charlie', role: 'guest' }
    ]);
  });

  describe('Call Block Filters', function () {



    it('Temp test for comparison : should support call block in templates', async () => {
      const template = `
          {% macro wrapper() %}
            Wrapped: {{ caller() }}
          {% endmacro %}

          {% call wrapper() -%}
            Content
          {%- endcall %}
        `;
      const result = await env.renderTemplateString(template);
      expect(result.trim()).to.contain('Wrapped: Content');
    });

    it('should filter output to text when using filter', async () => {
      const script = `
        text text
        data data
        macro wrapper()
           text text
           var content = caller()
           text("DebugContent: " + content)
           if content.text
             text(" HasText: " + content.text)
           endif
           return { text: text.snapshot() }
        endmacro

        call wrapper()
          text text
          data data
          text("Inner")
          data.key = "value"
          return text.snapshot()
        endcall

        return { text: text.snapshot(), data: data.snapshot() }`;
      const result = await env.renderScriptString(script);
      // filter means the call block output is text only.
      // And it is appended to the main script's text output.
      expect(result.text.trim()).to.equal('DebugContent: Inner');
      // The inner data should be discarded by the filter on the call block
      // But wrapper does not output data anyway.
    });

    it('should filter output to data when using filter', async () => {
      const script = `
        text text
        data data
        macro wrapper()
           data data
           var content = caller()
           data.wrappee = content
           return {data: data.snapshot() }
        endmacro

        call wrapper()
          data data
          text text
          text("Inner")
          data.key = "value"
          return data.snapshot()
        endcall

        return {data: data.snapshot(), text: text.snapshot() }`;
      const result = await env.renderScriptString(script);
      // Wrapper output focused to data.
      // Wrapper returns data object.
      // Caller returns object (since script mode).
      // wrapper logic sets @data.wrappee = content.
      // So wrapper output has data.
      // Main script receives filtered data.
      expect(result.data).to.not.be.undefined;
      expect(result.data.wrappee).to.not.be.undefined;
      // Depending on caller() behavior in script mode (returns object), wrappee might be object.
    });

    it('should return full object when no filter is specified', async () => {
      const script = `
        text text
        data data
        macro wrapper()
           data data
           var content = caller()
           data.wrappee = content
           return {data: data.snapshot() }
        endmacro

        call wrapper()
          text text
          data data
          text("Inner")
          data.key = "value"
          return { text: text.snapshot(), data: data.snapshot() }
        endcall

        return {data: data.snapshot(), text: text.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.data).to.not.be.undefined;
      expect(result.data.wrappee).to.not.be.undefined;
    });

    it('should handle call("macroName") consistently with direct calls (no [object Object] output)', async () => {
      const script = `

        text text
        macro dataProducer()
            data data
            data.value = "produced data direct"
            text(" (dataProducer exec) ")
            return data.snapshot()
        endmacro

        macro generic()
            data data
            text text
            data.foo = "bar"
            text("Generic text")
            return {data: data.snapshot(), text: text.snapshot() }
        endmacro

        macro testRunner()
            text text
            // Case 1: Call block invoking macro
            text("Call-Data: ")
            call dataProducer()
              text text
              return text.snapshot()
            endcall

            text(" Call-Generic: ")
            call generic()
              text text
              return text.snapshot()
            endcall
            return text.snapshot()
        endmacro

        call testRunner()
          text text
          return text.snapshot()
        endcall

        return text.snapshot()`;

      const result = await env.renderScriptString(script);

      // Check text output
      const textOut = (typeof result === 'string') ? result : (result.text || '');

      // "Call-Data: " should be followed by empty string because dataProducer filter suppresses text
      // and our fix ensures it doesn't print [object Object].
      expect(textOut).to.contain('Call-Data: ');
      expect(textOut).to.contain('Call-Generic: Generic text');
      expect(textOut).to.not.contain('[object Object]');
    });
  });

  describe('Output Suppression Coverage', function () {
    it('should ignore plain objects in script text output', async () => {
      const script = `
        // Plain object should be swallowed, not printed as [object Object]
        text text
        text({ key: "value" })
        text("End")

        return text.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.equal('End');
    });

    it('should handled mixed content with objects', async () => {
      const script = `
        text text
        text("Start ")
        text({ a: 1 })
        text("Middle")
        text({ b: 2 })
        text(" End")

        return text.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.equal('Start Middle End');
    });

    it('should stringify arrays in script text output (legacy behavior)', async () => {
      const script = `
        // Arrays fall through to standard suppressValue, so they get joined
        text text
        text([1, 2, 3])

        return text.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.equal('1,2,3');
    });

    it('should stringify objects with custom toString', async () => {
      const script = `
        text text
        text(customObj)

        return text.snapshot()`;
      const context = {
        customObj: {
          toString: function () { return 'Custom String'; }
        }
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.equal('Custom String');
    });

    it('should ignore async plain objects (Promises resolving to objects)', async () => {
      const script = `
        // asyncObj is a function returning a Promise that resolves to a plain object
        text text
        text(asyncObj())
        text("AsyncEnd")

        return text.snapshot()`;
      const context = {
        asyncObj: async () => {
          return { key: 'async val' };
        }
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.equal('AsyncEnd');
    });

    it('should handle async arrays', async () => {
      const script = `
        text text
        text(asyncArr())

        return text.snapshot()`;
      const context = {
        asyncArr: async () => {
          return [10, 20];
        }
      };
      const result = await env.renderScriptString(script, context);
      expect(result).to.equal('10,20');
    });
  });

  describe('Async and Error Handling', function () {
    it('should handle async path segments in @data', async () => {
      const context = {
        getIndex: async () => 0
      };
      const script = `
            data data
            data.items = [100]
            data.items[getIndex()] = 200

            return data.snapshot()`;
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({ items: [200] });
    });

    it('should handle async values in @data assignments', async () => {
      const context = {
        getValue: async () => 10
      };
      const script = `
            data data
            data.obj = { x: 1 }
            data.obj.x = getValue()

            return data.snapshot()`;
      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({ obj: { x: 10 } });
    });

    it('should handle poison propagation from path segments', async () => {
      const context = {
        getErrorIndex: async () => { throw new Error('Index Poison'); }
      };
      const script = `
            data data
            data.list = [1]
            data.list[getErrorIndex()] = 2

            return data.snapshot()`;
      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have failed');
      } catch (e) {
        expect(e.message).to.contain('Index Poison');
      }
    });

    it('should handle poison propagation from value resolution', async () => {
      const context = {
        getPoison: async () => { throw new Error('Value Poison'); }
      };
      const script = `
            data data
            data.val = getPoison()

            return data.snapshot()`;
      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have failed');
      } catch (e) {
        expect(e.message).to.contain('Value Poison');
      }
    });
  });

  describe('@value Output Handler', function () {
    it('should support @value(val) syntax', async () => {
      const script = `
          value value
          value(10)

          return { value: value.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.value).to.equal(10);
    });

    it('should support @value = val syntax', async () => {
      const script = `
          value value
          value = 20

          return { value: value.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.value).to.equal(20);
    });

    it('should return the last set value', async () => {
      const script = `
          value value
          value(1)
          value = 2
          value(3)

          return { value: value.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.value).to.equal(3);
    });

    it('should work with expressions', async () => {
      const script = `
          value value
          var x = 5
          value = x * 2

          return { value: value.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.value).to.equal(10);
    });

    it('should work with macros returning value', async () => {
      const script = `
          value value
          macro getValue()
              value value
              value = 42
              return { value: value.snapshot() }
          endmacro

          var res = getValue()
          value = res.value

          return { value: value.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.value).to.equal(42);
    });

    it('should work with focus on macro', async () => {
      const script = `
          value value
          macro computeSum(a, b)
              value value
              value = a + b
              return value.snapshot()
          endmacro

          var result = computeSum(10, 20)
          value = result

          return { value: value.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.value).to.equal(30);
    });

    it('should support focus to return unwrapped value', async () => {
      const script = `
          value value
          value = 42

          return value.snapshot()`;
      const result = await env.renderScriptString(script);
      // With focus, the result is the raw value, not { value: 42 }
      expect(result).to.equal(42);
    });

    it('should support focus with expressions', async () => {
      const script = `
          value value
          var x = 10
          var y = 20
          value = x + y

          return value.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.equal(30);
    });

    it('should support focus with object values', async () => {
      const script = `
          value value
          value = { name: "Alice", age: 30 }

          return value.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ name: 'Alice', age: 30 });
    });

    it('should support focus with array values', async () => {
      const script = `
          value value
          value = [1, 2, 3, 4, 5]

          return value.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql([1, 2, 3, 4, 5]);
    });

    it('should support focus with string values', async () => {
      const script = `
          value value
          value = "Hello, World!"

          return value.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.equal('Hello, World!');
    });

    it('should return last value when multiple @value commands with focus', async () => {
      const script = `
          value value
          value(10)
          value = 20
          value(30)

          return value.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.equal(30);
    });

    it('should work with focus in macros returning computed values', async () => {
      const script = `
          data data
          value value
          macro factorial(n)
              value value
              var result = 1
              var i = 1
              while i <= n
                  result = result * i
                  i = i + 1
              endwhile
              value = result
              return value.snapshot()
          endmacro

          var fact5 = factorial(5)
          data.result = fact5

          return {data: data.snapshot(), value: value.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.data.result).to.equal(120);
    });
  });
});
