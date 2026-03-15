(function () {
  'use strict';

  var expect;
  let AsyncEnvironment;
  let isPoisonError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    isPoisonError = require('../../src/runtime/runtime').isPoisonError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    isPoisonError = nunjucks.runtime.isPoisonError;
  }

  describe('Channel Poisoning for Conditional Branches', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should poison channels when if condition fails with text channel only', async () => {
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

    it('should poison channels when if condition fails with data channel only, in script', async () => {
      const script = `
        data result
        if asyncReject()
          result.value = "yes"
        endif

        return {data: result.snapshot() }`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should poison channels when while condition fails with data channel only, in script', async () => {
      const script = `
        data result
        while asyncReject()
          result.push("yes")
        endwhile

        return {data: result.snapshot() }`;

      const context = {
        async asyncReject() {
          throw new Error('Condition failed');
        }
      };

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should poison channels when if-else both write channels', async () => {
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

    it('should poison channels with mixed variables and channel writes', async () => {
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

  // Add to existing test file for poison channel tests

  describe('Poison Channel Tests - Scripts with data channel', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should poison data channel when condition fails in script', async () => {
      const script = `
      data result
      if asyncReject()
        result.user.name = "Alice"
        result.user.age = 30
      endif

      return {data: result.snapshot() }`;

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
      data result
      if asyncReject()
        result.branch = "true"
        result.value = 1
      else
        result.branch = "false"
        result.value = 2
      endif

      return {data: result.snapshot() }`;

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
      data result
      if asyncReject()
        result.users.push({ name: "Alice" })
        result.users.push({ name: "Bob" })
        result.count = 2
        result.status = "active"
      endif

      return {data: result.snapshot() }`;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison @data with nested paths', async () => {
      const script = `
      data result
      if asyncReject()
        result.company.employees[0].name = "Alice"
        result.company.employees[0].role = "Engineer"
        result.company.name = "TechCorp"
      endif

      return {data: result.snapshot() }`;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should handle mixed text and data channels in script', async () => {
      const script = `
      text output
      data result
      if asyncReject()
        output("Starting process...")
        result.status = "processing"
        result.step = 1
      endif

      return { text: output.snapshot(), data: result.snapshot() }`;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Should have markers for both 'text' and 'data' channels
      }
    });

    it('should work when data channel operations succeed but text channel fails', async () => {
      const script = `
      data result
      text output
      if true
        result.working = "yes"
      endif
      output(asyncReject())

      return {data: result.snapshot(), text: output.snapshot() }`;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison @data in nested conditionals', async () => {
      const script = `
      data result
      if true
        result.outer = "start"
        if asyncReject()
          result.inner = "value"
        endif
        result.outer = "end"
      endif

      return {data: result.snapshot() }`;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison @data in loop body when condition fails', async () => {
      const script = `
      data result
      for i in [1, 2, 3]
        if asyncReject()
          result.items.push(i)
        endif
      endfor

      return {data: result.snapshot() }`;

      try {
        await env.renderScriptString(script, context, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });
  });

  describe('Poison Channel Tests - Custom Sink Channels in Scripts', () => {
    let env;
    // Simple custom sink channel target for testing
    class TestSinkChannel {
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

      snapshot() {
        return { commands: this.commands };
      }

      getReturnValue() {
        return { commands: this.commands };
      }
    }

    // Singleton sink channel target for testing
    class SingletonSinkChannel {
      constructor() {
        this.allLogs = [];
        this.currentLogs = [];
      }

      _init(context) {
        this.currentLogs = [];
      }

      log(message) {
        if (!this.currentLogs) {
          this.currentLogs = [];
        }
        this.currentLogs.push(message);
        this.allLogs.push(message);
      }

      snapshot() {
        return { logs: this.currentLogs };
      }

      getReturnValue() {
        return { logs: this.currentLogs };
      }
    }

    let context;
    let singleton;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      singleton = new SingletonSinkChannel();

      context = {
        asyncReject: async () => { throw new Error('Async rejection'); },
        loggerRef: singleton,
        makeTest: () => new TestSinkChannel()
      };
    });

    it('should poison custom sink channel when condition fails', async () => {
      const script = `
        sink test = makeTest()
        if asyncReject()
          test.log("This should be poisoned")
          test.setValue("key", "value")
        endif
        return test.snapshot()
      `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison multiple custom sink channels', async () => {
      const script = `
        sink test = makeTest()
        sink logger = loggerRef
        if asyncReject()
          test.log("Channel 1")
          logger.log("Channel 2")
        endif
        return { test: test.snapshot(), logger: logger.snapshot() }`;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Both 'test' and 'logger' channels should have markers
      }
    });

    it('should poison custom sink channel in else branch', async () => {
      const script = `
        sink test = makeTest()
        if asyncReject()
          test.log("if branch")
        else
          test.log("else branch")
        endif
        return test.snapshot()
      `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should poison custom sink channel with method chains', async () => {
      // Add a sink channel target that supports subpaths
      class ChainSinkChannel {
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

        snapshot() {
          return this.state;
        }
      }

      const script = `
        sink chain = makeChain()
        if asyncReject()
          chain.subcommand.doSomething("test")
        endif
        return chain.snapshot()
      `;

      try {
        await env.renderScriptString(script, { ...context, makeChain: () => new ChainSinkChannel() });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should work with sink-backed custom channel when no condition poison', async () => {
      const script = `
      sink testSink = makeTest()
      if true
        testSink.log("Success")
        testSink.setValue("key", "value")
      endif
      return { test: testSink.snapshot() }
    `;

      const result = await env.renderScriptString(script, {
        ...context,
        makeTest: () => new TestSinkChannel()
      });
      expect(result.test.commands).to.have.length(2);
      expect(result.test.commands[0].type).to.be('log');
      expect(result.test.commands[1].type).to.be('set');
    });

    it('should poison channel in nested blocks with custom channels', async () => {
      const script = `
        sink test = makeTest()
        sink logger = loggerRef
        if true
          test.log("outer start")
          if asyncReject()
            test.log("inner")
            logger.log("inner logger")
          endif
          test.log("outer end")
        endif
        return { test: test.snapshot(), logger: logger.snapshot() }
      `;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should handle sink-backed singleton channel state correctly on poison', async () => {
      // First render - should succeed
      const script1 = `
      sink loggerSink = loggerRef
      if true
        loggerSink.log("First render")
      endif
      return { logger: loggerSink.snapshot() }
    `;
      const result1 = await env.renderScriptString(script1, context);
      expect(result1.logger.logs).to.contain(`First render`);

      // Second render - should fail and not pollute singleton state
      const script2 = `
        sink loggerSink = loggerRef
        if asyncReject()
          loggerSink.log("Should be poisoned")
        endif
        return loggerSink.snapshot()
      `;

      try {
        await env.renderScriptString(script2, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }

      // Third render - should succeed and not see poisoned state
      const script3 = `
      sink loggerSink = loggerRef
      if true
        loggerSink.log("Third render")
      endif
      return { logger: loggerSink.snapshot() }
    `;
      const result3 = await env.renderScriptString(script3, context);
      expect(result3.logger.logs).to.contain(`Third render`);
      expect(result3.logger.logs).to.not.contain(`Shoul  d be poisoned`);
    });
  });

  describe('Poison Channel Tests - Templates with Text Channel', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should poison text channel in template when condition fails', async () => {
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

  describe('Poison Channel Tests - Edge Cases', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should handle deeply nested channel calls in scripts', async () => {
      const script = `
      data result
      if true
        if true
          if asyncReject()
            result.deep = "value"
          endif
        endif
      endif

      return {data: result.snapshot() }`;

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
      data result
      if asyncReject1()
        result.first = 1
      endif
      if asyncReject2()
        result.second = 2
      endif

      return {data: result.snapshot() }`;

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

    it('should preserve error messages and stack traces', async () => {
      const errorWithStack = async () => {
        const err = new Error('Detailed error message');
        throw err;
      };
      const context2 = { errorWithStack };

      const script = `
      data result
      if errorWithStack()
        result.value = 1
      endif

      return {data: result.snapshot() }`;

      try {
        await env.renderScriptString(script, context2, { output: 'data' });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Detailed error message');
        expect(err.errors[0].stack).to.be.ok();
      }
    });
  });

})();
