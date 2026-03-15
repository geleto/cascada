'use strict';

let expect;
let AsyncEnvironment;
let expectAsyncError;
let TextCommand;
let DataCommand;
let SinkCommand;
let CommandBuffer;
let createChannel;
let createSinkChannel;
let createPoison;
let isPoisonError;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  TextCommand = require('../../src/runtime/runtime').TextCommand;
  DataCommand = require('../../src/runtime/runtime').DataCommand;
  SinkCommand = require('../../src/runtime/runtime').SinkCommand;
  CommandBuffer = require('../../src/runtime/runtime').CommandBuffer;
  createChannel = require('../../src/runtime/runtime').createChannel;
  createSinkChannel = require('../../src/runtime/runtime').createSinkChannel;
  createPoison = require('../../src/runtime/runtime').createPoison;
  isPoisonError = require('../../src/runtime/runtime').isPoisonError;
  expectAsyncError = require('../util').expectAsyncError;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  TextCommand = nunjucks.runtime.TextCommand;
  DataCommand = nunjucks.runtime.DataCommand;
  SinkCommand = nunjucks.runtime.SinkCommand;
  CommandBuffer = nunjucks.runtime.CommandBuffer;
  createChannel = nunjucks.runtime.createChannel;
  createSinkChannel = nunjucks.runtime.createSinkChannel;
  createPoison = nunjucks.runtime.createPoison;
  isPoisonError = nunjucks.runtime.isPoisonError;
  expectAsyncError = nunjucks.util.expectAsyncError;
}

