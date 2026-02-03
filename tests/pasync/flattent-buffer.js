'use strict';

let expect;
let AsyncEnvironment;
let flattenBuffer;
let expectAsyncError;
let DataHandler;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  flattenBuffer = require('../../src/runtime/runtime').flattenBuffer;
  expectAsyncError = require('../util').expectAsyncError;
  DataHandler = require('../../src/script/data-handler');
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  flattenBuffer = nunjucks.runtime.flattenBuffer;
  expectAsyncError = nunjucks.util.expectAsyncError;
  DataHandler = nunjucks.DataHandler;
}

describe('flattenBuffer', function () {
  let env;
  let context;

  // For each test, create a fresh environment and context.
  beforeEach(() => {
    env = new AsyncEnvironment();
    env.addCommandHandlerClass('data', DataHandler);
    context = {
      getVariables: () => ({ userId: 123 }),
      env: env,
    };
  });

  describe('Data Assembly (@put, @push, etc.)', function () {
    it('should handle a simple @data.set command', async function () {
      const buffer = [{ handler: 'data', command: 'set', arguments: [['user'], { name: 'Alice' }] }];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ user: { name: 'Alice' } });
    });

    it('should create nested objects with @data.set', async function () {
      const buffer = [{ handler: 'data', command: 'set', arguments: [['config', 'theme', 'color'], 'dark'] }];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ config: { theme: { color: 'dark' } } });
    });

    it('should handle a simple @data.push command', async function () {
      const buffer = [{ handler: 'data', command: 'push', arguments: [['users'], 'Alice'] }];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ users: ['Alice'] });
    });

    it('should create an array with @data.push if it does not exist', async function () {
      const buffer = [{ handler: 'data', command: 'push', arguments: [['config', 'admins'], 'root'] }];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ config: { admins: ['root'] } });
    });

    it('should handle the "[]" path syntax for creating and populating array items', async function () {
      const buffer = [
        { handler: 'data', command: 'push', arguments: [['users'], { id: 0 }] },
        { handler: 'data', command: 'set', arguments: [['users', '[]', 'id'], 1] },
        { handler: 'data', command: 'set', arguments: [['users', 0, 'name'], 'Alice'] }
      ];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ users: [{ id: 1, name: 'Alice' }] });
    });

    it('should handle the @data.merge command', async function () {
      const buffer = [
        { handler: 'data', command: 'set', arguments: [['user'], { id: 1, name: 'Alice' }] },
        { handler: 'data', command: 'merge', arguments: [['user'], { name: 'Alicia', active: true }] },
      ];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ user: { id: 1, name: 'Alicia', active: true } });
    });

    it('should handle null path to work on the root of the data object', async function () {
      const buffer = [
        { handler: 'data', command: 'set', arguments: [null, { id: 5, name: 'Bob' }] }
      ];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ id: 5, name: 'Bob' });
    });

    it('should handle null path with merge to combine with existing root data', async function () {
      const buffer = [
        { handler: 'data', command: 'set', arguments: [['id'], 10] },
        { handler: 'data', command: 'merge', arguments: [null, { name: 'Charlie' }] }
      ];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ id: 10, name: 'Charlie' });
    });
  });

  describe('Text Output & Mixed Content', function () {
    it('should join plain strings and numbers in the buffer', async function () {
      const buffer = ['Hello', ' ', 'world', '!', 42];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('Hello world!42');
    });

    it('should process nested buffer arrays', async function () {
      const buffer = ['Outer', ['Middle', ['Inner']], 'End'];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('OuterMiddleInnerEnd');
    });
  });

  describe('Command Handlers (Factory & Singleton)', function () {
    it('should instantiate and use a factory handler', async function () {
      class CounterHandler {
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
      env.addCommandHandlerClass('counter', CounterHandler);
      const buffer = [
        { handler: 'counter', command: 'increment', subpath: [], arguments: [] }
      ];
      const result = await flattenBuffer(buffer, context, 'counter');
      expect(result).to.eql({ count: 1 });
    });

    it('should use a singleton handler and call its _init hook', function () {
      const singletonHandler = {
        value: 0,
        _init(ctx) { this.value = ctx.userId; },
        set(val) { this.value = val; },
        getReturnValue() { return { value: this.value }; }
      };
      env.addCommandHandler('singleton', singletonHandler);
      const buffer = [{ handler: 'singleton', command: 'set', subpath: [], arguments: [456] }];
      const result = flattenBuffer(buffer, context, 'singleton');
      expect(result).to.eql({ value: 456 });
    });

    it('should support callable handlers (handler is a function)', function () {
      const callableHandler = function() {};
      callableHandler.set = function(val) { this.lastValue = val; };
      callableHandler.getReturnValue = function() { return { result: 'called', lastValue: this.lastValue }; };
      env.addCommandHandler('callable', callableHandler);
      const buffer = [{ handler: 'callable', command: 'set', subpath: [], arguments: ['test'] }];
      const result = flattenBuffer(buffer, context, 'callable');
      expect(result).to.eql({ result: 'called', lastValue: 'test' });
    });
  });

  describe('Post-Processing Functions (e.g., SafeString)', function () {
    it('should handle a simple array with a post-processing function', async function () {
      const buffer = [['Hello', (val) => val.toUpperCase()]];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('HELLO');
    });

    it('should handle nested arrays within a post-processing array', async function () {
      const buffer = [[['Hello', ' ', 'World'], (val) => val.toLowerCase()]];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('hello world');
    });

    it('should process the result of the function along with other buffer items', async function () {
      const buffer = ['Start ', [['mid'], (val) => val.toUpperCase()], ' End'];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('Start MID End');
    });

    it('should handle post-processing functions that return null or undefined', async function () {
      const buffer = [['text', () => null]];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('');
    });

    it('should handle post-processing functions that return another command object', async function () {
      const buffer = [[
        'Test',
        (val) => ({ handler: 'data', command: 'set', arguments: [['result'], val] })
      ]];
      const result = await flattenBuffer(buffer, context, 'data');
      expect(result).to.eql({ result: 'Test' });
    });
  });

  describe('Error Handling & Edge Cases', function () {
    it('should handle an empty buffer', async function () {
      const buffer = [];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('');
    });

    it('should ignore null and undefined values in the buffer', async function () {
      const buffer = ['Hello', null, undefined, 'World'];
      const result = await flattenBuffer(buffer, context, 'text');
      expect(result).to.equal('HelloWorld');
    });

    it('should throw an error for an unknown command handler', async function () {
      const buffer = [{ handler: 'nonexistent', command: 'method', subpath: [], arguments: [] }];
      await expectAsyncError(async () => {
        await flattenBuffer(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('Unknown command handler: nonexistent');
      });
    });

    it('should throw an error for an unknown command method on a handler', async function () {
      env.addCommandHandler('testHandler', {
        getReturnValue: () => ({ test: true })
      });
      const buffer = [{ handler: 'testHandler', command: 'nonexistent', subpath: [], arguments: [] }];
      await expectAsyncError(async () => {
        await flattenBuffer(buffer, context, 'text');
      }, (err) => {
        expect(err.message).to.contain('has no method');
      });
    });

    it('should throw an error for a non-string/non-number path segment', async function () {
      const buffer = [{ handler: 'data', command: 'set', arguments: [[{}], 'value'] }];
      await expectAsyncError(async () => {
        await flattenBuffer(buffer, context, 'data');
      }, (err) => {
        expect(err.message).to.contain('Invalid path segment');
      });
    });
  });
});
