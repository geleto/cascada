import expect from 'expect.js';
import {
  collectErrors,
  CommandBuffer,
  callWrapAsync,
  createArray,
  createObject,
  createPoison,
  createRenderState,
  handleError,
  isPoison,
  isPoisonError,
  isError,
  isRuntimeError,
  iterate,
  markPromiseHandled,
  PoisonedValue,
  PoisonError,
  PoisonErrorGroup,
  peekError,
  RESOLVE_MARKER,
  RuntimePromise,
  RuntimeContextError,
  RuntimeError,
  envCallWrapAsync,
  observeDiscardedExpression,
  cloneContext,
  cloneWithAddedContext
} from '../../src/runtime/runtime.js';

const TEST_EC = [1, 1, 'Poison.Unit', 'poison-unit.js', null, null];
const OTHER_EC = [2, 3, 'Poison.Other', 'poison-unit.js', null, null];

function poisonError(message, ec = TEST_EC) {
  return PoisonError.create(message, ec, 'ValueRejected');
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
    expect(() => createPoison(new Error('raw'))).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('createPoison expects');
      expect(err.context.label).to.be(null);
      expect(err.context.path).to.be(null);
    });
  });

  it('creates, wraps, and preserves source context on individual poison errors', () => {
    const raw = new Error('raw failure');
    const wrapped = PoisonError.wrap(raw, TEST_EC, 'UserCallThrew');

    expect(wrapped).to.be.a(PoisonError);
    expect(wrapped.cause).to.be(raw);
    expect(wrapped.kind).to.be('UserCallThrew');
    expect(wrapped.context).to.eql({
      lineno: 1,
      colno: 1,
      label: 'Poison.Unit',
      path: 'poison-unit.js',
      renderState: null
    });
    expect(wrapped.errorContext).to.be(undefined);
    expect(PoisonError.wrap(wrapped, OTHER_EC, 'LookupThrew')).to.be(wrapped);
    expect(wrapped.kind).to.be('UserCallThrew');
    expect(PoisonError.create('created failure', TEST_EC, 'NotCallable').kind).to.be('NotCallable');
    expect(() => new PoisonError('missing context')).to.throwException((err) => {
      expect(err).to.be.a(TypeError);
      expect(err.message).to.contain('compact origin context');
    });
  });

  it('does not convert fatal runtime errors into poison', () => {
    const fatal = RuntimeError.create('fatal', TEST_EC);

    expect(isRuntimeError(fatal)).to.be(true);
    expect(() => PoisonError.wrap(fatal, OTHER_EC)).to.throwException((err) => {
      expect(err).to.be(fatal);
    });
  });

  it('requires kind when creating a new poison source', () => {
    expect(() => PoisonError.create('missing kind', TEST_EC)).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('PoisonError.create requires kind');
    });
    expect(() => PoisonError.wrap(new Error('missing kind'), TEST_EC)).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('PoisonError.wrap requires kind');
    });
    expect(() => new RuntimePromise(Promise.resolve('ok'), TEST_EC)).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('RuntimePromise requires kind');
    });
  });

  it('groups only existing poison errors', () => {
    const one = poisonError('one');
    const two = poisonError('two', OTHER_EC);
    const grouped = PoisonError.group([one, two]);

    expect(grouped).to.be.a(PoisonErrorGroup);
    expect(grouped).to.be.a(PoisonError);
    expect(grouped.kind).to.be('ValueRejected');
    expect(grouped.kinds).to.eql(['ValueRejected']);
    expect(grouped.totalErrorCount).to.be(2);
    expect(grouped.errors).to.eql([one, two]);
    expect(grouped.context).to.eql(one.context);
    expect(grouped.errorContext).to.be(undefined);
    expect(grouped.description).to.be('Multiple errors occurred (2)');
    expect(grouped.lineno).to.be(1);
    expect(grouped.colno).to.be(1);
    expect(grouped.message).to.contain('PoisonErrorGroup (2 errors):');
    expect(grouped.message).to.contain('1. PoisonError: one');
    expect(grouped.message).to.contain('(poison-unit.js) [Line 1, Column 1] Poison.Unit');
    expect(grouped.message).to.contain('2. PoisonError: two');
    expect(grouped.message).to.contain('(poison-unit.js) [Line 2, Column 3] Poison.Other');
    expect(grouped.message).to.not.contain('\nLocation:');
    expect(grouped.fullMessage).to.contain('PoisonErrorGroup (2 errors):');
    expect(grouped.fullMessage).to.contain('1. PoisonError: one');
    expect(grouped.fullMessage).to.contain('2. PoisonError: two');
    expect(grouped.fullMessage).to.not.contain('\nLocation:');
    expect(() => PoisonError.group([one, new Error('raw')])).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('Expected existing poison errors');
      expect(err.context.label).to.be(null);
      expect(err.context.path).to.be(null);
    });
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
    expect(() => new PoisonErrorGroup(group)).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('PoisonErrorGroup constructor expects individual poison errors');
      expect(err.context.label).to.be('Poison.Unit');
    });
  });

  it('deduplicates separate wrappers around the same original cause', () => {
    const raw = new Error('same source');
    const first = PoisonError.wrap(raw, TEST_EC, 'ValueRejected');
    const second = PoisonError.wrap(raw, OTHER_EC, 'ValueRejected');
    const grouped = PoisonError.group([first, second]);

    expect(grouped).to.be(first);
    expect(grouped.errors).to.eql([first]);
  });

  it('sorts grouped poison errors by source before formatting', () => {
    const later = PoisonError.create('later', [5, 1, 'later', 'b.njk', null, null], 'LookupThrew');
    const earlier = PoisonError.create('earlier', [1, 2, 'earlier', 'a.njk', null, null], 'NotCallable');
    const sameLine = PoisonError.create('same line', [1, 3, 'same', 'a.njk', null, null], 'NotAFunction');
    const grouped = PoisonError.group([later, sameLine, earlier]);

    expect(grouped.errors).to.eql([earlier, sameLine, later]);
    expect(grouped.kinds).to.eql(['LookupThrew', 'NotAFunction', 'NotCallable']);
    expect(grouped.message.indexOf('earlier')).to.be.lessThan(grouped.message.indexOf('same line'));
    expect(grouped.message.indexOf('same line')).to.be.lessThan(grouped.message.indexOf('later'));
  });

  it('caps grouped poison messages while retaining all errors', () => {
    const errors = [];
    for (let i = 0; i < 12; i++) {
      const kind = i % 2 === 0 ? 'LookupThrew' : 'UserCallThrew';
      errors.push(PoisonError.create(`failure ${i}`, [i + 1, 1, `err${i}`, 'cap.njk', null, null], kind));
    }

    const grouped = PoisonError.group(errors);

    expect(grouped).to.be.a(PoisonErrorGroup);
    expect(grouped.totalErrorCount).to.be(12);
    expect(grouped.errors).to.have.length(12);
    expect(grouped.kinds).to.eql(['LookupThrew', 'UserCallThrew']);
    expect(grouped.message).to.contain('PoisonErrorGroup (12 errors, showing 10) of 2 kinds (LookupThrew, UserCallThrew):');
    expect(grouped.message).to.contain('failure 9');
    expect(grouped.message).to.not.contain('failure 10');
    expect(grouped.message).to.not.contain('failure 11');
    expect(grouped.errors[10].message).to.contain('failure 10');
    expect(grouped.errors[11].message).to.contain('failure 11');
  });

  it('collects poison errors and treats raw promise rejections as fatal', async () => {
    const one = poisonValue('one');
    const two = Promise.reject(PoisonError.group([poisonError('two')]));
    const errors = await collectErrors([one, two]);

    expect(errors.map(err => err.message)).to.eql([
      'PoisonError: one\n(poison-unit.js) [Line 1, Column 1] Poison.Unit',
      'PoisonError: two\n(poison-unit.js) [Line 1, Column 1] Poison.Unit'
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
    expect(() => new PoisonedValue([new Error('raw')])).to.throwException(/Expected existing poison errors/);
  });

  it('peeks poison errors without consuming healthy values', async () => {
    const poison = poisonValue('peek sync');
    const syncPeek = peekError(poison);

    expect(syncPeek).to.be.a(PoisonError);
    expect(syncPeek.description).to.be('peek sync');
    expect(syncPeek.message).to.contain('peek sync');
    expect(syncPeek.fullMessage).to.contain('PoisonError: peek sync');
    expect(syncPeek.fullMessage).to.contain('(poison-unit.js) [Line 1, Column 1] Poison.Unit');

    const asyncPeek = await peekError(Promise.resolve(poisonValue('peek async')));
    expect(asyncPeek).to.be.a(PoisonError);
    expect(asyncPeek.message).to.contain('peek async');
    expect(asyncPeek.fullMessage).to.contain('PoisonError: peek async');

    expect(await peekError(Promise.resolve(42))).to.be(null);
  });

  it('normalizes RuntimePromise rejections at the promise boundary', async () => {
    const raw = new Error('plain rejection');
    const wrapped = RuntimePromise._wrapRejection(raw, TEST_EC, 'LookupThrew');

    expect(wrapped).to.be.a(PoisonError);
    expect(wrapped.cause).to.be(raw);
    expect(wrapped.context.label).to.be('Poison.Unit');
    expect(wrapped.kind).to.be('LookupThrew');

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
    const handled = new RuntimePromise(Promise.reject(raw), TEST_EC, 'UserCallThrew')
      .then(null, (err) => {
        seen = err;
        return 'handled';
      });

    expect(await handled).to.be('handled');
    expect(seen).to.be.a(PoisonError);
    expect(seen.cause).to.be(raw);
    expect(seen.context.label).to.be('Poison.Unit');
    expect(seen.kind).to.be('UserCallThrew');
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
    expect(RuntimeError.create(existing)).to.be(existing);
    expect(() => RuntimeError.create(existing, OTHER_EC)).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('RuntimeError.create received context for an existing RuntimeError');
      expect(err.context.label).to.be('Poison.Other');
    });
    const contextless = RuntimeError.create('missing context', null);
    expect(isRuntimeError(contextless)).to.be(true);
    expect(contextless.context.label).to.be(null);
    expect(contextless.context.path).to.be(null);
    expect(contextless.message).to.contain('(unknown path) [Line ?, Column ?]');

    let reported = null;
    const renderState = createRenderState((err) => {
      reported = err;
    });
    const ec = [4, 5, 'Runtime.Report', 'runtime-report.casc', null, renderState];
    const reportedError = RuntimeError.report('reported fatal', ec);
    expect(reported).to.be(reportedError);
    expect(renderState.error).to.be(reportedError);

    const throwState = createRenderState();
    const throwEc = [6, 7, 'Runtime.Throw', 'runtime-report.casc', null, throwState];
    expect(() => RuntimeError.reportAndThrow('thrown fatal', throwEc)).to.throwException((err) => {
      expect(err).to.be(throwState.error);
      expect(isRuntimeError(err)).to.be(true);
    });
  });

  it('guards PoisonError.create message input and reports with runtime context', () => {
    expect(() => PoisonError.create(null, TEST_EC, 'ValueRejected')).to.throwException((err) => {
      expect(isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('PoisonError.create expects a message string');
      expect(err.context.label).to.be('Poison.Unit');
    });
  });

  it('keeps handleError compatibility with legacy positional arguments', () => {
    const err = handleError(new Error('legacy failure'), 3, 4, 'Legacy.Sync', 'legacy.casc');

    expect(isRuntimeError(err)).to.be(true);
    expect(err.message).to.contain('RuntimeError: legacy failure');
    expect(err.message).to.contain('(legacy.casc) [Line 3, Column 4] Legacy.Sync');
    expect(err.message).to.contain('Legacy.Sync');
    expect(err.cause.message).to.be('legacy failure');
  });

  it('exposes diagnostic info from runtime context errors', () => {
    const rootEc = [8, 1, 'Root', 'diagnostics.casc', null, null];
    const childEc = [9, 2, 'Child', 'diagnostics.casc', null, null];
    const root = new CommandBuffer({}, null, null, null, null, cloneWithAddedContext(rootEc, { entryName: 'root' }));
    const child = new CommandBuffer({}, root, null, null, null, cloneWithAddedContext(childEc, {
      methodName: 'child',
      loop: { index: 1, variables: ['item'] }
    }));
    const err = RuntimeError.create('diagnostic fatal', child.bufferStackErrorContext, child);
    const info = err.getInfo(child.getDiagnosticStack());

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

  it('uses explicit stack buffer in diagnostic info', () => {
    const root = new CommandBuffer({}, null, null, null, null, cloneWithAddedContext(
      [1, 1, 'Root', 'diagnostics.casc', null, null],
      {
        entryName: 'root'
      }
    ));
    const child = new CommandBuffer({}, root, null, null, null, cloneWithAddedContext(
      [2, 2, 'Child', 'diagnostics.casc', null, null],
      {
        branch: 'then'
      }
    ));

    expect(RuntimeContextError.getInfo(null, child.bufferStackErrorContext, child.getDiagnosticStack()).stack).to.eql([
      {
        lineno: 2,
        colno: 2,
        path: 'diagnostics.casc',
        label: 'Child',
        branch: 'then'
      },
      {
        lineno: 1,
        colno: 1,
        path: 'diagnostics.casc',
        label: 'Root',
        entryName: 'root'
      }
    ]);
    expect(RuntimeContextError.formatInfo(null, child.bufferStackErrorContext, child.getDiagnosticStack())).to.be([
      '(diagnostics.casc) [Line 2, Column 2] Child (branch=then)',
      'Stack:',
      '  1. (diagnostics.casc) [Line 1, Column 1] Root (entry name=root)'
    ].join('\n'));
  });

  it('rejects source fields on added context', () => {
    expect(() => RuntimeError.create(
      'metadata override attempt',
      [2, 3, 'Compact.Label', 'compact.casc', { lineno: 99 }, null]
    )).to.throwException((err) => {
      expect(err).to.be.a(TypeError);
      expect(err.message).to.contain('Added context cannot contain source field');
      expect(err.message).to.contain('lineno');
    });
  });

  it('rejects stale compact contexts without the renderState slot', () => {
    const staleContext = [2, 3, 'Old.Compact', 'compact.casc', null];

    expect(() => RuntimeError.create('stale context', staleContext)).to.throwException((err) => {
      expect(err.message).to.contain('compact error context');
    });
    expect(() => new CommandBuffer({}, null, null, null, null, staleContext)).to.throwException((err) => {
      expect(err).to.be.a(TypeError);
      expect(err.message).to.contain('compact bufferStackErrorContext');
    });
  });

  it('formats extended diagnostic messages with stacks as readable text', () => {
    const rootEc = [8, 1, 'Root', 'diagnostics.casc', null, null];
    const childEc = [9, 2, 'Child', 'diagnostics.casc', null, null];
    const root = new CommandBuffer({}, null, null, null, null, cloneWithAddedContext(rootEc, { entryName: 'root' }));
    const child = new CommandBuffer({}, root, null, null, null, cloneWithAddedContext(childEc, {
      methodName: 'child',
      loop: { index: 1, variables: ['item'] }
    }));
    const err = RuntimeError.create('diagnostic fatal', child.bufferStackErrorContext, child);

    expect(err.message).to.be([
      'RuntimeError: diagnostic fatal',
      '(diagnostics.casc) [Line 9, Column 2] Child (method name=child, loop={ index: 1, variables: [item] })'
    ].join('\n'));
    expect(err.fullMessage).to.be([
      'RuntimeError: diagnostic fatal',
      '(diagnostics.casc) [Line 9, Column 2] Child (method name=child, loop={ index: 1, variables: [item] })',
      'Stack:',
      '  1. (diagnostics.casc) [Line 8, Column 1] Root (entry name=root)'
    ].join('\n'));
  });

  it('keeps the first stack frame when it differs from the primary context', () => {
    const rootEc = [8, 1, 'Root', 'diagnostics.casc', null, null];
    const childEc = [9, 2, 'Child', 'diagnostics.casc', null, null];
    const primaryEc = [10, 4, 'Primary', 'diagnostics.casc', null, null];
    const root = new CommandBuffer({}, null, null, null, null, cloneWithAddedContext(rootEc, { entryName: 'root' }));
    const child = new CommandBuffer({}, root, null, null, null, cloneWithAddedContext(childEc, { branch: 'then' }));

    expect(RuntimeContextError.formatInfo(null, primaryEc, child.getDiagnosticStack())).to.be([
      '(diagnostics.casc) [Line 10, Column 4] Primary',
      'Stack:',
      '  1. (diagnostics.casc) [Line 9, Column 2] Child (branch=then)',
      '  2. (diagnostics.casc) [Line 8, Column 1] Root (entry name=root)'
    ].join('\n'));
  });

  it('keeps explicit diagnostic stack buffers local to each command buffer', () => {
    const root = new CommandBuffer({}, null, null, null, null, cloneWithAddedContext(
      [1, 1, 'Root', 'diagnostics.casc', null, null],
      {
        entryName: 'root'
      }
    ));
    const otherRoot = new CommandBuffer({}, null, null, null, null, cloneWithAddedContext(
      [2, 1, 'Root', 'other.casc', null, null],
      {
        entryName: 'other'
      }
    ));
    const sharedContext = cloneWithAddedContext([3, 2, 'Child', 'diagnostics.casc', null, null], { branch: 'shared' });
    const first = new CommandBuffer({}, root, null, null, null, cloneContext(sharedContext));
    const second = new CommandBuffer({}, otherRoot, null, null, null, cloneContext(sharedContext));

    expect(first.bufferStackErrorContext).to.not.be(second.bufferStackErrorContext);
    expect(first.getDiagnosticStack()).to.eql([first.bufferStackErrorContext, root.bufferStackErrorContext]);
    expect(second.getDiagnosticStack()).to.eql([second.bufferStackErrorContext, otherRoot.bufferStackErrorContext]);
    expect(RuntimeContextError.getInfo(null, first.bufferStackErrorContext, first.getDiagnosticStack()).stack[1].path).to.be('diagnostics.casc');
    expect(RuntimeContextError.getInfo(null, second.bufferStackErrorContext, second.getDiagnosticStack()).stack[1].path).to.be('other.casc');
  });

  it('formats cyclic diagnostic metadata without recursing forever', () => {
    const cyclic = { name: 'node' };
    cyclic.self = cyclic;
    const err = RuntimeError.create(
      'cyclic metadata',
      cloneWithAddedContext([1, 1, 'Meta', 'diagnostics.casc', null, null], { cyclic })
    );

    expect(err.message).to.contain('cyclic={ name: node, self: [Circular] }');
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

  describe('fatal render state early exits', () => {
    function createFatalContext(label = 'Fatal.Unit') {
      const renderState = createRenderState();
      return {
        renderState,
        errorContext: [1, 1, label, 'poison-unit.js', null, renderState]
      };
    }

    it('does not invoke call wrappers after fatal render state is reported', () => {
      const { errorContext } = createFatalContext('Fatal.Call');
      const fatal = RuntimeError.report('already fatal', errorContext);
      let callWrapInvoked = false;
      let envCallInvoked = false;
      const context = {
        env: { globals: {} },
        ctx: {}
      };

      expect(() => callWrapAsync(() => {
        callWrapInvoked = true;
        return 'called';
      }, 'lateCall', context, [], errorContext))
        .to.throwException((err) => {
          expect(err).to.be(fatal);
        });
      expect(() => envCallWrapAsync(() => {
        envCallInvoked = true;
        return 'called';
      }, context, [], errorContext))
        .to.throwException((err) => {
          expect(err).to.be(fatal);
        });

      expect(callWrapInvoked).to.be(false);
      expect(envCallInvoked).to.be(false);
    });

    it('stops scheduling loop bodies after fatal render state is reported', async () => {
      const { renderState, errorContext } = createFatalContext('Fatal.Loop');
      const buffer = new CommandBuffer({}, null, null, null, null, errorContext, null, renderState);
      const visited = [];

      await iterate([1, 2, 3], (value) => {
        visited.push(value);
        RuntimeError.report('loop fatal', errorContext);
      }, null, buffer, ['item'], {
        errorContext,
        sequential: false
      });

      expect(visited).to.eql([1]);
    });
  });

  describe('discarded expression observer', () => {
    it('reports raw discarded rejections without rethrowing or leaving them unhandled', async () => {
      let reported = null;
      const renderState = createRenderState((err) => {
        reported = err;
      });
      const errorContext = [1, 1, 'Discarded.Expression', 'poison-unit.js', null, renderState];
      const raw = new Error('discarded raw');

      observeDiscardedExpression(Promise.reject(raw), errorContext);
      await Promise.resolve();

      expect(reported).to.be.a(RuntimeError);
      expect(reported.message).to.contain('discarded raw');
      expect(renderState.error).to.be(reported);
    });

    it('swallows discarded poison rejections', async () => {
      let reported = null;
      const renderState = createRenderState((err) => {
        reported = err;
      });
      const errorContext = [1, 1, 'Discarded.Poison', 'poison-unit.js', null, renderState];

      observeDiscardedExpression(Promise.reject(poisonError('discarded poison')), errorContext);
      await Promise.resolve();

      expect(reported).to.be(null);
      expect(renderState.error).to.be(null);
    });
  });
});
