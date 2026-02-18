'use strict';

const expect = require('expect.js');
const { AsyncEnvironment } = require('../src/environment/environment');
const { createPoison } = require('../src/runtime/errors');
const { createOutput, createSinkOutput } = require('../src/runtime/output');

describe('output observation commands step3', function () {
  it('does not expose observation methods on output facades', async () => {
    const fakeBuffer = { _registerOutput() {} };
    const frame = { _outputBuffer: fakeBuffer };
    const out = createOutput(frame, 'out', null, 'data');

    expect(out.snapshot).to.be(undefined);
    expect(out.isError).to.be(undefined);
    expect(out.getError).to.be(undefined);
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

    expect(result.msg).to.be('peek-output-fail');
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
});
