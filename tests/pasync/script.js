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
        'var sink = 3'
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

  describe('External Variable Declaration with extern', function () {
    it.skip('should declare external variables', async function () {
      const script = `
        extern currentUser, theme
        return { result: { user: currentUser, theme: theme } }`;

      const context = {
        currentUser: { name: 'Alice' },
        theme: 'dark'
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.user).to.eql({ name: 'Alice' });
      expect(result.result.theme).to.be('dark');
    });

    it('should allow re-assigning extern variables', async function () {
      const script = `
        extern currentUser, theme
        theme = "guest"
        return { result: { theme: theme } }`;

      const context = {
        currentUser: { name: 'Alice' },
        theme: 'dark'
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.theme).to.be('guest');
    });

    it('should throw error when initializing extern variable', async function () {
      const script = `
        extern currentUser = "Alice"
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Invalid variable name in extern declaration');
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

  describe('Capture Block Assignment', function () {
    it('should use capture block for declaration and assignment', async function () {
      const script = `
        var rawUserData = fetchUser(123)
        var user = capture
          data userData
          userData.id = rawUserData.id
          userData.username = rawUserData.name | title
          userData.status = "active" if rawUserData.isActive == 1 else "inactive"
          return userData.snapshot()
        endcapture
        var result = {}
        result.user = user
        return result`;

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

    it('should use capture block for assignment to existing variable', async function () {
      const script = `
        var user
        user = capture
          data userData
          userData.name = "Bob"
          userData.role = "admin"
          return userData.snapshot()
        endcapture
        return { result: { user: user } }`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.user).to.eql({
        name: 'Bob',
        role: 'admin'
      });
    });

    it('should access outer scope variables in capture block', async function () {
      const script = `
        var baseUrl = "https://api.example.com"
        var user = capture
          data userData
          userData.apiUrl = baseUrl + "/users"
          userData.name = "Alice"
          return userData.snapshot()
        endcapture
        var result = {}
        result.user = user
        return result`;

      const result = await env.renderScriptString(script, {});
      expect(result.user).to.eql({
        apiUrl: 'https://api.example.com/users',
        name: 'Alice'
      });
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
  });

  describe('Complex Variable Scenarios', function () {
    it('should handle nested capture blocks', async function () {
      const script = `
        var outer = capture
          data outerData
          outerData.level = "outer"
          var inner = capture
            data innerData
            innerData.level = "inner"
            innerData.parentLevel = "outer"
            return innerData.snapshot()
          endcapture
          outerData.innerResult = inner
          return outerData.snapshot()
        endcapture
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

    it.skip('should handle multiple extern variables with reassignment', async function () {
      const script = `
        extern user, settings, theme
        theme = "dark"
        settings = capture
          data settingsData
          settingsData.notifications = true
          settingsData.language = "en"
          return settingsData.snapshot()
        endcapture
        return { result: { user: user, settings: settings, theme: theme } }`;

      const context = {
        user: { name: 'Alice' },
        settings: { theme: 'light' },
        theme: 'light'
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.user).to.eql({ name: 'Alice' });
      expect(result.result.settings).to.eql({
        notifications: true,
        language: 'en'
      });
      expect(result.result.theme).to.be('dark');
    });

    it('should handle complex variable declarations with async operations', async function () {
      const script = `
        var userData = fetchUser(1)
        var settings = fetchSettings(1)
        var profile = capture
          data profileData
          profileData.name = userData.name
          profileData.email = userData.email
          profileData.theme = settings.theme
          profileData.notifications = settings.notifications
          return profileData.snapshot()
        endcapture
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
    it('should handle errors in capture block gracefully', async function () {
      const script = `
        var capturedResult = capture
          data captureData
          // This would cause an error if not handled
          captureData.value = someUndefinedFunction()
          return captureData.snapshot()
        endcapture
        return { result: { output: capturedResult } }`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Can not look up unknown variable/function: someUndefinedFunction');
      }
    });

    it.skip('should handle errors in extern variable access', async function () {
      const script = `
        extern requiredVar
        return { result: { value: requiredVar } }`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('requiredVar is not defined');
      }
    });
  });

});


