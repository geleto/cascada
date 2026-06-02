
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {isPoisonError, isRuntimeError} from '../../src/runtime/runtime.js';

// Coverage for two findings from docs/code/error-handling-analysis.md §11:
//  - Q1: parallel/limited loops collect ALL iteration errors, deterministically.
//  - §11.16: a boundary fatal must not ALSO surface as an unhandled rejection.
(function () {
  describe('Loop error completeness and fatal delivery', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    function failingItems() {
      return [
        { async f() { throw new Error('iter-err-1'); } },
        { async f() { throw new Error('iter-err-2'); } },
        { async f() { throw new Error('iter-err-3'); } },
        { async f() { throw new Error('iter-err-4'); } },
      ];
    }

    // Q1: value/poison errors accumulate on the body chain (source-ordered), so a
    // loop with several failing iterations surfaces every error, identically every
    // run — regardless of concurrency mode or scheduling races.
    async function collectLoopErrors(tpl, runs) {
      const messages = [];
      for (let i = 0; i < runs; i++) {
        try {
          await env.renderTemplateString(tpl, { getItems: failingItems });
          expect().fail('expected the loop to produce poison');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          messages.push(err.message);
        }
      }
      return messages;
    }

    it('unbounded parallel loop collects all iteration errors, deterministically', async () => {
      const messages = await collectLoopErrors('{% for it in getItems() %}{{ it.f() }}{% endfor %}', 6);
      for (const message of messages) {
        ['iter-err-1', 'iter-err-2', 'iter-err-3', 'iter-err-4'].forEach((needle) => {
          expect(message).to.contain(needle);
        });
      }
      expect(messages.every((m) => m === messages[0])).to.be(true);
    });

    it('limited-concurrency loop (of N) collects all iteration errors, deterministically', async () => {
      const messages = await collectLoopErrors('{% for it in getItems() of 2 %}{{ it.f() }}{% endfor %}', 6);
      for (const message of messages) {
        ['iter-err-1', 'iter-err-2', 'iter-err-3', 'iter-err-4'].forEach((needle) => {
          expect(message).to.contain(needle);
        });
      }
      expect(messages.every((m) => m === messages[0])).to.be(true);
    });

    // §11.16 (known bug): the render rejects with the fatal correctly, but the loop
    // boundary's own promise also rejects with the same error and is unobserved,
    // surfacing as an unhandled rejection. Un-skip once §11.16 is fixed.
    it.skip('a boundary fatal does not also surface as an unhandled rejection (§11.16)', async () => {
      const seen = [];
      const onUnhandled = (err) => seen.push(err);
      process.on('unhandledRejection', onUnhandled);
      try {
        // Object iteration with a single loop variable -> RuntimeError from the loop boundary.
        await env.renderTemplateString('{% for x in obj %}{{ x }}{% endfor %}', { obj: { a: 1, b: 2 } });
        expect().fail('expected a fatal RuntimeError');
      } catch (err) {
        expect(isRuntimeError(err)).to.be(true);
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 30));
        process.removeListener('unhandledRejection', onUnhandled);
      }
      expect(seen.length).to.be(0);
    });
  });
})();
