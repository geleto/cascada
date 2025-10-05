(function () {
  'use strict';

  var expect;
  //var unescape;
  //var Environment;
  let runtime;
  let createPoison;
  let isPoison;
  let PoisonError;
  let collectErrors;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    runtime = require('../src/runtime');
    createPoison = runtime.createPoison;
    isPoison = runtime.isPoison;
    PoisonError = runtime.PoisonError;
    collectErrors = runtime.collectErrors;
  } else {
    expect = window.expect;
    createPoison = nunjucks.runtime.createPoison;
    isPoison = nunjucks.runtime.isPoison;
    PoisonError = nunjucks.runtime.PoisonError;
    collectErrors = nunjucks.runtime.collectErrors;
  }


  describe('Error Propagation Dataflow Poisoning - Unit Tests', () => {
    describe('createPoison and isPoison', () => {
      it('should create poison from single error', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        expect(isPoison(poison)).to.be(true);
        expect(poison.errors).to.have.length(1);
        expect(poison.errors[0]).to.equal(err);
      });

      it('should create poison from multiple errors', () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison = createPoison([err1, err2]);

        expect(isPoison(poison)).to.be(true);
        expect(poison.errors).to.have.length(2);
        expect(poison.errors[0]).to.equal(err1);
        expect(poison.errors[1]).to.equal(err2);
      });

      it('should identify non-poison values correctly', () => {
        expect(isPoison(null)).to.be(false);
        expect(isPoison(undefined)).to.be(false);
        expect(isPoison(42)).to.be(false);
        expect(isPoison('string')).to.be(false);
        expect(isPoison({})).to.be(false);
        expect(isPoison([])).to.be(false);
      });

      it('should identify poison values correctly', () => {
        const poison = createPoison(new Error('test'));
        expect(isPoison(poison)).to.be(true);
      });
    });

    describe('PoisonedValue thenable protocol', () => {
      it('should implement thenable protocol with catch', async () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        let caughtError = null;
        await poison.catch(e => {
          caughtError = e;
        });

        expect(caughtError).to.be.a(PoisonError);
        expect(caughtError.errors).to.have.length(1);
        expect(caughtError.errors[0]).to.equal(err);
      });

      it('should chain poison values without handlers', () => {
        const err = new Error('Original error');
        const poison = createPoison(err);

        // Chaining without a rejection handler should return poison
        const chained = poison.then(val => val * 2);
        expect(isPoison(chained)).to.be(true);
      });

      it('should propagate poison through then without rejection handler', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const result = poison.then(val => val * 2);
        expect(isPoison(result)).to.be(true);
      });

      it('should handle errors in rejection handler', async () => {
        const err = new Error('Original error');
        const poison = createPoison(err);

        const result = poison.catch(() => {
          throw new Error('Handler error');
        });

        expect(isPoison(result)).to.be(true);
      });

      it('should implement finally method', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        let finallyCalled = false;
        const result = poison.finally(() => {
          finallyCalled = true;
        });

        expect(finallyCalled).to.be(true);
        expect(isPoison(result)).to.be(true);
      });

      it('should ignore errors in finally handler', () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const result = poison.finally(() => {
          throw new Error('Finally error');
        });

        expect(isPoison(result)).to.be(true);
        expect(result.errors[0]).to.equal(err);
      });
    });

    describe('PoisonError', () => {
      it('should handle single error with simple message', () => {
        const err = new Error('Single error');
        const compound = new PoisonError([err]);

        expect(compound.message).to.equal('Single error');
        expect(compound.name).to.equal('PoisonError');
        expect(compound.errors).to.have.length(1);
      });

      it('should handle multiple errors with combined message', () => {
        const err1 = new Error('First error');
        const err2 = new Error('Second error');
        const compound = new PoisonError([err1, err2]);

        expect(compound.message).to.contain('Multiple errors occurred (2)');
        expect(compound.message).to.contain('First error');
        expect(compound.message).to.contain('Second error');
        expect(compound.errors).to.have.length(2);
      });

      it('should deduplicate errors with same message', () => {
        const err1 = new Error('Duplicate message');
        const err2 = new Error('Duplicate message');
        const err3 = new Error('Different message');

        const compound = new PoisonError([err1, err2, err3]);

        expect(compound.errors).to.have.length(2);
      });

      it('should preserve stack from first error', () => {
        const err = new Error('Test error');
        const compound = new PoisonError([err]);

        expect(compound.stack).to.equal(err.stack);
      });
    });

    describe('collectErrors', () => {
      it('should collect errors from array of poison values', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison1 = createPoison(err1);
        const poison2 = createPoison(err2);

        const errors = await collectErrors([poison1, poison2]);

        expect(errors).to.have.length(2);
        expect(errors[0]).to.equal(err1);
        expect(errors[1]).to.equal(err2);
      });

      it('should collect errors from rejected promises', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');

        const values = [
          Promise.reject(err1),
          Promise.reject(err2)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(2);
        expect(errors[0]).to.equal(err1);
        expect(errors[1]).to.equal(err2);
      });

      it('should collect errors from promises that resolve to poison', async () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const values = [
          Promise.resolve(poison)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(1);
        expect(errors[0]).to.equal(err);
      });

      it('should await all promises even after finding errors', async () => {
        let promise2Resolved = false;
        let promise3Resolved = false;

        const values = [
          createPoison(new Error('Error 1')),
          Promise.resolve(42).then(v => { promise2Resolved = true; return v; }),
          Promise.resolve(100).then(v => { promise3Resolved = true; return v; })
        ];

        await collectErrors(values);

        expect(promise2Resolved).to.be(true);
        expect(promise3Resolved).to.be(true);
      });

      it('should ignore non-poison, non-error values', async () => {
        const err = new Error('Test error');
        const poison = createPoison(err);

        const values = [
          poison,
          42,
          'string',
          { obj: true },
          Promise.resolve(100)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(1);
        expect(errors[0]).to.equal(err);
      });

      it('should deduplicate collected errors', async () => {
        const err1 = new Error('Duplicate error');
        const err2 = new Error('Duplicate error');
        const poison1 = createPoison(err1);
        const poison2 = createPoison(err2);

        const errors = await collectErrors([poison1, poison2]);

        expect(errors).to.have.length(1);
      });

      it('should handle mixed poison and rejected promises', async () => {
        const err1 = new Error('Poison error');
        const err2 = new Error('Rejection error');
        const poison = createPoison(err1);

        const values = [
          poison,
          Promise.reject(err2),
          Promise.resolve(42)
        ];

        const errors = await collectErrors(values);

        expect(errors).to.have.length(2);
      });

      it('should handle empty array', async () => {
        const errors = await collectErrors([]);
        expect(errors).to.have.length(0);
      });

      it('should handle multiple errors in single poison value', async () => {
        const err1 = new Error('Error 1');
        const err2 = new Error('Error 2');
        const poison = createPoison([err1, err2]);

        const errors = await collectErrors([poison]);

        expect(errors).to.have.length(2);
      });
    });
  });
})();
