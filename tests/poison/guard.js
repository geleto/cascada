(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var POISON_SYMBOL = (typeof Symbol !== 'undefined' && Symbol.for)
    ? Symbol.for('cascada.poison')
    : '__cascadaPoisonError';

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  } else {
    expect = window.expect;
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
        {% guard count %}
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
        {% guard count %}
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

    it.skip('should guard and restore sequence locks (postfix !)', async () => {
      const script = `
        guard lock!
          lock! = "acquired"
          lock! = poison()
        endguard
        @data.status = lock!
      `;

      const res = await env.renderScriptString(script, {
        poison: () => fakePoison('boom')
      });
      expect(res.data.status).to.be(undefined);
    });
  });
})();
