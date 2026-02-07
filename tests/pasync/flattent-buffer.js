'use strict';

let expect;
let AsyncEnvironment;
let flattenBuffer;
let expectAsyncError;
let TextCommand;
let DataCommand;
let SinkCommand;
let CommandBuffer;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  flattenBuffer = require('../../src/runtime/runtime').flattenBuffer;
  TextCommand = require('../../src/runtime/runtime').TextCommand;
  DataCommand = require('../../src/runtime/runtime').DataCommand;
  SinkCommand = require('../../src/runtime/runtime').SinkCommand;
  CommandBuffer = require('../../src/runtime/runtime').CommandBuffer;
  expectAsyncError = require('../util').expectAsyncError;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  flattenBuffer = nunjucks.runtime.flattenBuffer;
  TextCommand = nunjucks.runtime.TextCommand;
  DataCommand = nunjucks.runtime.DataCommand;
  SinkCommand = nunjucks.runtime.SinkCommand;
  CommandBuffer = nunjucks.runtime.CommandBuffer;
  expectAsyncError = nunjucks.util.expectAsyncError;
}

describe('flattenBuffer', function () {
  let env;
  let context;
  const makeOutput = (buffer, ctx, outputName) => ({
    _buffer: buffer,
    _context: ctx || null,
    _outputName: outputName || 'output',
    _outputType: outputName || 'text'
  });
  const flatten = (buffer, ctx, outputName) => (
    flattenBuffer(makeOutput(buffer, ctx, outputName), ctx)
  );
  const flattenSink = (commands, ctx, outputName, sink) => {
    const buffer = new CommandBuffer(ctx, null);
    const sinkOutput = {
      _buffer: buffer,
      _context: ctx || null,
      _outputName: outputName,
      _outputType: 'sink',
      _sink: sink,
      _sinkFinalized: false,
      _resolveSink() {
        return this._sink;
      }
    };

    buffer._outputTypes = Object.create(null);
    buffer._outputTypes[outputName] = 'sink';
    buffer._outputs = Object.create(null);
    buffer._outputs[outputName] = sinkOutput;
    buffer._outputHandlers = Object.create(null);
    buffer._outputHandlers[outputName] = sinkOutput;

    commands.forEach((entry) => buffer.add(entry, outputName));
    flattenBuffer(sinkOutput, ctx);
    return sink;
  };
  const cmd = (spec) => {
    if (spec.handler === 'data') {
      return new DataCommand(spec);
    }
    if (spec.handler === 'text') {
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
      const buffer = [cmd({ handler: 'data', command: 'set', arguments: [['user'], { name: 'Alice' }] })];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ user: { name: 'Alice' } });
    });

    it('should create nested objects with @data.set', async function () {
      const buffer = [cmd({ handler: 'data', command: 'set', arguments: [['config', 'theme', 'color'], 'dark'] })];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ config: { theme: { color: 'dark' } } });
    });

    it('should handle a simple @data.push command', async function () {
      const buffer = [cmd({ handler: 'data', command: 'push', arguments: [['users'], 'Alice'] })];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ users: ['Alice'] });
    });

    it('should create an array with @data.push if it does not exist', async function () {
      const buffer = [cmd({ handler: 'data', command: 'push', arguments: [['config', 'admins'], 'root'] })];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ config: { admins: ['root'] } });
    });

    it('should handle the "[]" path syntax for creating and populating array items', async function () {
      const buffer = [
        cmd({ handler: 'data', command: 'push', arguments: [['users'], { id: 0 }] }),
        cmd({ handler: 'data', command: 'set', arguments: [['users', '[]', 'id'], 1] }),
        cmd({ handler: 'data', command: 'set', arguments: [['users', 0, 'name'], 'Alice'] })
      ];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ users: [{ id: 1, name: 'Alice' }] });
    });

    it('should handle the @data.merge command', async function () {
      const buffer = [
        cmd({ handler: 'data', command: 'set', arguments: [['user'], { id: 1, name: 'Alice' }] }),
        cmd({ handler: 'data', command: 'merge', arguments: [['user'], { name: 'Alicia', active: true }] }),
      ];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ user: { id: 1, name: 'Alicia', active: true } });
    });

    it('should handle null path to work on the root of the data object', async function () {
      const buffer = [
        cmd({ handler: 'data', command: 'set', arguments: [null, { id: 5, name: 'Bob' }] })
      ];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ id: 5, name: 'Bob' });
    });

    it('should handle null path with merge to combine with existing root data', async function () {
      const buffer = [
        cmd({ handler: 'data', command: 'set', arguments: [['id'], 10] }),
        cmd({ handler: 'data', command: 'merge', arguments: [null, { name: 'Charlie' }] })
      ];
      const result = await flatten(buffer, context, 'data');
      expect(result).to.eql({ id: 10, name: 'Charlie' });
    });
  });

  describe('Text Output & Mixed Content', function () {
    it('should join plain strings and numbers in the buffer', async function () {
      const buffer = ['Hello', ' ', 'world', '!', 42];
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('Hello world!42');
    });

    it('should process nested buffer arrays', async function () {
      const buffer = ['Outer', ['Middle', ['Inner']], 'End'];
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('OuterMiddleInnerEnd');
    });
  });

  describe('Sink Outputs (Factory & Singleton)', function () {
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
        cmd({ handler: 'counter', command: 'increment', subpath: [], arguments: [] })
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
      const commands = [cmd({ handler: 'singleton', command: 'set', subpath: [], arguments: [456] })];

      flattenSink(commands, context, 'singleton', singletonSink);
      expect(singletonSink.getReturnValue()).to.eql({ value: 456 });
    });

    it('should support callable sink targets (sink is a function)', function () {
      const callableSink = function(val) { this.lastValue = val; };
      callableSink.getReturnValue = function() { return { result: 'called', lastValue: this.lastValue }; };
      const commands = [cmd({ handler: 'callable', command: null, subpath: [], arguments: ['test'] })];

      flattenSink(commands, context, 'callable', callableSink);
      expect(callableSink.getReturnValue()).to.eql({ result: 'called', lastValue: 'test' });
    });
  });

  describe('Error Handling & Edge Cases', function () {
    it('should handle an empty buffer', async function () {
      const buffer = [];
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('');
    });

    it('should ignore null and undefined values in the buffer', async function () {
      const buffer = ['Hello', null, undefined, 'World'];
      const result = await flatten(buffer, context, 'text');
      expect(result).to.equal('HelloWorld');
    });

    it('should throw an error for an unsupported output command target', async function () {
      const buffer = [cmd({ handler: 'nonexistent', command: 'method', subpath: [], arguments: [] })];
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('Unsupported output command target: nonexistent');
      });
    });

    it('should throw an error for an unknown command method on data output', async function () {
      const buffer = [cmd({ handler: 'data', command: 'nonexistent', subpath: [], arguments: [null] })];
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'data');
      }, (err) => {
        expect(err.message).to.contain('has no method');
      });
    });

    it('should throw an error for a non-string/non-number path segment', async function () {
      const buffer = [cmd({ handler: 'data', command: 'set', arguments: [[{}], 'value'] })];
      await expectAsyncError(async () => {
        await flatten(buffer, context, 'data');
      }, (err) => {
        expect(err.message).to.contain('Invalid path segment');
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
      // is wrapped in SafeString at the boundary (new SafeString(flattenBuffer(...))).
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
      // and flattens through flatten-commands.js processArrayItem — a separate
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
