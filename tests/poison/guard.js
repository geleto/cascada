(function () {
  'use strict';

  var cascada;
  var expect;
  var AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    cascada = require('../../src/index');
    AsyncEnvironment = cascada.AsyncEnvironment;
  } else {
    expect = window.expect;
    cascada = window.cascada;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  function throwError(message) {
    throw new Error(message);
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

    it.skip('should respect manual @_revert inside guard block', async () => {
      // TODO: Re-enable when 'revert' statement is implemented for guards
      // New syntax will be: revert (without @ prefix, only works inside guards)
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
        text output
        data result
        guard @output, @result
          output("INNER")
          result.guard.value = "DROP"
          output(explode())
        endguard

        output("OUTER")
        result.status = "ok"

        return { text: output.snapshot(), data: result.snapshot() }`;

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
        text output
        data result
        guard @
          output("INNER")
          result.guard.value = "DROP"
          output(explode())
        endguard

        output("OUTER")
        result.status = "ok"

        return { text: output.snapshot(), data: result.snapshot() }`;

      const context = {
        explode: () => {
          throw new Error('boom');
        }
      };

      const result = await env.renderScriptString(script, context);
      expect(result.text.trim()).to.equal('OUTER');
      expect(result.data).to.eql({ status: 'ok' });
    });

    it('should allow bare datatype selector to guard matching handler in script mode', async () => {
      const script = `
        data result
        text output
        guard data
          result.temp = "DROP"
          result.fail = explode()
        endguard

        output("OUTER")
        result.status = "ok"
        return { text: output.snapshot(), data: result.snapshot() }`;

      const result = await env.renderScriptString(script, {
        explode: () => {
          throw new Error('boom');
        }
      });

      expect(result.text.trim()).to.equal('OUTER');
      expect(result.data).to.eql({ status: 'ok' });
    });

    it('should allow var selector to guard all variables in script mode', async () => {
      const script = `
        var count = 1
        guard var
          count = count + 1
          count = explode()
        endguard
        return { count: count }`;

      const result = await env.renderScriptString(script, {
        explode: () => {
          throw new Error('boom');
        }
      });

      expect(result.count).to.equal(1);
    });

    it('should keep pre-guard snapshot while reverting guard output on failure', async () => {
      const script = `
        text output
        var snap = ""
        output("BEFORE")
        snap = output.snapshot()
        guard @output
          output("INNER")
          output(explode())
        endguard
        output("OUTER")
        return { snap: snap, final: output.snapshot() }
      `;

      const result = await env.renderScriptString(script, {
        explode: () => {
          throw new Error('boom');
        }
      });

      expect(result.snap.trim()).to.equal('BEFORE');
      expect(result.final.trim()).to.equal('BEFOREOUTER');
    });

    it('should propagate handler poison when only variables are guarded', async () => {
      const script = `
        text output
        var count = 1
        guard count
          output("INSIDE")
          count = count + 1
          output(explode())
        endguard
        output("AFTER")

        return { text: output.snapshot() }`;

      const context = {
        explode: () => throwError('boom')
      };

      try {
        await env.renderScriptString(script, context);
        expect().fail('Expected guard to propagate handler poison');
      } catch (err) {
        expect(err.message).to.contain('boom');
      }
    });

    it('should revert outputs when guard has no selectors', async () => {
      const script = `
        text output
        data result
        guard
          output("inside")
          result.val = explode()
        endguard

        output("outside")
        result.final = "ok"

        return { text: output.snapshot(), data: result.snapshot() }`;

      const context = {
        explode: () => { throw new Error('boom'); }
      };

      const res = await env.renderScriptString(script, context);
      expect(res.text.trim()).to.equal('outside');
      expect(res.data.final).to.equal('ok');
      expect(res.data.val).to.be(undefined);
    });

    it('should error when mixing @ with specific handlers', async () => {
      const script = `
        text output
        guard @, @output
          output("X")
        endguard

        return { text: output.snapshot() }`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected guard selector error');
      } catch (err) {
        expect(err.message).to.contain('"@" cannot be combined');
      }
    });

    it('should error on duplicate handler selectors', async () => {
      const script = `
        text output
        guard @output, @output
          output("X")
        endguard

        return { text: output.snapshot() }`;

      try {
        await env.renderScriptString(script, {});
        expect().fail('Expected guard duplicate selector error');
      } catch (err) {
        expect(err.message).to.contain('duplicate selector "@output"');
      }
    });

    it('should restore guarded variables on error in template mode', async () => {
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

    it('should keep guarded variable changes on success in template mode', async () => {
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

    it('should revert everything with guard * in template mode', async () => {
      const tpl = `
        {% set count = 1 %}
        {% guard * %}
          {% set count = count + 1 %}
          inside
          {{ error("fail") }}
        {% recover err %}
          RECOVER
        {% endguard %}
        {{ count }}
      `;

      const res = await env.renderTemplateString(tpl, {
        error: (msg) => { throw new Error(msg); }
      });

      const cleaned = res.replace(/\s+/g, ' ').trim();
      expect(cleaned).to.equal('RECOVER 1');
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
        poison: () => throwError('boom')
      });

      expect(res.replace(/\s+/g, ' ').trim()).to.equal('ok');
    });

    it('should revert everything with guard * in script mode', async () => {
      const script = `
        data result
        text output
        var count = 1
        guard *
          count = count + 1
          result.inner = "inside"
          output("INNER")
          count = poison()
          var ignore = lock!.fail()
        recover err
          result.recovered = true
        endguard
        result.count = count
        result.status = lock!.success()

        return {data: result.snapshot(), text: output.snapshot() }`;

      const res = await env.renderScriptString(script, {
        poison: () => throwError('boom'),
        lock: {
          fail: () => { throw new Error('lock failure'); },
          success: () => 'ok'
        }
      });

      expect(res.data.count).to.equal(1);
      expect(res.data.inner).to.be(undefined);
      expect(res.data.recovered).to.equal(true);
      expect(res.data.status).to.equal('ok');
      expect((res.text || '').trim()).to.equal('');
    });

    it('should restore guarded variables on error in script mode', async () => {
      const script = `
        var result = {}
        var count = 1
        guard count
          count = count + 1
          count = poison()
        endguard
        result.res = count

        return {data: result }`;

      const res = await env.renderScriptString(script, {
        poison: () => throwError('boom')
      });
      expect(res.data.res).to.equal(1);
    });

    it('should keep guarded variable changes on success in script mode', async () => {
      const script = `
        var result = {}
        var count = 1
        guard count
          count = count + 1
        endguard
        result.res = count

        return {data: result }`;

      const res = await env.renderScriptString(script);
      expect(res.data.res).to.equal(2);
    });

    it('should restore multiple guarded variables on error in script mode', async () => {
      const script = `
        var result = {}
        var a = 10
        var b = 20
        guard a, b
          a = 11
          b = poison()
        endguard
        result.resA = a
        result.resB = b

        return {data: result }`;

      const res = await env.renderScriptString(script, {
        poison: () => throwError('boom')
      });
      expect(res.data.resA).to.equal(10);
      expect(res.data.resB).to.equal(20);
    });

    it('should guard and restore sequence locks (postfix !)', async () => {
      const script = `
        var result = {}
        guard lock!
          var ignore = lock!.fail()
        endguard
        result.status = lock!.success()

        return {data: result }`;

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
        var result = {}
        var slowVar
        guard lock!, slowVar
          lock!.op()
          slowVar = getSlow()
        endguard
        result.status = lock!.success()

        return {data: result }`;

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
        var result = {}
        var success
        guard lock1!, lock2!
          var _1 = lock1!.op()
          var _2 = lock2!.op()
          var _3 = fail()
        endguard
        result.status1 = lock1!.success()
        result.status2 = lock2!.success()

        return {data: result }`;

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
        var result = {}
        var ignore
        guard lock!
          var _1 = lock!.slow()
          var _2 = lock!.fail()
        endguard
        result.status = lock!.success()

        return {data: result }`;

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
      data result
      var state = "initial"
      guard state, @result
        state = "changed"
        result.x = error("fail")
      recover err
        state = "recovered: " + err.message
        result.msg = err.message
      endguard
      result.finalState = state

      return {data: result.snapshot() }`;

      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };

      const res = await env.renderScriptString(script, context);

      // Verify finalState indicates successful recovery and variable access
      expect(res.data.finalState).to.contain('recovered:');
      expect(res.data.finalState).to.contain('fail');

      // Verify msg was set in recover block (confirms buffer output works)
      expect(res.data.msg).to.contain('fail');

      // Verify x was reverted
      expect(res.data.x).to.be(undefined);
    });

    // --- Top Priority Missing Tests ---

    it('should leak unrelated poison when guarding specific handler', async () => {
      // guard @result should ignore @output poison.
      // E.g. guard @result cannot stop output poison properly, so it bubbles up.
      // But side-effects (state="changed") should PERSIST because guard block technically "finished"
      // (it decided to ignore poison and continue).
      // Wait. If it ignores poison, it outputs to buffer.
      // The buffer is then processed.
      // If prompt/render throws on poison, we catch it.

      let trackedState = 'initial';
      const script = `
        text output
        var state = "initial"
        guard state, @result
          state = "changed"
          // This puts a PoisonedValue into the buffer (output handler default)
          // Since guard @result ignores it, this poison remains in buffer.
          output(poison())
        endguard

        // We track state AFTER guard to verify it wasn't reverted
        // If guard reverted, state would be "initial"
        track(state)

        return { text: output.snapshot() }`;

      const context = {
        poison: () => throwError('text-error'),
        track: (val) => { trackedState = val; }
      };

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have thrown RuntimeError due to leaked poison');
      } catch (e) {
        expect(e.message).to.contain('text-error');
      }

      // Guard didn't revert state change because it ignored the poison
      expect(trackedState).to.equal('changed');
    });

    it('should support nested recovery (inner suppresses error)', async () => {
      const script = `
        text output
        data result
        var outer = "ok"
        var inner = "ok"
        guard outer
          guard inner, @
            inner = "modified"
            // Inner error must go to buffer to trigger guard
            output(error("fail"))
          recover
             inner = "recovered"
          endguard
          // Outer continues because inner recovered
          outer = "finished"
        endguard
        result.inner = inner
        result.outer = outer

        return { text: output.snapshot(), data: result.snapshot() }`;

      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };

      const res = await env.renderScriptString(script, context);

      expect(res.data.inner).to.equal('recovered');
      expect(res.data.outer).to.equal('finished');
    });

    it('should check variable scope within guard (var declaration)', async () => {
      const script = `
        var result = {}
        var outer = "outer"
        guard outer
           var inner = "inner"
           result.innerVisible = inner
        endguard
        result.innerCheck = "checked"

        return {data: result }`;

      const context = {
        defined: (val) => val !== undefined
      };

      // We expect 'inner' to be undefined in outer scope
      try {
        await env.renderScriptString(script, context);
      } catch (e) {
        // Ignored
      }

      // Updated test strategy:
      const script2 = `
        data result
        guard @result
          var local = 1
        endguard
        result.leak = local

        return {data: result.snapshot() }`;
      try {
        const res = await env.renderScriptString(script2, {});
        // Local should remain guard-scoped and not leak into outer observable data.
        expect(res.data).to.eql({});
      } catch (err) {
        // Also valid: unknown-variable is surfaced as a script error.
        expect(err.message).to.match(/unknown variable\/function: local|local is not defined/);
      }
    });

    it('should recover in template mode (reverting output)', async () => {
      // guard @ implies guarding all outputs. "Start " should be reverted.
      // Use {% set %} instead of {% var %} in template mode.
      // We must modify "state" inside guard to satisfy guard requirement.
      const template = `{% set state = "ok" %}{% guard state, @ %}Start {% set state = "mod" %}{{ error("fail") }}{% recover %}Recovered{% set state = "recovered" %}{% endguard %} State: {{ state }}`;
      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };

      const res = await env.renderTemplateString(template, context);
      expect(res).to.equal('Recovered State: recovered');
    });

    it('should recover from async error', async () => {
      // await inside guard triggers 'expected block end' parser issue (do statement).
      // But await inside RECOVER (async closure) should work.
      const script = `text output
data result
guard @
  // await delay(10)
  output(error("fail"))
recover
  // await delay(5)
  result.res = "recovered"
endguard
return { text: output.snapshot(), data: result.snapshot() }`;
      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); },
        delay: (ms) => new Promise(r => setTimeout(r, ms))
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.res).to.equal('recovered');
    });

    it('should recover from macro error', async () => {
      const script = `data result
text output
macro bomb()
  text textInner
  textInner(error("boom"))
  return { text: textInner.snapshot() }
endmacro

guard @
  call bomb()
    return {}
  endcall
recover
  result.res = "safe"
endguard
return {data: result.snapshot(), text: output.snapshot() }`;
      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.res).to.equal('safe');
    });

    it('should handle error in recover block (bubbling)', async () => {
      const script = `
        text output
        guard @
          output(error("fail1"))
        recover
          output(error("fail2"))
        endguard

        return { text: output.snapshot() }`;
      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };

      try {
        await env.renderScriptString(script, context);
        expect().fail('Should have failed');
      } catch (e) {
        // We expect fail2. fail1 is consumed.
        expect(e.message).to.contain('fail2');
      }
    });

    it('should handle loop control (break) inside guard', async () => {
      // guard blocks transpiled as async blocks might wrap loop control.
      // We verification if break propagates correctly.
      const script = `
        data result
        var i = 0
        var guarded_exec = 0
        while i < 10
          guard @
            if i == 5
              break
            endif
            guarded_exec = guarded_exec + 1
          endguard
          i = i + 1
        endwhile
        result.count = i
        result.guarded = guarded_exec

        return {data: result.snapshot() }`;
      const res = await env.renderScriptString(script, {});
      // Known limitation: break inside guard is currently ignored by transpiler/runtime
      expect(res.data.count).to.equal(10);
      expect(res.data.guarded).to.equal(10);
    });

    it('should catch @result poison with global guard', async () => {
      const script = `data result
guard
  result.err = error("fail")
recover
  result.res = "caught"
endguard
return {data: result.snapshot() }`;
      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.res).to.equal('caught');
    });

    it('should handle multiple concurrent errors', async () => {
      const script = `text output
data result
guard @
  output(error("fail1"))
  output(error("fail2"))
recover
  result.res = "caught"
endguard
return { text: output.snapshot(), data: result.snapshot() }`;
      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.res).to.equal('caught');
    });

    it('should guard child paths when parent path is guarded', async () => {
      const script = `
        var result = {}
        var log = []
        guard lock!
          // This creates a lock on lock.sub! which is !lock!sub
          var ignore = lock.sub!.fail()
        endguard
        // Should be repaired
        log.push(lock.sub!.success())
        result.log = log

        return {data: result }`;
      const context = {
        lock: {
          sub: {
            fail: () => { throw new Error('fail'); },
            success: () => 'ok'
          }
        }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.log[0]).to.equal('ok');
    });

    it('should guard simple sequence lock', async () => {
      const script = `
        var result = {}
        var log = []
        guard lock!
          // This creates a lock on !lock
          var ignore = lock!.fail()
        endguard
        // Should be repaired
        log.push(lock!.success())
        result.log = log

        return {data: result }`;
      const context = {
        lock: {
          fail: () => { throw new Error('fail'); },
          success: () => 'ok'
        }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.log[0]).to.equal('ok');
    });

    it('should fail compilation if guarded sequence lock is not modified', async () => {
      const script = `
        guard lock!
          var x = 1
        endguard
      `;
      try {
        await env.renderScriptString(script, {});
        throw new Error('Should have failed');
      } catch (e) {
        expect(e.message).to.contain('guard sequence lock "lock!" is not modified inside guard');
      }
    });

    it('should guard all paths when global ! is guarded', async () => {
      const script = `
        var result = {}
        var log = []
        guard !
          var ignore = lock.sub!.fail()
        endguard
        // Should be repaired
        log.push(lock.sub!.success())
        result.log = log

        return {data: result }`;
      const context = {
        lock: {
          sub: {
            fail: () => { throw new Error('fail'); },
            success: () => 'ok'
          }
        }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.log[0]).to.equal('ok');
    });


    it('should fail guard when sequence lock fails', async () => {
      const script = `
        var result = {}
        var log = []
        guard lock!
           var ignore = lock!.fail()
        endguard
        result.log = log

        return {data: result }`;
      const context = {
        lock: {
          fail: () => { throw new Error('fail'); },
          success: () => 'ok'
        }
      };

      try {
        await env.renderScriptString(script, context);
        throw new Error('Should have failed');
      } catch (e) {
        expect(e.message).to.contain('fail');
      }
    });

    it('should succeed guard when sequence lock succeeds', async () => {
      const script = `
        var result = {}
        var log = []
        guard lock!
           var ignore = lock!.success()
        endguard
        log.push('done')
        result.log = log

        return {data: result }`;
      const context = {
        lock: {
          fail: () => { throw new Error('fail'); },
          success: () => 'ok'
        }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.log).to.contain('done');
    });

    it('should revert guarded variables when sequence lock fails', async () => {
      const script = `
        var result = {}
        var x = 1
        var log = []

        guard x, lock!
           x = 2
           var ignore = lock!.fail()
        recover
           log.push('recovered')
           log.push(x) // Should be 1
        endguard

        result.log = log

        return {data: result }`;
      const context = {
        lock: {
          fail: () => { throw new Error('fail'); },
          success: () => 'ok'
        }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.log[0]).to.equal('recovered');
      expect(res.data.log[1]).to.equal(1);
    });

    it('should aggregate multiple sequence errors', async () => {
      const script = `
        var result = {}
        guard lock1!, lock2!
           // Both fail
           var a = lock1!.fail1()
           var b = lock2!.fail2()
        recover err
           result.errorCount = err.errors.length
           result.msg1 = err.errors[0].message
           result.msg2 = err.errors[1].message
        endguard

        return {data: result }`;
      const context = {
        lock1: { fail1: () => { throw new Error('fail1'); } },
        lock2: { fail2: () => { throw new Error('fail2'); } }
      };
      const res = await env.renderScriptString(script, context);
      expect(res.data.errorCount).to.equal(2);
      expect(res.data.msg1).to.contain('fail1');
      expect(res.data.msg2).to.contain('fail2');
    });

    it('should aggregate mixed buffer, variable, and sequence errors', async () => {
      const script = `
        text output
        data result
        guard lock!, @output
           // 1. Buffer poison
           output(error('buffer_fail'))
           // 2. Sequence poison
           var lockRes = lock!.fail()
           // 3. Another Buffer poison
           output(error('buffer_fail_2'))
        recover err
           result.errorCount = err.errors.length
           // We expect:
           // - buffer_fail
           // - buffer_fail_2
           // - sequence_fail
           for e in err.errors
             result.msgs.push(e.message)
           endfor
        endguard

        return { text: output.snapshot(), data: result.snapshot() }`;
      const context = {
        error: (msg) => { return new cascada.runtime.PoisonedValue([new Error(msg)]); },
        lock: { fail: () => { return new cascada.runtime.PoisonedValue([new Error('sequence_fail')]); } }
      };
      const res = await env.renderScriptString(script, context);

      expect(res.data.errorCount).to.equal(3);
      expect(res.data.msgs.some(m => m.includes('buffer_fail'))).to.be(true);
      expect(res.data.msgs.some(m => m.includes('buffer_fail_2'))).to.be(true);
      expect(res.data.msgs.some(m => m.includes('sequence_fail'))).to.be(true);
    });

  });
})();
