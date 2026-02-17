'use strict';

const expect = require('expect.js');
const { createPoison, isPoison, isPoisonError } = require('../src/runtime/errors');
const {
  TextCommand,
  ValueCommand,
  DataCommand,
  SinkCommand
} = require('../src/runtime/commands');
const { TextOutput, ValueOutput, DataOutput, SinkOutput } = require('../src/runtime/output');

describe('output commands step2 poison encoding', function () {
  it('TextCommand encodes poison into target instead of throwing', () => {
    const output = new TextOutput(null, 'text', null, 'text');
    const poison = createPoison([new Error('text poison')]);
    const cmd = new TextCommand({ handler: 'text', args: ['ok', poison], pos: { lineno: 1, colno: 1 } });

    cmd.apply(output);

    expect(output._target).to.have.length(1);
    expect(isPoison(output._target[0])).to.be(true);
    expect(output._target[0].errors[0].message).to.contain('text poison');
  });

  it('ValueCommand poisons target on invalid arity', () => {
    const output = new ValueOutput(null, 'value', null, 'value');
    const cmd = new ValueCommand({ handler: 'value', args: [1, 2], pos: { lineno: 1, colno: 1 } });

    cmd.apply(output);

    expect(isPoison(output._target)).to.be(true);
    expect(output._target.errors[0].message).to.contain('exactly one argument');
  });

  it('DataCommand writes poison to addressed path and allows later repair overwrite', async () => {
    const output = new DataOutput(null, 'data', null, 'data');
    const poison = createPoison([new Error('data poison')]);
    const bad = new DataCommand({
      handler: 'data',
      command: 'set',
      args: [['x'], poison],
      pos: { lineno: 1, colno: 1 }
    });
    const fix = new DataCommand({
      handler: 'data',
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
    const output = new DataOutput(null, 'data', null, 'data');
    const cmd = new DataCommand({
      handler: 'data',
      command: 'doesNotExist',
      args: [['x'], 1],
      pos: { lineno: 1, colno: 1 }
    });

    cmd.apply(output);
    expect(isPoison(output._target.x)).to.be(true);
    expect(output._target.x.errors[0].message).to.contain("has no method 'doesNotExist'");
  });

  it('SinkCommand poisons target on failure, skips while poisoned, and repairs via repair()', async () => {
    const calls = [];
    const sink = {
      write(value) {
        if (value === 'boom') {
          throw new Error('sink failed');
        }
        calls.push(value);
      },
      repair() {
        calls.push('repair');
      },
      snapshot() {
        return calls.slice();
      }
    };

    const output = new SinkOutput(null, 'logger', null, sink);

    await new SinkCommand({ handler: 'logger', command: 'write', args: ['ok'] }).apply(output);
    await new SinkCommand({ handler: 'logger', command: 'write', args: ['boom'] }).apply(output);
    expect(isPoison(output._target)).to.be(true);

    await new SinkCommand({ handler: 'logger', command: 'write', args: ['skipped'] }).apply(output);
    expect(calls).to.eql(['ok']);

    await new SinkCommand({ handler: 'logger', command: 'repair', args: [] }).apply(output);
    expect(output._target).to.be(undefined);
    expect(calls).to.eql(['ok', 'repair']);

    await new SinkCommand({ handler: 'logger', command: 'write', args: ['after'] }).apply(output);
    expect(calls).to.eql(['ok', 'repair', 'after']);
  });

  it('SequenceCallCommand still rejects deferred result when poison args are passed', async () => {
    const sink = {
      exec() {
        throw new Error('should not run');
      }
    };
    const output = new SinkOutput(null, 'seq', null, sink);
    const poison = createPoison([new Error('arg poison')]);
    const { SequenceCallCommand } = require('../src/runtime/commands');
    const cmd = new SequenceCallCommand({
      handler: 'seq',
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
