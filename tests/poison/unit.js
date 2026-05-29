import expect from 'expect.js';
import {
  collectErrors,
  CommandBuffer,
  createArray,
  createObject,
  createPoison,
  createRenderState,
  handleError,
  isPoison,
  isPoisonError,
  isError,
  isRuntimeError,
  markPromiseHandled,
  PoisonedValue,
  PoisonError,
  PoisonErrorGroup,
  peekError,
  RESOLVE_MARKER,
  RuntimePromise,
  RuntimeError
} from '../../src/runtime/runtime.js';

const TEST_EC = [1, 1, 'Poison.Unit', 'poison-unit.js', null];
const OTHER_EC = [2, 3, 'Poison.Other', 'poison-unit.js', null];

function poisonError(message, ec = TEST_EC) {
  return PoisonError.create(message, ec);
}

function poisonValue(message, ec = TEST_EC) {
  return createPoison(poisonError(message, ec));
}

describe('typed poison error contracts', () => {
  it('creates a poison value only from a typed poison error', () => {
    const error = poisonError('source failed');
    const poison = createPoison(error);

    expect(isPoison(poison)).to.be(true);
    expect(poison.errors).to.eql([error]);
    expect(() => createPoison(new Error('raw'))).to.throwException(/createPoison expects/);
  });

  it('creates, wraps, and preserves source context on individual poison errors', () => {
    const raw = new Error('raw failure');
    const wrapped = PoisonError.wrap(raw, TEST_EC);

    expect(wrapped).to.be.a(PoisonError);
    expect(wrapped.cause).to.be(raw);
    expect(wrapped.errorContext).to.be(TEST_EC);
    expect(PoisonError.wrap(wrapped, OTHER_EC)).to.be(wrapped);
  });

  it('does not convert fatal runtime errors into poison', () => {
    const fatal = RuntimeError.create('fatal', TEST_EC);

    expect(isRuntimeError(fatal)).to.be(true);
    expect(() => PoisonError.wrap(fatal, OTHER_EC)).to.throwException((err) => {
      expect(err).to.be(fatal);
    });
  });

  it('groups only existing poison errors', () => {
    const one = poisonError('one');
    const two = poisonError('two', OTHER_EC);
    const grouped = PoisonError.group([one, two]);

    expect(grouped).to.be.a(PoisonErrorGroup);
    expect(grouped.errors).to.eql([one, two]);
    expect(grouped.errorContext).to.be(TEST_EC);
    expect(grouped.lineno).to.be(1);
    expect(grouped.colno).to.be(1);
    expect(grouped.message).to.contain('Multiple errors occurred (2):');
    expect(grouped.message).to.contain('1. (poison-unit.js) [Line 1, Column 1]');
    expect(grouped.message).to.contain('2. (poison-unit.js) [Line 2, Column 3]');
    expect(() => PoisonError.group([one, new Error('raw')])).to.throwException(/PoisonError\.group expects/);
  });

  it('returns the single poison error instead of wrapping it in a group', () => {
    const error = poisonError('single');

    expect(PoisonError.group([error])).to.be(error);
    expect(PoisonError.group(error)).to.be(error);
    expect(PoisonError.group([error])).to.not.be.a(PoisonErrorGroup);
  });

  it('rejects empty poison groups', () => {
    expect(() => PoisonError.group([])).to.throwException(/requires at least one poison error/);
  });

  it('regroups existing poison groups by unwrapping their errors', () => {
    const one = poisonError('one');
    const two = poisonError('two', OTHER_EC);
    const group = PoisonError.group([one, two]);
    const regrouped = PoisonError.group(group);

    expect(regrouped).to.be.a(PoisonErrorGroup);
    expect(regrouped.errors).to.eql([one, two]);
  });

  it('deduplicates separate wrappers around the same original cause', () => {
    const raw = new Error('same source');
    const first = PoisonError.wrap(raw, TEST_EC);
    const second = PoisonError.wrap(raw, OTHER_EC);
    const grouped = PoisonError.group([first, second]);

    expect(grouped).to.be(first);
    expect(grouped.errors).to.eql([first]);
  });

  it('collects poison errors and treats raw promise rejections as fatal', async () => {
    const one = poisonValue('one');
    const two = Promise.reject(PoisonError.group([poisonError('two')]));
    const errors = await collectErrors([one, two]);

    expect(errors.map(err => err.message)).to.eql([
      '(poison-unit.js) [Line 1, Column 1] doing \'Poison.Unit\' : one',
      '(poison-unit.js) [Line 1, Column 1] doing \'Poison.Unit\' : two'
    ]);

    const raw = new Error('raw rejection');
    try {
      await collectErrors([Promise.reject(raw)]);
      expect().fail('collectErrors should throw raw rejections');
    } catch (err) {
      expect(err).to.be(raw);
    }
  });

  it('collects rejected individual and grouped poison errors through collectErrors', async () => {
    const one = poisonError('one');
    const two = poisonError('two');
    const three = poisonError('three');
    const errors = await collectErrors([
      Promise.reject(one),
      Promise.reject(PoisonError.group([two, three]))
    ]);

    expect(errors).to.eql([one, two, three]);
  });

  it('checks poison states with isError and throws raw promise rejections', async () => {
    expect(await isError('healthy')).to.be(false);
    expect(await isError(Promise.resolve(poisonValue('resolved poison')))).to.be(true);
    expect(await isError(Promise.reject(poisonError('rejected poison')))).to.be(true);

    const raw = new Error('raw is fatal');
    try {
      await isError(Promise.reject(raw));
      expect().fail('isError should rethrow raw rejections');
    } catch (err) {
      expect(err).to.be(raw);
    }
  });

  it('implements the poison thenable protocol for poison errors only', async () => {
    const poison = poisonValue('thenable');
    let caught = null;

    expect(poison.then(() => 'unused')).to.be(poison);

    await poison.catch(err => {
      caught = err;
    });

    expect(isPoisonError(caught)).to.be(true);
    expect(caught.errors).to.have.length(1);

    const next = poison.catch(() => {
      throw poisonError('handler poison');
    });
    expect(isPoison(next)).to.be(true);
    expect(next.errors[0].message).to.contain('handler poison');

    expect(() => poison.catch(() => {
      throw new Error('raw handler failure');
    })).to.throwException(/raw handler failure/);
  });

  it('runs PoisonedValue.finally callbacks and preserves poison identity', () => {
    const poison = poisonValue('finally');
    let called = false;

    expect(poison.finally(() => {
      called = true;
    })).to.be(poison);
    expect(called).to.be(true);

    expect(poison.finally(() => {
      throw new Error('ignored finally failure');
    })).to.be(poison);
  });

  it('does not allow raw errors inside PoisonedValue', () => {
    expect(() => new PoisonedValue([new Error('raw')])).to.throwException(/PoisonError\.group expects/);
  });

  it('peeks poison errors without consuming healthy values', async () => {
    const poison = poisonValue('peek sync');
    const syncPeek = peekError(poison);

    expect(syncPeek).to.be.a(PoisonError);
    expect(syncPeek.message).to.contain('peek sync');

    const asyncPeek = await peekError(Promise.resolve(poisonValue('peek async')));
    expect(asyncPeek).to.be.a(PoisonError);
    expect(asyncPeek.message).to.contain('peek async');

    expect(await peekError(Promise.resolve(42))).to.be(null);
  });

  it('normalizes RuntimePromise rejections at the promise boundary', async () => {
    const raw = new Error('plain rejection');
    const wrapped = RuntimePromise._wrapRejection(raw, TEST_EC);

    expect(wrapped).to.be.a(PoisonError);
    expect(wrapped.cause).to.be(raw);
    expect(wrapped.errorContext).to.be(TEST_EC);

    const fatal = RuntimeError.create('fatal rejection', TEST_EC);
    expect(RuntimePromise._wrapRejection(fatal, OTHER_EC)).to.be(fatal);

    const poison = poisonError('existing poison');
    expect(RuntimePromise._wrapRejection(poison, OTHER_EC)).to.be(poison);

    const poisonValueResult = RuntimePromise._wrapRejection(poisonValue('poison value'), OTHER_EC);
    expect(isPoisonError(poisonValueResult)).to.be(true);
    expect(poisonValueResult.message).to.contain('poison value');
  });

  it('passes normalized rejections to RuntimePromise handlers', async () => {
    const raw = new Error('handler source');
    let seen = null;
    const handled = new RuntimePromise(Promise.reject(raw), TEST_EC)
      .then(null, (err) => {
        seen = err;
        return 'handled';
      });

    expect(await handled).to.be('handled');
    expect(seen).to.be.a(PoisonError);
    expect(seen.cause).to.be(raw);
    expect(seen.errorContext).to.be(TEST_EC);
  });

  it('marks promises handled by installing a rejection handler', () => {
    let called = false;
    const fakePromise = {
      catch(handler) {
        called = typeof handler === 'function';
        return this;
      }
    };

    expect(markPromiseHandled(fakePromise)).to.be(fakePromise);
    expect(called).to.be(true);
  });

  it('keeps RuntimeError factory and reporting behavior idempotent', () => {
    const existing = RuntimeError.create('existing fatal', TEST_EC);
    expect(RuntimeError.create(existing, OTHER_EC)).to.be(existing);
    expect(() => RuntimeError.create('missing context', null)).to.throwException(/requires an error context/);

    let reported = null;
    const renderState = createRenderState((err) => {
      reported = err;
    });
    const ec = [4, 5, 'Runtime.Report', 'runtime-report.casc', renderState];
    const reportedError = RuntimeError.report('reported fatal', ec);
    expect(reported).to.be(reportedError);
    expect(renderState.error).to.be(reportedError);

    const throwState = createRenderState();
    const throwEc = [6, 7, 'Runtime.Throw', 'runtime-report.casc', throwState];
    expect(() => RuntimeError.reportAndThrow('thrown fatal', throwEc)).to.throwException((err) => {
      expect(err).to.be(throwState.error);
      expect(isRuntimeError(err)).to.be(true);
    });
  });

  it('guards PoisonError.create message input and reports with runtime context', () => {
    expect(() => PoisonError.create(null, TEST_EC)).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('PoisonError.create expects a message string');
      expect(err.errorContext).to.be(TEST_EC);
    });
  });

  it('keeps handleError compatibility with legacy positional arguments', () => {
    const err = handleError(new Error('legacy failure'), 3, 4, 'Legacy.Sync', 'legacy.casc');

    expect(isRuntimeError(err)).to.be(true);
    expect(err.message).to.contain('(legacy.casc) [Line 3, Column 4]');
    expect(err.message).to.contain('Legacy.Sync');
    expect(err.cause.message).to.be('legacy failure');
  });

  it('exposes diagnostic info from runtime context errors', () => {
    const rootEc = [8, 1, 'Root', 'diagnostics.casc', null];
    const childEc = [9, 2, 'Child', 'diagnostics.casc', null];
    const root = new CommandBuffer({}, null, null, null, null, { ec: rootEc, entryName: 'root' });
    const child = new CommandBuffer({}, root, null, null, null, {
      ec: childEc,
      methodName: 'child',
      loop: { index: 1, variables: ['item'] }
    });
    const err = RuntimeError.create('diagnostic fatal', child.bufferStackContext);
    const info = err.getInfo({ stackBuffer: child });

    expect(info).to.eql({
      lineno: 9,
      colno: 2,
      path: 'diagnostics.casc',
      label: 'Child',
      methodName: 'child',
      loop: { index: 1, variables: ['item'] },
      stack: [
        {
          lineno: 9,
          colno: 2,
          path: 'diagnostics.casc',
          label: 'Child',
          methodName: 'child',
          loop: { index: 1, variables: ['item'] }
        },
        {
          lineno: 8,
          colno: 1,
          path: 'diagnostics.casc',
          label: 'Root',
          entryName: 'root'
        }
      ]
    });
  });

  it('treats raw lazy object and array rejections as fatal', async () => {
    const objectFailure = new Error('object raw');
    const objectValue = createObject({ value: Promise.reject(objectFailure) });

    try {
      await objectValue[RESOLVE_MARKER];
      expect().fail('object marker should reject');
    } catch (err) {
      expect(err).to.be(objectFailure);
    }

    const arrayFailure = new Error('array raw');
    const arrayValue = createArray([Promise.reject(arrayFailure)]);

    try {
      await arrayValue[RESOLVE_MARKER];
      expect().fail('array marker should reject');
    } catch (err) {
      expect(err).to.be(arrayFailure);
    }
  });

  it('collects poison rejections from lazy object and array markers', async () => {
    const objectPoison = poisonError('object poison');
    const objectValue = createObject({ value: Promise.reject(objectPoison) });

    try {
      await objectValue[RESOLVE_MARKER];
      expect().fail('object marker should reject');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      expect(err.errors).to.eql([objectPoison]);
    }

    const arrayPoison = poisonError('array poison');
    const arrayValue = createArray([Promise.reject(arrayPoison)]);

    try {
      await arrayValue[RESOLVE_MARKER];
      expect().fail('array marker should reject');
    } catch (err) {
      expect(isPoisonError(err)).to.be(true);
      expect(err.errors).to.eql([arrayPoison]);
    }
  });
});
