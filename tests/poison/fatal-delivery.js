
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {
  CommandBuffer,
  RuntimeError,
  SnapshotCommand,
  TextCommand,
  createRenderState,
  declareBufferChain,
  isPoisonError,
  isRuntimeError,
  runControlFlowBoundary
} from '../../src/runtime/runtime.js';

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

    // Regression guard: fatal delivery belongs to the render state and
    // must not also leak through a structural boundary promise.
    it('a boundary fatal does not also surface as an unhandled rejection (§11.16)', async () => {
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

    it('stops entering later sibling boundaries after fatal state is already reported', async () => {
      const renderState = createRenderState();
      const errorContext = [1, 1, 'Fatal.Sibling', 'fatal-sibling.njk', null, renderState];
      const rootBuffer = new CommandBuffer({}, null, null, null, null, errorContext, null, renderState);
      let laterSiblingStarted = false;

      const result = runControlFlowBoundary(
        rootBuffer,
        null, null,
        {},
        renderState,
        async (outerBuffer) => {
          runControlFlowBoundary(
            outerBuffer,
            null, null,
            {},
            renderState,
            async (siblingBuffer) => {
              RuntimeError.report('sibling fatal', errorContext, siblingBuffer);
            },
            errorContext
          );
          runControlFlowBoundary(
            outerBuffer,
            null, null,
            {},
            renderState,
            async () => {
              laterSiblingStarted = true;
            },
            errorContext
          );
        },
        errorContext
      );

      try {
        await result;
        expect().fail('expected the outer boundary to reject with the reported fatal');
      } catch (err) {
        expect(isRuntimeError(err)).to.be(true);
        expect(err.message).to.contain('sibling fatal');
      }
      expect(laterSiblingStarted).to.be(false);
    });

    it('rejects abandoned observable command promises after fatal stop', async () => {
      const renderState = createRenderState();
      const errorContext = [1, 1, 'Fatal.Observable', 'fatal-observable.njk', null, renderState];
      const rootBuffer = new CommandBuffer({}, null, null, null, null, errorContext, null, renderState);
      declareBufferChain(rootBuffer, 'text', 'text', {}, null);
      const childBuffer = new CommandBuffer({}, rootBuffer, [['text'], ['text']], null, null, errorContext, null, renderState);
      const output = rootBuffer.getChain('text');

      childBuffer.addCommand(new TextCommand({
        chainName: 'text',
        args: ['held-open'],
        errorContext
      }), 'text');
      const snapshotPromise = rootBuffer.addCommand(new SnapshotCommand({
        chainName: 'text',
        errorContext
      }), 'text');

      const fatal = RuntimeError.report('abandon observable', errorContext);
      rootBuffer.addCommand(new TextCommand({
        chainName: 'text',
        args: ['after-fatal'],
        errorContext
      }), 'text');
      childBuffer.finish();
      rootBuffer.finish();

      try {
        await Promise.race([
          snapshotPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for abandoned observable')), 100))
        ]);
        expect().fail('expected abandoned snapshot to reject');
      } catch (err) {
        expect(err).to.be(fatal);
      }
      await output.getFinishedPromise();
    });
  });
})();