describe('channel.finalSnapshot', function () {
  let env;
  let context;
  const createBuffer = (input, ctx, channelName) => {
    const targetName = channelName || 'text';
    const cb = new CommandBuffer(ctx || null, null, { parent: null });
    const addItem = (buffer, item) => {
      if (item instanceof CommandBuffer) {
        buffer.add(item, targetName);
        return;
      }
      if (Array.isArray(item)) {
        const nested = new CommandBuffer(ctx || null, null, { parent: null });
        item.forEach((child) => addItem(nested, child));
        nested.markFinishedAndPatchLinks();
        buffer.add(nested, targetName);
        return;
      }
      if (item instanceof TextCommand || item instanceof DataCommand || item instanceof SinkCommand) {
        buffer.add(item, targetName);
        return;
      }
      if (targetName === 'text') {
        buffer.add(new TextCommand({ channelName: 'text', args: [item], pos: { lineno: 0, colno: 0 } }), targetName);
        return;
      }
      buffer.add(item, targetName);
    };
    if (Array.isArray(input)) {
      input.forEach((item) => addItem(cb, item));
    } else if (input !== null && input !== undefined) {
      addItem(cb, input);
    }
    cb.markFinishedAndPatchLinks();
    return cb;
  };
  const makeChannel = (buffer, ctx, channelName) => {
    const name = channelName || 'text';
    const frame = { parent: null };
    return createChannel(frame, buffer, name, ctx || null, name);
  };
  const flatten = (buffer, ctx, channelName) => (
    makeChannel(buffer, ctx, channelName).finalSnapshot()
  );
  const flattenSink = (commands, ctx, channelName, sink) => {
    const buffer = new CommandBuffer(ctx, null, { parent: null });
    const frame = { parent: null };
    const sinkChannel = createSinkChannel(frame, buffer, channelName, ctx || null, sink);

    buffer._channelTypes = Object.create(null);
    buffer._channelTypes[channelName] = 'sink';
    // Don't overwrite buffer._channels - it's already a Map from the constructor
    // Just ensure the sink channel is registered (it should be from constructor)
    if (buffer._channels instanceof Map) {
      buffer._channels.set(channelName, sinkChannel);
    }

    commands.forEach((entry) => buffer.add(entry, channelName));
    sinkChannel.finalSnapshot();
    return sink;
  };
  const cmd = (spec) => {
    if (spec.channelName === 'data') {
      return new DataCommand(spec);
    }
    if (spec.channelName === 'text') {
      return new TextCommand(spec);
    }
    return new SinkCommand(spec);
  };

  // For each test, create a fresh environment and context.
  beforeEach(() => {
    env = new AsyncEnvironment();
    context = {
      getVariables: () => ({ userId: 123 }),
      env: env,
    };
  });

  describe('Data Assembly (@put, @push, etc.)', function () {
    it('should handle a simple @data.set command', async function () {
      const buffer = createBuffer([cmd({ channelName: 'data', command: 'set', arguments: [['user'], { name: 'Alice' }] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ user: { name: 'Alice' } });
    });

    it('should create nested objects with @data.set', async function () {
      const buffer = createBuffer([cmd({ channelName: 'data', command: 'set', arguments: [['config', 'theme', 'color'], 'dark'] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ config: { theme: { color: 'dark' } } });
    });

    it('should handle a simple @data.push command', async function () {
      const buffer = createBuffer([cmd({ channelName: 'data', command: 'push', arguments: [['users'], 'Alice'] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ users: ['Alice'] });
    });

    it('should create an array with @data.push if it does not exist', async function () {
      const buffer = createBuffer([cmd({ channelName: 'data', command: 'push', arguments: [['config', 'admins'], 'root'] })], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ config: { admins: ['root'] } });
    });

    it('should handle the "[]" path syntax for creating and populating array items', async function () {
      const buffer = createBuffer([
        cmd({ channelName: 'data', command: 'push', arguments: [['users'], { id: 0 }] }),
        cmd({ channelName: 'data', command: 'set', arguments: [['users', '[]', 'id'], 1] }),
        cmd({ channelName: 'data', command: 'set', arguments: [['users', 0, 'name'], 'Alice'] })
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ users: [{ id: 1, name: 'Alice' }] });
    });

    it('should handle the @data.merge command', async function () {
      const buffer = createBuffer([
        cmd({ channelName: 'data', command: 'set', arguments: [['user'], { id: 1, name: 'Alice' }] }),
        cmd({ channelName: 'data', command: 'merge', arguments: [['user'], { name: 'Alicia', active: true }] }),
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ user: { id: 1, name: 'Alicia', active: true } });
    });

    it('should handle null path to work on the root of the data object', async function () {
      const buffer = createBuffer([
        cmd({ channelName: 'data', command: 'set', arguments: [null, { id: 5, name: 'Bob' }] })
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ id: 5, name: 'Bob' });
    });

    it('should handle null path with merge to combine with existing root data', async function () {
      const buffer = createBuffer([
        cmd({ channelName: 'data', command: 'set', arguments: [['id'], 10] }),
        cmd({ channelName: 'data', command: 'merge', arguments: [null, { name: 'Charlie' }] })
      ], context, 'data');
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ id: 10, name: 'Charlie' });
    });
  });

  describe('Text Channel & Mixed Content', function () {
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

  describe('Sink Channels (Factory & Singleton)', function () {
    it('should instantiate and use a factory-style sink instance', function () {
      class CounterSink {
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

      const sink = new CounterSink();
      const commands = [
        cmd({ channelName: 'counter', command: 'increment', subpath: [], arguments: [] })
      ];

      flattenSink(commands, context, 'counter', sink);
      expect(sink.getReturnValue()).to.eql({ count: 1 });
    });

    it('should use a singleton sink instance', function () {
      const singletonSink = {
        value: 0,
        set(val) { this.value = val; },
        getReturnValue() { return { value: this.value }; }
      };
      const commands = [cmd({ channelName: 'singleton', command: 'set', subpath: [], arguments: [456] })];

      flattenSink(commands, context, 'singleton', singletonSink);
      expect(singletonSink.getReturnValue()).to.eql({ value: 456 });
    });

    it('should support callable sink targets (sink is a function)', function () {
      const callableSink = function(val) { this.lastValue = val; };
      callableSink.getReturnValue = function() { return { result: 'called', lastValue: this.lastValue }; };
      const commands = [cmd({ channelName: 'callable', command: null, subpath: [], arguments: ['test'] })];

      flattenSink(commands, context, 'callable', callableSink);
      expect(callableSink.getReturnValue()).to.eql({ result: 'called', lastValue: 'test' });
    });
  });

  describe('Error Handling & Edge Cases', function () {
    it('should resolve snapshot at command position before later writes', async function () {
      const buffer = new CommandBuffer(context, null, { parent: null });
      const frame = { parent: null };
      const textOut = createChannel(frame, buffer, 'text', context, 'text');

      textOut('A');
      const snap = buffer.addSnapshot('text', { lineno: 0, colno: 0 });
      textOut('B');
      buffer.markFinishedAndPatchLinks();

      const early = await snap;
      const final = await textOut.finalSnapshot();
      expect(early).to.equal('A');
      expect(final).to.equal('AB');
    });

    it('should allow snapshot calls after buffer is already finished', async function () {
      const buffer = createBuffer(['A'], context, 'text');
      const textChannel = makeChannel(buffer, context, 'text');
      const first = await textChannel.finalSnapshot();
      const second = await textChannel.finalSnapshot();
      expect(first).to.equal('A');
      expect(second).to.equal('A');
    });

    it('finalSnapshot should wait for owning channel completion', async function () {
      const buffer = new CommandBuffer(context, null, { parent: null });
      const frame = { parent: null };
      const out = createChannel(frame, buffer, 'text', context, 'text');
      out('late');

      const early = await Promise.race([
        out.finalSnapshot(),
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 80))
      ]);
      expect(early).to.equal('__timeout__');

      buffer.markFinishedAndPatchLinks();
      const resolved = await out.finalSnapshot();
      expect(resolved).to.equal('late');
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

    it('should throw an error for an unsupported channel command target', async function () {
      const buffer = createBuffer([cmd({ channelName: 'nonexistent', command: 'method', subpath: [], arguments: [] })]);
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('Sink method \'method\' not found');
      });
    });

    it('should throw an error for an unknown command method on data channel', async function () {
      const buffer = createBuffer([cmd({ channelName: 'data', command: 'nonexistent', subpath: [], arguments: [null] })], context, 'data');
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'data');
      }, (err) => {
        expect(err.message).to.contain('has no method');
      });
    });

    it('should throw an error for a non-string/non-number path segment', async function () {
      const buffer = createBuffer([cmd({ channelName: 'data', command: 'set', arguments: [[{}], 'value'] })], context, 'data');
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'data');
      }, (err) => {
        expect(err.message).to.contain('Invalid path segment');
      });
    });

    it('should reject CommandBuffer values inside TextCommand arguments', async function () {
      const nested = new CommandBuffer(context, null, { parent: null });
      nested.add(new TextCommand({ channelName: 'text', args: ['x'], pos: { lineno: 0, colno: 0 } }), 'text');
      const buffer = createBuffer([
        new TextCommand({ channelName: 'text', args: [nested], pos: { lineno: 1, colno: 1 } })
      ], context, 'text');

      await expectAsyncError(async () => {
        await flatten(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('Invalid TextCommand argument type');
      });
    });

    it('should reject plain object envelope values inside TextCommand arguments', async function () {
      const buffer = createBuffer([
        new TextCommand({ channelName: 'text', args: [{ text: 'wrapped' }], pos: { lineno: 1, colno: 1 } })
      ], context, 'text');

      await expectAsyncError(async () => {
        await flatten(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('Invalid TextCommand argument type');
      });
    });
  });

  describe('Channel Snapshot Poison Handling', function () {
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
        const poison = createPoison(new Error('Output error'));
        const arr = ['Valid text', poison, 'More text'];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.equal('Output error');
        }
      });

      it('should collect multiple poisons', async function () {
        const poison1 = createPoison(new Error('Error 1'));
        const poison2 = createPoison(new Error('Error 2'));
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
        const poison = createPoison(new Error('Early error'));
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
        const poison = createPoison(new Error('Nested error'));
        const arr = ['text', ['nested', poison, 'more'], 'end'];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should collect poison from arrays with functions', async function () {
        const poison = createPoison(new Error('Func array error'));
        const arr = [['prefix', poison, (val) => val.toUpperCase()]];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should handle command objects with poisoned args', async function () {
        const poison = createPoison(new Error('Arg error'));
        const arr = [cmd({
          channelName: 'text',
          command: null,
          subpath: [],
          arguments: ['valid', poison],
          pos: { lineno: 1, colno: 1 }
        })];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('should collect errors from channel instantiation failures', async function () {
        const arr = [cmd({
          channelName: 'nonexistent',
          command: 'method',
          subpath: [],
          arguments: ['arg'],
          pos: { lineno: 5, colno: 10 }
        })];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Sink method \'method\' not found');
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
        const poison1 = createPoison(err);
        const poison2 = createPoison(err);
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
        const poison1 = createPoison(new Error('Error A'));
        const poison2 = createPoison(new Error('Error B'));
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
          createPoison(new Error('Error 1')),
          'valid',
          createPoison(new Error('Error 2')),
          'more valid',
          createPoison(new Error('Error 3'))
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
          createPoison(new Error('Level 0')),
          ['text', createPoison(new Error('Level 1')), [createPoison(new Error('Level 2'))]]
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

    describe('Channel command error collection', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should collect data channel method errors', async function () {
        const arr = [cmd({
          channelName: 'data',
          command: 'nonexistentMethod',
          subpath: [],
          arguments: [null],
          pos: { lineno: 1, colno: 1 }
        })];

        try {
          await flatten(createBuffer(arr, poisonContext, 'data'), poisonContext, 'data');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.contain('has no method');
        }
      });

      it('should collect unsupported channel target errors', async function () {
        const arr = [cmd({
          channelName: 'badHandler',
          command: 'method',
          subpath: ['nested', 'path'],
          arguments: [],
          pos: { lineno: 2, colno: 5 }
        })];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
          expect(thrown.errors[0].message).to.contain('Sink method \'method\' not found');
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
          ['level1', ['level2', createPoison(new Error('Deep poison')), 'more level2'], 'more level1'],
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

    describe('Channel name handling', function () {
      let poisonContext;

      beforeEach(() => {
        poisonContext = {
          env: {},
          path: '/test.html',
          getVariables: () => ({})
        };
      });

      it('should handle channel name with poison', async function () {
        const poison = createPoison(new Error('Focus poison'));
        const arr = [poison, 'text'];

        try {
          await flatten(createBuffer(arr, poisonContext, 'text'), poisonContext, 'text');
          expect().fail('Should have thrown');
        } catch (thrown) {
          expect(isPoisonError(thrown)).to.be(true);
        }
      });

      it('should return a text channel snapshot when no poison', async function () {
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
      // Script output uses suppressValueScriptAsync (not suppressValueAsync)
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
