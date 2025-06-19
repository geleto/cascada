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
      @put result.users userList
      @merge result.config appConfig
      @put result.config.loaded true
      @push result.log "Data fetch complete"
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
        @put user.id userData.id
        @put user.name userData.name
        @put user.tasks tasksData
      endmacro

      // Call the macro for different users. These two calls are independent
      // and will execute in parallel.
      set report1 = buildUserReport(1)
      set report2 = buildUserReport(2)

      // The final assembly step for the main script. This block waits for
      // both 'report1' and 'report2' to be fully resolved before running.
      @put reports.user1 report1.user
      @put reports.user2 report2.user
      @put reports.summary "Generated 2 reports"
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
    it('should handle @put, @push, @merge, and @deepMerge', async () => {
      const script = `
        :data
        // Put creates/replaces values
        @put user.name "Alice"
        @put user.role "Admin"
        @put user.role "Super-Admin" // Overwrites previous put

        // Push adds to an array, creating it if needed
        @push user.tags "active"
        @push user.tags "new"

        // Merge combines objects
        @put settings.profile { theme: "light" }
        @merge settings.profile { notifications: true }

        // Deep merge combines nested objects
        @put settings.deep { a: { b: 1 } }
        @deepMerge settings.deep { a: { c: 2 }, d: 3 }
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

    it('should handle array manipulation with @pop, @shift, @unshift, and @reverse', async () => {
      const script = `
        :data
        @push items "a"
        @push items "b"
        @push items "c"
        @push items "d"

        @pop items // remove "d" -> [a, b, c]
        @shift items // remove "a" -> [b, c]
        @unshift items "x" // add "x" -> [x, b, c]
        @reverse items // -> [c, b, x]
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: ['c', 'b', 'x'] });
    });

    it('should handle array index targeting including last-item `[]`', async () => {
      const script = `
        :data
        @push users { name: 'Alice', tasks: ['task1', 'task2'] }
        @push users { name: 'Bob' }

        // Target specific index
        @put users[0].role "Admin"

        // Target last item pushed in script sequence
        @push users { name: 'Charlie' }
        @put users[].role "Guest" // Affects Charlie

        @put users[1].status "active" // Affects Bob
        @put users[0].tasks[] "task3" //change the last task of Alice
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

  describe('@print command', function() {
    it('should append to global text stream and return in the text property', async () => {
      const script = `
        @print "Hello"
        @print ", "
        @print "World!"
        @put status "ok"
      `;
      // No focus, so we get the full result object
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        data: { status: 'ok' },
        text: 'Hello, World!'
      });
    });

    it('should append to a path in the data object with `@print path value`', async () => {
      const script = `
        :data
        @put log "Log started. "
        @print log "Event 1. "
        @print log "Event 2."
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ log: 'Log started. Event 1. Event 2.' });
    });



    it('should focus the output to just the text stream with :text', async () => {
      const script = `
        :text
        @print "This is "
        @print "the final text."
        @put status "ignored"
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
        }
      });
      const script = `
        :data
        @push users { id: 1, name: "Alice", status: "active" }
        @push users { id: 2, name: "Bob" }
        @upsert users { id: 1, status: "inactive" } // Updates Alice
        @upsert users { id: 3, name: "Charlie" }    // Adds Charlie
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

    it('should support custom handlers with the Singleton pattern (addCommandHandler)', async () => {
      const logger = {
        log: [],
        // _init is called at the start of each render
        _init() { this.log = []; },
        // _call is a catch-all for commands
        _call(command, ...args) { this.log.push(`${command}(${args.join(',')})`); }
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
  });

  describe('Scoping and Control', function() {
    it('should use a set block to capture output without focusing', async () => {
      const script = `
        :data
        set captured
          @put user.name "Captured User"
          @print "hello from capture"
        endset
        @put result captured
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
        @put data.status "ignored"
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
        @put name user.name
        @put role user.role
      endset

      @put result.user userData
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
});
