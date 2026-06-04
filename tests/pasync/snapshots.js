
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {expectAsyncError} from '../util.js';
import {
  TextCommand,
  SnapshotCommand,
  DataCommand,
  SequenceCallCommand,
  CommandBuffer,
  declareBufferChain,
  createPoison,
  createRenderState,
  isPoisonError,
  PoisonError,
  linkInheritanceCallableFootprintChains,
  runControlFlowBoundary,
  cloneWithAddedContext
} from '../../src/runtime/runtime.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const TEST_DIAGNOSTIC_CONTEXT = cloneWithAddedContext(TEST_EC, { branch: 'test' });
const createTestPoison = (error) => createPoison(PoisonError.wrap(error, TEST_EC, 'UserCallThrew'));

describe('chain.finalSnapshot', function () {
  let env;
  let context;
  const createBuffer = (input, ctx, chainName) => {
    const targetName = chainName || 'text';
    const cb = new CommandBuffer(ctx || null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    makeChain(cb, ctx, targetName);
    const addItem = (buffer, item) => {
      if (item instanceof CommandBuffer) {
        buffer.addBuffer(item, targetName);
        return;
      }
      if (Array.isArray(item)) {
        const nested = new CommandBuffer(ctx || null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
        const linkedChain = buffer.getChain(targetName);
        if (linkedChain) {
          nested._installLinkedChain(targetName, linkedChain);
        }
        item.forEach((child) => addItem(nested, child));
        nested.finish();
        buffer.addBuffer(nested, targetName);
        return;
      }
      if (item instanceof TextCommand || item instanceof DataCommand || item instanceof SequenceCallCommand) {
        buffer.addCommand(item, targetName);
        return;
      }
      if (targetName === 'text') {
        buffer.addCommand(new TextCommand({ chainName: 'text', args: [item], errorContext: TEST_EC }), targetName);
        return;
      }
      buffer._add(item, targetName);
    };
    if (Array.isArray(input)) {
      input.forEach((item) => addItem(cb, item));
    } else if (input !== null && input !== undefined) {
      addItem(cb, input);
    }
    cb.finish();
    return cb;
  };
  const makeChain = (buffer, ctx, chainName) => {
    if (!buffer.bufferStackErrorContext) {
      buffer.bufferStackErrorContext = TEST_DIAGNOSTIC_CONTEXT;
    }
    const name = chainName || 'text';
    return buffer.getOwnChain(name) || declareBufferChain(buffer, name, name, ctx || null, null);
  };
  const flatten = (buffer, ctx, chainName) => (
    makeChain(buffer, ctx, chainName).finalSnapshot()
  );
  const flattenSequence = (commands, ctx, chainName, sequence) => {
    const buffer = new CommandBuffer(ctx, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    const sequenceChain = declareBufferChain(buffer, chainName, 'sequence', ctx || null, sequence);

    commands.forEach((entry) => buffer.addCommand(entry, chainName));
    sequenceChain.finalSnapshot();
    return sequence;
  };
  const cmd = (spec) => {
    const commandSpec = {
      ...spec,
      errorContext: spec.errorContext || TEST_EC
    };
    if (spec.chainName === 'data') {
      return new DataCommand(commandSpec);
    }
    if (spec.chainName === 'text') {
      return new TextCommand(commandSpec);
    }
    return new SequenceCallCommand(commandSpec);
  };

  // For each test, create a fresh environment and context.
  beforeEach(() => {
    env = new AsyncEnvironment();
    context = {
      getVariables: () => ({ userId: 123 }),
      env: env,
    };
  });

  describe('buffer entry cleanup', function () {
    it('releases applied command entries after finalSnapshot completes', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(buffer, 'text', 'text', context, null);

      buffer.addCommand(new TextCommand({
        chainName: 'text',
        args: ['A'],
        errorContext: TEST_EC
      }), 'text');
      buffer.addCommand(new TextCommand({
        chainName: 'text',
        args: ['B'],
        errorContext: TEST_EC
      }), 'text');
      buffer.finish();

      const result = await chain.finalSnapshot();
      expect(result).to.be('AB');
      expect(buffer.arrays.text).to.be(null);
    });

    it('releases finished child buffers after the iterator leaves them', async function () {
      const parent = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const child = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(parent, 'text', 'text', context, null);
      child._installLinkedChain('text', chain);

      child.addCommand(new TextCommand({
        chainName: 'text',
        args: ['A'],
        errorContext: TEST_EC
      }), 'text');
      child.finish();

      parent.addBuffer(child, 'text');
      parent.addCommand(new TextCommand({
        chainName: 'text',
        args: ['B'],
        errorContext: TEST_EC
      }), 'text');
      parent.finish();

      const result = await chain.finalSnapshot();
      expect(result).to.be('AB');
      expect(parent.arrays.text).to.be(null);
      expect(child.arrays.text).to.be(null);
      expect(child.getChainIfExists('text')).to.be(chain);
    });

    it('disposes finished iterator state after completion', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(buffer, 'text', 'text', context, null);
      const iterator = chain._iterator;

      buffer.addCommand(new TextCommand({
        chainName: 'text',
        args: ['A'],
        errorContext: TEST_EC
      }), 'text');
      buffer.finish();

      const first = await chain.finalSnapshot();
      const second = await chain.finalSnapshot();

      expect(first).to.be('A');
      expect(second).to.be('A');
      expect(chain._iterator).to.be(null);
      expect(iterator.finished).to.be(true);
      expect(iterator.stack).to.eql([]);
      expect(iterator.output).to.be(null);
      expect(iterator._pendingObservables).to.be(null);
    });

    it('clears chain completion promise state after completion', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(buffer, 'text', 'text', context, null);

      buffer.addCommand(new TextCommand({
        chainName: 'text',
        args: ['A'],
        errorContext: TEST_EC
      }), 'text');
      buffer.finish();

      const result = await chain.finalSnapshot();

      expect(result).to.be('A');
      expect(chain._completionResolved).to.be(true);
      expect(chain._completionPromise).to.be(null);
      expect(chain._resolveCompletion).to.be(null);
    });

    it('finishes aggregate buffer state after all lanes close', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(buffer, 'text', 'text', context, null);

      buffer.addCommand(new TextCommand({
        chainName: 'text',
        args: ['A'],
        errorContext: TEST_EC
      }), 'text');
      buffer.finish();

      const result = await chain.finalSnapshot();

      expect(result).to.be('A');
      expect(buffer.finished).to.be(true);
    });

    it('clears resolved sequence promise cache after async sequence target resolution', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const sequenceChain = declareBufferChain(buffer, 'logger', 'sequence', context, Promise.resolve({
        snapshot() {
          return ['ok'];
        }
      }));

      buffer.finish();

      const result = await sequenceChain.finalSnapshot();

      expect(result).to.eql(['ok']);
      expect(sequenceChain._sequenceTargetReady).to.be(true);
      expect(sequenceChain._sequenceTargetReadyPromise).to.be(null);
    });

    it('creates declared chain lanes and finishes unused lanes', function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(buffer, 'unused', 'var', context, null);

      expect(buffer.getChain('unused')).to.be(chain);
      expect(Object.keys(buffer.arrays)).to.eql(['unused']);
      expect(buffer.arrays.unused).to.eql([]);

      buffer.finish();

      expect(buffer.finished).to.be(true);
      expect(buffer.isChainFinished('unused')).to.be(true);
    });

    it('fails when a linked parent chain has no registered chain object', function () {
      const parent = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      declareBufferChain(parent, 'text', 'text', context, null);
      delete parent._chains.text;

      expect(() => new CommandBuffer(context, null, ['text'], parent, null, TEST_DIAGNOSTIC_CONTEXT)).to.throwError((err) => {
        expect(err.message).to.contain('Cannot link chain \'text\' without a registered chain object');
      });
      expect(parent.arrays.text).to.have.length(0);
    });

    it('rejects duplicate linked lane metadata', function () {
      expect(() => new CommandBuffer(context, null, ['text', 'text'], null, null, TEST_DIAGNOSTIC_CONTEXT)).to.throwError(/linkedChains contains duplicate chain 'text'/);
      expect(() => new CommandBuffer(context, null, [42], null, null, TEST_DIAGNOSTIC_CONTEXT)).to.throwError(/linkedChains contains a non-string chain name/);
    });

    it('treats repeated lane creation as an invariant failure', function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      declareBufferChain(buffer, 'text', 'text', context, null);

      expect(() => declareBufferChain(buffer, 'text', 'text', context, null)).to.throwError(/registered more than once/);
    });

    it('does not overwrite chain type metadata when duplicate declaration fails', function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      declareBufferChain(buffer, 'text', 'text', context, null);

      expect(() => declareBufferChain(buffer, 'text', 'var', context, null)).to.throwError(/registered more than once/);
      expect(buffer._chainTypes.text).to.be('text');
    });

    it('does not hide invalid async-boundary lane metadata', async function () {
      const parent = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      declareBufferChain(parent, 'text', 'text', context, null);
      try {
        await runControlFlowBoundary(parent, 'text', null, context, createRenderState(), async () => null, TEST_EC);
        throw new Error('expected invalid linked chain metadata to fail');
      } catch (err) {
        expect(err.name).to.be('RuntimeError');
        expect(err.message).to.contain('linkedChains must be an array when provided');
      }
    });


    it('stores linked mutated metadata for construction-time and late links', function () {
      const parent = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      declareBufferChain(parent, 'text', 'text', context, null);
      declareBufferChain(parent, 'data', 'data', context, null);

      const constructedChild = new CommandBuffer(context, null, ['text'], parent, ['text'], TEST_DIAGNOSTIC_CONTEXT);
      expect(constructedChild.isLinkedMutatedChain('text')).to.be(true);

      const lateLinkedChild = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      linkInheritanceCallableFootprintChains(parent, lateLinkedChild, ['text', 'data'], ['data'], TEST_EC);
      expect(lateLinkedChild.isLinkedMutatedChain('text')).to.be(false);
      expect(lateLinkedChild.isLinkedMutatedChain('data')).to.be(true);
    });

    it('links a child to an already-finished parent chain without structural insertion', function () {
      const parent = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(parent, 'text', 'text', context, null);
      parent.finish();

      const child = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      linkInheritanceCallableFootprintChains(parent, child, ['text'], null, TEST_EC);

      expect(child.getChain('text')).to.be(chain);
      expect(parent.arrays.text).to.be(null);
      expect(child.parent).to.be(null);
    });

    it('fails when finishing an unknown lane', function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      declareBufferChain(buffer, 'text', 'text', context, null);

      expect(() => buffer.finishChain('missing')).to.throwError((err) => {
        expect(err.name).to.be('RuntimeError');
        expect(err.message).to.contain('Chain \'missing\' is visible but this buffer has no linked lane');
      });
    });

    it('finds chains only through local declarations and explicit links', function () {
      const parent = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const child = new CommandBuffer(context, parent, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = declareBufferChain(parent, 'text', 'text', context, null);

      expect(parent.getChain('text')).to.be(chain);
      expect(child.hasChain('text')).to.be(false);

      parent.addBuffer(child, 'text');

      expect(child.getChain('text')).to.be(chain);
      expect(child.getOwnChain('text')).to.be(undefined);
      expect(child.hasChain('text')).to.be(true);
    });

    it('fails instead of lazily creating a lane when adding to an unlinked chain', function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);

      expect(() => {
        buffer.addCommand(new TextCommand({
          chainName: 'text',
          args: ['hidden'],
          errorContext: TEST_EC
        }), 'text');
      }).to.throwError(/has no linked lane/);
    });

    it('fails instead of lazily creating a lane when an iterator enters an unlinked chain', function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);

      expect(() => {
        buffer.onIteratorEnterBuffer({ onBufferFinished() {} }, 'text');
      }).to.throwError(/has no linked lane/);
    });
  });

  describe('Data Assembly (@put, @push, etc.)', function () {
    it('should handle a simple @data.set command', async function () {
      const buffer = createBuffer([cmd({ chainName: 'data', operation: 'set', args: [['user'], { name: 'Alice' }] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ user: { name: 'Alice' } });
    });

    it('should create nested objects with @data.set', async function () {
      const buffer = createBuffer([cmd({ chainName: 'data', operation: 'set', args: [['config', 'theme', 'color'], 'dark'] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ config: { theme: { color: 'dark' } } });
    });

    it('should handle a simple @data.push command', async function () {
      const buffer = createBuffer([cmd({ chainName: 'data', operation: 'push', args: [['users'], 'Alice'] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ users: ['Alice'] });
    });

    it('should create an array with @data.push if it does not exist', async function () {
      const buffer = createBuffer([cmd({ chainName: 'data', operation: 'push', args: [['config', 'admins'], 'root'] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ config: { admins: ['root'] } });
    });

    it('should handle the "[]" path syntax for creating and populating array items', async function () {
      const buffer = createBuffer([
        cmd({ chainName: 'data', operation: 'push', args: [['users'], { id: 0 }] }),
        cmd({ chainName: 'data', operation: 'set', args: [['users', '[]', 'id'], 1] }),
        cmd({ chainName: 'data', operation: 'set', args: [['users', 0, 'name'], 'Alice'] })
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ users: [{ id: 1, name: 'Alice' }] });
    });

    it('should handle the @data.merge command', async function () {
      const buffer = createBuffer([
        cmd({ chainName: 'data', operation: 'set', args: [['user'], { id: 1, name: 'Alice' }] }),
        cmd({ chainName: 'data', operation: 'merge', args: [['user'], { name: 'Alicia', active: true }] }),
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ user: { id: 1, name: 'Alicia', active: true } });
    });

    it('should handle null path to work on the root of the data object', async function () {
      const buffer = createBuffer([
        cmd({ chainName: 'data', operation: 'set', args: [null, { id: 5, name: 'Bob' }] })
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ id: 5, name: 'Bob' });
    });

    it('should handle null path with merge to combine with existing root data', async function () {
      const buffer = createBuffer([
        cmd({ chainName: 'data', operation: 'set', args: [['id'], 10] }),
        cmd({ chainName: 'data', operation: 'merge', args: [null, { name: 'Charlie' }] })
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ id: 10, name: 'Charlie' });
    });
  });

  describe('Text Chain & Mixed Content', function () {
    it('should join plain strings and numbers in the buffer', async function () {
      const buffer = createBuffer(['Hello', ' ', 'world', '!', 42], context, 'text');
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('Hello world!42');
    });

    it('should process nested buffer arrays', async function () {
      const buffer = createBuffer(['Outer', ['Middle', ['Inner']], 'End'], context, 'text');
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('OuterMiddleInnerEnd');
    });
  });

  describe('Sequence Chains (Factory & Singleton)', function () {
    it('should instantiate and use a factory-style sequence instance', function () {
      class CounterSequence {
        constructor() {
          this.count = 0;
        }
        increment() {
          this.count++;
        }
        getReturnValue() {
          return { count: this.count };
        }
      }

      const sequence = new CounterSequence();
      const commands = [
        cmd({ chainName: 'counter', methodName: 'increment', path: [], args: [] })
      ];

      flattenSequence(commands, context, 'counter', sequence);
      expect(sequence.getReturnValue()).to.eql({ count: 1 });
    });

    it('should use a singleton sequence instance', function () {
      const singletonSequence = {
        value: 0,
        set(val) { this.value = val; },
        getReturnValue() { return { value: this.value }; }
      };
      const commands = [cmd({ chainName: 'singleton', methodName: 'set', path: [], args: [456] })];

      flattenSequence(commands, context, 'singleton', singletonSequence);
      expect(singletonSequence.getReturnValue()).to.eql({ value: 456 });
    });

    it('should support callable sequence targets', function () {
      const callableSequence = function(val) { this.lastValue = val; };
      callableSequence.getReturnValue = function() { return { result: 'called', lastValue: this.lastValue }; };
      const commands = [cmd({ chainName: 'callable', path: [], args: ['test'] })];

      flattenSequence(commands, context, 'callable', callableSequence);
      expect(callableSequence.getReturnValue()).to.eql({ result: 'called', lastValue: 'test' });
    });
  });

  describe('Error Handling & Edge Cases', function () {
    it('should resolve snapshot at command position before later writes', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      buffer.bufferStackErrorContext = TEST_DIAGNOSTIC_CONTEXT;
      const textOut = declareBufferChain(buffer, 'text', 'text', context, null);

      textOut('A', TEST_EC);
      const snap = buffer.addCommand(new SnapshotCommand({
        chainName: 'text',
        errorContext: TEST_EC
      }), 'text');
      textOut('B', TEST_EC);
      buffer.finish();

      const early = await snap;
      const final = await textOut.finalSnapshot();
      expect(early).to.equal('A');
      expect(final).to.equal('AB');
    });

    it('should allow snapshot calls after buffer is already finished', async function () {
      const buffer = createBuffer(['A'], context, 'text');
      const textChain = makeChain(buffer, context, 'text');
      const first = await textChain.finalSnapshot();
      const second = await textChain.finalSnapshot();
      expect(first).to.equal('A');
      expect(second).to.equal('A');
    });

    it('finalSnapshot should wait for owning chain completion', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      buffer.bufferStackErrorContext = TEST_DIAGNOSTIC_CONTEXT;
      const out = declareBufferChain(buffer, 'text', 'text', context, null);
      out('late', TEST_EC);

      const early = await Promise.race([
        out.finalSnapshot(),
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 80))
      ]);
      expect(early).to.equal('__timeout__');

      buffer.finish();
      const resolved = await out.finalSnapshot();
      expect(resolved).to.equal('late');
    });

    it('tracks finished state per chain', async function () {
      const buffer = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      buffer.bufferStackErrorContext = TEST_DIAGNOSTIC_CONTEXT;
      const text = declareBufferChain(buffer, 'text', 'text', context, null);
      const data = declareBufferChain(buffer, 'data', 'data', context, null);

      text('later', TEST_EC);
      data.set(['ready'], 1, TEST_EC);

      buffer.finishChain('data');

      expect(buffer.isChainFinished('data')).to.be(true);
      expect(buffer.isChainFinished('text')).to.be(false);
      expect(buffer.finished).to.be(false);

      const dataSnapshot = await buffer.addCommand(new SnapshotCommand({
        chainName: 'data',
        errorContext: TEST_EC
      }), 'data');
      expect(dataSnapshot).to.eql({ ready: 1 });

      text(' now', TEST_EC);
      buffer.finishChain('text');

      expect(buffer.finished).to.be(false);
      buffer.finish();
      expect(buffer.finished).to.be(true);
      const textSnapshot = await text.finalSnapshot();
      expect(textSnapshot).to.equal('later now');
    });

    it('should handle an empty buffer', async function () {
      const buffer = createBuffer([], context, 'text');
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('');
    });

    it('should ignore null and undefined values in the buffer', async function () {
      const buffer = createBuffer(['Hello', null, undefined, 'World'], context, 'text');
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('HelloWorld');
    });

    it('should throw an error for an unknown command method on data chain', async function () {
      const buffer = createBuffer([cmd({ chainName: 'data', operation: 'nonexistent', args: [null] })], context, 'data');
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'data');
      }, (err) => {
        expect(err.message).to.contain('Unable to call `nonexistent`, which is undefined');
      });
    });

    it('should throw an error for a non-string/non-number path segment', async function () {
      const buffer = createBuffer([cmd({ chainName: 'data', operation: 'set', args: [[{}], 'value'] })], context, 'data');
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'data');
      }, (err) => {
        expect(err.message).to.contain('Invalid path segment');
      });
    });

    it('should reject CommandBuffer values inside TextCommand arguments', async function () {
      const nested = new CommandBuffer(context, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      declareBufferChain(nested, 'text', 'text', context, null);
      nested.addCommand(new TextCommand({ chainName: 'text', args: ['x'], errorContext: TEST_EC }), 'text');
      const buffer = createBuffer([
        new TextCommand({ chainName: 'text', args: [nested], errorContext: TEST_EC })
      ], context, 'text');

      await expectAsyncError(async () => {
        await flatten(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('Invalid TextCommand argument type');
      });
    });

    it('should reject plain object envelope values inside TextCommand arguments', async function () {
      const buffer = createBuffer([
        new TextCommand({ chainName: 'text', args: [{ text: 'wrapped' }], errorContext: TEST_EC })
      ], context, 'text');

      await expectAsyncError(async () => {
        await flatten(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('Invalid TextCommand argument type');
      });
    });
  });

  describe('Chain Snapshot Poison Handling', function () {
    describe('snapshot with simple templates', function () {
      it('should concatenate simple values', async function () {
        const arr = ['Hello', ' ', 'World'];
        const result = await flatten(createBuffer(arr));
        expect(result).to.equal('Hello World');
      });

      it('should handle nested arrays', async function () {
        const arr = ['A', ['B', 'C'], 'D'];
        const result = await flatten(createBuffer(arr));
        expect(result).to.equal('ABCD');
      });
    });

    describe('snapshot with script context - poison detection', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should collect poison from text output', async function () {
        const poison = createTestPoison(new Error('Output error'));
        const arr = ['Valid text', poison, 'More text'];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Output error');
        }
      });

      it('should collect multiple poisons', async function () {
        const poison1 = createTestPoison(new Error('Error 1'));
        const poison2 = createTestPoison(new Error('Error 2'));
        const arr = [poison1, 'text', poison2];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(2);
        }
      });

      it('should continue processing after finding poison', async function () {
        const poison = createTestPoison(new Error('Early error'));
        const arr = [poison, 'Valid', 'Text'];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(1);
        }
      });

      it('should collect poison from nested arrays', async function () {
        const poison = createTestPoison(new Error('Nested error'));
        const arr = ['text', ['nested', poison, 'more'], 'end'];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should collect poison from arrays with functions', async function () {
        const poison = createTestPoison(new Error('Func array error'));
        const arr = [['prefix', poison, (val) => val.toUpperCase()]];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should handle command objects with poisoned args', async function () {
        const poison = createTestPoison(new Error('Arg error'));
        const arr = [cmd({
          chainName: 'text',
          args: ['valid', poison],
          errorContext: TEST_EC
        })];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should return a valid snapshot when no poison is found', async function () {
        const arr = ['Hello', ' ', 'World'];
        const result = await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
        expect(result).to.equal('Hello World');
      });
    });

    describe('Error deduplication in snapshot', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should deduplicate identical errors', async function () {
        const err = new Error('Duplicate');
        const poison1 = createTestPoison(err);
        const poison2 = createTestPoison(err);
        const arr = [poison1, poison2];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(1);
        }
      });

      it('should keep distinct errors', async function () {
        const poison1 = createTestPoison(new Error('Error A'));
        const poison2 = createTestPoison(new Error('Error B'));
        const arr = [poison1, poison2];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(2);
        }
      });
    });

    describe('Complete error collection', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should process entire buffer even with early errors', async function () {
        const errors = [
          createTestPoison(new Error('Error 1')),
          'valid',
          createTestPoison(new Error('Error 2')),
          'more valid',
          createTestPoison(new Error('Error 3'))
        ];

        try {
          await flatten(createBuffer(errors, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(3);
        }
      });

      it('should collect errors from multiple nested levels', async function () {
        const arr = [
          createTestPoison(new Error('Level 0')),
          ['text', createTestPoison(new Error('Level 1')), [createTestPoison(new Error('Level 2'))]]
        ];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(3);
        }
      });
    });

    describe('Chain command error collection', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should collect data chain method errors', async function () {
        const arr = [cmd({
          chainName: 'data',
          operation: 'nonexistentMethod',
          args: [null],
          errorContext: TEST_EC
        })];

        try {
          await flatten(createBuffer(arr, poisonContext, 'data'), poisonContext, 'data');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.contain('Unable to call `nonexistentMethod`, which is undefined');
        }
      });

    });

    describe('Complex nested poison scenarios', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should handle poison in deeply nested structures', async function () {
        const arr = [
          'start',
          ['level1', ['level2', createTestPoison(new Error('Deep poison')), 'more level2'], 'more level1'],
          'end'
        ];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors).to.have.length(1);
        }
      });
    });

    describe('Chain name handling', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should handle chain name with poison', async function () {
        const poison = createTestPoison(new Error('Focus poison'));
        const arr = [poison, 'text'];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
        }
      });

      it('should return a text chain snapshot when no poison', async function () {
        const arr = ['Hello', ' ', 'World'];
        const result = await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
        expect(result).to.equal('Hello World');
      });
    });
  });

  describe('Async Autoescape — integration', function () {
    describe('sync values', function () {
      beforeEach(() => {
        env = new AsyncEnvironment(null, { autoescape: true });
      });

      it('should escape HTML entities in {{ }} output', async function () {
        const result = await env.renderTemplateString('{{ value }}', { value: '<b>bold</b>' });
        expect(result).to.equal('&lt;b&gt;bold&lt;/b&gt;');
      });

      it('should not escape with autoescape off', async function () {
        const offEnv = new AsyncEnvironment(null, { autoescape: false });
        const result = await offEnv.renderTemplateString('{{ value }}', { value: '<b>bold</b>' });
        expect(result).to.equal('<b>bold</b>');
      });

      it('should bypass autoescape with | safe filter', async function () {
        const result = await env.renderTemplateString('{{ value | safe }}', { value: '<b>bold</b>' });
        expect(result).to.equal('<b>bold</b>');
      });

      it('should coerce null to empty string', async function () {
        const result = await env.renderTemplateString('x{{ value }}y', { value: null });
        expect(result).to.equal('xy');
      });

      it('should coerce undefined to empty string', async function () {
        const result = await env.renderTemplateString('x{{ value }}y', {});
        expect(result).to.equal('xy');
      });
    });

    describe('async context functions', function () {
      beforeEach(() => {
        env = new AsyncEnvironment(null, { autoescape: true });
      });

      it('should escape value resolved from async function', async function () {
        const result = await env.renderTemplateString('{{ getHtml() }}', {
          getHtml: () => Promise.resolve('<em>async</em>')
        });
        expect(result).to.equal('&lt;em&gt;async&lt;/em&gt;');
      });

      it('should not escape async value with autoescape off', async function () {
        const offEnv = new AsyncEnvironment(null, { autoescape: false });
        const result = await offEnv.renderTemplateString('{{ getHtml() }}', {
          getHtml: () => Promise.resolve('<em>async</em>')
        });
        expect(result).to.equal('<em>async</em>');
      });

      it('should bypass autoescape on async value with | safe', async function () {
        const result = await env.renderTemplateString('{{ getHtml() | safe }}', {
          getHtml: () => Promise.resolve('<b>safe</b>')
        });
        expect(result).to.equal('<b>safe</b>');
      });

      it('should escape multiple parallel async expressions independently', async function () {
        const result = await env.renderTemplateString('{{ a() }} and {{ b() }}', {
          a: () => Promise.resolve('<i>one</i>'),
          b: () => Promise.resolve('<i>two</i>')
        });
        expect(result).to.equal('&lt;i&gt;one&lt;/i&gt; and &lt;i&gt;two&lt;/i&gt;');
      });
    });

    describe('macro boundary — no double-escape', function () {
      // Each {{ }} inside a macro is escaped per-expression. The macro output
      // is wrapped in SafeString at the boundary (new SafeString(snapshot(...))).
      // Interpolating the result in the outer template must not escape again.
      beforeEach(() => {
        env = new AsyncEnvironment(null, { autoescape: true });
      });

      it('should not double-escape sync macro argument', async function () {
        const template =
          '{% macro card(title) %}<div>{{ title }}</div>{% endmacro %}' +
          '{{ card("<b>Hello</b>") }}';
        const result = await env.renderTemplateString(template, {});
        // '<b>Hello</b>' escaped once inside macro. SafeString at boundary
        // prevents re-escape at the outer {{ card(...) }}.
        expect(result).to.equal('<div>&lt;b&gt;Hello&lt;/b&gt;</div>');
      });

      it('should not double-escape async macro argument', async function () {
        const template =
          '{% macro wrap(content) %}<span>{{ content }}</span>{% endmacro %}' +
          '{{ wrap(getHtml()) }}';
        const result = await env.renderTemplateString(template, {
          getHtml: () => Promise.resolve('<script>xss</script>')
        });
        expect(result).to.contain('&lt;script&gt;xss&lt;/script&gt;');
        // If double-escaped, & would become &amp; — must not happen
        expect(result).to.not.contain('&amp;lt;');
      });
    });

    describe('throwOnUndefined + autoescape', function () {
      // Compiler wraps output expressions with ensureDefinedAsync when
      // throwOnUndefined is enabled. Validation runs before escape.
      beforeEach(() => {
        env = new AsyncEnvironment(null, { autoescape: true, throwOnUndefined: true });
      });

      it('should escape a defined value normally', async function () {
        const result = await env.renderTemplateString('{{ value }}', { value: '<b>x</b>' });
        expect(result).to.equal('&lt;b&gt;x&lt;/b&gt;');
      });

      it('should throw on null output value', async function () {
        try {
          await env.renderTemplateString('{{ value }}', { value: null });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('null or undefined');
        }
      });

      it('should throw when async function resolves to null', async function () {
        try {
          await env.renderTemplateString('{{ getValue() }}', {
            getValue: () => Promise.resolve(null)
          });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('null or undefined');
        }
      });

      it('should throw when async function resolves to undefined', async function () {
        try {
          await env.renderTemplateString('{{ getValue() }}', {
            getValue: () => Promise.resolve(undefined)
          });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(err.message).to.contain('null or undefined');
        }
      });
    });

    describe('script @text output', function () {
      // Script output uses suppressValueScript (not suppressValueAsync)
      // and resolves through command snapshots in processArrayItem - a separate
      // path from template {{ }} which goes through flattenText.
      beforeEach(() => {
        env = new AsyncEnvironment(null, { autoescape: true });
      });

      it('should escape HTML in sync text output', async function () {
        const script = `
          text out
          out("<b>bold</b>")
          return out.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.equal('&lt;b&gt;bold&lt;/b&gt;');
      });

      it('should escape async function result in text output', async function () {
        const script = `
          text out
          out(getHtml())
          return out.snapshot()`;
        const result = await env.renderScriptString(script, {
          getHtml: () => Promise.resolve('<em>async</em>')
        });
        expect(result).to.equal('&lt;em&gt;async&lt;/em&gt;');
      });

      it('should escape async variable in text output', async function () {
        const script = `
          text out
          var html = getHtml()
          out(html)
          return out.snapshot()`;
        const result = await env.renderScriptString(script, {
          getHtml: () => Promise.resolve('<script>xss</script>')
        });
        expect(result).to.equal('&lt;script&gt;xss&lt;/script&gt;');
      });

      it('should not escape text output with autoescape off', async function () {
        const offEnv = new AsyncEnvironment(null, { autoescape: false });
        const script = `
          text out
          out("<b>bold</b>")
          return out.snapshot()`;
        const result = await offEnv.renderScriptString(script);
        expect(result).to.equal('<b>bold</b>');
      });

      it('should escape multiple text calls independently', async function () {
        const script = `
          text out
          out("<i>one</i>")
          out("<i>two</i>")
          return out.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.equal('&lt;i&gt;one&lt;/i&gt;&lt;i&gt;two&lt;/i&gt;');
      });
    });
  });
});
