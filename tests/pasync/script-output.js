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
        data result
        var obj = none
        result.value = obj.prop
        return result.snapshot()`;

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
      data result
      var userList = fetchData('users')
      var appConfig = fetchData('config')

      // The '@' commands are buffered. They run sequentially AFTER the parallel
      // operations above complete, using their now-resolved values.
      result.result.users.set(userList)
      result.result.config.merge(appConfig)
      result.result.config.loaded.set(true)
      result.result.log.push("Data fetch complete")

      return result.snapshot()`;

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
      data result
      macro buildUserReport(id)
        data reportData
        // These two fetches inside the macro also run in parallel.
        var userData = fetchUser(id)
        var tasksData = fetchTasks(id)

        // Assemble the macro's own return value. This happens after
        // its internal fetches are complete.
        reportData.user.id = userData.id
        reportData.user.name = userData.name
        reportData.user.tasks = tasksData
        return reportData.snapshot()
      endmacro

      // Call the macro for different users. These two calls are independent
      // and will execute in parallel.
      var report1 = buildUserReport(1)
      var report2 = buildUserReport(2)

      // The final assembly step for the main script. This block waits for
      // both 'report1' and 'report2' to be fully resolved before running.
      result.reports.user1 = report1.user
      result.reports.user2 = report2.user
      result.reports.summary = "Generated 2 reports"

      return result.snapshot()`;

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
        data result
        result.user.name = "Alice"
        result.user.role = "Admin"
        result.user.role = "Super-Admin" // Overwrites previous set

        // Push adds to an array, creating it if needed
        result.user.tags.push("active")
        result.user.tags.push("new")

        // Merge combines objects
        result.settings.profile = { theme: "light" }
        result.settings.profile.merge({ notifications: true })

        // Deep merge combines nested objects
        result.settings.deep = { a: { b: 1 } }
        result.settings.deep.deepMerge({ a: { c: 2 }, d: 3 })

        return result.snapshot()`;
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
        data result
        result = { name: 'George', age: 30 }

        // This should replace the entire object, not add to it
        result = { status: 'active', role: 'user' }

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        status: 'active',
        role: 'user'
      });
    });

    it('should correctly handle nested macro calls with different filters', async () => {
      const script = `

        text mainText
        macro dataProducer()
            data result
            text ignoredText
            result.value = "produced data"
            ignoredText("ignored text in data macro")
            return result.snapshot()
        endmacro

        macro generic()
            data result
            text genericText
            result.foo = "bar"
            genericText("Generic text")
            return {data: result.snapshot(), text: genericText.snapshot() }
        endmacro

        macro textConsumer()
            text consumerText
            consumerText("Start consumer. ")

            // Case 1: Calling macro (returns unwrapped data object)
            var dataRes = dataProducer()
            if (dataRes.value)
                 consumerText("Data: " + dataRes.value + ". ")
            endif

            // Case 2: Calling no-filter macro (returns full Result Object)
            var genRes = generic()
            consumerText("Inner text: " + genRes.text)
            return consumerText.snapshot()
        endmacro

        var consumerResult = textConsumer()
        mainText(consumerResult)

        return mainText.snapshot()`;

      const result = await env.renderScriptString(script);
      expect(result).to.contain('Start consumer.');
      expect(result).to.contain('Data: produced data.');
      expect(result).to.contain('Inner text: Generic text');
    });

    it('should support explicit callbacks with parameters and return focus', async () => {
      const script = `
        data result
        macro recursive(list, initial)
          data resultData
          var acc = initial
          for item in list
            acc = caller(acc, item)
          endfor
          resultData.value = acc
          return resultData.snapshot()
        endmacro

        var callResult = call recursive([1, 2, 3], 0) (sum, num)
          data callData
          callData = sum + num
          return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 6 });
    });

    it('should support explicit callbacks with no arguments, only focusing', async () => {
      const script = `
        data result
        macro recursive(list)
          data resultData
          var acc = 0
          for item in list
            var res = caller()
            acc = acc + res.value
          endfor
          resultData.value = acc
          return resultData.snapshot()
        endmacro

        var callResult = call recursive([1, 2, 3])
          data callData
          callData.value = 1
          return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 3 });
    });

    it('should support explicit callbacks with arguments but no focusing', async () => {
      const script = `
        data result
        macro recursive(list)
          data resultData
          var acc = 0
          for item in list
            var res = caller(item)
            acc = acc + res.val
          endfor
          resultData.value = acc
          return resultData.snapshot()
        endmacro

        var callResult = call recursive([1, 2, 3]) (item)
          data callData
          callData.val = item * 2
          return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 12 });
    });

    it('should support explicit callbacks with no arguments and no focusing', async () => {
      const script = `
        data result
        macro recursive(list)
          data resultData
          var acc = 0
          for item in list
             var res = caller()
             acc = acc + res.val
          endfor
          resultData.value = acc
          return resultData.snapshot()
        endmacro

        var callResult = call recursive([1, 2, 3])
          data callData
          callData.val = 1
          return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 3 });
    });

    it('should support explicit callbacks with empty arguments and focusing', async () => {
      const script = `
        data result
        macro runner()
          data resultData
          var res = caller()
          resultData.value = res.val
          return resultData.snapshot()
        endmacro

        var callResult = call runner() ()
           data callData
           callData.val = 42
           return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ value: 42 });
    });

    it('should access outer variables in call block', async () => {
      const script = `
        data result
        var outer = 10
        macro runner()
          data resultData
          var res = caller()
          resultData.val = res.val
          return resultData.snapshot()
        endmacro

        var callResult = call runner()
          data callData
          callData.val = outer
          return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ val: 10 });
    });

    it('should resolve variables from caller site (lexical scope)', async () => {
      const script = `
        data result
        var x = "outer"
        macro runner()
          data resultData
          var innerX = "inner"
          var res = caller()
          resultData.val = res.val
          return resultData.snapshot()
        endmacro

        var callResult = call runner()
          data callData
          callData.val = x
          return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ val: 'outer' });
    });

    it('should allow call arguments to shadow outer variables', async () => {
      const script = `
        data result
        var x = "outer"
        macro runner()
          data resultData
          var res = caller("arg")
          resultData.val = res.val
          return resultData.snapshot()
        endmacro

        var callResult = call runner() (callX)
          data callData
          callData.val = callX
          return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ val: 'arg' });
    });

    it('should fail to access variables defined purely inside the macro (isolation)', async () => {
      const script = `
        data result
        macro runner()
          data resultData
          var secret = "inner"
          var res = caller()
          resultData.val = res.val
          return resultData.snapshot()
        endmacro

        var callResult = call runner()
           data callData
           callData.val = secret
           return callData.snapshot()
        endcall
        result = callResult

        return result.snapshot()`;
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
        data result
        result.user.name = "Alice"
        result.user.role = "Admin"

        // Merge new data into the root object
        result.deepMerge({ user: { status: "active" }, config: { theme: "dark" } })

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        user: { name: 'Alice', role: 'Admin', status: 'active' },
        config: { theme: 'dark' }
      });
    });

    it('should handle null path with deepMerge for nested object merging', async () => {
      const script = `
        // Start with nested data
        data result
        result.user.profile.name = "Bob"
        result.user.profile.settings.theme = "light"

        // Deep merge new data into the root object
        result.deepMerge({
          user: {
            profile: {
              settings: { notifications: true },
              email: "bob@example.com"
            }
          }
        })

        return result.snapshot()`;
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
        data result
        result.items.push("a")
        result.items.push("b")
        result.items.push("c")
        result.items.push("d")

        result.items.pop() // remove "d" -> [a, b, c]
        result.items.shift() // remove "a" -> [b, c]
        result.items.unshift("x") // add "x" -> [x, b, c]
        result.items.reverse() // -> [c, b, x]

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: ['c', 'b', 'x'] });
    });

    it('should handle array index targeting including last-item `[]`', async () => {
      const script = `
        data result
        result.users.push({ name: 'Alice', tasks: ['task1', 'task2'] })
        result.users.push({ name: 'Bob' })

        // Target specific index
        result.users[0].role = "Admin"

        // Target last item pushed in script sequence
        result.users.push({ name: 'Charlie' })
        result.users[].role = "Guest" // Affects Charlie

        result.users[1].status = "active" // Affects Bob
        result.users[0].tasks[] = "task3" // append task to Alice

        return result.snapshot()`;
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
        data result
        result.users = usersData
        result.users[getUserIndex()].roles.push("editor")

        return result.snapshot()`;
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
        data result
        result.company = companyData
        result.company.departments[getDeptId()].merge({ budget: 50000 })

        return result.snapshot()`;
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
        data result
        result.company = companyData
        result.company.users[getUserId()].profile.settings[getSettingKey()] = "enabled"

        return result.snapshot()`;
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
        data result
        result.company = companyData
        result.company.users[getUserId()].log.append(" - User logged in")

        return result.snapshot()`;
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
        data result
        result.users = usersData
        result.users[getUserIndex()].items.pop()

        return result.snapshot()`;
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
        data result
        result.users = usersData
        result.users[getUserIndex()].tasks.shift()

        return result.snapshot()`;
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
        data result
        result.users = usersData
        result.users[getUserIndex()].tasks.unshift("urgent")

        return result.snapshot()`;
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
        data result
        result.users = usersData
        result.users[getUserIndex()].items.reverse()

        return result.snapshot()`;
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
        text output
        data result
        output("Hello")
        output(", ")
        output("World!")
        result.status = "ok"

        return { text: output.snapshot(), data: result.snapshot() }`;
      // No focus, so we get the full result object
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        data: { status: 'ok' },
        text: 'Hello, World!'
      });
    });

    it('should append to a path in the data object with @data.append', async () => {
      const script = `
        data result
        result.log = "Log started. "
        result.log.append("Event 1. ")
        result.log.append("Event 2.")

        return result.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
    });

    it('should focus the output to just the text stream with', async () => {
      const script = `
        text output
        data result
        output("This is ")
        output("the final text.")
        result.status = "ignored"

        return output.snapshot()`;
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
        data result
        result.users.push({ id: 1, name: "Alice", status: "active" })
        result.users.push({ id: 2, name: "Bob" })
        result.users.upsert({ id: 1, status: "inactive" }) // Updates Alice
        result.users.upsert({ id: 3, name: "Charlie" })    // Adds Charlie

        return result.snapshot()`;
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
        data result
        var captured = capture
          data captureData
          text captureText
          captureData.user.name = "Captured User"
          captureText("hello from capture")
          return {data: captureData.snapshot(), text: captureText.snapshot() }
        endcapture
        result.result = captured

        return result.snapshot()`;
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
        data result
        sink turtle = makeTurtle()
        turtle.forward(100)
        result.status = "ignored"
        return turtle.snapshot()
      `;
      const result = await env.renderScriptString(script, context);
      expect(result).to.be.a(Turtle);
      expect(result.x).to.equal(100);
    });

    it('should allow input focusing in capture blocks', async () => {
      const script = `
        // The capture block's output is focused to just the data object
        data result
        var userData = capture
          data captureData
          var user = { name: "Bob", role: "user" }
          captureData.name = user.name
          captureData.role = user.role
          return captureData.snapshot()
        endcapture

        result.result.user = userData

        return result.snapshot()`;

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
        data result
        var capturedContent = "initial"

        // 2. Assign using capture (must work on existing variable)
        capturedContent = capture
             data captureData
             captureData.status = "updated"
             captureData.value = 123
             return captureData.snapshot()
        endcapture

        result.result = capturedContent

        return result.snapshot()`;
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
      data result
      var captured = capture
        data captureData
        text captureText
        captureData.user.name = "Captured User"
        captureText("hello from capture")
        return {data: captureData.snapshot(), text: captureText.snapshot() }
      endcapture
      result.result = captured

      return result.snapshot()`;

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
          text output
          output(user.name)
          return { text: output.snapshot() }
        `;
        const context = { user: { name: 'Alice' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Alice');
      });

      it('should handle a simple path-like expression with trailing whitespace', async () => {
        const script = `
          text output
          output(user.name)
          return { text: output.snapshot() }
        `;
        const context = { user: { name: 'Alice' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Alice');
      });

      it('should handle an expression with a binary operator', async () => {
        const script = `
          text output
          output("Hello, " + user.name)
          return { text: output.snapshot() }
        `;
        const context = { user: { name: 'Bob' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Hello, Bob');
      });

      it('should handle an expression starting with a string literal', async () => {
        const script = `
          text output
          output("Hello World")
          return { text: output.snapshot() }
        `;
        const result = await env.renderScriptString(script, {});
        expect(result.text).to.equal('Hello World');
      });

      it('should handle an expression that is a function call', async () => {
        const script = `
          text output
          output(format(user.name))
          return { text: output.snapshot() }
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
          text output
          output(user.name|title)
          return { text: output.snapshot() }
        `;
        const context = { user: { name: 'dave' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Dave');
      });

      it('should handle a path-like expression broken by a math operator', async () => {
        const script = `
          text output
          output(user.id + 1)
          return { text: output.snapshot() }
        `;
        const context = { user: { id: 99 } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('100');
      });

      it('should handle a path-like expression broken by parenthesis', async () => {
        const script = `
          text output
          output((user.name))
          return { text: output.snapshot() }
        `;
        const context = { user: { name: 'Eve' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Eve');
      });

      it('should handle an expression with multiple path-like parts', async () => {
        const script = `
          text output
          output(user.name + " " + user.lastName)
          return { text: output.snapshot() }
        `;
        const context = { user: { name: 'Frank', lastName: 'Castle' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Frank Castle');
      });

      it('should handle an expression with a path broken by internal whitespace', async () => {
        // Transpiles to `{{ user. firstName }}`, where `user.` is undefined.
        // Nunjucks treats `undefined` as an empty string in concatenation.
        const script = `
          text output
          output(user. firstName)
          return { text: output.snapshot() }
        `;
        const context = { user: { firstName: 'Grace' } };
        const result = await env.renderScriptString(script, context);
        expect(result.text).to.equal('Grace');
      });

      it('should handle an object as an expression', async () => {
        const script = `
          text output
          output(user)
          return { text: output.snapshot() }
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
                data result
                result.user.name = "Alice"

                return result.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { name: 'Alice' } });
      });

      it('should handle @data assignment with a path and a variable value', async () => {
        const script = `
                data result
                var userId = 123
                result.user.profile.id = userId

                return result.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { profile: { id: 123 } } });
      });

      it('should handle @data assignment with a complex expression in brackets', async () => {
        const script = `
                data result
                var key = "complex"
                result.items[key + "Id"] = "value"

                return result.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ items: { complexId: 'value' } });
      });

      it('should handle statement-style @data.append to append to a data path', async () => {
        // Note: statement-style @data.append APPENDS, it doesn't set.
        const script = `
                data result
                result.log = "Log started. "
                result.log.append("Event 1. ")
                result.log.append("Event 2.")

                return result.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
      });

      it('should handle command with path but no value argument (@data.pop)', async () => {
        const script = `
                data result
                result.user.items = ["a", "b", "c"]
                result.user.items.pop()

                return result.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: ['a', 'b'] } });
      });

      it('should handle command with no arguments (@data.reverse) on a path', async () => {
        // Note: The built-in @data.reverse command requires a path.
        // A command like @data.reverse with no args is valid syntax but would
        // throw an error in the handler. Here we test a valid use case.
        const script = `
                data result
                result.user.items = [1, 2, 3]
                result.user.items.reverse()

                return result.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.eql({ user: { items: [3, 2, 1] } });
      });

      it('should ignore comments between command parts', async () => {
        const script = `
                data result
                result.user.name = "Heidi"

                return result.snapshot()`;
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
      data result
      var obj = getData()
      result.result = { id: obj.id, name: obj.name }

      return result.snapshot()`;

        const result = await env.renderScriptString(script, context);
        expect(result.result.id).to.equal(42);
        expect(result.result.name).to.equal('Test');
      });
    });

    describe('Dynamic path commands (function calls and expressions in paths)', () => {
      it('should handle @data assignment with function call in array index', async () => {
        const script = `
          data result
          result.company = companyData
          result.company.users[getUserId()].name = "Alice"

          return result.snapshot()`;
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
          data result
          result.company = companyData
          result.company.users[getUserKey()].status = "active"

          return result.snapshot()`;
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
          data result
          result.items = itemsData
          var index = 1
          result.items[index + 1].name = "Item C"

          return result.snapshot()`;
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
          data result
          result.data = dataSource
          var prefix = "user"
          var suffix = "Profile"
          result.data[prefix + suffix].name = "Dynamic User"

          return result.snapshot()`;
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
          data result
          result.users = usersData
          result.users[getUserIndex()].roles.push("editor")

          return result.snapshot()`;
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
          data result
          result.company = companyData
          result.company.departments[getDeptId()].merge({ budget: 50000 })

          return result.snapshot()`;
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
          data result
          result.company = companyData
          result.company.users[0].profile.settings.notifications = "enabled"
          result.company.users[getUserId()].profile.settings.deepMerge({ theme: "dark" })

          return result.snapshot()`;
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
          data result
          result.company = companyData
          result.company.users[getUserId()].log.append(" - User logged in")

          return result.snapshot()`;
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
          data result
          result.users = usersData
          result.users[getUserIndex()].items.pop()

          return result.snapshot()`;
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
          data result
          result.users = usersData
          result.users[getUserIndex()].tasks.shift()

          return result.snapshot()`;
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
          data result
          result.users = usersData
          result.users[getUserIndex()].tasks.unshift("urgent")

          return result.snapshot()`;
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
          data result
          result.users = usersData
          result.users[getUserIndex()].items.reverse()

          return result.snapshot()`;
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
          data result
          result.company = companyData
          result.company.users[getUserId()].name = "Updated User"
          result.company.users[getUserId()].roles.push("manager")
          result.company.departments[getDeptId()].head = getUserId()

          return result.snapshot()`;
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
          data result
          var userData = fetchUser(1)
          var salaryData = fetchSalary(1)

          result.user.name = userData.name
          result.user.salary = salaryData.base
          result.user.salary += salaryData.bonus
          result.user.salary *= 1.05

          return result.snapshot()`;
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
          data result
          result.users = usersData
          var isAdmin = true
          result.users[0 if isAdmin else 1].role = "admin"

          return result.snapshot()`;
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
          data result
          result.items = itemsData
          var baseIndex = 2
          result.items[baseIndex * 2 - 1].priority = "high"

          return result.snapshot()`;
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
          data result
          result.company = companyData
          result.company.users[getNestedUserId()].profile.settings[getSettingKey()] = "enabled"

          return result.snapshot()`;
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
          data result
          result.users = usersData
          result.users[getUserIndex()].name = "Updated Name"

          return result.snapshot()`;
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
          data result
          result.counter = 10
          result.counter += 5
          result.counter += 3

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 18
        });
      });

      it('should handle @data.add with strings', async () => {
        const script = `
          data result
          result.message = "Hello"
          result.message += " World"
          result.message += "!"

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          message: 'Hello World!'
        });
      });

      it('should handle @data.add with undefined target', async () => {
        const script = `
          data result
          result.counter += 10
          result.message += "Hello"

          return result.snapshot()`;
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
          data result
          result.counter = 20
          result.counter -= 5
          result.counter -= 3

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 12
        });
      });

      it('should handle @data.subtract with undefined target', async () => {
        const script = `
          data result
          result.counter -= 10

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'subtract\' cannot be undefined or null');
        }
      });

      it('should handle @data.increment', async () => {
        const script = `
          data result
          result.counter = 5
          result.counter++
          result.counter++

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 7
        });
      });

      it('should handle @data.increment with undefined target', async () => {
        const script = `
          data result
          result.counter++

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'increment\' cannot be undefined or null');
        }
      });

      it('should handle @data.decrement', async () => {
        const script = `
          data result
          result.counter = 10
          result.counter--
          result.counter--

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 8
        });
      });

      it('should handle @data.decrement with undefined target', async () => {
        const script = `
          data result
          result.counter--

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'decrement\' cannot be undefined or null');
        }
      });

      it('should handle @data.multiply', async () => {
        const script = `
          data result
          result.counter = 5
          result.counter *= 3
          result.counter *= 2

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 30
        });
      });

      it('should handle @data.multiply with undefined target', async () => {
        const script = `
          data result
          result.counter *= 5

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'multiply\' cannot be undefined or null');
        }
      });

      it('should handle @data.divide', async () => {
        const script = `
          data result
          result.counter = 100
          result.counter /= 2
          result.counter /= 5

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          counter: 10
        });
      });

      it('should handle @data.divide with undefined target', async () => {
        const script = `
          data result
          result.counter /= 2

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'divide\' cannot be undefined or null');
        }
      });

      it('should throw error on division by zero', async () => {
        const script = `
          data result
          result.counter = 10
          result.counter /= 0

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Division by zero is not allowed');
        }
      });

      it('should handle arithmetic operations with dynamic paths', async () => {
        const script = `
          data result
          result.company.people = peopleData
          result.company.people[0].salary += 100
          result.company.people[1].age++
          result.company.people[2].bonus *= 1.5

          return result.snapshot()`;
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
          data result
          result.company.people.push({ name: 'Alice', salary: 50000 })
          result.company.people.push({ name: 'Bob', age: 30, salary: 100 })
          result.company.people[].salary += 100
          result.company.people[].age++

          return result.snapshot()`;
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
          data result
          result = []

          // Push items to the root array
          result.push({ name: 'Alice' })
          result.push({ name: 'Bob' })

          // Target the last item pushed (Bob) and modify it
          result[].status = "active"

          // Push another item
          result.push({ name: 'Charlie' })

          // Target the new last item (Charlie)
          result[].role = "guest"

          return result.snapshot()`;
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
          data result
          result = []

          // Push items to the root array
          result.push({ name: 'Alice' })
          result.push({ name: 'Bob' })

          // Target a specific index and modify it
          result[0].status = "inactive"

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql([
          { name: 'Alice', status: 'inactive' },
          { name: 'Bob' }
        ]);
      });

      it('should handle root-level dynamic indexing with function call', async () => {
        const script = `
          data result
          result = [{ name: 'A' }, { name: 'B' }, { name: 'C' }]
          result[getIndex()].flag = "reviewed"

          return result.snapshot()`;
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
          data result
          result = []
          result.push({ name: 'Alice' })
          result.push({ name: 'Bob' })
          result[].tags.push("new")         // affects Bob
          result[].meta.role = "guest"      // affects Bob

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql([
          { name: 'Alice' },
          { name: 'Bob', tags: ['new'], meta: { role: 'guest' } }
        ]);
      });

      it('should allow complex property paths after @data[] with dynamic key', async () => {
        const script = `
          data result
          result = []
          result.push({ name: 'Alice' })
          result.push({ name: 'Bob' })
          result[].profile[getKey()].score = 10

          return result.snapshot()`;
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
          data result
          result = []
          result.push({ name: 'A', count: 0 })
          result[].count++
          result.push({ name: 'B', count: 1 })
          result[].count += 4

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql([
          { name: 'A', count: 1 },
          { name: 'B', count: 5 }
        ]);
      });

      it('should throw when using @data[] on an empty root array', async () => {
        const script = `
          data result
          result = []
          result[].value = 1

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain(`Cannot set last element ('[]') on empty array.`);
        }
      });

      it('should throw when using @data[] and root is not an array', async () => {
        const script = `
          data result
          result = { a: 1 }
          result[].x = 2

          return result.snapshot()`;
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
          data result
          result.value = true
          result.value &&= true
          result.value &&= "hello"

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          value: 'hello'
        });
      });

      it('should handle @data.and with falsy values', async () => {
        const script = `
          data result
          result.value = true
          result.value &&= false
          result.value &&= "hello"

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          value: false
        });
      });

      it('should handle @data.and with undefined target', async () => {
        const script = `
          data result
          result.value &&= true

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'and\' cannot be undefined or null');
        }
      });

      it('should handle @data.or with truthy values', async () => {
        const script = `
          data result
          result.value = false
          result.value ||= true
          result.value ||= "hello"

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          value: true
        });
      });

      it('should handle @data.or with falsy values', async () => {
        const script = `
          data result
          result.value = false
          result.value ||= false
          result.value ||= "hello"

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          value: 'hello'
        });
      });

      it('should handle @data.or with undefined target', async () => {
        const script = `
          data result
          result.value ||= "hello"

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'or\' cannot be undefined or null');
        }
      });

      it('should handle logical operations with complex values', async () => {
        const script = `
          data result
          var permissions = ['read', 'write']
          var user = { name: 'Alice', active: true }
          result.user = user
          result.permissions = permissions
          result.value = true
          result.value &&= user.active
          result.value ||= permissions.length > 0

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: { name: 'Alice', active: true },
          permissions: ['read', 'write'],
          value: true
        });
      });

      it('should handle @data.bitAnd with numbers', async () => {
        const script = `
          data result
          result.flags = 15  // 1111 in binary
          result.flags &= 10  // 1010 in binary

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          flags: 10  // 1010 in binary
        });
      });

      it('should handle @data.bitAnd with undefined target', async () => {
        const script = `
          data result
          result.flags &= 10

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitAnd\' cannot be undefined or null');
        }
      });

      it('should handle @data.bitAnd with non-number target', async () => {
        const script = `
          data result
          result.flags = "hello"
          result.flags &= 10

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitAnd\' must be a number');
        }
      });

      it('should handle @data.bitOr with numbers', async () => {
        const script = `
          data result
          result.flags = 5   // 0101 in binary
          result.flags |= 10  // 1010 in binary

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          flags: 15  // 1111 in binary
        });
      });

      it('should handle @data.bitOr with undefined target', async () => {
        const script = `
          data result
          result.flags |= 10

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitOr\' cannot be undefined or null');
        }
      });

      it('should handle @data.bitOr with non-number target', async () => {
        const script = `
          data result
          result.flags = "hello"
          result.flags |= 10

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitOr\' must be a number');
        }
      });

      it('should handle @data.bitNot with numbers', async () => {
        const script = `
          data result
          result.flags = 15  // 1111 in binary
          result.flags.bitNot()

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          flags: -16  // ~15 = -16
        });
      });

      it('should handle @data.bitNot with undefined target', async () => {
        const script = `
          data result
          result.flags.bitNot()

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitNot\' cannot be undefined or null');
        }
      });

      it('should handle @data.bitNot with non-number target', async () => {
        const script = `
          data result
          result.flags = "hello"
          result.flags.bitNot()

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'bitNot\' must be a number');
        }
      });

      it('should handle @data.not with truthy values', async () => {
        const script = `
          data result
          result.value = true
          result.value.not()

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          value: false
        });
      });

      it('should handle @data.not with falsy values', async () => {
        const script = `
          data result
          result.value = false
          result.value.not()

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          value: true
        });
      });

      it('should handle @data.not with undefined target', async () => {
        const script = `
          data result
          result.value.not()

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'not\' cannot be undefined or null');
        }
      });

      it('should handle @data.not with various value types', async () => {
        const script = `
          data result
          result.truthy = "hello"
          result.falsy = ""
          result.zero = 0
          result.nonZero = 42
          result.nullValue = null

          var truthyVal = "hello"
          var falsyVal = ""
          var zeroVal = 0
          var nonZeroVal = 42

          result.notTruthy = truthyVal
          result.notFalsy = falsyVal
          result.notZero = zeroVal
          result.notNonZero = nonZeroVal

          result.notTruthy.not()
          result.notFalsy.not()
          result.notZero.not()
          result.notNonZero.not()

          return result.snapshot()`;
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
          data result
          result.company.people = peopleData
          result.company.people[0].permissions &= 3
          result.company.people[1].flags |= 8
          result.company.people[2].mask.bitNot()

          return result.snapshot()`;
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
          data result
          result.user = { name: 'Alice', oldName: 'Bob' }
          result.user.oldName.delete()

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: { name: 'Alice' }
        });
      });

      it('should handle @data.delete with undefined target', async () => {
        const script = `
          data result
          result.user.name.delete()

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          user: {}
        });
      });

      it('should handle @data.delete with dynamic paths', async () => {
        const script = `
          data result
          result.company.people = peopleData
          result.company.people[0].oldEmail.delete()
          result.company.people[1].tempData.delete()

          return result.snapshot()`;
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
          data result
          result.items = [1, 2, 3]
          result.items.concat([4, 5, 6])

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3, 4, 5, 6]
        });
      });

      it('should handle @data.concat with single values', async () => {
        const script = `
          data result
          result.items = [1, 2, 3]
          result.items.concat(4)
          result.items.concat("hello")

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3, 4, 'hello']
        });
      });

      it('should handle @data.concat with undefined target', async () => {
        const script = `
          data result
          result.items.concat([1, 2, 3])

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3]
        });
      });

      it('should handle @data.concat with non-array target', async () => {
        const script = `
          data result
          result.items = "hello"
          result.items.concat([1, 2, 3])

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'concat\' must be an array');
        }
      });

      it('should handle @data.concat with mixed array and non-array values', async () => {
        const script = `
          data result
          result.items = [1, 2]
          result.items.concat([3, 4])
          result.items.concat(5)
          result.items.concat([6, 7])
          result.items.concat("eight")

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 2, 3, 4, 5, 6, 7, 'eight']
        });
      });

      it('should handle @data.concat with dynamic paths', async () => {
        const script = `
          data result
          result.company.people = peopleData
          result.company.people[0].tags.concat(["admin", "active"])
          result.company.people[1].skills.concat(["JavaScript", "Python"])

          return result.snapshot()`;
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
          data result
          result.users = [{ name: 'Alice', id: 1 }]
          result.users.concat([{ name: 'Bob', id: 2 }, { name: 'Charlie', id: 3 }])

          return result.snapshot()`;
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
          data result
          result.value = "hello"
          result.value -= 5

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'subtract\' must be a number');
        }
      });

      it('should throw error when using increment on non-numbers', async () => {
        const script = `
          data result
          result.value = "hello"
          result.value++

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'increment\' must be a number');
        }
      });

      it('should throw error when using decrement on non-numbers', async () => {
        const script = `
          data result
          result.value = "hello"
          result.value--

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'decrement\' must be a number');
        }
      });

      it('should throw error when using multiply on non-numbers', async () => {
        const script = `
          data result
          result.value = "hello"
          result.value *= 2

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'multiply\' must be a number');
        }
      });

      it('should throw error when using divide on non-numbers', async () => {
        const script = `
          data result
          result.value = "hello"
          result.value /= 2

          return result.snapshot()`;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'divide\' must be a number');
        }
      });

      it('should throw error when using add on non-number and non-string', async () => {
        const script = `
          data result
          result.value = { name: 'Alice' }
          result.value += "hello"

          return result.snapshot()`;
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
          data result
          result.counter = 10
          result.counter += 5
          result.counter *= 2
          result.counter -= 3
          result.counter++
          result.counter /= 2

          result.flag = true
          result.flag &&= finished
          result.flag ||= finished

          return result.snapshot()`;
        const result = await env.renderScriptString(script, { finished: true });
        expect(result).to.eql({
          counter: 14,
          flag: true
        });
      });

      it('should handle operations in loops', async () => {
        const script = `
          data result
          result.total = 0
          result.count = 0
          for i in range(5)
            result.total += i
            result.count++
          endfor

          return result.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          total: 10, // 0+1+2+3+4
          count: 5
        });
      });

      it('should handle operations in macros', async () => {
        const script = `
          data result
          macro processUser(name, salary)
            data userData
            userData.name = name
            userData.salary = salary
            userData.salary += 1000
            userData.bonus = salary * 0.1
            return userData.snapshot()
          endmacro

          var user1 = processUser("Alice", 50000)
          var user2 = processUser("Bob", 60000)

          result.users.push(user1)
          result.users.push(user2)
          result.totalSalary = 0
          result.totalSalary += user1.salary
          result.totalSalary += user2.salary

          return result.snapshot()`;
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
          data result
          var userData = fetchUser(1)
          var salaryData = fetchSalary(1)

          result.user.name = userData.name
          result.user.salary = salaryData.base
          result.user.salary += salaryData.bonus
          result.user.salary *= 1.05

          return result.snapshot()`;
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
      data result
      result.a.b.c.d.push(100)
      result.a.b.anotherProp = "hello"

      return result.snapshot()`;
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
      data result
      result = []

      // Push items to the root array
      result.push({ name: 'Alice' })
      result.push({ name: 'Bob' })

      // Target the last item pushed (Bob) and modify it
      result[].status = "active"

      // Push another item
      result.push({ name: 'Charlie' })

      // Target the new last item (Charlie)
      result[].role = "guest"

      return result.snapshot()`;
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
        text mainText
        data mainData
        macro wrapper()
           text wrapperText
           var content = caller()
           wrapperText("DebugContent: " + content)
           if content.text
             wrapperText(" HasText: " + content.text)
           endif
           return { text: wrapperText.snapshot() }
        endmacro

        var wrapped = call wrapper()
          text innerText
          data result
          innerText("Inner")
          result.key = "value"
          return innerText.snapshot()
        endcall

        mainText(wrapped.text)
        return { text: mainText.snapshot(), data: mainData.snapshot() }`;
      const result = await env.renderScriptString(script);
      // filter means the call block output is text only.
      // And it is appended to the main script's text output.
      expect(result.text.trim()).to.equal('DebugContent: Inner');
      // The inner data should be discarded by the filter on the call block
      // But wrapper does not output data anyway.
    });

    it('should filter output to data when using filter', async () => {
      const script = `
        text output
        data result
        macro wrapper()
           data wrapperData
           var content = caller()
           wrapperData.wrappee = content
           return {data: wrapperData.snapshot() }
        endmacro

        call wrapper()
          data callData
          text callOutput
          callOutput("Inner")
          callData.key = "value"
          return callData.snapshot()
        endcall

        return {data: result.snapshot(), text: output.snapshot() }`;
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
        text mainText
        data mainData
        macro wrapper()
           data wrapperData
           var content = caller()
           wrapperData.wrappee = content
           return {data: wrapperData.snapshot() }
        endmacro

        var wrapped = call wrapper()
          text innerText
          data result
          innerText("Inner")
          result.key = "value"
          return { text: innerText.snapshot(), data: result.snapshot() }
        endcall

        mainData = wrapped.data
        return {data: mainData.snapshot(), text: mainText.snapshot() }`;
      const result = await env.renderScriptString(script);
      expect(result.data).to.not.be.undefined;
      expect(result.data.wrappee).to.not.be.undefined;
    });
  });
});
