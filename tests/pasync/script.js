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
        data data
        var user = fetchUser(1)
        data.result.user = user
      
        return data.snapshot()`;

      const context = {
        fetchUser: async (id) => ({ id, name: 'Alice' })
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.user).to.eql({ id: 1, name: 'Alice' });
    });

    it('should declare a variable with default value none', async function () {
      const script = `
        data data
        var report
        var value = 1
		    data.result.hasReportValue = report !== none
        data.result.hasValue = value !== none
        data.result.value = value
        data.result.reportValue = report
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.hasReportValue).to.be(false);
      expect(result.result.reportValue).to.be(null);
      expect(result.result.value).to.be(1);
      expect(result.result.hasValue).to.be(true);
    });

    it('should declare multiple variables and assign them a single value', async function () {
      const script = `
        data data
        var x, y = 100
        data.result.x = x
        data.result.y = y
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.x).to.be(100);
      expect(result.result.y).to.be(100);
    });

    it('should throw error when re-declaring a variable', async function () {
      const script = `
        :data
        var user = "Alice"
        var user = "Bob"
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('has already been declared');
      }
    });
  });

  describe('External Variable Declaration with extern', function () {
    it.skip('should declare external variables', async function () {
      const script = `
        data data
        extern currentUser, theme
        data.result.user = currentUser
        data.result.theme = theme
      
        return data.snapshot()`;

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
        data data
        extern currentUser, theme
        theme = "guest"
        data.result.theme = theme
      
        return data.snapshot()`;

      const context = {
        currentUser: { name: 'Alice' },
        theme: 'dark'
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.theme).to.be('guest');
    });

    it('should throw error when initializing extern variable', async function () {
      const script = `
        :data
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
        data data
        var name = "Alice"
        name = "Bob"
        data.result.name = name
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.name).to.be('Bob');
    });

    it('should assign multiple existing variables at once', async function () {
      const script = `
        data data
        var x = 10
        var y = 20
        x, y = 200
        data.result.x = x
        data.result.y = y
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.x).to.be(200);
      expect(result.result.y).to.be(200);
    });

    it('should throw error when assigning to undeclared variable', async function () {
      const script = `
        :data
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
        data data
        var rawUserData = fetchUser(123)
        var user = capture
          data data
          data.id = rawUserData.id
          data.username = rawUserData.name | title
          data.status = "active" if rawUserData.isActive == 1 else "inactive"
          return data.snapshot()
        endcapture
        data.result.user = user
      
        return data.snapshot()`;

      const context = {
        fetchUser: async (id) => ({ id: 123, name: 'alice', isActive: 1 })
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.user).to.eql({
        id: 123,
        username: 'Alice',
        status: 'active'
      });
    });

    it('should use capture block for assignment to existing variable', async function () {
      const script = `
        data data
        var user
        user = capture
          data data
          data.name = "Bob"
          data.role = "admin"
          return data.snapshot()
        endcapture
        data.result.user = user
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.user).to.eql({
        name: 'Bob',
        role: 'admin'
      });
    });

    it('should access outer scope variables in capture block', async function () {
      const script = `
        data data
        var baseUrl = "https://api.example.com"
        var user = capture
          data data
          data.apiUrl = baseUrl + "/users"
          data.name = "Alice"
          return data.snapshot()
        endcapture
        data.result.user = user
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.user).to.eql({
        apiUrl: 'https://api.example.com/users',
        name: 'Alice'
      });
    });
  });

  describe('Variable Scoping and Shadowing', function () {
    it('should not allow variable shadowing in child scope', async function () {
      const script = `
        :data
        var item = "parent"
        for i in range(2)
          var item = "child " + i
        endfor
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
        data data
        var parentVar = "parent value"
        for i in range(2)
          data.result.items.push(parentVar + " " + i)
        endfor
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.items).to.eql(['parent value 0', 'parent value 1']);
    });

    it('should allow declaring different variables in different scopes', async function () {
      const script = `
        data data
        var outerVar = "outer"
        for i in range(2)
          var innerVar = "inner " + i
          data.result.items.push(outerVar + " - " + innerVar)
        endfor
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.items).to.eql(['outer - inner 0', 'outer - inner 1']);
    });

    it('should scope branch-local vars for each side of an if/else', async function () {
      const script = `
        data data
        var usePrimary = inputFlag
        if usePrimary
          var scopedValue = "primary"
          data.result.selection = scopedValue
        else
          var scopedValue = "fallback"
          data.result.selection = scopedValue
        endif
      
        return data.snapshot()`;

      const primary = await env.renderScriptString(script, { inputFlag: true });
      expect(primary.result.selection).to.be('primary');

      const fallback = await env.renderScriptString(script, { inputFlag: false });
      expect(fallback.result.selection).to.be('fallback');
    });

    it('should not leak vars declared inside if/else branches', async function () {
      const script = `
        data data
        var pickPrimary = true
        if pickPrimary
          var scopedValue = "primary-only"
          data.result.selection = scopedValue
        else
          var scopedValue = "fallback-only"
          data.result.selection = scopedValue
        endif
        data.result.postBranchSeen = scopedValue
      
        return data.snapshot()`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected referencing scopedValue outside the branch to fail');
      } catch (error) {
        expect(error.message).to.contain('Can not look up unknown variable/function');
      }
    });

    it('should allow redeclaring a branch-local name after the if/else', async function () {
      const script = `
        data data
        var shouldUsePrimary = true
        if shouldUsePrimary
          var scopedValue = "primary branch"
          data.result.internal = scopedValue
        else
          var scopedValue = "fallback branch"
          data.result.internal = scopedValue
        endif
        var scopedValue = "outer scope"
        data.result.outer = scopedValue
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.internal).to.be('primary branch');
      expect(result.result.outer).to.be('outer scope');
    });

    it('should scope switch case variables independently', async function () {
      const script = `
        data data
        var mode = currentMode
        switch mode
        case "alpha"
          var branchScoped = "ALPHA"
          data.result.value = branchScoped
        case "beta"
          var branchScoped = "BETA"
          data.result.value = branchScoped
        default
          var branchScoped = "DEFAULT"
          data.result.value = branchScoped
        endswitch
      
        return data.snapshot()`;

      const betaResult = await env.renderScriptString(script, { currentMode: 'beta' });
      expect(betaResult.result.value).to.be('BETA');

      const defaultResult = await env.renderScriptString(script, { currentMode: 'gamma' });
      expect(defaultResult.result.value).to.be('DEFAULT');
    });

    it('should not leak vars declared in switch cases', async function () {
      const script = `
        data data
        var mode = "alpha"
        switch mode
        case "alpha"
          var branchScoped = "ALPHA"
          data.result.value = branchScoped
        case "beta"
          var branchScoped = "BETA"
          data.result.value = branchScoped
        default
          var branchScoped = "DEFAULT"
          data.result.value = branchScoped
        endswitch
        data.result.after = branchScoped
      
        return data.snapshot()`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected branchScoped lookup after switch to fail');
      } catch (error) {
        expect(error.message).to.contain('Can not look up unknown variable/function');
      }
    });

    it('should allow redeclaring a case-local name after the switch', async function () {
      const script = `
        data data
        var mode = "beta"
        switch mode
        case "alpha"
          var branchScoped = "ALPHA"
          data.result.inner = branchScoped
        case "beta"
          var branchScoped = "BETA"
          data.result.inner = branchScoped
        default
          var branchScoped = "DEFAULT"
          data.result.inner = branchScoped
        endswitch
        var branchScoped = "outer switch scope"
        data.result.outer = branchScoped
      
        return data.snapshot()`;

      const result = await env.renderScriptString(script, {});
      expect(result.result.inner).to.be('BETA');
      expect(result.result.outer).to.be('outer switch scope');
    });
  });

  describe('Complex Variable Scenarios', function () {
    it('should handle nested capture blocks', async function () {
      const script = `
        data data
        var outer = capture
          data data
          data.level = "outer"
          var inner = capture
            data data
            data.level = "inner"
            data.parentLevel = "outer"
            return data.snapshot()
          endcapture
          data.innerResult = inner
          return data.snapshot()
        endcapture
        data.result.outer = outer
      
        return data.snapshot()`;

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
        data data
        extern user, settings, theme
        theme = "dark"
        settings = capture
          data data
          data.notifications = true
          data.language = "en"
          return data.snapshot()
        endcapture
        data.result.user = user
        data.result.settings = settings
        data.result.theme = theme
      
        return data.snapshot()`;

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
        data data
        var userData = fetchUser(1)
        var settings = fetchSettings(1)
        var profile = capture
          data data
          data.name = userData.name
          data.email = userData.email
          data.theme = settings.theme
          data.notifications = settings.notifications
          return data.snapshot()
        endcapture
        data.result.profile = profile
      
        return data.snapshot()`;

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
        data data
        var result = capture
          data data
          // This would cause an error if not handled
          data.value = someUndefinedFunction()
          return data.snapshot()
        endcapture
        data.result.output = result
      
        return data.snapshot()`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Can not look up unknown variable/function: someUndefinedFunction');
      }
    });

    it.skip('should handle errors in extern variable access', async function () {
      const script = `
        data data
        extern requiredVar
        data.result.value = requiredVar
      
        return data.snapshot()`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('requiredVar is not defined');
      }
    });
  });

});
