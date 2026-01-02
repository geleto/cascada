(function () {
  'use strict';

  var cascada;
  var expect;
  var AsyncEnvironment;
  var POISON_SYMBOL = (typeof Symbol !== 'undefined' && Symbol.for)
    ? Symbol.for('cascada.poison')
    : '__cascadaPoisonError';

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    cascada = require('../../src/index');
    AsyncEnvironment = cascada.AsyncEnvironment;
  } else {
    expect = window.expect;
    cascada = window.cascada;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  function fakePoison(message) {
    const poison = {
      errors: [new Error(message)]
    };
    poison[POISON_SYMBOL] = true;
    return poison;
  }

  describe('Guard Block', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should output content normally when successful', async () => {
      const tpl = `
        {% guard %}
          guarded content
        {% endguard %}
      `;
      const res = await env.renderTemplateString(tpl);
      expect(res.trim()).to.equal('guarded content');
    });

    it('should revert content on error', async () => {
      const tpl = `
        before
        {% guard %}
          inside
          {{ error("fail") }}
          after error
        {% endguard %}
        after
      `;
      // The guard fails, so inner output 'inside' should be reverted.
      // 'before' and 'after' should remain.
      const res = await env.renderTemplateString(tpl, {
        error: (msg) => { throw new Error(msg); }
      });
      const cleaned = res.replace(/\s+/g, ' ').trim();
      expect(cleaned).to.equal('before after');
    });

    it('should revert nested guard content on error', async () => {
      const tpl = `
        BLOCK1
        {% guard %}
          block2
          {% guard %}
            block3
            {{ error("fail") }}
          {% endguard %}
          block4
        {% endguard %}
        BLOCK5
      `;
      // Inner guard fails -> reverts block3.
      // Inner guard swallows error -> execution continues to block4.
      // Outer guard succeeds.
      // Expected: BLOCK1 block2 block4 BLOCK5
      const res = await env.renderTemplateString(tpl, {
        error: (msg) => { throw new Error(msg); }
      });
      const cleaned = res.replace(/\s+/g, ' ').trim();
      expect(cleaned).to.equal('BLOCK1 block2 block4 BLOCK5');
    });

    it('should revert outer guard if error propagates', async () => {
      // guard swallows error
      const tpl = `
        OUTER
        {% guard %}
          INNER
          {{ error("fail") }}
        {% endguard %}
        DONE
      `;
      const res = await env.renderTemplateString(tpl, {
        error: (msg) => { throw new Error(msg); }
      });
      expect(res.replace(/\s+/g, ' ').trim()).to.equal('OUTER DONE');
    });

    it('should respect manual @_revert inside guard block', async () => {
      const tpl = `
        BEFORE
        {% guard %}
          discard
          {% revert %}
          keep
        {% endguard %}
        AFTER
      `;
      const res = await env.renderTemplateString(tpl);
      expect(res.replace(/\s+/g, ' ').trim()).to.equal('BEFORE keep AFTER');
    });

    it('should revert only specified handlers in script mode', async () => {
      const script = `
        guard @text, @data
          @text("INNER")
          @data.guard.value = "DROP"
          @text(explode())
        endguard

        @text("OUTER")
        @data.status = "ok"
      `;

      const context = {
        explode: () => {
          throw new Error('boom');
        }
      };

      const result = await env.renderScriptString(script, context);
      expect(result.text.trim()).to.equal('OUTER');
      expect(result.data).to.eql({ status: 'ok' });
    });

    it('should allow guard @ to revert all handlers', async () => {
      const script = `
        guard @
          @text("INNER")
          @data.guard.value = "DROP"
          @text(explode())
        endguard

        @text("OUTER")
        @data.status = "ok"
      `;

      const context = {
        explode: () => {
          throw new Error('boom');
        }
      };

      const result = await env.renderScriptString(script, context);
      expect(result.text.trim()).to.equal('OUTER');
      expect(result.data).to.eql({ status: 'ok' });
    });

    it('should error when mixing @ with specific handlers', async () => {
      const script = `
        guard @, @text
          @text("X")
        endguard
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected guard selector error');
      } catch (err) {
        expect(err.message).to.contain('"@" cannot be combined');
      }
    });

    it('should error on duplicate handler selectors', async () => {
      const script = `
        guard @text, @text
          @text("X")
        endguard
      `;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected guard duplicate selector error');
      } catch (err) {
        expect(err.message).to.contain('duplicate selector "@text"');
      }
    });

    it('should restore guarded variables on error', async () => {
      const tpl = `
        {% set count = 1 %}
        {% guard count, @ %}
          {% set count = count + 1 %}
          {{ error("boom") }}
        {% endguard %}
        {{ count }}
      `;

      const res = await env.renderTemplateString(tpl, {
        error: (msg) => { throw new Error(msg); }
      });

      expect(res.replace(/\s+/g, ' ').trim()).to.equal('1');
    });

    it('should keep guarded variable changes on success', async () => {
      const tpl = `
        {% set count = 1 %}
        {% guard count, @ %}
          {% set count = count + 1 %}
        {% endguard %}
        {{ count }}
      `;

      const res = await env.renderTemplateString(tpl);
      expect(res.replace(/\s+/g, ' ').trim()).to.equal('2');
    });

    it('should error when guarding undeclared variables', async () => {
      const tpl = `
        {% guard missingVar %}
          {% set missingVar = 1 %}
        {% endguard %}
      `;

      try {
        await env.renderTemplateString(tpl);
        expect().fail('Expected undeclared guard variable error');
      } catch (err) {
        expect(err.message).to.contain('guard variable "missingVar" is not declared');
      }
    });

    it('should error when guard variable is not modified', async () => {
      const tpl = `
        {% set value = 1 %}
        {% guard value %}
          {{ value }}
        {% endguard %}
      `;

      try {
        await env.renderTemplateString(tpl);
        expect().fail('Expected guard variable modification error');
      } catch (err) {
        expect(err.message).to.contain('guard variable "value" must be modified');
      }
    });

    it('should revert when variable becomes poison without buffer errors', async () => {
      const tpl = `
        {% set status = "ok" %}
        {% guard status %}
          {% set status = poison() %}
        {% endguard %}
        {{ status }}
      `;

      const res = await env.renderTemplateString(tpl, {
        poison: () => fakePoison('boom')
      });

      expect(res.replace(/\s+/g, ' ').trim()).to.equal('ok');
    });

    it('should restore guarded variables on error in script mode', async () => {
      const script = `
        var count = 1
        guard count
          count = count + 1
          count = poison()
        endguard
        @data.res = count
      `;

      const res = await env.renderScriptString(script, {
        poison: () => fakePoison('boom')
      });
      expect(res.data.res).to.equal(1);
    });

    it('should keep guarded variable changes on success in script mode', async () => {
      const script = `
        var count = 1
        guard count
          count = count + 1
        endguard
        @data.res = count
      `;

      const res = await env.renderScriptString(script);
      expect(res.data.res).to.equal(2);
    });

    it('should restore multiple guarded variables on error in script mode', async () => {
      const script = `
        var a = 10
        var b = 20
        guard a, b
          a = 11
          b = poison()
        endguard
        @data.resA = a
        @data.resB = b
      `;

      const res = await env.renderScriptString(script, {
        poison: () => fakePoison('boom')
      });
      expect(res.data.resA).to.equal(10);
      expect(res.data.resB).to.equal(20);
    });

    it('should guard and restore sequence locks (postfix !)', async () => {
      const script = `
        guard lock!
          var ignore = lock!.fail()
        endguard
        @data.status = lock!.success()
      `;

      const res = await env.renderScriptString(script, {
        lock: {
          fail: () => { throw new Error('lock failure'); },
          success: () => 'ok'
        }
      });
      expect(res.data.status).to.equal('ok');
    });

    it('sequence lock shall not wait on guarded var', async () => {
      const script = `
        var slowVar
        guard lock!, slowVar
          lock!.op()
          slowVar = getSlow()
        endguard
        @data.status = lock!.success()
      `;

      var slowResolved = false;

      const res = await env.renderScriptString(script, {
        lock: {
          op: () => 'op',
          success: () => {
            if (slowResolved) {
              return 'Not ok';
            }
            return 'ok';
          }
        },
        getSlow: () => {
          return new Promise(resolve => {
            setTimeout(() => {
              slowResolved = true;
              resolve('slow');
            }, 200);
          });
        }
      });
      expect(res.data.status).to.equal('ok');
    });

    it('should guard and restore multiple sequence locks', async () => {
      const script = `
        var success
        guard lock1!, lock2!
          var _1 = lock1!.op()
          var _2 = lock2!.op()
          var _3 = fail()
        endguard
        @data.status1 = lock1!.success()
        @data.status2 = lock2!.success()
      `;

      const context = {
        fail: () => { throw new Error('failure'); },
        lock1: {
          op: () => 'op1',
          success: () => 'ok1',
          fail: () => { throw new Error('fail1'); }
        },
        lock2: {
          op: () => 'op2',
          success: () => 'ok2',
          fail: () => { throw new Error('fail2'); }
        }
      };

      const res = await env.renderScriptString(script, context);
      expect(res.data.status1).to.equal('ok1');
      expect(res.data.status2).to.equal('ok2');
    });

    it('should repair sequence failure happening after slow sequence operation', async () => {
      // This ensures that the guard waits for the entire sequence to complete (or fail)
      // before attempting to repair. If it repaired too early (e.g. while slow() was running),
      // the subsequent fail() would leave the lock in a broken state.
      const script = `
        var ignore
        guard lock!
          var _1 = lock!.slow()
          var _2 = lock!.fail()
        endguard
        @data.status = lock!.success()
      `;

      const context = {
        lock: {
          slow: () => new Promise(resolve => setTimeout(() => resolve('slow'), 50)),
          fail: () => { throw new Error('sequence failed'); },
          success: () => 'ok'
        }
      };

      const res = await env.renderScriptString(script, context);
      expect(res.data.status).to.equal('ok');
    });

    it('should allow concurrent access to sequence lock while original owner accepts slow output', async () => {
      // This is the real proof.
      // Request A: guard { lock!.op(); {{ getSlow() }} }
      // 'getSlow()' returns a Promise that is written to the buffer.
      // The compiler does NOT await output expressions immediately (it buffers them).
      // So the guard body finishes compilation/execution (sync part).
      // Then 'finally' executes -> repairSequenceLocks -> lock is released.
      // Then 'waitAllClosures' executes -> waits for getSlow().
      //
      // So Request B should be able to acquire the lock WHILE A is still waiting for getSlow().

      const templateA = `
         {%- guard lock! -%}
           {{ lock!.op() }}
           {{ getSlow() }}
         {%- endguard -%}
       `;

      const templateB = `{{ lock!.success() }}`;

      let isAinSlow = false;
      let isBFinished = false;

      const context = {
        lock: {
          op: () => 'op',
          success: () => 'ok'
        },
        getSlow: () => {
          return new Promise(resolve => {
            isAinSlow = true;
            setTimeout(() => {
              resolve('done_slow');
              isAinSlow = false;
            }, 200);
          });
        }
      };

      const promA = env.renderTemplateString(templateA, context);

      // Wait 50ms for A to enter slow state
      await new Promise(r => setTimeout(r, 50));

      // Start B
      const promB = env.renderTemplateString(templateB, context);

      await promB.then(res => {
        expect(res.trim()).to.equal('ok');
        isBFinished = true;
      });

      // B must finish while A is still in slow
      expect(isAinSlow).to.be(true);
      expect(isBFinished).to.be(true);

      await promA;
    });

    it('should execute recover block on error', async () => {
      const script = `
      var state = "initial"
      guard state, @data
        state = "changed"
        @data.x = error("fail")
      recover err
        state = "recovered: " + err.message
        @data.msg = err.message
      endguard
      @data.finalState = state
      `;

      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };

      const res = await env.renderScriptString(script, context);

      // Verify finalState indicates successful recovery and variable access
      expect(res.data.finalState).to.equal('recovered: fail');

      // Verify msg was set in recover block (confirms buffer output works)
      expect(res.data.msg).to.equal('fail');

      // Verify x was reverted
      expect(res.data.x).to.be(undefined);
    });  // 'data' handler: `getHandler` returns instance.
    // Assuming 'data' handler has some way to check output.
    // In these tests, usually checking context/variables or throwing.
  });
})();
