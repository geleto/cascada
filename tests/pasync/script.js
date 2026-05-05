
import expect from 'expect.js';
import {AsyncEnvironment, Script} from '../../src/environment/environment.js';

describe('Cascada Script: Variables', function () {
  let env;

  // For each test, create a fresh environment.
  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Variable Declaration with var', function () {
    it('should declare and initialize a variable', async function () {
      const script = `
        var user = fetchUser(1)
        return { result: { user: user } }`;

      const context = {
        fetchUser: async (id) => ({ id, name: 'Alice' })
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.user).to.eql({ id: 1, name: 'Alice' });
    });

    it('should declare a variable with default value none', async function () {
      const script = `
        var report
        var amount = 1
		    var result = {}
		    result.hasReportValue = report !== none
        result.hasValue = amount !== none
        result.value = amount
        result.reportValue = report

		    return result`;

      const result = await env.renderScriptString(script, {});
      expect(result.hasReportValue).to.be(false);
      expect(result.reportValue).to.be(null);
      expect(result.value).to.be(1);
      expect(result.hasValue).to.be(true);
    });

    it('should declare multiple variables and assign them a single value', async function () {
      const script = `
        var x, y = 100
        return { result: { x: x, y: y } }`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.x).to.be(100);
      expect(result.result.y).to.be(100);
    });

    it('should throw error when re-declaring a variable', async function () {
      const script = `
        var user = "Alice"
        var user = "Bob"
        return user
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('has already been declared');
      }
    });

    it('should reject reserved keywords as variable names', async function () {
      const scripts = [
        'var data = 1',
        'var value = 2',
        'var context = 4'
      ];

      for (const script of scripts) {
        try {
          await env.renderScriptString(script, {});
          expect().fail(`Should have thrown for script: ${script}`);
        } catch (error) {
          expect(error.message).to.contain('is reserved');
        }
      }
    });
  });

  describe('Variable Assignment with =', function () {
    it('should assign to previously declared variables', async function () {
      const script = `
        var name = "Alice"
        name = "Bob"
        return { result: { name: name } }`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.name).to.be('Bob');
    });

    it('should assign multiple existing variables at once', async function () {
      const script = `
        var x = 10
        var y = 20
        x, y = 200
        return { result: { x: x, y: y } }`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.x).to.be(200);
      expect(result.result.y).to.be(200);
    });

    it('should throw error when assigning to undeclared variable', async function () {
      const script = `
        username = "Charlie"
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Cannot assign to undeclared variable');
      }
    });
  });

  describe('Variable Assignment with Objects', function () {
    it('should handle declaration and assignment from async values', async function () {
      const script = `
        var rawUserData = fetchUser(123)
        var user = {}
        user.id = rawUserData.id
        user.username = rawUserData.name | title
        user.status = "active" if rawUserData.isActive == 1 else "inactive"
        return { user: user }`;

      const context = {
        fetchUser: async (id) => ({ id: 123, name: 'alice', isActive: 1 })
      };

      const result = await env.renderScriptString(script, context);
      expect(result.user).to.eql({
        id: 123,
        username: 'Alice',
        status: 'active'
      });
    });

    it('should support assignment to an existing variable', async function () {
      const script = `
        var user
        user = { name: "Bob", role: "admin" }
        return { result: { user: user } }`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.user).to.eql({
        name: 'Bob',
        role: 'admin'
      });
    });

    it('should access outer scope variables in assignment expressions', async function () {
      const script = `
        var baseUrl = "https://api.example.com"
        var user = {}
        user.apiUrl = baseUrl + "/users"
        user.name = "Alice"
        return { user: user }`;

      const result = await env.renderScriptString(script, {});
      expect(result.user).to.eql({
        apiUrl: 'https://api.example.com/users',
        name: 'Alice'
      });
    });

    it('should read outer scope variable in assignment flow', async function () {
      const script = `
        var base = "outer"
        var result = base
        return result`;

      const result = await env.renderScriptString(script, {});
      expect(result).to.be('outer');
    });
  });

  describe('Variable Scoping and Shadowing', function () {
    it('should not allow variable shadowing in child scope', async function () {
      const script = `
        var item = "parent"
        for i in range(2)
          var item = "child " + i
        endfor
        return item
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain(' has already been declared');
      }
    });

    it('should allow accessing parent scope variables in child scope', async function () {
      const script = `
        data result
        var parentVar = "parent value"
        for i in range(2)
          result.items.push(parentVar + " " + i)
        endfor

        return result.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.items).to.eql(['parent value 0', 'parent value 1']);
    });

    it('should allow declaring different variables in different scopes', async function () {
      const script = `
        data result
        var outerVar = "outer"
        for i in range(2)
          var innerVar = "inner " + i
          result.items.push(outerVar + " - " + innerVar)
        endfor

        return result.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.items).to.eql(['outer - inner 0', 'outer - inner 1']);
    });

    it('should scope branch-local vars for each side of an if/else', async function () {
      const script = `
        var result = {}
        var usePrimary = inputFlag
        if usePrimary
          var scopedValue = "primary"
          result.selection = scopedValue
        else
          var scopedValue = "fallback"
          result.selection = scopedValue
        endif

        return result`;

      const primary = await env.renderScriptString(script, { inputFlag: true });
      expect(primary.selection).to.be('primary');

      const fallback = await env.renderScriptString(script, { inputFlag: false });
      expect(fallback.selection).to.be('fallback');
    });

    it('should emit canonical runtime aliases for duplicated branch declarations', function () {
      const script = `
        var result = {}
        if flag
          var scopedValue = "A"
          result.out = scopedValue
        else
          var scopedValue = "B"
          result.out = scopedValue
        endif
        return result`;

      const compiled = new Script(script, env, 'dup-branch-script.casc').compileSource();
      expect(/scopedValue#\d+/.test(compiled)).to.be(true);
    });

    it('should timeout with branch-local var assigned into outer object path (minimal repro)', async function () {
      const script = `
        var result
        if condition
          var scopedValue = "primary"
          result = scopedValue
        endif
        return result`;
      await env.renderScriptString(script, {condition: true});
    });

    it('should not leak vars declared inside if/else branches', async function () {
      const script = `
        var result = {}
        var pickPrimary = true
        if pickPrimary
          var scopedValue = "primary-only"
          result.selection = scopedValue
        else
          var scopedValue = "fallback-only"
          result.selection = scopedValue
        endif
        result.postBranchSeen = scopedValue

        return result`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected referencing scopedValue outside the branch to fail');
      } catch (error) {
        expect(error.message).to.contain('Can not look up unknown variable/function');
      }
    });

    it('should allow redeclaring a branch-local name after the if/else', async function () {
      const script = `
        var result = {}
        var shouldUsePrimary = true
        if shouldUsePrimary
          var scopedValue = "primary branch"
          result.internal = scopedValue
        else
          var scopedValue = "fallback branch"
          result.internal = scopedValue
        endif
        var scopedValue = "outer scope"
        result.outer = scopedValue

        return result`;

      const result = await env.renderScriptString(script, {});
      expect(result.internal).to.be('primary branch');
      expect(result.outer).to.be('outer scope');
    });

    it('should scope switch case variables independently', async function () {
      const script = `
        var result = {}
        var mode = currentMode
        switch mode
        case "alpha"
          var branchScoped = "ALPHA"
          result.value = branchScoped
        case "beta"
          var branchScoped = "BETA"
          result.value = branchScoped
        default
          var branchScoped = "DEFAULT"
          result.value = branchScoped
        endswitch

        return result`;

      const betaResult = await env.renderScriptString(script, { currentMode: 'beta' });
      expect(betaResult.value).to.be('BETA');

      const defaultResult = await env.renderScriptString(script, { currentMode: 'gamma' });
      expect(defaultResult.value).to.be('DEFAULT');
    });

    it('should emit canonical runtime aliases for duplicated switch declarations', function () {
      const script = `
        var result = {}
        switch mode
        case "alpha"
          var branchScoped = "ALPHA"
          result.out = branchScoped
        case "beta"
          var branchScoped = "BETA"
          result.out = branchScoped
        default
          var branchScoped = "DEFAULT"
          result.out = branchScoped
        endswitch
        return result`;

      const compiled = new Script(script, env, 'dup-switch-script.casc').compileSource();
      expect(/branchScoped#\d+/.test(compiled)).to.be(true);
    });

    it('should not leak vars declared in switch cases', async function () {
      const script = `
        var result = {}
        var mode = "alpha"
        switch mode
        case "alpha"
          var branchScoped = "ALPHA"
          result.value = branchScoped
        case "beta"
          var branchScoped = "BETA"
          result.value = branchScoped
        default
          var branchScoped = "DEFAULT"
          result.value = branchScoped
        endswitch
        result.after = branchScoped

        return result`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected branchScoped lookup after switch to fail');
      } catch (error) {
        expect(error.message).to.contain('Can not look up unknown variable/function');
      }
    });

    it('should allow redeclaring a case-local name after the switch', async function () {
      const script = `
        var result = {}
        var mode = "beta"
        switch mode
        case "alpha"
          var branchScoped = "ALPHA"
          result.inner = branchScoped
        case "beta"
          var branchScoped = "BETA"
          result.inner = branchScoped
        default
          var branchScoped = "DEFAULT"
          result.inner = branchScoped
        endswitch
        var branchScoped = "outer switch scope"
        result.outer = branchScoped

        return result`;

      const result = await env.renderScriptString(script, {});
      expect(result.inner).to.be('BETA');
      expect(result.outer).to.be('outer switch scope');
    });

    it('should keep for-body declarations scoped and allow outer redeclaration', async function () {
      const script = `
        var values = []
        for i in [1, 2]
          var scopedValue = "inner-" + i
          values.push(scopedValue)
        endfor
        var scopedValue = "outer"
        return { values: values, outer: scopedValue }`;

      const result = await env.renderScriptString(script, {});
      expect(result.values).to.eql(['inner-1', 'inner-2']);
      expect(result.outer).to.be('outer');
    });

    it('should keep while-body declarations scoped and allow outer redeclaration', async function () {
      const script = `
        var n = 0
        var values = []
        while n < 2
          var scopedValue = "w-" + n
          values.push(scopedValue)
          n = n + 1
        endwhile
        var scopedValue = "outer"
        return { values: values, outer: scopedValue }`;

      const result = await env.renderScriptString(script, {});
      expect(result.values).to.eql(['w-0', 'w-1']);
      expect(result.outer).to.be('outer');
    });

    it('should reject reserved keywords as loop variable names', async function () {
      const scripts = [
        `
          for data in [1]
          endfor
          return 1`,
        `
          var items = [1]
          each value in items
          endeach
          return 1`,
        `
          var n = 0
          while n < 1
            var context = n
            n = n + 1
          endwhile
          return n`
      ];

      for (const script of scripts) {
        try {
          await env.renderScriptString(script, {});
          expect().fail(`Should have thrown for script: ${script}`);
        } catch (error) {
          expect(error.message).to.contain('is reserved');
        }
      }
    });

    it('should allow outer assignment updated inside branch', async function () {
      const script = `
        var scopedValue = "outer"
        if true
          scopedValue = "inner"
        endif
        var outerValue = "outer"
        return { value: scopedValue, outer: outerValue }`;

      const result = await env.renderScriptString(script, {});
      expect(result.value).to.be('inner');
      expect(result.outer).to.be('outer');
    });
  });

  describe('Complex Variable Scenarios', function () {
    it('should handle nested object construction', async function () {
      const script = `
        var inner = {}
        inner.level = "inner"
        inner.parentLevel = "outer"
        var outer = {}
        outer.level = "outer"
        outer.innerResult = inner
        return { result: { outer: outer } }`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.outer).to.eql({
        level: 'outer',
        innerResult: {
          level: 'inner',
          parentLevel: 'outer'
        }
      });
    });

    it('should handle complex variable assignment with async operations', async function () {
      const script = `
        var userData = fetchUser(1)
        var settings = fetchSettings(1)
        var profile = {}
        profile.name = userData.name
        profile.email = userData.email
        profile.theme = settings.theme
        profile.notifications = settings.notifications
        return { result: { profile: profile } }`;

      const context = {
        fetchUser: async (id) => ({ name: 'Alice', email: 'alice@example.com' }),
        fetchSettings: async (id) => ({ theme: 'dark', notifications: true })
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.profile).to.eql({
        name: 'Alice',
        email: 'alice@example.com',
        theme: 'dark',
        notifications: true
      });
    });
  });

  describe('Error Handling in Variable Operations', function () {
    it('should handle errors in assignment expressions gracefully', async function () {
      const script = `
        var capturedResult = {}
        capturedResult.value = someUndefinedFunction()
        return { result: { output: capturedResult } }`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Can not look up unknown variable/function: someUndefinedFunction');
      }
    });

  });

});
