'use strict';

const expect = require('expect.js');
const { createCommandBuffer } = require('../src/runtime/command-buffer');
const { TargetPoisonCommand } = require('../src/runtime/commands');
const { RuntimeFatalError } = require('../src/runtime/errors');

describe('output commands step5 async slot fill', function () {
  it('encodes non-fatal async producer rejections as TargetPoisonCommand', async () => {
    const buffer = createCommandBuffer({ path: 'test.njk' }, null);

    const slot = await buffer.addAsyncArgsCommand('text', Promise.reject(new Error('slot-fail')));

    expect(slot).to.be(0);
    expect(buffer.arrays.text).to.have.length(1);
    expect(buffer.arrays.text[0] instanceof TargetPoisonCommand).to.be(true);
    expect(buffer.arrays.text[0].errors[0].message).to.contain('slot-fail');
  });

  it('propagates RuntimeFatalError and invokes onFatal callback', async () => {
    const buffer = createCommandBuffer({ path: 'test.njk' }, null);
    const fatal = new RuntimeFatalError('fatal-slot-fail', 1, 1, 'slot', 'test.njk');
    let observedFatal = null;

    try {
      await buffer.addAsyncArgsCommand('text', Promise.reject(fatal), (err) => {
        observedFatal = err;
      });
      expect().fail('Expected RuntimeFatalError');
    } catch (err) {
      expect(err).to.be(fatal);
    }

    expect(observedFatal).to.be(fatal);
  });
});
