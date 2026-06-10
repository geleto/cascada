
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {createPoison, isPoisonError, PoisonError} from '../../src/runtime/runtime.js';

const TEST_EC = [1, 1, 'HandlerPoisoning.TestInput', 'handler-poisoning.js', null, null];
const createTestPoison = (message) => createPoison(PoisonError.create(message, TEST_EC, 'UserCallThrew'));

(function () {

  describe('Chain Poisoning for Conditional Branches', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should poison chains when if condition fails with text chain only', async () => {
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

    it('should poison chains when if condition fails with data chain only, in script', async () => {
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

    it('should poison chains when while condition fails with data chain only, in script', async () => {
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

    it('should poison chains when if-else both write chains', async () => {
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

    it('should poison chains with mixed variables and chain writes', async () => {
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

    it('should not poison a parent chain only read by a skipped if branch', async () => {
      const script = `
        var source = "alive"
        if poisonedCondition()
          var local = source
        endif

        return source`;

      const result = await env.renderScriptString(script, {
        poisonedCondition() {
          return createTestPoison('Condition failed');
        }
      });

      expect(result).to.equal('alive');
    });

    it('should still poison a parent chain written by a skipped if branch', async () => {
      const script = `
        var source = "alive"
        if poisonedCondition()
          source = "changed"
        endif

        return source`;

      try {
        await env.renderScriptString(script, {
          poisonedCondition() {
            return createTestPoison('Condition failed');
          }
        });
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.message).to.contain('Condition failed');
      }
    });

    it('should not poison a parent chain only read by skipped switch cases', async () => {
      const script = `
        var source = "alive"
        switch poisonedValue()
          case "a"
            var caseLocal = source
          default
            var defaultLocal = source
        endswitch

        return source`;

      const result = await env.renderScriptString(script, {
        poisonedValue() {
          return createTestPoison('Switch failed');
        }
      });

      expect(result).to.equal('alive');
    });

    it('should not poison a parent chain only read by a skipped while body when the condition fails', async () => {
      const script = `
        var source = "alive"
        while poisonedCondition()
          var local = source
        endwhile

        return source`;

      const result = await env.renderScriptString(script, {
        poisonedCondition() {
          return createTestPoison('While failed');
        }
      });

      expect(result).to.equal('alive');
    });

    it('should not poison a parent chain only read by a skipped loop body when the iterator fails', async () => {
      const script = `
        var source = "alive"
        for item in poisonedItems()
          var local = source
        endfor

        return source`;

      const result = await env.renderScriptString(script, {
        poisonedItems() {
          return createTestPoison('Items failed');
        }
      });

      expect(result).to.equal('alive');
    });

    it('should not poison a parent chain only read by a skipped loop else when the iterator fails', async () => {
      const script = `
        var source = "alive"
        for item in poisonedItems()
          var local = item
        else
          var fallback = source
        endfor

        return source`;

      const result = await env.renderScriptString(script, {
        poisonedItems() {
          return createTestPoison('Items failed');
        }
      });

      expect(result).to.equal('alive');
    });

    it('should not poison a parent chain only read by a skipped malformed destructuring body', async () => {
      const script = `
        var source = "alive"
        for name, id in [1]
          var local = source
        endfor

        return source`;

      const result = await env.renderScriptString(script);

      expect(result).to.equal('alive');
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

  // Add to existing test file for poison chain tests

  describe('Poison Chain Tests - Scripts with data chain', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should poison data chain when condition fails in script', async () => {
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

    it('should handle mixed text and data chains in script', async () => {
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
        // Should have markers for both 'text' and 'data' chains
      }
    });

    it('should work when data chain operations succeed but text chain fails', async () => {
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

  describe('Poison Chain Tests - Custom Sequence Chains in Scripts', () => {
    let env;
    // Simple custom sequence chain target for testing
    class TestSequenceChain {
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

    // Singleton sequence chain target for testing
    class SingletonSequenceChain {
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
      singleton = new SingletonSequenceChain();

      context = {
        asyncReject: async () => { throw new Error('Async rejection'); },
        loggerRef: singleton,
        makeTest: () => new TestSequenceChain()
      };
    });

    it('should poison custom sequence chain when condition fails', async () => {
      const script = `
        sequence test = makeTest()
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

    it('should poison multiple custom sequence chains', async () => {
      const script = `
        sequence test = makeTest()
        sequence logger = loggerRef
        if asyncReject()
          test.log("Chain 1")
          logger.log("Chain 2")
        endif
        return { test: test.snapshot(), logger: logger.snapshot() }`;

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Both 'test' and 'logger' chains should have markers
      }
    });

    it('should poison custom sequence chain in else branch', async () => {
      const script = `
        sequence test = makeTest()
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

    it('should poison custom sequence chain with method chains', async () => {
      // Add a sequence chain target that supports subpaths
      class ChainSequenceChain {
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
        sequence chain = makeChain()
        if asyncReject()
          chain.subcommand.doSomething("test")
        endif
        return chain.snapshot()
      `;

      try {
        await env.renderScriptString(script, { ...context, makeChain: () => new ChainSequenceChain() });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }
    });

    it('should work with sequence-backed custom chain when no condition poison', async () => {
      const script = `
      sequence testSequence = makeTest()
      if true
        testSequence.log("Success")
        testSequence.setValue("key", "value")
      endif
      return { test: testSequence.snapshot() }
    `;

      const result = await env.renderScriptString(script, {
        ...context,
        makeTest: () => new TestSequenceChain()
      });
      expect(result.test.commands).to.have.length(2);
      expect(result.test.commands[0].type).to.be('log');
      expect(result.test.commands[1].type).to.be('set');
    });

    it('should poison chain in nested blocks with custom chains', async () => {
      const script = `
        sequence test = makeTest()
        sequence logger = loggerRef
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

    it('should handle sequence-backed singleton chain state correctly on poison', async () => {
      // First render - should succeed
      const script1 = `
      sequence loggerSequence = loggerRef
      if true
        loggerSequence.log("First render")
      endif
      return { logger: loggerSequence.snapshot() }
    `;
      const result1 = await env.renderScriptString(script1, context);
      expect(result1.logger.logs).to.contain(`First render`);

      // Second render - should fail and not pollute singleton state
      const script2 = `
        sequence loggerSequence = loggerRef
        if asyncReject()
          loggerSequence.log("Should be poisoned")
        endif
        return loggerSequence.snapshot()
      `;

      try {
        await env.renderScriptString(script2, context);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
      }

      // Third render - should succeed and not see poisoned state
      const script3 = `
      sequence loggerSequence = loggerRef
      if true
        loggerSequence.log("Third render")
      endif
      return { logger: loggerSequence.snapshot() }
    `;
      const result3 = await env.renderScriptString(script3, context);
      expect(result3.logger.logs).to.contain(`Third render`);
      expect(result3.logger.logs).to.not.contain(`Shoul  d be poisoned`);
    });
  });

  describe('Poison Chain Tests - Templates with Text Chain', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should poison text chain in template when condition fails', async () => {
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

  describe('Poison Chain Tests - Edge Cases', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment(null, { asyncMode: true, scriptMode: true });
      context = {
        asyncReject: async () => { throw new Error('Async rejection'); }
      };
    });

    it('should handle deeply nested chain calls in scripts', async () => {
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
