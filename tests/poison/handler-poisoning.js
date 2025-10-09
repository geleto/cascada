(function () {
  'use strict';

  var expect;
  let AsyncEnvironment;
  let isPoisonError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    isPoisonError = require('../../src/runtime').isPoisonError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    isPoisonError = nunjucks.runtime.isPoisonError;
  }

  describe('Handler Poisoning for Conditional Branches', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should poison handlers when if condition fails with output only', async () => {
      const template = `{% if asyncReject() %}yes{% endif %}`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should poison handlers when if-else both have output', async () => {
      const template = `{% if asyncReject() %}yes{% else %}no{% endif %}`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should poison handlers with mixed variables and output', async () => {
      const template = `{% if asyncReject() %}{% set x = 5 %}{{ x }}{% endif %}Result: {{ x }}`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should handle nested conditionals with poisoned inner condition', async () => {
      const template = `{% if true %}{% if asyncReject() %}inner{% endif %}outer{% endif %}`;

      const context = {
        async asyncReject() {
          throw new Error('Inner condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Inner condition failed');
      }
    });

    it('should handle empty branches gracefully', async () => {
      const template = `{% if asyncReject() %}{% endif %}done`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.equal('done');
    });

    it('should handle multiple outputs in single branch', async () => {
      const template = `{% if asyncReject() %}{{ "first" }} {{ "second" }} {{ "third" }}{% endif %}`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should handle complex nested structure', async () => {
      const template = `
        {% if outerCondition() %}
          Outer start
          {% if asyncReject() %}
            Inner content
          {% endif %}
          Outer end
        {% endif %}
      `;

      const context = {
        async outerCondition() {
          return true;
        },
        async asyncReject() {
          throw new Error('Inner failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Inner failed');
      }
    });

    it('should handle if with only else branch having output', async () => {
      const template = `{% if asyncReject() %}{% set x = 1 %}{% else %}no{% endif %}`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should work with successful async condition evaluation', async () => {
      const template = `
        {% if asyncCheck() %}
          {{ "condition true" }}
        {% else %}
          {{ "condition false" }}
        {% endif %}
      `;

      const context = {
        async asyncCheck() {
          return false;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('condition false');
    });
  });

  describe('Fast Path Poison Handling (Simple Templates)', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should detect poison markers in fast path', async () => {
      const template = `{% if asyncReject() %}yes{% endif %}`;

      const context = {
        async asyncReject() {
          throw new Error('Fast path condition failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Fast path condition failed');
      }
    });

    it('should handle fast path with nested buffer and poison marker', async () => {
      const template = `{{ "a" }}{% if asyncReject() %}b{% endif %}{{ "c" }}`;

      const context = {
        async asyncReject() {
          throw new Error('Nested buffer error');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Nested buffer error');
      }
    });

    it('should collect multiple errors in fast path', async () => {
      const template = `{% if asyncReject1() %}a{% endif %}{% if asyncReject2() %}b{% endif %}`;

      const context = {
        async asyncReject1() {
          throw new Error('Error 1');
        },
        async asyncReject2() {
          throw new Error('Error 2');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        // Should contain at least one of the errors
        const hasError1 = err.message.includes('Error 1');
        const hasError2 = err.message.includes('Error 2');
        expect(hasError1 || hasError2).to.be(true);
      }
    });

    it('should handle deeply nested arrays with poison in fast path', async () => {
      const template = `outer{% if cond1() %}{% if cond2() %}inner{% endif %}middle{% endif %}end`;

      const context = {
        async cond1() {
          return true;
        },
        async cond2() {
          throw new Error('Deep nested error');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Deep nested error');
      }
    });

    it('should not throw when no poison present in fast path', async () => {
      const template = `{% if asyncResolve() %}success{% else %}failure{% endif %}`;

      const context = {
        async asyncResolve() {
          return true;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.equal('success');
    });

    it('should handle mixed text and poisoned conditionals in fast path', async () => {
      const template = `Before{% if asyncReject() %} middle{% endif %} after`;

      const context = {
        async asyncReject() {
          throw new Error('Middle section failed');
        }
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(err.message).to.contain('Middle section failed');
      }
    });
  });

  // Add to existing test file for poison handler tests

  describe('Poison Handler Tests - Scripts with @data', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should poison @data handler when condition fails in script', async () => {
      const script = `
      if asyncReject()
        @data.user.name = "Alice"
        @data.user.age = 30
      endif
    `;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Async rejection');
      }
    });

    it('should collect all @data errors from both if branches', async () => {
      const script = `
      if asyncReject()
        @data.branch = "true"
        @data.value = 1
      else
        @data.branch = "false"
        @data.value = 2
      endif
    `;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors.length).to.be.greaterThan(0);
        expect(err.errors[0].message).to.contain('Async rejection');
      }
    });

    it('should poison multiple @data operations in same branch', async () => {
      const script = `
      if asyncReject()
        @data.users.push({ name: "Alice" })
        @data.users.push({ name: "Bob" })
        @data.count = 2
        @data.status = "active"
      endif
    `;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison @data with nested paths', async () => {
      const script = `
      if asyncReject()
        @data.company.employees[0].name = "Alice"
        @data.company.employees[0].role = "Engineer"
        @data.company.name = "TechCorp"
      endif
    `;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should handle mixed text and @data handlers in script', async () => {
      const script = `
      if asyncReject()
        @text("Starting process...")
        @data.status = "processing"
        @data.step = 1
      endif
    `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Should have markers for both 'text' and 'data' handlers
      }
    });

    it('should work when @data operations succeed but other output fails', async () => {
      const script = `
      if true
        @data.working = "yes"
      endif
      @text(asyncReject())
    `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison @data in nested conditionals', async () => {
      const script = `
      if true
        @data.outer = "start"
        if asyncReject()
          @data.inner = "value"
        endif
        @data.outer = "end"
      endif
    `;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison @data in loop body when condition fails', async () => {
      const script = `
      for i in [1, 2, 3]
        if asyncReject()
          @data.items.push(i)
        endif
      endfor
    `;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });
  });

  describe('Poison Handler Tests - Custom Handlers in Scripts', () => {
    let env;
    // Simple custom handler for testing
    class TestHandler {
      constructor(context) {
        this.commands = [];
        this.context = context;
      }

      log(message) {
        this.commands.push({ type: 'log', message });
      }

      setValue(key, value) {
        this.commands.push({ type: 'set', key, value });
      }

      getReturnValue() {
        return { commands: this.commands };
      }
    }

    // Singleton handler for testing
    class SingletonHandler {
      constructor() {
        this.allLogs = [];
      }

      _init(context) {
        this.currentLogs = [];
      }

      log(message) {
        this.currentLogs.push(message);
        this.allLogs.push(message);
      }

      getReturnValue() {
        return { logs: this.currentLogs };
      }
    }

    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      env.addCommandHandlerClass('test', TestHandler);

      const singleton = new SingletonHandler();
      env.addCommandHandler('logger', singleton);

      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should poison custom handler when condition fails', async () => {
      const script = `
      if asyncReject()
        @test.log("This should be poisoned")
        @test.setValue("key", "value")
      endif
    `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison multiple custom handlers', async () => {
      const script = `
      if asyncReject()
        @test.log("Handler 1")
        @logger.log("Handler 2")
      endif
    `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Both 'test' and 'logger' handlers should have markers
      }
    });

    it('should poison custom handler in else branch', async () => {
      const script = `
      if asyncReject()
        @test.log("if branch")
      else
        @test.log("else branch")
      endif
    `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison custom handler with method chains', async () => {
      // Add a handler that supports subpaths
      class ChainHandler {
        constructor() {
          this.state = { actions: [] };
        }

        get subcommand() {
          return {
            doSomething: (value) => {
              this.state.actions.push({ sub: 'doSomething', value });
            }
          };
        }

        getReturnValue() {
          return this.state;
        }
      }

      env.addCommandHandlerClass('chain', ChainHandler);

      const script = `
      if asyncReject()
        @chain.subcommand.doSomething("test")
      endif
    `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should work with custom handler when no condition poison', async () => {
      const script = `
      if true
        @test.log("Success")
        @test.setValue("key", "value")
      endif
    `;

      const result = await env.renderScriptString(script, context);
      expect(result.test.commands).to.have.length(2);
      expect(result.test.commands[0].type).to.be('log');
      expect(result.test.commands[1].type).to.be('set');
    });

    it('should poison handler in nested blocks with custom handlers', async () => {
      const script = `
      if true
        @test.log("outer start")
        if asyncReject()
          @test.log("inner")
          @logger.log("inner logger")
        endif
        @test.log("outer end")
      endif
    `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should handle singleton handler state correctly on poison', async () => {
      // First render - should succeed
      const script1 = `
      if true
        @logger.log("First render")
      endif
    `;
      const result1 = await env.renderScriptString(script1, context);
      expect(result1.logger.logs).to.contain(`First render`);

      // Second render - should fail and not pollute singleton state
      const script2 = `
      if asyncReject()
        @logger.log("Should be poisoned")
      endif
    `;

      try {
        await env.renderScriptString(script2, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }

      // Third render - should succeed and not see poisoned state
      const script3 = `
      if true
        @logger.log("Third render")
      endif
    `;
      const result3 = await env.renderScriptString(script3, context);
      expect(result3.logger.logs).to.contain(`Third render`);
      expect(result3.logger.logs).to.not.contain(`Shoul  d be poisoned`);
    });
  });

  describe('Poison Handler Tests - Templates with Text Output', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should poison text output in template when condition fails', async () => {
      const template = `{% if asyncReject() %}Hello World{% endif %}`;

      try {
        await env.renderTemplateString(template, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison text in both if/else branches', async () => {
      const template = `{% if asyncReject() %}yes{% else %}no{% endif %}`;

      try {
        await env.renderTemplateString(template, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison output expressions in template', async () => {
      const template = `{% if asyncReject() %}{{ "output" }}{% endif %}`;

      try {
        await env.renderTemplateString(template, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should handle nested conditionals in templates', async () => {
      const template = `
      {% if true %}
        outer start
        {% if asyncReject() %}
          inner text
        {% endif %}
        outer end
      {% endif %}
    `;

      try {
        await env.renderTemplateString(template, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should work when condition succeeds in template', async () => {
      const template = `{% if true %}success{% endif %}`;
      const result = await env.renderTemplateString(template, context);
      expect(result).to.be('success');
    });
  });

  describe('Poison Handler Tests - Edge Cases', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should handle deeply nested handler calls in scripts', async () => {
      const script = `
      if true
        if true
          if asyncReject()
            @data.deep = "value"
          endif
        endif
      endif
    `;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should collect errors from multiple poisoned conditions', async () => {
      const context2 = {
        asyncReject1: async () => { throw new Error('Error 1'); },
        asyncReject2: async () => { throw new Error('Error 2'); }
      };

      const script = `
      if asyncReject1()
        @data.first = 1
      endif
      if asyncReject2()
        @data.second = 2
      endif
    `;

      try {
        await env.renderScriptString(script, context2, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Should contain both errors
        expect(err.message).to.contain('Error 1');
        expect(err.message).to.contain('Error 2');
      }
    });

    it('should deduplicate identical errors from multiple branches', async () => {
      const sameError = async () => { throw new Error('Same error'); };
      const context2 = { sameError };

      const script = `
      if sameError()
        @data.a = 1
      endif
      if sameError()
        @data.b = 2
      endif
    `;

      try {
        await env.renderScriptString(script, context2, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Should deduplicate - only one "Same error" message
        const messages = err.errors.map(e => e.message);
        const sameErrorCount = messages.filter(m => m.includes('Same error')).length;
        expect(sameErrorCount).to.be(1);
      }
    });

    it('should preserve error messages and stack traces', async () => {
      const errorWithStack = async () => {
        const err = new Error('Detailed error message');
        err.code = 'TEST_ERROR';
        throw err;
      };
      const context2 = { errorWithStack };

      const script = `
      if errorWithStack()
        @data.value = 1
      endif
    `;

      try {
        await env.renderScriptString(script, context2, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Detailed error message');
        expect(err.errors[0].code).to.be('TEST_ERROR');
        expect(err.errors[0].stack).to.be.ok();
      }
    });
  });

})();

