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

describe('Cascada Script: Variables', function () {
  let env;

  // For each test, create a fresh environment.
  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Variable Declaration with var', function () {
    it('should declare and initialize a variable', async function () {
      const script = `
        :data
        var user = fetchUser(1)
        @data.result.user.set(user)
      `;

      const context = {
        fetchUser: async (id) => ({ id, name: 'Alice' })
      };

      const result = await env.renderScriptString(script, context);
      expect(result.result.user).to.eql({ id: 1, name: 'Alice' });
    });

    it('should declare a variable with default value none', async function () {
      const script = `
        :data
        var report
        @data.result.hasReport.set(report !== undefined)
		@data.result.hasReportValue.set(report !== none)
        @data.result.reportValue.set(report)
      `;

      const result = await env.renderScriptString(script, {});
      expect(result.result.hasReport).to.be(true);
	  expect(result.result.hasReportValue).to.be(false);
      expect(result.result.reportValue).to.be(null);
    });

    it('should declare multiple variables and assign them a single value', async function () {
      const script = `
        :data
        var x, y = 100
        @data.result.x.set(x)
        @data.result.y.set(y)
      `;

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
        :data
        extern currentUser, theme
        @data.result.user.set(currentUser)
        @data.result.theme.set(theme)
      `;

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
        :data
        extern currentUser, theme
        theme = "guest"
        @data.result.theme.set(theme)
      `;

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
        :data
        var name = "Alice"
        name = "Bob"
        @data.result.name.set(name)
      `;

      const result = await env.renderScriptString(script, {});
      expect(result.result.name).to.be('Bob');
    });

    it('should assign multiple existing variables at once', async function () {
      const script = `
        :data
        var x = 10
        var y = 20
        x, y = 200
        @data.result.x.set(x)
        @data.result.y.set(y)
      `;

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
        :data
        var rawUserData = fetchUser(123)
        var user = capture :data
          @data.id.set(rawUserData.id)
          @data.username.set(rawUserData.name | title)
          @data.status.set("active" if rawUserData.isActive == 1 else "inactive")
        endcapture
        @data.result.user.set(user)
      `;

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
        :data
        var user
        user = capture :data
          @data.name.set("Bob")
          @data.role.set("admin")
        endcapture
        @data.result.user.set(user)
      `;

      const result = await env.renderScriptString(script, {});
      expect(result.result.user).to.eql({
        name: 'Bob',
        role: 'admin'
      });
    });

    it('should access outer scope variables in capture block', async function () {
      const script = `
        :data
        var baseUrl = "https://api.example.com"
        var user = capture :data
          @data.apiUrl.set(baseUrl + "/users")
          @data.name.set("Alice")
        endcapture
        @data.result.user.set(user)
      `;

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
        :data
        var parentVar = "parent value"
        for i in range(2)
          @data.result.items.push(parentVar + " " + i)
        endfor
      `;

      const result = await env.renderScriptString(script, {});
      expect(result.result.items).to.eql(['parent value 0', 'parent value 1']);
    });

    it('should allow declaring different variables in different scopes', async function () {
      const script = `
        :data
        var outerVar = "outer"
        for i in range(2)
          var innerVar = "inner " + i
          @data.result.items.push(outerVar + " - " + innerVar)
        endfor
      `;

      const result = await env.renderScriptString(script, {});
      expect(result.result.items).to.eql(['outer - inner 0', 'outer - inner 1']);
    });
  });

  describe('Complex Variable Scenarios', function () {
    it('should handle nested capture blocks', async function () {
      const script = `
        :data
        var outer = capture :data
          @data.level.set("outer")
          var inner = capture :data
            @data.level.set("inner")
            @data.parentLevel.set("outer")
          endcapture
          @data.innerResult.set(inner)
        endcapture
        @data.result.outer.set(outer)
      `;

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
        :data
        extern user, settings, theme
        theme = "dark"
        settings = capture :data
          @data.set(notifications, true)
          @data.set(language, "en")
        endcapture
        @data.set(result.user, user)
        @data.set(result.settings, settings)
        @data.set(result.theme, theme)
      `;

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
        :data
        var userData = fetchUser(1)
        var settings = fetchSettings(1)
        var profile = capture :data
          @data.name.set(userData.name)
          @data.email.set(userData.email)
          @data.theme.set(settings.theme)
          @data.notifications.set(settings.notifications)
        endcapture
        @data.result.profile.set(profile)
      `;

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
        :data
        var result = capture :data
          @data.value.set("success")
          // This would cause an error if not handled
          var invalid = someUndefinedFunction()
        endcapture
        @data.result.output.set(result)
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Unable to call `someUndefinedFunction`');
      }
    });

    it.skip('should handle errors in extern variable access', async function () {
      const script = `
        :data
        extern requiredVar
        @data.set(result.value, requiredVar)
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('requiredVar is not defined');
      }
    });
  });

});
