(function () {
  'use strict';

  var expect;
  let runtime;
  let createPoison;
  let isPoison;
  let isPoisonError;
  let AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../../src/runtime');
    createPoison = runtime.createPoison;
    isPoisonError = runtime.isPoisonError;
    isPoison = runtime.isPoison;
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    isPoisonError = nunjucks.runtime.isPoisonError;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  describe('Iterator Functions Poison Handling - Integration tests (basic)', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should handle normal iteration when array is valid', async () => {
      const template = `
        {% set count = 0 %}
        {% for item in [1, 2, 3] %}
          {% set count = count + 1 %}
        {% endfor %}
        Count: {{ count }}
      `;

      const result = await env.renderTemplateString(template);
      expect(result.trim()).to.equal('Count: 3');
    });

    it('should handle normal iteration with async operations', async () => {
      const context = {
        items: [1, 2, 3],
        async increment(val) {
          return val;
        }
      };

      const template = `
        {% set count = 0 %}
        {% for item in items %}
          {% set count = count + increment(item) %}
        {% endfor %}
        Count: {{ count }}
      `;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Count: 6');
    });
  });

  describe('Iterator Functions Poison Handling - Integration tests', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should handle for loop modifying outer variable with async operations', async () => {
      const context = {
        items: [1, 2, 3],
        async process(val) {
          return val * 2;
        }
      };

      const template = `
        {% set total = 0 %}
        {% for item in items %}
          {% set processed = process(item) %}
          {% set total = total + processed %}
        {% endfor %}
        Total: {{ total }}
      `;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Total: 12');
    });
  });

  describe('Integration: For Loops with Poison Handling', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    // Replaces: 'iterate - poisoned iterable' -> 'should poison branch writes when array is poisoned'
    it('should poison variables written inside a loop over a poisoned iterable', async () => {
      const context = {
        poisonedItems: createPoison(new Error('Iterable is poisoned'))
      };
      const template = `
        {% set total = 0 %}
        {% for item in poisonedItems %}
          {% set total = total + item %}
        {% endfor %}
        {{ total }}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('Iterable is poisoned');
      }
    });

    // Replaces: 'iterate - poisoned iterable' -> 'should execute else branch when iterable is poisoned'
    it('should execute the else block for a loop over a poisoned iterable', async () => {
      const context = {
        poisonedItems: createPoison(new Error('Iterable is poisoned'))
      };
      const template = `
        {% for item in poisonedItems %}
          NEVER SEEN
        {% else %}
          Else block was executed
        {% endfor %}
        END
      `;
      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('Iterable is poisoned');
      }
    });

    // Replaces: 'iterateAsyncSequential - error collection' -> 'should collect all errors from poisoned values'
    it('should collect all errors from an async generator yielding poison', async () => {
      const context = {
        async *myGenerator() {
          yield 1;
          yield createPoison(new Error('First failure'));
          yield 2;
          yield createPoison(new Error('Second failure'));
        }
      };
      const template = `{% for item in myGenerator() %}{{ item }}{% endfor %}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(2);
        expect(err.errors[0].message).to.contain('First failure');
        expect(err.errors[1].message).to.contain('Second failure');
      }
    });

    // Replaces: 'iterateAsyncSequential - error collection' -> 'should continue iteration after finding error'
    // @todo - convert to script and use @data for a separate test
    // @todo - in this test processed shall be poisoned (convert to script)
    it('should continue processing valid items after a poison value is yielded', async () => {
      const context = {
        processed: [],
        async *myGenerator() {
          yield 'A';
          yield createPoison(new Error('Transient error'));
          yield 'B';
        }
      };
      const template = `{% for item in myGenerator() %}{% do processed!.push(item) }}{% endfor %}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(context.processed).to.eql(['A', 'B']);
      }
    });

    // Replaces: 'iterateAsyncParallel - error collection' -> 'should process all iterations even after error'
    // Also covers 'should handle multiple parallel errors'
    it('should process all parallel iterations and collect multiple errors', async () => {
      const context = {
        processed: [],
        async *myGenerator() {
          yield 1;
          yield 2;
          yield 3;
          yield 4;
        },
        async failingFunc(val) {
          if (val === 2 || val === 4) {
            throw new Error(`Failure on ${val}`);
          }
          return val;
        }
      };
      const template = `
        {% for item in myGenerator() %}
          {% set result = failingFunc(item) %}
          {% do processed!.push(result) %}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(2);
        const messages = err.errors.map(e => e.message).sort();
        expect(messages).to.eql(['Failure on 2', 'Failure on 4']);

        const successfulResults = await Promise.all(
          context.processed.filter(p => !isPoison(p))
        );
        expect(successfulResults).to.eql([1, 3]);
      }
    });

    // Replaces: 'Deterministic error collection'
    it('should collect errors deterministically regardless of async timing', async () => {
      const expectedErrors = ['Error A', 'Error B', 'Error C'].sort();

      for (let i = 0; i < 5; i++) {
        const context = {
          async *myGenerator() {
            await new Promise(res => setTimeout(res, Math.random() * 5));
            yield createPoison(new Error('Error A'));
            await new Promise(res => setTimeout(res, Math.random() * 5));
            yield createPoison(new Error('Error B'));
            await new Promise(res => setTimeout(res, Math.random() * 5));
            yield createPoison(new Error('Error C'));
          }
        };
        const template = `{% for item in myGenerator() %}{% endfor %}`;

        try {
          await env.renderTemplateString(template, context);
          expect().fail(`Run ${i + 1} should have thrown`);
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          const messages = err.errors.map(e => e.message).sort();
          expect(messages).to.eql(expectedErrors);
        }
      }
    });
  });

  //
  // -----------------------------------------------------------
  // Part 2: Advanced cases + dedup + edge cases (fixed)
  // -----------------------------------------------------------
  describe('Integration: For Loops with Poison Handling (Advanced Cases)', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    // Replaces: 'iterate - poisoned iterable' -> 'should handle object iteration when object is poisoned'
    it('should execute the else block for a loop over a poisoned object', async () => {
      const context = {
        poisonedObject: createPoison(new Error('Object is poisoned'))
      };
      const template = `
        {% for key, value in poisonedObject %}
          NEVER SEEN: {{ key }} -> {{ value }}
        {% else %}
          Object else block executed
        {% endfor %}
      `;
      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Object else block executed');
    });

    // Replaces: 'iterateAsyncSequential - error collection' -> 'should collect errors from loop body execution'
    it('should catch and propagate errors thrown from an async function in a loop body', async () => {
      const context = {
        async *items() {
          yield 1;
          yield 2; // This one will cause the function to throw
          yield 3;
        },
        async processItem(item) {
          if (item === 2) {
            throw new Error('Processing failed for item 2');
          }
          return item;
        }
      };
      const template = `
        {% for item in items() %}
          {% set result = processItem(item) %}
          {{ result }}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('Processing failed for item 2');
        expect(err.errors[0].lineno).to.be.a('number');
      }
    });

    // Replaces: 'iterateAsyncSequential - error collection' -> 'should handle mixed poison and promise rejections'
    it('should collect errors from both yielded poison and rejected promises in an async generator', async () => {
      const context = {
        async *myGenerator() {
          yield 'good';
          yield createPoison(new Error('Yielded poison error'));
          yield Promise.reject(new Error('Rejected promise error'));
          yield 'also good';
        }
      };
      const template = `{% for item in myGenerator() %}{{ item }}{% endfor %}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(2);
        const messages = err.errors.map(e => e.message).sort();
        expect(messages).to.eql(['Rejected promise error', 'Yielded poison error']);
      }
    });

    // Replaces: 'iterateAsyncSequential - error collection' -> 'should handle loop body returning poison'
    it('should handle functions in a loop body that return poison values', async () => {
      const context = {
        items: ['A', 'B', 'C'],
        processItem(item) {
          if (item === 'B') {
            return createPoison(new Error('Item B is invalid'));
          }
          return item;
        }
      };
      const template = `
        {% for item in items %}
          {% set result = processItem(item) %}
          {{ result }}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('Item B is invalid');
      }
    });

    // Replaces: 'iterateAsyncSequential - error collection' -> 'should handle destructuring with poisoned values'
    it('should handle destructuring loops where an item is a poison value', async () => {
      const context = {
        processed: [],
        async *myGenerator() {
          yield ['good', 1];
          yield createPoison(new Error('This item is poisoned'));
          yield ['also good', 2];
        }
      };
      const template = `
        {% for name, id in myGenerator() %}
          {{ processed.push(name) }}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('This item is poisoned');
        expect(context.processed).to.eql(['good', 'also good']);
      }
    });
  });

  describe('Integration: Advanced Loop Error Collection and Deduplication', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    // Replaces: 'iterateAsyncParallel - error collection' -> 'should handle mixed poison and async errors'
    it('should collect errors from both yielded poison and parallel async function errors', async () => {
      const context = {
        async *myGenerator() {
          yield createPoison(new Error('Poison from generator'));
          yield 'item-to-process';
          yield 'another-good-item';
        },
        async processItem(item) {
          if (item === 'item-to-process') {
            throw new Error('Async processing error');
          }
          return item;
        }
      };
      const template = `
        {% for item in myGenerator() %}
          {% set result = processItem(item) %}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(2);
        const messages = err.errors.map(e => e.message).sort();
        expect(messages).to.eql(['Async processing error', 'Poison from generator']);
      }
    });

    // Replaces: 'Deterministic error collection' -> single poisoned value
    it('should deterministically catch a single poisoned value from a delayed generator', async () => {
      for (let i = 0; i < 3; i++) {
        const context = {
          async *myGenerator() {
            await new Promise(res => setTimeout(res, Math.random() * 5));
            yield createPoison(new Error('Single deterministic error'));
          }
        };
        const template = `{% for item in myGenerator() %}{{item}}{% endfor %}`;

        try {
          await env.renderTemplateString(template, context);
          expect().fail(`Run ${i + 1} should have thrown`);
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(1);
          expect(err.errors[0].message).to.contain('Single deterministic error');
        }
      }
    });

    // Replaces: 'Deterministic error collection' -> all poisoned values
    it('should deterministically catch all poisoned values from a delayed generator', async () => {
      const expectedMessages = ['Error 1', 'Error 2', 'Error 3'].sort();

      for (let i = 0; i < 3; i++) {
        const context = {
          async *myGenerator() {
            yield createPoison(new Error('Error 1'));
            await new Promise(res => setTimeout(res, Math.random() * 5));
            yield createPoison(new Error('Error 2'));
            await new Promise(res => setTimeout(res, Math.random() * 5));
            yield createPoison(new Error('Error 3'));
          }
        };
        const template = `{% for item in myGenerator() %}{% endfor %}`;

        try {
          await env.renderTemplateString(template, context);
          expect().fail(`Run ${i + 1} should have thrown`);
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          const messages = err.errors.map(e => e.message).sort();
          expect(messages).to.eql(expectedMessages);
        }
      }
    });

    // Replaces: 'Error deduplication' -> identical instance should be deduped
    it('should deduplicate errors when the exact same error instance is yielded multiple times', async () => {
      const sameError = new Error('This error should only appear once');
      const context = {
        items: [
          createPoison(sameError),
          'good item',
          createPoison(sameError)
        ]
      };
      const template = `{% for item in items %}{% endfor %}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('This error should only appear once');
      }
    });

    // Replaces: 'Error deduplication' -> distinct instances are separate
    it('should treat distinct error instances as separate entries', async () => {
      const context = {
        items: [
          createPoison(new Error('Same message')),
          createPoison(new Error('Same message'))
        ]
      };
      const template = `{% for item in items %}{{item}}{% endfor %}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(2); // two distinct instances retained
        expect(err.errors[0].message).to.contain('Same message');
        expect(err.errors[1].message).to.contain('Same message');
      }
    });

    // Replaces: 'Error deduplication' -> preserve order while deduplicating
    it('should preserve the encounter order of unique errors during deduplication', async () => {
      const context = {
        items: [
          createPoison(new Error('Error A')),
          createPoison(new Error('Error B')),
          createPoison(new Error('Error A')), // Duplicate
          createPoison(new Error('Error C')),
          createPoison(new Error('Error B'))  // Duplicate
        ]
      };
      const template = `{% for item in items %}{% endfor %}`;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(3);
        const messages = err.errors.map(e => e.message);
        expect(messages).to.eql(['Error A', 'Error B', 'Error C']);
      }
    });
  });

  describe('Integration: Loop Edge Cases', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    // Replaces: 'Edge cases' -> null iterable
    it('should handle a null iterable without throwing and execute the else block', async () => {
      const context = { items: null };
      const template = `
        {% for item in items %}
          This should not render.
        {% else %}
          Else block for null iterable.
        {% endfor %}
      `;

      const result = await env.renderTemplateString(template, context);
      expect(result.trim()).to.equal('Else block for null iterable.');
    });

    // Replaces: 'Edge cases' -> empty iterable (array & object)
    it('should handle empty iterables (array and object) and execute the else block', async () => {
      // Empty array
      const contextArray = { items: [] };
      const templateArray = `
        {% for item in items %}
          This should not render.
        {% else %}
          Empty array handled.
        {% endfor %}
      `;
      const resultArray = await env.renderTemplateString(templateArray, contextArray);
      expect(resultArray.trim()).to.equal('Empty array handled.');

      // Empty object
      const contextObject = { data: {} };
      const templateObject = `
        {% for key, value in data %}
          This should not render.
        {% else %}
          Empty object handled.
        {% endfor %}
      `;
      const resultObject = await env.renderTemplateString(templateObject, contextObject);
      expect(resultObject.trim()).to.equal('Empty object handled.');
    });

    // Replaces: 'Edge cases' -> iterable throws during iteration
    it('should catch and propagate an error thrown from within an async generator', async () => {
      const context = {
        async *throwingGenerator() {
          yield 'first item';
          yield 'second item';
          // Native JS error (not a yielded PoisonValue)
          throw new Error('The generator itself has failed');
        }
      };
      const template = `
        {% for item in throwingGenerator() %}
          {{ item }}
        {% endfor %}
      `;

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Render should have thrown a PoisonError');
      } catch (err) {
        // Runtime should wrap the thrown error into a PoisonError
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('The generator itself has failed');
      }
    });
  });
})();

