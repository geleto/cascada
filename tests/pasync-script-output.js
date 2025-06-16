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

describe.skip('Cascada Script: Output commands', function () {
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
      // :data

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

  /**
   * This test demonstrates that caller() blocks can use input focusing
   * to control what data is returned to the macro.
   * @todo: The call'ed macro must write directly to the parent scope output data object, this is not yet implemented
   * @todo: The {% call %} tag is cleverly parsed into a structure where it is treated as a standard FunCall node that is placed inside an Output node, exactly like a {{ ... }} expression.
   * @todo: For scripts implement merging from the output tag (see above todo)
   * @todo: Check if the merge concatenates arrays
   * @todo - just merging will not pop, shift and delete. Mayne we should run in the parent command scope - harder to implement
   */
  it('should allow input focusing in caller() blocks', async () => {
    const script = `
      macro processUser(id) : data
        // The caller() block will return just the data object
        // due to its :data directive
        set userData = caller()
        @put result.id id
        @merge result userData
      endmacro

      call processUser(123) : data
        // This block's output is focused to just the data object
        set user = { name: "Alice", role: "admin" }
        @put name user.name
        @put role user.role
      endcall
    `;

    const result = await env.renderScriptString(script, {});

    expect(result).to.eql({
      result: {
        id: 123,
        name: 'Alice',
        role: 'admin'
      }
    });
  });


  it('should allow input focusing in set blocks', async () => {
    const script = `
      // The set block's output is focused to just the data object
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
      expect(error.message).to.contain('Input focusing cannot be used with direct assignment');
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
      expect(error.message).to.contain('Input focusing cannot be used with direct assignment');
    }
  });
});
