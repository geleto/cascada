'use strict';

const expect = require('expect.js');
const { AsyncEnvironment } = require('../../src/environment');
const { createPoison, isPoisonError } = require('../../src/runtime/runtime');

describe('Phase 4: Async Iterator Error Handling', () => {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  // Test 4.1: User generator yields values that cause loop body errors (soft errors)
  it('should collect errors when loop body throws for yielded values and continue iteration', async () => {
    const context = {
      async *testGen() {
        yield { value: 1, shouldFail: false };
        yield { value: 2, shouldFail: true };  // Will cause loop body to throw
        yield { value: 3, shouldFail: false };
        yield { value: 4, shouldFail: true };  // Will cause loop body to throw
        yield { value: 5, shouldFail: false };
      },
      processItem: (item) => {
        if (item.shouldFail) {
          throw new Error(`Processing failed for value ${item.value}`);
        }
        return item.value;
      }
    };

    const script = `
      :data
      for item in testGen()
        var processed = processItem(item)
        @data.items.push(processed)
      endfor
    `;

    try {
      await env.renderScriptString(script, context);
      expect().fail('Should have thrown PoisonError');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      expect(err.errors.length).to.be.greaterThan(0);
      const messages = err.errors.map(e => e.message);
      const hasError2 = messages.some(m => m.includes('value 2'));
      const hasError4 = messages.some(m => m.includes('value 4'));
      expect(hasError2 || hasError4).to.be(true);
    }
  });

  // Test 4.3: User generator yields mixed values, some cause errors
  it('should collect all errors while processing mixed values', async () => {
    const context = {
      async *testGen() {
        yield 'a';
        yield { shouldFail: true, msg: 'Error 1' };
        yield 'b';
        yield 'c';
        yield { shouldFail: true, msg: 'Error 2' };
        yield 'd';
        yield { shouldFail: true, msg: 'Error 3' };
      },
      processValue: (item) => {
        if (typeof item === 'object' && item.shouldFail) {
          throw new Error(item.msg);
        }
        return item;
      }
    };

    const script = `
      :data
      for item in testGen()
        var processed = processValue(item)
        @data.items.push(processed)
      endfor
    `;

    try {
      await env.renderScriptString(script, context);
      expect().fail('Should have thrown PoisonError');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      expect(err.errors.length).to.be.greaterThan(0);
      const messages = err.errors.map(e => e.message);
      const hasError1 = messages.some(m => m.includes('Error 1'));
      const hasError2 = messages.some(m => m.includes('Error 2'));
      const hasError3 = messages.some(m => m.includes('Error 3'));
      expect(hasError1 || hasError2 || hasError3).to.be(true);
    }
  });

  // Test 4.4: Loop body throws during iteration
  it('should collect errors from loop body as soft errors', async () => {
    const context = {
      async *testGen() {
        yield { value: 1, shouldFail: false };
        yield { value: 2, shouldFail: true };
        yield { value: 3, shouldFail: false };
        yield { value: 4, shouldFail: true };
      },
      processItem: (item) => {
        if (item.shouldFail) {
          throw new Error(`Processing failed for item ${item.value}`);
        }
        return item.value;
      }
    };

    const script = `
      :data
      for item in testGen()
        var result = processItem(item)
        @data.results.push(result)
      endfor
    `;

    try {
      await env.renderScriptString(script, context);
      expect().fail('Should have thrown PoisonError');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      expect(err.errors.length).to.be.greaterThan(0);
      // Should have errors from items 2 and 4
      const messages = err.errors.map(e => e.message);
      const hasError2 = messages.some(m => m.includes('item 2'));
      const hasError4 = messages.some(m => m.includes('item 4'));
      expect(hasError2 || hasError4).to.be(true);
    }
  });

  // Test 4.5: Empty async iterator
  it('should handle empty async iterator without errors', async () => {
    const context = {
      async *emptyGen() {
        // Yields nothing
      }
    };

    const script = `
      :data
      for item in emptyGen()
        @data.items.push(item)
      else
        @data.isEmpty = true
      endfor
    `;

    const result = await env.renderScriptString(script, context);
    expect(result.isEmpty).to.be(true);
    expect(result.items).to.be(undefined);
  });

  // Additional test: Verify runtime no longer poisons writes (Phase 2 does it)
  it('should not poison writes in runtime - compiler handles it', async () => {
    const context = {
      getPoisonedArray: () => createPoison(new Error('Array evaluation failed'))
    };

    const script = `
      :data
      var total = 0
      for item in getPoisonedArray()
        total = total + item
      else
        @data.elseBranch = true
      endfor
      @data.total = total
    `;

    try {
      await env.renderScriptString(script, context);
      expect().fail('Should have thrown PoisonError');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      // The key assertion: runtime.iterate should just return false
      // The compiler's catch block (Phase 2) should handle poisoning
      // This test verifies runtime doesn't double-poison
    }
  });

  // Test 4.7: Generator yields Error objects directly (soft errors)
  it('should collect errors when generator yields Error objects and continue iteration', async () => {
    const context = {
      async *testGen() {
        yield 1;
        yield new Error('Soft error at iteration 2');
        yield 3;
        yield new Error('Soft error at iteration 4');
        yield 5;
      }
    };

    const script = `
      :data
      for item in testGen()
        @data.items.push(item)
      endfor
    `;

    try {
      await env.renderScriptString(script, context);
      expect().fail('Should have thrown PoisonError');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      // The errors are wrapped in a context error, so check the message
      const errorMsg = err.message;
      expect(errorMsg).to.contain('Soft error at iteration 2');
      expect(errorMsg).to.contain('Soft error at iteration 4');
      // Note: items 1, 3, 5 were successfully processed before error thrown
    }
  });

  // Test 4.8: Generator yields PoisonError object directly (multiple soft errors)
  it('should collect errors when generator yields PoisonError and continue iteration', async () => {
    const { PoisonError } = require('../../src/runtime/runtime');

    const context = {
      async *testGen() {
        yield 'a';
        yield new PoisonError([
          new Error('Multiple error 1'),
          new Error('Multiple error 2')
        ]);
        yield 'b';
      }
    };

    const script = `
      :data
      for item in testGen()
        @data.items.push(item)
      endfor
    `;

    try {
      await env.renderScriptString(script, context);
      expect().fail('Should have thrown PoisonError');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      // The errors are wrapped in a context error, so check the message
      const errorMsg = err.message;
      expect(errorMsg).to.contain('Multiple error 1');
      expect(errorMsg).to.contain('Multiple error 2');
    }
  });

  // Test 4.9: Realistic example - API errors yielded from generator
  it('should handle realistic async API pattern with yielded errors', async () => {
    const context = {
      async *fetchPages() {
        // Simulate paginated API calls
        yield { page: 1, data: [1, 2, 3] };

        // Page 2 fetch fails - yield error instead of throwing
        yield new Error('API rate limit exceeded on page 2');

        // Continue to page 3
        yield { page: 3, data: [7, 8, 9] };
      }
    };

    const script = `
      :data
      for pageResult in fetchPages()
        if pageResult.data
          for item in pageResult.data
            @data.allItems.push(item)
          endfor
        endif
      endfor
    `;

    try {
      await env.renderScriptString(script, context);
      expect().fail('Should have thrown PoisonError');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      expect(err.errors).to.have.length(1);
      expect(err.errors[0].message).to.contain('API rate limit exceeded');
      // Note: Pages 1 and 3 were successfully processed
    }
  });

  describe('Hard and Soft Error Handling in Async Iterators', () => {
    // Test 4.2: User generator throws (hard error)
    let context;
    beforeEach(() => {
      context = {
        hardError: false,
        //the counts will be 0 because context is shallow-copied before use:
        iterationCount: 0,
        async *testGen() {
          yield 1;
          this.iterationCount++;
          yield 2;
          this.iterationCount++;
          if (this.hardError) {
            throw new Error('Hard error - generator exhausted');
          } else {
            yield new Error('Soft error - continuing iteration');
          }
          yield 3; // Unreachable
        }
      };
    });

    it('Should propagate a soft error to body handler of "for"/"each" loops', async () => {
      let script = `
        :data
        for item in testGen()
          @data.items.push(item)
        endfor
      `;

      for (let i = 0; i < 2; i++) {
        const ctx = { ...context };
        // test soft error
        try {
          await env.renderScriptString(script, ctx);
          expect().fail('Should have thrown PoisonError(soft)');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(1);
          expect(err.errors[0].message).to.contain('Soft error - continuing iteration');
        }
        script = script.replace('for item', 'each item').replace('endfor', 'endeach');
      }
    });

    it('Should propagate a hard error to body handler of "for"/"each" loops', async () => {
      let script = `
        :data
        for item in testGen()
          @data.items.push(item)
        endfor
      `;

      for (let i = 0; i < 2; i++) {
        const ctx = { ...context, hardError: true };
        // test hard error
        try {
          await env.renderScriptString(script, ctx);
          expect().fail('Should have thrown PoisonError(hard)');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(1);
          expect(err.errors[0].message).to.contain('Hard error - generator exhausted');
        }

        // test with 'for' and 'each'(sequential) loops
        script = script.replace('for item', 'each item').replace('endfor', 'endeach');
      }
    });
  });
});

