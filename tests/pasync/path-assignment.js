'use strict';

let expect;
let AsyncEnvironment;
let runtime;
let createPoison;
let isPoison;
let isPoisonError;
let transpiler;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  runtime = require('../../src/runtime/runtime');
  createPoison = require('../../src/runtime/errors').createPoison;
  isPoison = require('../../src/runtime/errors').isPoison;
  isPoisonError = require('../../src/runtime/errors').isPoisonError;
  transpiler = require('../../src/script/script-transpiler');
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  runtime = nunjucks.runtime;
  createPoison = nunjucks.createPoison;
  isPoison = nunjucks.isPoison;
  isPoisonError = nunjucks.isPoisonError;
  transpiler = nunjucks.transpiler;
}

describe('Cascada Script: Variable Path Assignments (set_path)', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  // Helper to verify the state of a variable after script execution
  async function checkVariable(script, varName, context = {}) {
    // We capture the variable into @data output to verify it
    const wrappedScript = `
        ${script}
        :data
        @data.res = ${varName}
    `;
    const result = await env.renderScriptString(wrappedScript, context);

    // Resolve if the result itself or properties are promises
    // In this specific test case, result.res might be a Promise or contain Promises
    let res = result.res;
    if (res && typeof res.then === 'function') {
      res = await res;
    }
    // Also deep resolve if needed? For now just top level variable
    return res;
  }

  describe('Synchronous', () => {
    it('should set property on script variable', async () => {
      const result = await checkVariable(`
           var obj = { x: 1 }
           obj.y = 2
        `, 'obj');
      expect(result).to.eql({ x: 1, y: 2 });
    });

    it('should set nested property on script variable', async () => {
      const result = await checkVariable(`
           var obj = { profile: { name: 'Alice' } }
           obj.profile.age = 30
        `, 'obj');
      expect(result).to.eql({ profile: { name: 'Alice', age: 30 } });
    });

    it('should handle array indices on script variable', async () => {
      const result = await checkVariable(`
           var list = [1, 2, 3]
           list[1] = 20
        `, 'list');
      expect(result).to.eql([1, 20, 3]);
    });

    it('should handle array append with [] on script variable', async () => {
      const result = await checkVariable(`
           var list = [1, 2]
           list[] = 3
        `, 'list');
      expect(result).to.eql([1, 2, 3]);
    });

    it('should throw error when path does not exist (strict)', async () => {
      const script = `
           var obj = {}
           obj.a.b = 1
        `;
      try {
        await env.renderScriptString(script);
        throw new Error('Should have failed');
      } catch (e) {
        expect(e.message).to.contain('Cannot access property');
      }
    });

    it('should throw error when root is null', async () => {
      const script = `
           var obj = null
           obj.prop = 1
        `;
      try {
        await env.renderScriptString(script);
        throw new Error('Should have failed');
      } catch (e) {
        expect(e.message).to.contain('Cannot access property'); // setPath throws this for null root
      }
    });
  });

  describe('Asynchronous', () => {
    it('should handle async object resolution', async () => {
      const context = {
        getObj: async () => ({ x: 1 })
      };
      const result = await checkVariable(`
            var obj = getObj()
            obj.y = 2
         `, 'obj', context);
      expect(result).to.eql({ x: 1, y: 2 });
    });

    it('should handle async path segment resolution', async () => {
      const context = {
        getIndex: async () => 0
      };
      const result = await checkVariable(`
            var list = [100]
            list[getIndex()] = 200
         `, 'list', context);
      expect(result).to.eql([200]);
    });

    it('should handle async value resolution', async () => {
      const context = {
        getValue: async () => 10
      };
      const result = await checkVariable(`
            var obj = { x: 1 }
            obj.x = getValue()
         `, 'obj', context);
      expect(result).to.eql({ x: 10 });
    });
  });

  describe('Poison Propagation', () => {
    it('should propagate poison from root', async () => {
      const context = {
        getPoison: async () => { throw new Error('Root Poison'); }
      };
      try {
        await checkVariable(`
                var obj = getPoison()
                obj.x = 1
            `, 'obj', context);
        throw new Error('Should have failed');
      } catch (e) {
        // Can fail with Root Poison (if awaited and thrown) OR Cannot access property (if returned undefined)
        expect(e.message).to.match(/Root Poison|Cannot access property/);
      }
    });

    it('should propagate poison from index', async () => {
      const context = {
        getErrorIndex: async () => { throw new Error('Index Poison'); }
      };
      try {
        await checkVariable(`
                var list = [1]
                list[getErrorIndex()] = 2
            `, 'list', context);
        throw new Error('Should have failed');
      } catch (e) {
        expect(e.message).to.contain('Index Poison');
      }
    });
  });

  describe('Scoping and Edge Cases', () => {
    it('should correctly scope set_path updates inside blocks', async () => {
      // If set_path creates a local variable 'obj' inside the if block,
      // the outer 'obj' will remain unchanged { x: 1 }.
      // We expect the outer 'obj' to be updated to { x: 2 }.
      const result = await checkVariable(`
            var obj = { x: 1 }
            if true
              obj.x = 2
            endif
        `, 'obj');
      expect(result).to.eql({ x: 2 });
    });

    it('should handle mid-path [] as last-element access', async () => {
      // list[].id = 2 should update the last element's id property
      const result = await checkVariable(`
            var list = [{ id: 1 }]
            list[].id = 2
        `, 'list');
      expect(result[0].id).to.be(2);
    });
  });

  describe('ScriptTranspiler - Path Assignment', () => {
    const check = (code, expectedTarget, expectedSegments, expectedValue) => {
      const result = transpiler._deconstructPathAssignment(code, 1);
      // If we expect null (not a path assignment), assert that
      if (expectedTarget === null) {
        expect(result).to.be(null);
      } else {
        expect(result).to.not.be(null);
        expect(result.target).to.be(expectedTarget);
        expect(result.segments).to.be(expectedSegments);
        expect(result.value).to.be(expectedValue);
      }
    };

    it('should transpile simple path assignment', () => {
      check('user.name = "John"', 'user', '["name"]', '"John"');
    });

    it('should transpile nested path assignment', () => {
      check('user.profile.age = 30', 'user', '["profile", "age"]', '30');
    });

    it('should transpile path assignment with array index', () => {
      check('items[0] = 5', 'items', '[0]', '5');
    });

    it('should transpile path assignment with append', () => {
      check('items[] = 5', 'items', '["[]"]', '5');
    });

    it('should transpile list parse check', () => {
      check('list[] = 3', 'list', '["[]"]', '3');
    });

    it('should transpile path assignment with dynamic index', () => {
      check('items[i] = 5', 'items', '[i]', '5');
    });

    it('should transpile mixed path assignment', () => {
      check('a.b[c].d = e', 'a', '["b", c, "d"]', 'e');
    });

    it('should not break regular variable assignment', () => {
      check('x = 10', null);
    });

    it('should NOT throw error for capture block in check (throws in processing)', () => {
      expect(transpiler._isAssignment('x.y = capture', 1)).to.be(true);
    });

  });

  describe('runtime.setPath', () => {
    it('should set a simple property on an object (sync)', () => {
      const obj = { x: 1 };
      const result = runtime.setPath(obj, ['y'], 2);
      expect(result).to.not.be(obj); // Immutable
      expect(result).to.eql({ x: 1, y: 2 });
      expect(obj).to.eql({ x: 1 });
    });

    it('should set a nested property (sync)', () => {
      const obj = { user: { name: 'Alice', age: 25 } };
      const result = runtime.setPath(obj, ['user', 'age'], 26);
      expect(result).to.not.be(obj);
      expect(result.user).to.not.be(obj.user);
      expect(result).to.eql({ user: { name: 'Alice', age: 26 } });
      expect(obj.user.age).to.be(25);
    });

    it('should handle array indices (sync)', () => {
      const obj = { list: [1, 2, 3] };
      const result = runtime.setPath(obj, ['list', 1], 20);
      expect(result.list).to.not.be(obj.list);
      expect(result.list).to.eql([1, 20, 3]);
    });

    it('should handle array append "[]" (sync)', () => {
      const obj = { list: [1, 2] };
      const result = runtime.setPath(obj, ['list', '[]'], 3);
      expect(result.list).to.eql([1, 2, 3]);
    });

    it('should handle async root object', async () => {
      const objPromise = Promise.resolve({ x: 1 });
      const resultPromise = runtime.setPath(objPromise, ['y'], 2);
      expect(resultPromise).to.be.a(Promise);
      const result = await resultPromise;
      expect(result).to.eql({ x: 1, y: 2 });
    });

    it('should handle async path segments only when needed', async () => {
      const obj = { items: [100] };
      const indexPromise = Promise.resolve(0);
      // segments array containing a promise
      const resultPromise = runtime.setPath(obj, ['items', indexPromise], 200);
      expect(resultPromise).to.be.a(Promise);
      const result = await resultPromise;
      expect(result.items[0]).to.be(200);
    });

    it('should handle async value only when needed', async () => {
      // If value is promise, setPath usually assigns the promise itself unless strict logic prevents it.
      // Wait, Cascada usually awaits assignments?
      // Implementation of setPath: _setSinglePathSync assigns value directly.
      // _setSinglePathAsync checks poison but resolving value is optional or done via Promise.all.
      // My implementation:
      // const [obj, key, value] = await Promise.all([objSyncOrPromise, keySyncOrPromise, valueSyncOrPromise]);
      // So it DOES resolve the value if it looks like a promise.

      const obj = { x: 1 };
      const valPromise = Promise.resolve(10);
      const resultPromise = runtime.setPath(obj, ['x'], valPromise);

      const result = await resultPromise;
      expect(result.x).to.be(10);
    });

    it('should propagate poison from root', () => {
      const poison = createPoison(new Error('Toxic'));
      const result = runtime.setPath(poison, ['x'], 1);
      expect(isPoison(result)).to.be(true);
      expect(result.errors[0].message).to.be('Toxic');
    });

    it('should propagate poison from key (async reject)', async () => {
      const obj = { x: 1 };
      const poisonKey = createPoison(new Error('Toxic Key'));
      const resultPromise = runtime.setPath(obj, [poisonKey], 2);

      // Head is poison, setPath now returns poison synchronously if passed as raw value in array?
      // In test: [poisonKey]. head = poisonKey.
      // My optimization: if (isPoison(head)) return head;
      // So it should be sync!

      // Check if resultPromise is actually a promise or poison
      const result = resultPromise;

      if (result && typeof result.then === 'function') {
        // If it returned a promise
        try {
          await result;
          expect().fail('Should have rejected');
        } catch (e) {
          // expect(isPoisonError(e)).to.be(true); // setPath throws standard error for invalid access
          expect(e).to.be.an(Error);
          expect(e.errors[0].message).to.be('Toxic Key');
        }
      } else {
        expect(isPoison(result)).to.be(true);
      }
    });

    it('should propagate poison from async resolution', async () => {
      const objPromise = Promise.resolve({ x: 1 });
      const resultPromise = runtime.setPath(objPromise, ['y'], Promise.resolve(createPoison(new Error('Async Toxic'))));

      try {
        await resultPromise;
        // setPath resolves value. If value resolves to poison, _setPathAsync re-wraps it in poison?
        // _setPathAsync: const [obj, key, value] = await Promise.all(...)
        // If value is poison, Promise.all resolves fine (PoisonedValue is a value).
        // Then: if (isPoison(value)) return createPoison(...)
        // await resultPromise -> unwraps -> throws PoisonError.
        expect().fail('Should have rejected');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.errors[0].message).to.be('Async Toxic');
      }
    });

    it('should throw error when path does not exist (sync)', () => {
      const obj = {};
      expect(() => runtime.setPath(obj, ['a', 'b'], 1)).to.throwError(/Cannot access property/);
    });

    it('should return poison when path does not exist (async)', async () => {
      const objPromise = Promise.resolve({});
      const resultPromise = runtime.setPath(objPromise, ['a', 'b'], 1);

      try {
        await resultPromise;
        expect().fail('Should have rejected');
      } catch (e) {
        expect(e).to.be.an(Error);
        expect(e.message).to.contain('Cannot access property');
      }
    });
    it('should collect multiple errors from sync inputs', () => {
      const poison1 = createPoison(new Error('Error 1'));
      const poison2 = createPoison(new Error('Error 2'));
      // setPath(poison1, [poison2], 1)
      const result = runtime.setPath(poison1, [poison2], 1);

      expect(isPoison(result)).to.be(true);
      expect(result.errors).to.have.length(2);
      expect(result.errors[0].message).to.be('Error 1');
      expect(result.errors[1].message).to.be('Error 2');
    });

    it('should collect multiple errors from async inputs', async () => {
      const p1 = Promise.reject(new Error('Async Error 1'));
      const p2 = Promise.reject(new Error('Async Error 2'));
      p1.catch(() => { });
      p2.catch(() => { });

      const resultPromise = runtime.setPath(p1, [p2], 1);

      try {
        await resultPromise;
        expect().fail('Should have rejected');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.errors).to.have.length(2);
        const msgs = e.errors.map(err => err.message);
        expect(msgs).to.contain('Async Error 1');
        expect(msgs).to.contain('Async Error 2');
      }
    });

    it('should collect errors from mixed sync poison and async rejection', async () => {
      const poison = createPoison(new Error('Sync Error'));
      const p = Promise.reject(new Error('Async Error'));
      p.catch(() => { });

      const resultPromise = runtime.setPath(poison, [p], 1);

      try {
        await resultPromise;
        expect().fail('Should have rejected');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.errors).to.have.length(2);
        const msgs = e.errors.map(err => err.message);
        expect(msgs).to.contain('Sync Error');
        expect(msgs).to.contain('Async Error');
      }
    });
    it('should collect errors from both root and value (Sync Verify)', function () {
      const error1 = new Error('Root Error');
      const error2 = new Error('Value Error');
      const root = createPoison(error1);
      const value = createPoison(error2);

      const result = runtime.setPath(root, ['prop'], value);

      expect(isPoison(result)).to.be(true);
      expect(result.errors).to.have.length(2);
      expect(result.errors.map(e => e.message)).to.contain('Root Error');
      expect(result.errors.map(e => e.message)).to.contain('Value Error');
    });

    it('should collect errors from both root and value (Async Root, Sync Value Verify)', async function () {
      const error1 = new Error('Root Error');
      const error2 = new Error('Value Error');
      const rootPromise = Promise.resolve(createPoison(error1));
      const value = createPoison(error2);

      const result = runtime.setPath(rootPromise, ['prop'], value);

      try {
        await result;
        throw new Error('Should have thrown PoisonError');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.errors).to.have.length(2);
        expect(e.errors.map(err => err.message)).to.contain('Root Error');
        expect(e.errors.map(err => err.message)).to.contain('Value Error');
      }
    });

    it('should collect errors from both root and value (Sync Root, Async Value Verify)', async function () {
      const error1 = new Error('Root Error');
      const error2 = new Error('Value Error');
      const root = createPoison(error1);
      const valuePromise = Promise.resolve(createPoison(error2));

      const result = runtime.setPath(root, ['prop'], valuePromise);

      try {
        await result;
        throw new Error('Should have thrown PoisonError');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.errors).to.have.length(2);
        expect(e.errors.map(err => err.message)).to.contain('Root Error');
        expect(e.errors.map(err => err.message)).to.contain('Value Error');
      }
    });


    it('should return value reference if segments is empty', () => {
      const obj = { x: 1 };
      const val = { y: 2 };
      const result = runtime.setPath(obj, [], val);
      expect(result).to.be(val);
      expect(obj).to.eql({ x: 1 });
    });

    it('should throw error when accessing [] on empty array (sync)', () => {
      const list = [];
      expect(() => runtime.setPath(list, ['[]', 'prop'], 1)).to.throwError(/Cannot access last element/);
    });

    it('should return poison when accessing [] on empty array (async)', async () => {
      const listPromise = Promise.resolve([]);
      const resultPromise = runtime.setPath(listPromise, ['[]', 'prop'], 1);
      try {
        await resultPromise;
        expect().fail('Should have rejected');
      } catch (e) {
        expect(e.message).to.contain('Cannot access last element');
      }
    });

  });
});
