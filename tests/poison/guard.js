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
  });
})();
