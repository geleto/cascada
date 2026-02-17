'use strict';

const expect = require('expect.js');
const { AsyncEnvironment } = require('../src/environment/environment');
const { createPoison } = require('../src/runtime/errors');
const { createOutput, createSinkOutput } = require('../src/runtime/output');

describe('output observation commands step3', function () {
  it('routes data facade snapshot/isError/getError through command buffer APIs', async () => {
    const calls = [];
    const fakeBuffer = {
      addSnapshot(name) {
        calls.push(['snapshot', name]);
        return Promise.resolve({ ok: true });
      },
      addIsError(name) {
        calls.push(['isError', name]);
        return Promise.resolve(false);
      },
      addGetError(name) {
        calls.push(['getError', name]);
        return Promise.resolve(null);
      },
      _registerOutput() {}
    };
    const frame = { _outputBuffer: fakeBuffer };

    const out = createOutput(frame, 'out', null, 'data');
    const snap = await out.snapshot();
    const isErr = await out.isError();
    const err = await out.getError();

    expect(snap).to.eql({ ok: true });
    expect(isErr).to.be(false);
    expect(err).to.be(null);
    expect(calls).to.eql([
      ['snapshot', 'out'],
      ['isError', 'out'],
      ['getError', 'out']
    ]);
  });

  it('routes sink facade repair through command buffer API', async () => {
    const calls = [];
    const fakeBuffer = {
      addSinkRepair(name) {
        calls.push(['repair', name]);
        return Promise.resolve(undefined);
      },
      _registerOutput() {}
    };
    const frame = { _outputBuffer: fakeBuffer };
    const sink = { repair() {} };

    const out = createSinkOutput(frame, 'logger', null, sink);
    await out.repair();

    expect(calls).to.eql([['repair', 'logger']]);
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
});
