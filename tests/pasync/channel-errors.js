'use strict';

import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment';
import {createPoison, isPoison, isPoisonError, PoisonError, RuntimeFatalError} from '../../src/runtime/errors';
import {TextCommand} from '../../src/runtime/channels/text';
import {VarCommand} from '../../src/runtime/channels/var';
import {DataCommand} from '../../src/runtime/channels/data';
import {SequenceCallCommand} from '../../src/runtime/channels/sequence';

import {
  Channel,
  TextChannel,
  VarChannel,
  DataChannel,
  SequenceChannel,
  inspectTargetForErrors,
  createChannel,
} from '../../src/runtime/channels';

import {createCommandBuffer} from '../../src/runtime/command-buffer';
import {createArray} from '../../src/runtime/resolve';
describe('channel errors', function () {
  describe('channel commands step2 poison encoding', function () {
    it('propagates RuntimeFatalError instead of degrading it into poison during argument resolution', async () => {
      const output = new TextChannel(null, 'text', { path: 'fatal-output.script' }, 'text');
      const fatal = new RuntimeFatalError('fatal command failure', 1, 1, null, 'fatal-output.script');
      const cmd = new TextCommand({
        channelName: 'text',
        args: [Promise.reject(fatal)],
        pos: { lineno: 1, colno: 1 }
      });

      try {
        await cmd.apply(output);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err).to.be.a(RuntimeFatalError);
        expect(err.message).to.contain('fatal command failure');
      }
    });

    it('TextCommand encodes poison into target instead of throwing', () => {
      const output = new TextChannel(null, 'text', null, 'text');
      const poison = createPoison([new Error('text poison')]);
      const cmd = new TextCommand({ channelName: 'text', args: ['ok', poison], pos: { lineno: 1, colno: 1 } });

      cmd.apply(output);

      expect(output._target).to.have.length(1);
      expect(isPoison(output._target[0])).to.be(true);
      expect(output._target[0].errors[0].message).to.contain('text poison');
    });

    it('VarCommand poisons target on invalid arity', () => {
      const output = new VarChannel(null, 'value', null, 'value');
      const cmd = new VarCommand({ channelName: 'value', args: [1, 2], pos: { lineno: 1, colno: 1 } });

      cmd.apply(output);

      expect(isPoison(output._target)).to.be(true);
      expect(output._target.errors[0].message).to.contain('exactly one argument');
    });

    it('DataCommand writes poison to addressed path and allows later repair overwrite', async () => {
      const output = new DataChannel(null, 'data', null, 'data');
      const poison = createPoison([new Error('data poison')]);
      const bad = new DataCommand({
        channelName: 'data',
        command: 'set',
        args: [['x'], poison],
        pos: { lineno: 1, colno: 1 }
      });
      const fix = new DataCommand({
        channelName: 'data',
        command: 'set',
        args: [['x'], 'ok'],
        pos: { lineno: 2, colno: 1 }
      });

      bad.apply(output);
      expect(isPoison(output._target.x)).to.be(true);

      fix.apply(output);
      expect(output._target.x).to.be('ok');

      const snap = await output._resolveSnapshotCommandResult();
      expect(snap.x).to.be('ok');
    });

    it('DataCommand encodes missing-method failure into addressed path', () => {
      const output = new DataChannel(null, 'data', null, 'data');
      const cmd = new DataCommand({
        channelName: 'data',
        command: 'doesNotExist',
        args: [['x'], 1],
        pos: { lineno: 1, colno: 1 }
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
      const output = new SequenceChannel(null, 'seq', null, sequence);
      const poison = createPoison([new Error('arg poison')]);
      const cmd = new SequenceCallCommand({
        channelName: 'seq',
        command: 'exec',
        args: [poison],
        withDeferredResult: true
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
    it('surfaces RuntimeFatalError through channel inspection without wrapping it as poison', async () => {
      const output = new VarChannel(null, 'value', { path: 'fatal-inspection.script' }, 'value');
      const fatal = new RuntimeFatalError('fatal inspection failure', 2, 3, null, 'fatal-inspection.script');

      output._recordError(fatal, { pos: { lineno: 2, colno: 3 } });

      const result = await output._ensureErrorState();
      expect(result.hasError).to.be(true);
      expect(result.error).to.be.a(RuntimeFatalError);
      expect(result.error.message).to.contain('fatal inspection failure');
    });

    it('collects poison from nested arrays/objects/promises', async () => {
      const target = {
        direct: createPoison([new Error('direct poison')]),
        nested: [
          Promise.resolve(createPoison([new Error('resolved poison')])),
          Promise.reject(new Error('rejected promise'))
        ],
        wrapped: Promise.reject(new PoisonError([new Error('poison rejection')]))
      };

      const result = await inspectTargetForErrors(target);

      expect(result.hasError).to.be(true);
      expect(result.error).to.be.a(PoisonError);

      const messages = result.error.errors.map((err) => err.message).join(' | ');
      expect(messages).to.contain('direct poison');
      expect(messages).to.contain('resolved poison');
      expect(messages).to.contain('rejected promise');
      expect(messages).to.contain('poison rejection');
    });

    it('collects poison from marker-backed lazy structures', async () => {
      const target = createArray([
        'ok',
        Promise.reject(new Error('marker rejection'))
      ]);

      const result = await inspectTargetForErrors(target);

      expect(result.hasError).to.be(true);
      expect(result.error).to.be.a(PoisonError);
      expect(result.error.errors[0].message).to.contain('marker rejection');
    });

    it('avoids recursion issues on cyclic plain objects', async () => {
      const target = {};
      target.self = target;
      target.err = createPoison([new Error('cycle poison')]);

      const result = await inspectTargetForErrors(target);
      expect(result.hasError).to.be(true);
      expect(result.error.errors[0].message).to.contain('cycle poison');
    });

    it('caches inspection by state version and invalidates on writes', async () => {
      const output = new Channel(null, null, 'x', null, 'value', 1, null);
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

  describe('output observation commands step3', function () {
    it('does not expose observation methods on output facades', async () => {
      const buffer = createCommandBuffer(null);
      const out = createChannel(buffer, 'out', null, 'data');

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
        bad: createPoison([new Error('temporary-fail')])
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
        bad: createPoison([new Error('output-fail')])
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
        bad: createPoison([new Error('peek-output-fail')])
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
