
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {cloneWithAddedContext} from '../../src/runtime/error-context.js';
import {createPoison, isPoison, isPoisonError, PoisonError, RuntimeError} from '../../src/runtime/errors.js';
import {TextCommand} from '../../src/runtime/commands/text.js';
import {VarCommand} from '../../src/runtime/commands/var.js';
import {DataCommand} from '../../src/runtime/commands/data.js';
import {SequenceCallCommand} from '../../src/runtime/commands/sequence.js';
import {SequentialPathWriteCommand} from '../../src/runtime/commands/sequential-path.js';

import {
  Chain,
  TextChain,
  VarChain,
  DataChain,
  SequenceChain,
  inspectTargetForErrors,
  createChain,
} from '../../src/runtime/chains/index.js';

import {CommandBuffer} from '../../src/runtime/command-buffer.js';
import {createArray} from '../../src/runtime/resolve.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const TEST_DIAGNOSTIC_CONTEXT = cloneWithAddedContext(TEST_EC, { branch: 'test' });

function testError(message) {
  return PoisonError.create(message, TEST_EC, 'ValueRejected');
}

describe('chain errors', function () {
  describe('chain commands step2 poison encoding', function () {
    it('propagates RuntimeError instead of degrading it into poison during argument resolution', async () => {
      const output = new TextChain(null, 'text', { path: 'fatal-output.script' }, 'text');
      const fatal = new RuntimeError('fatal command failure', [1, 1, null, 'fatal-output.script', null, null]);
      const cmd = new TextCommand({
        chainName: 'text',
        args: [Promise.reject(fatal)],
        errorContext: TEST_EC
      });

      try {
        await cmd.apply(output);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err).to.be.a(RuntimeError);
        expect(err.message).to.contain('fatal command failure');
      }
    });

    it('reports raw command argument rejections as fatal runtime errors', async () => {
      const output = new TextChain(null, 'text', { path: 'fatal-output.script' }, 'text');
      const raw = new Error('raw command argument failure');
      const cmd = new TextCommand({
        chainName: 'text',
        args: [Promise.reject(raw)],
        errorContext: TEST_EC
      });

      try {
        await cmd.apply(output);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err).to.be.a(RuntimeError);
        expect(err.cause).to.be(raw);
        expect(err.message).to.contain('raw command argument failure');
      }
    });

    it('TextCommand encodes poison into target instead of throwing', () => {
      const output = new TextChain(null, 'text', null, 'text');
      const poison = createPoison(testError('text poison'));
      const cmd = new TextCommand({ chainName: 'text', args: ['ok', poison], errorContext: TEST_EC });

      cmd.apply(output);

      expect(output._target).to.have.length(1);
      expect(isPoison(output._target[0])).to.be(true);
      expect(output._target[0].errors[0].message).to.contain('text poison');
    });

    it('VarCommand poisons target on invalid arity', () => {
      const output = new VarChain(null, 'value', null, 'value');
      const cmd = new VarCommand({ chainName: 'value', args: [1, 2], errorContext: TEST_EC });

      cmd.apply(output);

      expect(isPoison(output._target)).to.be(true);
      expect(output._target.errors[0].message).to.contain('exactly one argument');
    });

    it('DataCommand writes poison to addressed path and allows later repair overwrite', async () => {
      const output = new DataChain(null, 'data', null, 'data');
      const poison = createPoison(testError('data poison'));
      const bad = new DataCommand({
        chainName: 'data',
        operation: 'set',
        args: [['x'], poison],
        errorContext: TEST_EC
      });
      const fix = new DataCommand({
        chainName: 'data',
        operation: 'set',
        args: [['x'], 'ok'],
        errorContext: TEST_EC
      });

      bad.apply(output);
      expect(isPoison(output._target.x)).to.be(true);

      fix.apply(output);
      expect(output._target.x).to.be('ok');

      const snap = await output._resolveSnapshotCommandResult();
      expect(snap.x).to.be('ok');
    });

    it('DataCommand encodes missing-method failure into addressed path', () => {
      const output = new DataChain(null, 'data', null, 'data');
      const cmd = new DataCommand({
        chainName: 'data',
        operation: 'doesNotExist',
        args: [['x'], 1],
        errorContext: TEST_EC
      });

      cmd.apply(output);
      expect(isPoison(output._target.x)).to.be(true);
      expect(output._target.x.errors[0].message).to.contain(`has no method 'doesNotExist'`);
    });

    it('SequenceCallCommand still rejects deferred result when poison args are passed', async () => {
      const sequence = {
        exec() {
          throw new Error('should not run');
        }
      };
      const output = new SequenceChain(null, 'seq', null, sequence);
      const poison = createPoison(testError('arg poison'));
      const cmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'exec',
        args: [poison],
        errorContext: TEST_EC
      });

      try {
        cmd.apply(output);
        await cmd.promise;
        expect().fail('Should have rejected');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('arg poison');
      }
    });
  });

  describe('output target inspection internals', function () {
    it('surfaces RuntimeError through chain inspection without wrapping it as poison', async () => {
      const output = new VarChain(null, 'value', { path: 'fatal-inspection.script' }, 'value');
      const fatal = new RuntimeError('fatal inspection failure', [2, 3, null, 'fatal-inspection.script', null, null]);

      output._recordError(fatal, { errorContext: TEST_EC });

      const result = await output._ensureErrorState();
      expect(result.hasError).to.be(true);
      expect(result.error).to.be.a(RuntimeError);
      expect(result.error.message).to.contain('fatal inspection failure');
    });

    it('collects poison from nested arrays/objects/promises', async () => {
      const target = {
        direct: createPoison(testError('direct poison')),
        nested: [
          Promise.resolve(createPoison(testError('resolved poison'))),
          Promise.reject(testError('rejected promise'))
        ],
        wrapped: Promise.reject(PoisonError.group([testError('poison rejection')]))
      };

      const result = await inspectTargetForErrors(target);

      expect(result.hasError).to.be(true);
      expect(isPoisonError(result.error)).to.be(true);

      const messages = result.error.errors.map((err) => err.message).join(' | ');
      expect(messages).to.contain('direct poison');
      expect(messages).to.contain('resolved poison');
      expect(messages).to.contain('rejected promise');
      expect(messages).to.contain('poison rejection');
    });

    it('collects poison from marker-backed lazy structures', async () => {
      const target = createArray([
        'ok',
        Promise.reject(testError('marker rejection'))
      ]);

      const result = await inspectTargetForErrors(target);

      expect(result.hasError).to.be(true);
      expect(isPoisonError(result.error)).to.be(true);
      expect(result.error.errors[0].message).to.contain('marker rejection');
    });

    it('treats raw promise failures during target inspection as fatal', async () => {
      const raw = new Error('raw inspection failure');

      try {
        await inspectTargetForErrors({ value: Promise.reject(raw) });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err).to.be(raw);
      }
    });

    it('avoids recursion issues on cyclic plain objects', async () => {
      const target = {};
      target.self = target;
      target.err = createPoison(testError('cycle poison'));

      const result = await inspectTargetForErrors(target);
      expect(result.hasError).to.be(true);
      expect(result.error.errors[0].message).to.contain('cycle poison');
    });

    it('caches inspection by state version and invalidates on writes', async () => {
      const output = new Chain(null, null, 'x', null, 'value', 1, null);
      let inspectCalls = 0;
      output._computeTargetErrorState = async () => {
        inspectCalls += 1;
        return { hasError: false, error: null };
      };

      await output._ensureErrorState();
      await output._ensureErrorState();
      expect(inspectCalls).to.be(1);

      output._setTarget(2);
      await output._ensureErrorState();
      expect(inspectCalls).to.be(2);
    });
  });

  describe('sequential path command hardening', function () {
    it('reports raw async sequential operation rejections as fatal runtime errors', async () => {
      const raw = new Error('raw sequential failure');
      const cmd = new SequentialPathWriteCommand({
        chainName: 'db',
        pathKey: 'db',
        operation: () => Promise.reject(raw),
        errorContext: TEST_EC
      });
      const chain = {
        _getSequentialPathPoisonError: () => null,
        _applySequentialPathPoisonError: () => {
          throw new Error('raw failure should not be stored as poison');
        },
        _setSequentialPathLastResult: () => {}
      };

      try {
        await cmd.apply(chain);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err).to.be.a(RuntimeError);
        expect(err.cause).to.be(raw);
        expect(err.message).to.contain('raw sequential failure');
      }
    });
  });

  describe('output observation commands step3', function () {
    it('does not expose observation methods on output facades', async () => {
      const buffer = new CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const out = createChain(buffer, 'out', null, 'data');

      expect(out.snapshot).to.be(undefined);
      expect(out.isError).to.be(undefined);
      expect(out.getError).to.be(undefined);
    });

    it('reports healthy output state after poison is repaired by later overwrite', async () => {
      const env = new AsyncEnvironment();
      const script = `
      data out
      out.x = bad
      out.x = "ok"
      return { has: out.isError(), err: out.getError(), snap: out.snapshot() }
    `;

      const result = await env.renderScriptString(script, {
        bad: createPoison(testError('temporary-fail'))
      });

      expect(result.has).to.be(false);
      expect(result.err).to.be(null);
      expect(result.snap).to.eql({ x: 'ok' });
    });

    it('supports "is error" operator for declared outputs', async () => {
      const env = new AsyncEnvironment();
      const script = `
      data out
      out.x = bad
      return { has: out is error }
    `;

      const result = await env.renderScriptString(script, {
        bad: createPoison(testError('output-fail'))
      });

      expect(result.has).to.be(true);
    });

    it('supports peek operator (#) for declared outputs', async () => {
      const env = new AsyncEnvironment();
      const script = `
      data out
      out.x = bad
      return { msg: out#errors[0].message }
    `;

      const result = await env.renderScriptString(script, {
        bad: createPoison(testError('peek-output-fail'))
      });

      expect(result.msg).to.contain('peek-output-fail');
    });

    it('supports declared output writes with dynamic path segments', async () => {
      const env = new AsyncEnvironment();
      const script = `
      data out
      var key = "k"
      out[key] = 7
      return out.snapshot()
    `;

      const result = await env.renderScriptString(script, {});
      expect(result).to.eql({ k: 7 });
    });

    it('observes errors from a promise resolving to a lazy structure built in script', async () => {
      const env = new AsyncEnvironment();
      const script = `
      data out
      out.items = wrapValue([okValue(), badValue()])
      return { has: out.isError(), err: out.getError().errors[0].message }
    `;

      const result = await env.renderScriptString(script, {
        wrapValue: (val) => Promise.resolve(val),
        okValue: async () => 'ok',
        badValue: async () => {
          throw new Error('wrapped marker rejection');
        }
      });

      expect(result.has).to.be(true);
      expect(result.err).to.contain('wrapped marker rejection');
    });
  });

});
