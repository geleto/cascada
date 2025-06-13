'use strict';

let expect;
let AsyncEnvironment;
let flattenBuffer;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../src/environment').AsyncEnvironment;
  flattenBuffer = require('../src/runtime').flattenBuffer;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  flattenBuffer = nunjucks.runtime.flattenBuffer;
}

// Helper function for async rejection tests with expect.js
async function expectAsyncError(asyncFn, checkFn) {
  let error = null;
  try {
    await asyncFn();
  } catch (e) {
    error = e;
  }

  expect(error).to.be.an(Error); // Check an error was thrown
  if (checkFn) {
    checkFn(error); // Optional additional checks on the error
  }
}

describe('flattenBuffer', function () {
  let env;
  let context;

  // For each test, create a fresh environment and context.
  beforeEach(() => {
    env = new AsyncEnvironment();
    context = {
      getVariables: () => ({ userId: 123 }),
      env: env,
    };
  });

  describe('Data Assembly (@put, @push, etc.)', function () {
    // Add the necessary data methods for this test suite.
    beforeEach(() => {
      env.addDataMethods({
        put: (target, key, value) => { target[key] = value; },
        push: (target, key, value) => {
          if (!Array.isArray(target[key])) target[key] = [];
          target[key].push(value);
        },
        merge: (target, key, value) => {
          if (typeof target[key] !== 'object' || target[key] === null) {
            target[key] = {};
          }
          Object.assign(target[key], value);
        }
      });
    });

    it('should handle a simple @put command', async function () {
      const buffer = [{ method: 'put', path: ['user'], value: { name: 'Alice' } }];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ data: { user: { name: 'Alice' } } });
    });

    it('should create nested objects with @put', async function () {
      const buffer = [{ method: 'put', path: ['config', 'theme', 'color'], value: 'dark' }];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ data: { config: { theme: { color: 'dark' } } } });
    });

    it('should handle a simple @push command', async function () {
      const buffer = [{ method: 'push', path: ['users'], value: 'Alice' }];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ data: { users: ['Alice'] } });
    });

    it('should create an array with @push if it does not exist', async function () {
      const buffer = [{ method: 'push', path: ['config', 'admins'], value: 'root' }];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ data: { config: { admins: ['root'] } } });
    });

    it('should handle the "[]" path syntax for creating and populating array items', async function () {
      const buffer = [
        { method: 'put', path: ['users', '[]', 'id'], value: 1 },
        { method: 'put', path: ['users', 0, 'name'], value: 'Alice' }
      ];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ data: { users: [{ id: 1, name: 'Alice' }] } });
    });

    it('should handle the @merge command', async function () {
      const buffer = [
        { method: 'put', path: ['user'], value: { id: 1, name: 'Alice' } },
        { method: 'merge', path: ['user'], value: { name: 'Alicia', active: true } },
      ];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ data: { user: { id: 1, name: 'Alicia', active: true } } });
    });
  });

  describe('Text Output & Mixed Content', function () {
    it('should join plain strings and numbers in the buffer', async function () {
      const buffer = ['Hello, ', 'world! ', 2024];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ text: 'Hello, world! 2024' });
    });

    it('should handle @print commands (handler: null)', async function () {
      const buffer = [{ handler: null, command: 'print', arguments: ['Log message.'] }];
      const result = await flattenBuffer(buffer, context, null, 'text');
      expect(result).to.eql({ text: 'Log message.' });
    });

    it('should process nested buffer arrays', async function () {
      const buffer = ['<div>', ['<p>', 'content', '</p>'], '</div>'];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ text: '<div><p>content</p></div>' });
    });
  });

  describe('Command Handlers (Factory & Singleton)', function () {
    class CanvasTurtle {
      constructor(ctx) { this.x = 0; this.y = 0; this.contextUserId = ctx.userId; }
      forward(dist) { this.x += dist; }
      turn(deg) { this.y += deg; }
    }

    const logger = {
      logs: [],
      _init(ctx) { this.logs = [`Initialized for user ${ctx.userId}`]; },
      log(message) { this.logs.push(message); }
    };

    const createCallableHandler = () => {
      const handler = function (...args) {
        handler.calledWith.push(args);
      };
      handler.calledWith = [];
      return handler;
    };

    it('should instantiate and use a factory handler', async function () {
      env.addCommandHandlerClass('turtle', CanvasTurtle);
      const buffer = [
        { handler: 'turtle', command: 'forward', arguments: [50] },
        { handler: 'turtle', command: 'turn', arguments: [90] }
      ];
      const result = await flattenBuffer(buffer, context);
      expect(result.turtle.x).to.equal(50);
      expect(result.turtle.y).to.equal(90);
      expect(result.turtle.contextUserId).to.equal(123);
    });

    it('should use a singleton handler and call its _init hook', async function () {
      logger.logs = []; // Reset singleton state before test
      env.addCommandHandler('logger', logger);
      const buffer = [{ handler: 'logger', command: 'log', arguments: ['User action'] }];
      await flattenBuffer(buffer, context);
      expect(logger.logs).to.eql(['Initialized for user 123', 'User action']);
    });

    it('should support callable handlers (handler is a function)', async function () {
      const callableHandler = createCallableHandler();
      env.addCommandHandler('callable', callableHandler);
      const buffer = [{ handler: 'callable', command: null, arguments: [1, 'arg2'] }];
      await flattenBuffer(buffer, context);
      expect(callableHandler.calledWith).to.eql([[1, 'arg2']]);
    });

    it('should dispatch to a default handler', async function () {
      logger.logs = []; // Reset singleton state
      const defaultHandlerName = 'logger';
      env.addCommandHandler('logger', logger);
      const buffer = [{ handler: null, command: 'log', arguments: ['Default log.'] }];
      await flattenBuffer(buffer, context, null, defaultHandlerName);
      expect(logger.logs).to.eql(['Initialized for user 123', 'Default log.']);
    });
  });

  describe('Focused Output', function () {
    // Setup the environment for all tests in this suite
    beforeEach(() => {
      class Turtle { constructor() { this.pos = 0; } forward(d) { this.pos += d; } }
      env.addCommandHandlerClass('turtle', Turtle);
      env.addDataMethods({ put: (target, key, value) => { target[key] = value; } });
    });

    const fullBuffer = [
      { method: 'put', path: ['user', 'name'], value: 'Bob' },
      'Some text. ',
      { handler: 'turtle', command: 'forward', arguments: [10] }
    ];

    it('should return only the data object when focus is "data"', async function () {
      const result = await flattenBuffer(fullBuffer, context, 'data');
      expect(result).to.eql({ user: { name: 'Bob' } });
    });

    it('should return only the text output when focus is "text"', async function () {
      const result = await flattenBuffer(fullBuffer, context, 'text');
      expect(result).to.be('Some text. ');
    });

    it('should return only a handler instance when focus is on a handler name', async function () {
      const result = await flattenBuffer(fullBuffer, context, 'turtle');
      expect(result.pos).to.equal(10);
    });

    it('should return undefined when focus key does not exist', async function () {
      const result = await flattenBuffer(fullBuffer, context, 'nonexistent');
      expect(result).to.be(undefined);
    });
  });

  describe('Post-Processing Functions (e.g., SafeString)', function () {
    class SafeString {
      constructor(val) { this.val = String(val); }
      toString() { return this.val; }
    }

    it('should handle a simple array with a post-processing function', async function () {
      const buffer = [
        ['<p>', 'Hello', '</p>', (val) => new SafeString(val.toUpperCase())]
      ];
      const result = await flattenBuffer(buffer, context);
      expect(result.text).to.equal('<P>HELLO</P>');
    });

    it('should handle nested arrays within a post-processing array', async function () {
      const buffer = [
        ['<span>', ['nested', ' text'], '</span>', (val) => new SafeString(val.replace(/ /g, '_'))]
      ];
      const result = await flattenBuffer(buffer, context);
      expect(result.text).to.equal('<span>nested_text</span>');
    });

    it('should process the result of the function along with other buffer items', async function () {
      const buffer = [
        'Prefix -- ',
        ['data', (val) => new SafeString(val + '!')],
        ' -- Suffix'
      ];
      const result = await flattenBuffer(buffer, context);
      expect(result.text).to.equal('Prefix -- data! -- Suffix');
    });

    it('should handle post-processing functions that return null or undefined', async function () {
      const buffer = ['A', ['B', (val) => null], 'C'];
      const result = await flattenBuffer(buffer, context);
      expect(result.text).to.equal('AC');
    });

    it('should handle post-processing functions that return another command object', async function () {
      env.addDataMethods({ put: (target, key, value) => { target[key] = value; } });
      const buffer = [
        ['ignored', (val) => ({ method: 'put', path: ['wasProcessed'], value: true })]
      ];
      const result = await flattenBuffer(buffer, context);
      expect(result).to.eql({ data: { wasProcessed: true } });
    });
  });

  describe('Error Handling & Edge Cases', function () {
    it('should handle an empty buffer', async function () {
      const result = await flattenBuffer([], context);
      expect(result).to.eql({});
    });

    it('should ignore null and undefined values in the buffer', async function () {
      const result = await flattenBuffer(['A', null, 'B', undefined, 'C'], context);
      expect(result).to.eql({ text: 'ABC' });
    });

    it('should throw an error for an unknown command handler', async function () {
      const buffer = [{ handler: 'nonexistent', command: 'do', arguments: [], node: { lineno: 1, colno: 1 } }];
      await expectAsyncError(
        () => flattenBuffer(buffer, context),
        (err) => expect(err.message).to.contain('Unknown command handler: nonexistent')
      );
    });

    it('should throw an error for an unknown command method on a handler', async function () {
      env.addCommandHandler('logger', { log: () => {} });
      const buffer = [{ handler: 'logger', command: 'nonexistent', arguments: [], node: { lineno: 1, colno: 1 } }];
      await expectAsyncError(
        () => flattenBuffer(buffer, context),
        (err) => expect(err.message).to.contain(`has no method 'nonexistent'`)
      );
    });

    it('should throw an error for @put on an invalid path', async function () {
      env.addDataMethods({ put: (target, key, value) => { target[key] = value; } });
      const buffer = [
        { method: 'put', path: ['user'], value: null },
        { method: 'put', path: ['user', 'profile'], value: 'test' }
      ];
      await expectAsyncError(
        () => flattenBuffer(buffer, context),
        (err) => expect(err.message).to.contain('on null or undefined path segment')
      );
    });

    it('should throw an error for a non-string/non-number path segment', async function () {
      env.addDataMethods({ put: (target, key, value) => { target[key] = value; } });
      const buffer = [{ method: 'put', path: ['config', null, 'value'], value: 'test' }];
      await expectAsyncError(
        () => flattenBuffer(buffer, context),
        (err) => expect(err.message).to.contain('Invalid path segment')
      );
    });
  });
});
