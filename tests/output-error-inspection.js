'use strict';

const expect = require('expect.js');
const { createPoison, PoisonError } = require('../src/runtime/errors');
const { Output, inspectTargetForErrors } = require('../src/runtime/output');

describe('output target inspection internals', function () {
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

  it('avoids recursion issues on cyclic plain objects', async () => {
    const target = {};
    target.self = target;
    target.err = createPoison([new Error('cycle poison')]);

    const result = await inspectTargetForErrors(target);
    expect(result.hasError).to.be(true);
    expect(result.error.errors[0].message).to.contain('cycle poison');
  });

  it('caches inspection by state version and invalidates on writes', async () => {
    const output = new Output(null, 'x', null, 'value', 1, null);
    let inspectCalls = 0;
    output._inspectTargetForErrors = async () => {
      inspectCalls += 1;
      return { hasError: false, error: null };
    };

    await output._ensureInspection();
    await output._ensureInspection();
    expect(inspectCalls).to.be(1);

    output._setTarget(2);
    await output._ensureInspection();
    expect(inspectCalls).to.be(2);
  });
});
