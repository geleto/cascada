(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
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
  });
})();
