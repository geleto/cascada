(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let isPoison;
  let AsyncFrame;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime/runtime');
    createPoison = runtime.createPoison;
    isPoison = runtime.isPoison;
    AsyncFrame = runtime.AsyncFrame;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    AsyncFrame = nunjucks.runtime.AsyncFrame;
  }

  describe('Frame Poison Handling', () => {
    it('stores poison values correctly in frame variables', () => {
      const frame = new AsyncFrame();
      const poison = createPoison(new Error('Test error'));

      frame.set('myVar', poison, true);
      const retrieved = frame.lookup('myVar');

      expect(isPoison(retrieved)).to.be(true);
      expect(retrieved).to.equal(poison);
    });

    it('stores explicit poison assignment in child async frame', () => {
      const parentFrame = new AsyncFrame();
      const asyncFrame = parentFrame.pushAsyncBlock();
      const poison = createPoison(new Error('Async error'));

      asyncFrame.set('myVar', poison, true);
      expect(isPoison(asyncFrame.lookup('myVar'))).to.be(true);
      expect(parentFrame.lookup('myVar')).to.be(undefined);
    });

    it('stores independent poison assignments on different frame variables', () => {
      const frame = new AsyncFrame();
      const poison1 = createPoison(new Error('Error 1'));
      const poison2 = createPoison(new Error('Error 2'));

      frame.set('var1', poison1, true);
      frame.set('var2', poison2, true);

      const result1 = frame.lookup('var1');
      const result2 = frame.lookup('var2');
      expect(isPoison(result1)).to.be(true);
      expect(isPoison(result2)).to.be(true);
      expect(result1).to.equal(poison1);
      expect(result2).to.equal(poison2);
    });
  });
})();
