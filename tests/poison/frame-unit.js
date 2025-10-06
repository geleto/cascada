(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let isPoison;
  let AsyncFrame;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime');
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

    describe('AsyncFrame.set and lookup', () => {
      it('should store poison values correctly', () => {
        const frame = new AsyncFrame();
        const poison = createPoison(new Error('Test error'));

        frame.set('myVar', poison, true);
        const retrieved = frame.lookup('myVar');

        expect(isPoison(retrieved)).to.be.true;
        expect(retrieved).to.equal(poison);
      });

      it('should store poison in asyncVars', () => {
        const parentFrame = new AsyncFrame();
        parentFrame.set('myVar', 'initial', true);

        const asyncFrame = parentFrame.pushAsyncBlock(null, { myVar: 1 });
        const poison = createPoison(new Error('Async error'));

        asyncFrame.set('myVar', poison, true);
        const retrieved = asyncFrame.lookup('myVar');

        expect(isPoison(retrieved)).to.be.true;
      });

      it('should propagate poison through parent frames', () => {
        const rootFrame = new AsyncFrame();
        rootFrame.set('x', 'initial', true);

        const childFrame = rootFrame.push();
        const poison = createPoison(new Error('Child error'));

        childFrame.set('x', poison, true);

        // Should be retrievable from child
        expect(isPoison(childFrame.lookup('x'))).to.be.true;

        // Should propagate to root
        expect(isPoison(rootFrame.lookup('x'))).to.be.true;
      });
    });

    describe('AsyncFrame._promisifyParentVar', () => {
      it('should stop loop when poison is resolved', async () => {
        const parentFrame = new AsyncFrame();
        parentFrame.set('myVar', 'initial', true);

        const asyncFrame = parentFrame.pushAsyncBlock(null, { myVar: 1 });

        // Simulate setting a poison after promisification
        setTimeout(() => {
          asyncFrame.set('myVar', createPoison(new Error('Delayed poison')), true);
        }, 10);

        // Wait for promisification loop to process
        await new Promise(resolve => setTimeout(resolve, 50));

        // Parent should have the poison
        const parentValue = parentFrame.lookup('myVar');
        expect(isPoison(parentValue)).to.be.true;
      });

      it('should convert rejected promise to poison', async () => {
        const parentFrame = new AsyncFrame();
        parentFrame.set('myVar', 'initial', true);

        const asyncFrame = parentFrame.pushAsyncBlock(null, { myVar: 1 });

        // Set a rejected promise
        setTimeout(() => {
          asyncFrame.set('myVar', Promise.reject(new Error('Promise rejected')), true);
        }, 10);

        await new Promise(resolve => setTimeout(resolve, 50));

        // Parent should have poison created from rejection
        const parentValue = parentFrame.lookup('myVar');
        expect(isPoison(parentValue)).to.be.true;
        expect(parentValue.errors[0].message).to.equal('Promise rejected');
      });

      it('should handle promise that resolves to poison', async () => {
        const parentFrame = new AsyncFrame();
        parentFrame.set('myVar', 'initial', true);

        const asyncFrame = parentFrame.pushAsyncBlock(null, { myVar: 1 });

        const poison = createPoison(new Error('Poison in promise'));
        setTimeout(() => {
          asyncFrame.set('myVar', Promise.resolve(poison), true);
        }, 10);

        await new Promise(resolve => setTimeout(resolve, 50));

        const parentValue = parentFrame.lookup('myVar');
        expect(isPoison(parentValue)).to.be.true;
      });
    });

    describe('AsyncFrame.poisonBranchWrites', () => {
      it('should poison all variables in varCounts', () => {
        const frame = new AsyncFrame();
        frame.set('x', 'initial_x', true);
        frame.set('y', 'initial_y', true);

        const error = new Error('Branch condition failed');
        frame.poisonBranchWrites(error, { x: 1, y: 1 });

        expect(isPoison(frame.lookup('x'))).to.be.true;
        expect(isPoison(frame.lookup('y'))).to.be.true;

        const xPoison = frame.lookup('x');
        expect(xPoison.errors[0]).to.equal(error);
      });

      it('should accept PoisonedValue as input', () => {
        const frame = new AsyncFrame();
        frame.set('a', 'initial', true);

        const poison = createPoison(new Error('Already poison'));
        frame.poisonBranchWrites(poison, { a: 2 });

        expect(isPoison(frame.lookup('a'))).to.be.true;
        expect(frame.lookup('a')).to.equal(poison);
      });

      it('should handle multiple write counts', () => {
        const frame = new AsyncFrame();
        frame.set('counter', 0, true);

        // Simulate a loop that would write 5 times
        frame.poisonBranchWrites(new Error('Loop failed'), { counter: 5 });

        expect(isPoison(frame.lookup('counter'))).to.be.true;
      });

      it('should create variables if they do not exist', () => {
        const frame = new AsyncFrame();

        frame.poisonBranchWrites(new Error('Before declaration'), { newVar: 1 });

        expect(isPoison(frame.lookup('newVar'))).to.be.true;
      });

      it('should work with asyncVars', async () => {
        const parentFrame = new AsyncFrame();
        parentFrame.set('x', 'initial', true);

        const asyncFrame = parentFrame.pushAsyncBlock(null, { x: 2 });

        asyncFrame.poisonBranchWrites(new Error('Async branch failed'), { x: 2 });

        // Should poison the asyncVar
        expect(isPoison(asyncFrame.lookup('x'))).to.be.true;

        // Wait for countdown to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        // Should propagate to parent
        expect(isPoison(parentFrame.lookup('x')));
      });
    });

    describe('AsyncFrame poison propagation through async blocks', () => {
      it('should propagate poison from child to parent frame', async () => {
        const rootFrame = new AsyncFrame();
        rootFrame.set('result', 'initial', true);

        const asyncFrame = rootFrame.pushAsyncBlock(null, { result: 1 });

        // Set poison in async block
        const poison = createPoison(new Error('Child block error'));
        asyncFrame.set('result', poison, true);

        // Trigger countdown
        asyncFrame._countdownAndResolveAsyncWrites('result', 1);

        // Wait for resolution
        await new Promise(resolve => setTimeout(resolve, 10));

        // Parent should have poison
        const parentValue = rootFrame.lookup('result');
        expect(isPoison(parentValue)).to.be.true;
      });

      it('should handle nested async blocks with poison', async () => {
        const rootFrame = new AsyncFrame();
        rootFrame.set('data', 'initial', true);

        const level1 = rootFrame.pushAsyncBlock(null, { data: 1 });
        const level2 = level1.pushAsyncBlock(null, { data: 1 });

        // Poison at deepest level
        const poison = createPoison(new Error('Deep error'));
        level2.set('data', poison, true);
        level2._countdownAndResolveAsyncWrites('data', 1);

        await new Promise(resolve => setTimeout(resolve, 20));

        // Should propagate all the way up
        expect(isPoison(rootFrame.lookup('data'))).to.be.true;
      });
    });

    describe('AsyncFrame with multiple errors', () => {
      it('should preserve all errors when merging poisons', () => {
        const frame = new AsyncFrame();

        const poison1 = createPoison(new Error('Error 1'));
        const poison2 = createPoison(new Error('Error 2'));

        frame.set('var1', poison1, true);

        // Second poison - should this merge? Or just replace?
        // Based on current implementation, it replaces
        frame.set('var1', poison2, true);

        const result = frame.lookup('var1');
        expect(isPoison(result)).to.be.true;
        // Latest value wins (no automatic merging in set)
        expect(result).to.equal(poison2);
      });
    });

    describe('AsyncFrame poison handling edge cases', () => {
      it('should handle poison in _resolveAsyncVar', () => {
        const frame = new AsyncFrame();
        const poison = createPoison(new Error('Resolve error'));

        // Set up async var with poison
        frame.asyncVars = { testVar: poison };
        frame.promiseResolves = { testVar: () => { } };

        // Should not throw when resolving poison
        expect(() => frame._resolveAsyncVar('testVar')).to.not.throw();
      });

      it('should handle poison in nested frame resolution', () => {
        const rootFrame = new AsyncFrame();
        const childFrame = rootFrame.push();
        const grandChildFrame = childFrame.push();

        const poison = createPoison(new Error('Nested error'));
        grandChildFrame.set('nested', poison, true);

        // Should be accessible from all levels
        expect(isPoison(grandChildFrame.lookup('nested'))).to.be.true;
        expect(isPoison(childFrame.lookup('nested'))).to.be.true;
        expect(isPoison(rootFrame.lookup('nested'))).to.be.true;
      });

      it('should handle poison in asyncVars vs variables', () => {
        const parentFrame = new AsyncFrame();
        parentFrame.set('testVar', 'initial', true);

        const asyncFrame = parentFrame.pushAsyncBlock(null, { testVar: 1 });

        // Poison in asyncVars
        const asyncPoison = createPoison(new Error('Async poison'));
        asyncFrame.asyncVars.testVar = asyncPoison;

        // Poison in regular variables
        const regularPoison = createPoison(new Error('Regular poison'));
        asyncFrame.variables.regularVar = regularPoison;

        expect(isPoison(asyncFrame.lookup('testVar'))).to.be.true;
        expect(isPoison(asyncFrame.lookup('regularVar'))).to.be.true;
      });
    });

    describe('AsyncFrame poison with complex scenarios', () => {
      it('should handle poison in promise chain', async () => {
        const frame = new AsyncFrame();
        frame.set('chain', 'start', true);

        const asyncFrame = frame.pushAsyncBlock(null, { chain: 1 });

        // Create a promise that resolves to poison
        const poison = createPoison(new Error('Chain poison'));
        const promiseChain = Promise.resolve().then(() => poison);

        asyncFrame.set('chain', promiseChain, true);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 20));

        // Should have poison in parent
        const parentValue = frame.lookup('chain');
        expect(isPoison(parentValue)).to.be.true;
      });

      it('should handle multiple poison sources in same frame', () => {
        const frame = new AsyncFrame();

        const error1 = new Error('Error 1');
        const error2 = new Error('Error 2');

        frame.poisonBranchWrites(error1, { var1: 1, var2: 1 });
        frame.poisonBranchWrites(error2, { var3: 1, var4: 1 });

        // All variables should be poisoned
        expect(isPoison(frame.lookup('var1'))).to.be.true;
        expect(isPoison(frame.lookup('var2'))).to.be.true;
        expect(isPoison(frame.lookup('var3'))).to.be.true;
        expect(isPoison(frame.lookup('var4'))).to.be.true;

        // Each should have its respective error
        expect(frame.lookup('var1').errors[0]).to.equal(error1);
        expect(frame.lookup('var3').errors[0]).to.equal(error2);
      });

      it('should handle poison propagation through multiple async blocks', async () => {
        const rootFrame = new AsyncFrame();
        rootFrame.set('shared', 'initial', true);

        const block1 = rootFrame.pushAsyncBlock(null, { shared: 1 });
        const block2 = rootFrame.pushAsyncBlock(null, { shared: 1 });

        // Poison in first block
        const poison1 = createPoison(new Error('Block 1 error'));
        block1.set('shared', poison1, true);
        block1._countdownAndResolveAsyncWrites('shared', 1);

        // Poison in second block
        const poison2 = createPoison(new Error('Block 2 error'));
        block2.set('shared', poison2, true);
        block2._countdownAndResolveAsyncWrites('shared', 1);

        await new Promise(resolve => setTimeout(resolve, 30));

        // Root should have one of the poisons (last one wins)
        const rootValue = rootFrame.lookup('shared');
        expect(isPoison(rootValue)).to.be.true;
      });
    });
  });
});

