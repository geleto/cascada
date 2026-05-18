import expect from 'expect.js';
import {
  PoisonError,
  RuntimeError,
  RuntimeFatalError,
  createPoison,
  getErrorInfo,
  handleError,
  handleFatal,
  isPoison,
  normalizeErrorContext,
  prepareErrorContexts
} from '../../src/runtime/runtime.js';

describe('error context tracing runtime foundation', () => {
  it('prepares compact contexts without mutating shared specs', () => {
    const labels = ['For.Iterator(Symbol)'];
    const specs = [
      [1, 0, 'Root'],
      [7, 11, 0]
    ];
    const cb = () => {};

    const prepared = prepareErrorContexts('script.casc', cb, labels, specs);

    expect(prepared).to.eql([
      [1, 0, 'Root', 'script.casc', cb],
      [7, 11, 'For.Iterator(Symbol)', 'script.casc', cb]
    ]);
    expect(specs).to.eql([
      [1, 0, 'Root'],
      [7, 11, 0]
    ]);

    const secondCb = () => {};
    const second = prepareErrorContexts('other.casc', secondCb, labels, specs);

    expect(second).to.eql([
      [1, 0, 'Root', 'other.casc', secondCb],
      [7, 11, 'For.Iterator(Symbol)', 'other.casc', secondCb]
    ]);
    expect(second[0]).not.to.be(prepared[0]);
    expect(second[1]).not.to.be(prepared[1]);
  });

  it('wraps errors with compact context metadata', () => {
    const ec = [3, 7, 'If.Condition(LookupVal)', 'script.casc', null];
    const wrapped = handleError(new Error('bad condition'), ec, {});

    expect(wrapped.message).to.contain('(script.casc) [Line 3, Column 7]');
    expect(wrapped.message).to.contain("doing 'If.Condition(LookupVal)'");
    expect(wrapped.errorContext).to.eql(ec);
    expect(wrapped.label).to.be('If.Condition(LookupVal)');
    expect(wrapped.errorContextString).to.be('If.Condition(LookupVal)');
  });

  it('normalizes compact, legacy object, and empty contexts', () => {
    const cb = () => {};

    expect(normalizeErrorContext([1, 2, 'LookupVal', 'script.casc', cb])).to.eql({
      lineno: 1,
      colno: 2,
      label: 'LookupVal',
      path: 'script.casc',
      cb
    });
    expect(normalizeErrorContext({
      lineno: 3,
      colno: 4,
      errorContextString: 'FunCall',
      path: 'legacy.casc',
      cb
    })).to.eql({
      lineno: 3,
      colno: 4,
      label: 'FunCall',
      path: 'legacy.casc',
      cb
    });
    expect(normalizeErrorContext(null)).to.eql({
      lineno: null,
      colno: null,
      label: null,
      path: null,
      cb: null
    });
  });

  it('does not add source metadata when no context is present', () => {
    const err = new RuntimeError('plain failure');

    expect(err.message).to.equal('plain failure');
    expect(err.errorContext).to.be(null);
  });

  it('preserves an existing error context over helper fallback context', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null];
    const wrapped = handleError(new Error('original failure'), origin);
    const consumed = handleError(wrapped, fallback);

    expect(consumed).to.equal(wrapped);
    expect(consumed.errorContext).to.eql(origin);
    expect(getErrorInfo(consumed, fallback, null, false)).to.eql({
      lineno: 2,
      colno: 4,
      path: 'origin.casc',
      label: 'FunCall',
      errorContextString: 'FunCall',
      cb: null
    });
    expect(getErrorInfo(consumed, fallback, null, true).stack).to.eql([]);
  });

  it('preserves existing context when RuntimeError wraps an error directly', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null];
    const err = new Error('original failure');
    err.errorContext = origin;

    const wrapped = new RuntimeError(err, fallback);

    expect(wrapped.errorContext).to.eql(origin);
    expect(wrapped.message).to.contain('origin.casc');
    expect(wrapped.message).to.contain("doing 'FunCall'");
  });

  it('stores context on PoisonError contents rather than the wrapper', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null];
    const poison = new PoisonError([new Error('poisoned')], origin);

    const cloned = new PoisonError(poison, fallback);

    expect(poison.errorContext).to.be(undefined);
    expect(poison.errors[0].errorContext).to.eql(origin);
    expect(cloned.errorContext).to.be(undefined);
    expect(cloned.errors[0].errorContext).to.eql(origin);
  });

  it('applies context precedence per PoisonError contained error', () => {
    const origin = [4, 2, 'LookupVal', 'origin.casc', null];
    const fallback = [8, 3, 'For.Iterator(Symbol)', 'consumer.casc', null];
    const wrapped = handleError(new Error('already wrapped'), origin);
    const raw = new Error('raw');
    const poison = new PoisonError([wrapped, raw]);

    const handled = handleError(poison, fallback);

    expect(handled.errors[0].errorContext).to.eql(origin);
    expect(handled.errors[1].errorContext).to.eql(fallback);
    expect(handled.errors[1].message).to.contain('consumer.casc');
  });

  it('does not wrap PoisonError contents when no context exists', () => {
    const raw = new Error('raw');
    const poison = new PoisonError([raw]);

    const handled = handleError(poison);

    expect(handled.errors[0]).to.equal(raw);
  });

  it('createPoison accepts plural inputs and compact context', () => {
    const ec = [5, 9, 'Switch.Expression(Symbol)', 'switch.casc', null];
    const poison = createPoison([new Error('one'), 'two'], ec, {});

    expect(isPoison(poison)).to.be(true);
    expect(poison.errors).to.have.length(2);
    expect(poison.errors[0].errorContext).to.eql(ec);
    expect(poison.errors[1].errorContext).to.eql(ec);
    expect(poison.errors[1].message).to.contain('two');
  });

  it('RuntimeFatalError accepts compact context', () => {
    const ec = [6, 10, 'Include.Template', 'include.casc', null];
    const err = new RuntimeFatalError('include failed', ec, {});

    expect(err.name).to.be('RuntimeFatalError');
    expect(err.errorContext).to.eql(ec);
    expect(err.message).to.contain('(include.casc) [Line 6, Column 10]');
    expect(err.message).to.contain("doing 'Include.Template'");
  });

  it('handleFatal reports through context callback when present', () => {
    let reported = null;
    const cb = err => {
      reported = err;
    };
    const ec = [7, 2, 'AsyncBoundary', 'fatal.casc', cb];

    const wrapped = handleFatal(new Error('fatal failure'), ec, {});

    expect(reported).to.equal(wrapped);
    expect(wrapped.errorContext).to.eql(ec);
    expect(wrapped.message).to.contain('fatal.casc');
  });

  it('handleFatal throws when no context callback is present', () => {
    const ec = [7, 2, 'AsyncBoundary', 'fatal.casc', null];

    expect(() => handleFatal(new Error('fatal failure'), ec, {})).to.throwException(err => {
      expect(err.errorContext).to.eql(ec);
      expect(err.message).to.contain('fatal.casc');
    });
  });
});
