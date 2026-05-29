import expect from 'expect.js';
import {
  collectErrors,
  createArray,
  createObject,
  createPoison,
  isPoison,
  isPoisonError,
  isRuntimeError,
  PoisonedValue,
  PoisonError,
  PoisonErrorGroup,
  RESOLVE_MARKER,
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
    expect(() => PoisonError.group([one, new Error('raw')])).to.throwException(/PoisonError\.group expects/);
  });

  it('returns the single poison error instead of wrapping it in a group', () => {
    const error = poisonError('single');

    expect(PoisonError.group([error])).to.be(error);
    expect(PoisonError.group(error)).to.be(error);
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

  it('implements the poison thenable protocol for poison errors only', async () => {
    const poison = poisonValue('thenable');
    let caught = null;

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

  it('does not allow raw errors inside PoisonedValue', () => {
    expect(() => new PoisonedValue([new Error('raw')])).to.throwException(/PoisonError\.group expects/);
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
});
