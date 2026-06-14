
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {cloneWithAddedContext} from '../../src/runtime/error-context.js';
import {createPoison, isPoison, isPoisonError, isRuntimeError, PoisonError, RuntimeError} from '../../src/runtime/errors.js';
import {TextCommand} from '../../src/runtime/commands/text.js';
import {VarCommand} from '../../src/runtime/commands/var.js';
import {DataCommand} from '../../src/runtime/commands/data.js';
import {SnapshotCommand} from '../../src/runtime/commands/observation.js';
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
  declareBufferChain,
} from '../../src/runtime/chains/index.js';

import {CommandBuffer} from '../../src/runtime/command-buffer.js';
import {createArray, RESOLVE_MARKER, RESOLVED_VALUE_MARKER} from '../../src/runtime/resolve.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const ORIGIN_EC = [9, 9, 'Origin', 'origin.casc', null, null];
const TEST_DIAGNOSTIC_CONTEXT = cloneWithAddedContext(TEST_EC, { branch: 'test' });
const isThenable = (value) => !!(value && typeof value.then === 'function');

function testError(message) {
  return PoisonError.create(message, TEST_EC, 'UserCallThrew');
}

describe('chain errors', function () {
  describe('chain command poison encoding', function () {
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

    it('VarCommand stores the first value without resolving', async () => {
      const output = new VarChain(null, 'value', null, 'value');
      const promised = Promise.resolve(1);
      const cmd = new VarCommand({ chainName: 'value', args: [promised, 2], errorContext: TEST_EC });

      cmd.apply(output);

      expect(output._target).to.be(promised);
      expect(await output._target).to.be(1);

      new VarCommand({
        chainName: 'value',
        args: [3, createPoison(testError('ignored extra arg'))],
        errorContext: TEST_EC
      }).apply(output);

      expect(output._target).to.be(3);
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
      expect(output._target.x.errors[0].kind).to.be('MissingFunction');
      expect(output._target.x.errors[0].message).to.contain('Unable to call `doesNotExist`, which is undefined');
    });

    it('DataCommand encodes method failures as user call poison', () => {
      const output = new DataChain(null, 'data', null, 'data');
      output._base.fail = () => {
        throw new Error('data method failed');
      };
      const cmd = new DataCommand({
        chainName: 'data',
        operation: 'fail',
        args: [['x']],
        errorContext: TEST_EC
      });

      cmd.apply(output);
      expect(isPoison(output._target.x)).to.be(true);
      expect(output._target.x.errors[0].kind).to.be('UserCallThrew');
      expect(output._target.x.errors[0].message).to.contain('data method failed');
    });

    it('DataCommand reports async method returns as fatal runtime errors', async () => {
      const output = new DataChain(null, 'data', null, 'data');
      output._base.addMethod('asyncSet', async (_target, value) => value);
      const cmd = new DataCommand({
        chainName: 'data',
        operation: 'asyncSet',
        args: [['x'], 'ok'],
        errorContext: TEST_EC
      });

      try {
        cmd.apply(output);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isRuntimeError(err)).to.be(true);
        expect(err.message).to.contain('Data chain methods must return synchronously resolved values.');
      }
      expect(output._target.x).to.be(undefined);
      await Promise.resolve();
    });

    it('TextCommand text.set accepts multiple text arguments', () => {
      const output = new TextChain(null, 'text', null, 'text');
      const cmd = new TextCommand({
        chainName: 'text',
        operation: 'set',
        args: ['A', 1, 'B', 2],
        errorContext: TEST_EC
      });

      cmd.apply(output);

      expect(output._target.join('')).to.be('A1B2');

      new TextCommand({
        chainName: 'text',
        operation: 'set',
        args: [],
        errorContext: TEST_EC
      }).apply(output);

      expect(output._target.join('')).to.be('');
    });

    it('TextCommand uses specific poison kinds for unsupported operations and invalid values', async () => {
      const unsupported = new TextChain(null, 'text', null, 'text');
      new TextCommand({
        chainName: 'text',
        operation: 'weird',
        args: [],
        errorContext: TEST_EC
      }).apply(unsupported);
      expect(isPoison(unsupported._target)).to.be(true);
      expect(unsupported._target.errors[0].kind).to.be('MissingFunction');

      const invalid = new TextChain(null, 'text', null, 'text');
      const cmd = new TextCommand({
        chainName: 'text',
        args: [{ wrapped: true }],
        errorContext: TEST_EC
      });

      try {
        cmd.apply(invalid);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].kind).to.be('InvalidTextValue');
        invalid._recordError(err, cmd);
      }
      expect(isPoison(invalid._target[0])).to.be(true);
      expect(invalid._target[0].errors[0].kind).to.be('InvalidTextValue');
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

    it('SequenceCallCommand classifies null target and method failures', async () => {
      const missingTarget = new SequenceChain(null, 'seq', null, null);
      const nullCmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'exec',
        args: [],
        path: ['nested'],
        errorContext: TEST_EC
      });

      try {
        nullCmd.apply(missingTarget);
        await nullCmd.promise;
        expect().fail('Should have rejected');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('NullLookup');
      }

      const badMethods = new SequenceChain(null, 'seq', null, { missing: undefined, bad: 1 });
      const missingCmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'missing',
        args: [],
        errorContext: TEST_EC
      });
      const badCmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'bad',
        args: [],
        errorContext: TEST_EC
      });

      expect(() => missingCmd.apply(badMethods)).to.throwException((err) => {
        expect(isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('MissingFunction');
      });
      expect(() => badCmd.apply(badMethods)).to.throwException((err) => {
        expect(isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('NotAFunction');
      });
    });

    it('SequenceCallCommand classifies method throws locally', async () => {
      const output = new SequenceChain(null, 'seq', null, {
        fail() {
          throw new Error('sequence failed');
        },
        async failAsync() {
          throw new Error('sequence async failed');
        }
      });

      const syncCmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'fail',
        args: [],
        errorContext: TEST_EC
      });
      expect(() => syncCmd.apply(output)).to.throwException((err) => {
        expect(isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('UserCallThrew');
        expect(err.message).to.contain('sequence failed');
      });

      const asyncCmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'failAsync',
        args: [],
        errorContext: TEST_EC
      });
      try {
        await asyncCmd.apply(output);
        expect().fail('Should have rejected');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('UserCallThrew');
        expect(err.message).to.contain('sequence async failed');
      }
    });

    it('SequenceCallCommand preserves existing poison origin from method failures', async () => {
      const originError = PoisonError.create('sequence origin failure', ORIGIN_EC, 'LookupThrew');
      const output = new SequenceChain(null, 'seq', null, {
        failPoison() {
          throw originError;
        },
        async failPoisonAsync() {
          throw originError;
        }
      });

      const syncCmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'failPoison',
        args: [],
        errorContext: TEST_EC
      });
      expect(() => syncCmd.apply(output)).to.throwException((err) => {
        expect(err).to.be(originError);
        expect(err.context.label).to.be('Origin');
      });

      const asyncCmd = new SequenceCallCommand({
        chainName: 'seq',
        methodName: 'failPoisonAsync',
        args: [],
        errorContext: TEST_EC
      });
      try {
        await asyncCmd.apply(output);
        expect().fail('Should have rejected');
      } catch (err) {
        expect(err).to.be(originError);
        expect(err.context.label).to.be('Origin');
      }
    });
  });

  describe('output target inspection internals', function () {
    it('surfaces RuntimeError through chain inspection without wrapping it as poison', async () => {
      const output = new VarChain(null, 'value', { path: 'fatal-inspection.script' }, 'value');
      const fatal = new RuntimeError('fatal inspection failure', [2, 3, null, 'fatal-inspection.script', null, null]);

      output._recordError(fatal, { errorContext: TEST_EC });

      const result = await output._ensureErrorState();
      expect(result).to.be.a(RuntimeError);
      expect(result.message).to.contain('fatal inspection failure');
    });

    it('inspects all-sync targets without returning a thenable', () => {
      const healthy = inspectTargetForErrors({ nested: ['ok', { count: 1 }] });
      expect(isThenable(healthy)).to.be(false);
      expect(healthy).to.be(null);

      const poisoned = inspectTargetForErrors({
        nested: [createPoison(testError('sync nested poison'))]
      });
      expect(isThenable(poisoned)).to.be(false);
      expect(isPoisonError(poisoned)).to.be(true);
      expect(poisoned.errors[0].message).to.contain('sync nested poison');
    });

    it('unwraps resolved-value wrappers without entering the async path', () => {
      let thenCalled = false;
      const wrapped = {
        value: createPoison(testError('wrapped sync poison')),
        [RESOLVED_VALUE_MARKER]: true,
        then() {
          thenCalled = true;
          throw new Error('should not assimilate resolved-value wrapper');
        }
      };

      const result = inspectTargetForErrors(wrapped);

      expect(isThenable(result)).to.be(false);
      expect(isPoisonError(result)).to.be(true);
      expect(result.errors[0].message).to.contain('wrapped sync poison');
      expect(thenCalled).to.be(false);
    });

    it('returns sync observations for clean and poisoned completed var chains', () => {
      const clean = new VarChain(null, 'value', null, 'var', 'ok');
      clean._resolveIteratorCompletion();

      const cleanIsError = clean._isError();
      const cleanErrors = clean._getErrors();
      expect(isThenable(cleanIsError)).to.be(false);
      expect(isThenable(cleanErrors)).to.be(false);
      expect(cleanIsError).to.be(false);
      expect(cleanErrors).to.be(null);

      const poisoned = new VarChain(null, 'value', null, 'var', createPoison(testError('completed sync poison')));
      poisoned._resolveIteratorCompletion();

      const poisonedIsError = poisoned._isError();
      const poisonedErrors = poisoned._getErrors();
      expect(isThenable(poisonedIsError)).to.be(false);
      expect(isThenable(poisonedErrors)).to.be(false);
      expect(poisonedIsError).to.be(true);
      expect(isPoisonError(poisonedErrors)).to.be(true);
      expect(poisonedErrors.errors[0].message).to.contain('completed sync poison');
    });

    it('returns completed healthy final snapshots synchronously', () => {
      const output = new VarChain(null, 'value', null, 'var', 'ready');
      output._resolveIteratorCompletion();

      const result = output.finalSnapshot();

      expect(isThenable(result)).to.be(false);
      expect(result).to.be('ready');
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

      const inspection = inspectTargetForErrors(target);
      expect(isThenable(inspection)).to.be(true);
      const result = await inspection;

      expect(isPoisonError(result)).to.be(true);

      const messages = result.errors.map((err) => err.message).join(' | ');
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

      expect(isPoisonError(result)).to.be(true);
      expect(result.errors[0].message).to.contain('marker rejection');
    });

    it('revisits marker-backed structures after successful marker resolution', async () => {
      const target = {
        nested: createPoison(testError('resolved marker leaf poison'))
      };
      Object.defineProperty(target, RESOLVE_MARKER, {
        value: Promise.resolve(),
        configurable: true
      });

      const result = await inspectTargetForErrors(target);

      expect(isPoisonError(result)).to.be(true);
      expect(result.errors[0].message).to.contain('resolved marker leaf poison');
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

    it('drains nested pending inspections before throwing a fatal error', async () => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const fastFatal = new Error('fast inspection fatal');
      const nestedFatal = new Error('nested inspection fatal');
      const unhandled = [];
      const onUnhandled = (reason) => {
        unhandled.push(reason);
      };

      process.on('unhandledRejection', onUnhandled);
      try {
        try {
          await inspectTargetForErrors({
            fast: Promise.reject(fastFatal),
            nested: pause(1).then(() => [
              pause(5).then(() => {
                throw nestedFatal;
              })
            ])
          });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err).to.be(fastFatal);
        }

        await pause(20);
        expect(unhandled).to.eql([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('reports unexpected raw command apply failures as fatal runtime errors', () => {
      const output = new VarChain(null, 'value', null, 'value');
      const raw = new Error('unexpected command failure');

      expect(() => output._recordError(raw, { errorContext: TEST_EC })).to.throwException((err) => {
        expect(err).to.be.a(RuntimeError);
        expect(err.cause).to.be(raw);
        expect(err.message).to.contain('unexpected command failure');
      });
    });

    it('reports unexpected raw command apply failures through buffer iteration', async () => {
      const buffer = new CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const output = declareBufferChain(buffer, 'value', 'var', null, null);
      const raw = new Error('unexpected iterator command failure');

      try {
        buffer.addCommand({
          chainName: 'value',
          errorContext: TEST_EC,
          apply() {
            throw raw;
          }
        });
        buffer.finish();
        await output.finalSnapshot();
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err).to.be.a(RuntimeError);
        expect(err.cause).to.be(raw);
        expect(err.message).to.contain('unexpected iterator command failure');
      }
    });

    it('avoids recursion issues on cyclic plain objects', async () => {
      const target = {};
      target.self = target;
      target.err = createPoison(testError('cycle poison'));

      const result = await inspectTargetForErrors(target);
      expect(result.errors[0].message).to.contain('cycle poison');
    });

    it('caches inspection by state version and invalidates on writes', async () => {
      const output = new Chain(null, null, 'x', null, 'value', 1, null);
      let inspectCalls = 0;
      output._computeTargetErrorState = async () => {
        inspectCalls += 1;
        return null;
      };

      await output._ensureErrorState();
      await output._ensureErrorState();
      expect(inspectCalls).to.be(1);

      output._setTarget(2);
      await output._ensureErrorState();
      expect(inspectCalls).to.be(2);
    });

    it('does not cache an async inspection result under a newer state version', async () => {
      const output = new Chain(null, 'value', null, 'var', 'old', null);
      let resolveInspection;
      const inspectedTargets = [];

      output._computeTargetErrorState = async (target) => {
        inspectedTargets.push(target);
        await new Promise((resolve) => {
          resolveInspection = resolve;
        });
        return null;
      };

      const firstInspection = output._ensureErrorState();
      output._setTarget('new');
      resolveInspection();

      await firstInspection;
      expect(output._errorStateCache.version).to.be(-1);
      expect(inspectedTargets).to.eql(['old']);

      output._computeTargetErrorState = async (target) => {
        inspectedTargets.push(target);
        return null;
      };
      await output._ensureErrorState();

      expect(output._errorStateCache.version).to.be(output._stateVersion);
      expect(inspectedTargets).to.eql(['old', 'new']);
    });
  });

  describe('sequential path command hardening', function () {
    it('reports raw sync sequential operation throws as fatal runtime errors', () => {
      const raw = new Error('raw sequential sync failure');
      const cmd = new SequentialPathWriteCommand({
        chainName: 'db',
        pathKey: 'db',
        operation: () => {
          throw raw;
        },
        errorContext: TEST_EC
      });
      const chain = {
        _getSequentialPathPoisonError: () => null,
        _applySequentialPathPoisonError: () => {
          throw new Error('raw failure should not be stored as poison');
        },
        _setSequentialPathLastResult: () => {}
      };

      expect(() => cmd.apply(chain)).to.throwException((err) => {
        expect(err).to.be.a(RuntimeError);
        expect(err.cause).to.be(raw);
        expect(err.message).to.contain('raw sequential sync failure');
      });
    });

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

  describe('output observation commands', function () {
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

    it('lets var observations capture immediately without waiting for immutable promised target', async () => {
      const buffer = new CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const out = declareBufferChain(buffer, 'value', 'var', null, null);
      let resolveOld;
      const oldValue = new Promise((resolve) => {
        resolveOld = resolve;
      });

      buffer.addCommand(new VarCommand({
        chainName: 'value',
        args: [oldValue],
        errorContext: TEST_EC
      }), 'value');
      const snap = buffer.addCommand(new SnapshotCommand({
        chainName: 'value',
        errorContext: TEST_EC
      }), 'value');
      buffer.addCommand(new VarCommand({
        chainName: 'value',
        args: ['new'],
        errorContext: TEST_EC
      }), 'value');
      buffer.finish();

      await Promise.resolve();
      expect(out._target).to.be('new');

      resolveOld('old');
      expect(await snap).to.be('old');
      expect(await out.finalSnapshot()).to.be('new');
    });

    it('captures data snapshots before later copy-on-write mutations', async () => {
      const buffer = new CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const out = declareBufferChain(buffer, 'data', 'data', null, null);

      buffer.addCommand(new DataCommand({
        chainName: 'data',
        operation: 'set',
        args: [['x'], 1],
        errorContext: TEST_EC
      }), 'data');
      const snap = buffer.addCommand(new SnapshotCommand({
        chainName: 'data',
        errorContext: TEST_EC
      }), 'data');
      buffer.addCommand(new DataCommand({
        chainName: 'data',
        operation: 'set',
        args: [['x'], 2],
        errorContext: TEST_EC
      }), 'data');
      buffer.finish();

      expect(await snap).to.eql({ x: 1 });
      expect(await out.finalSnapshot()).to.eql({ x: 2 });
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
