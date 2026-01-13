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
  isPoisonError = nunjucks.isPoisonError;
  isPoison = nunjucks.isPoison;
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

    // Helper to deeply resolve lazy structures for verification
    async function deepResolve(item) {
      if (!item) return item;

      // If promise, await it
      if (typeof item.then === 'function') {
        item = await item;
      }

      // If lazy object, trigger resolution
      if (item && item[Symbol.for('cascada.resolve')]) {
        await item[Symbol.for('cascada.resolve')];
      }
      return item;
    }

    // Resolve top level
    res = await deepResolve(res);

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

  describe('runtime.setPath (Lazy Semantics)', () => {


    async function evalScript(script, context = {}) {
      const wrapped = `
        ${script}
        :data
        @data.res = res
      `;
      // env is available from outer scope
      const result = await env.renderScriptString(wrapped, context);
      // Deep resolve the result for verification
      return runtime.resolveAll([result.res]).then(r => r[0]);
    }

    it('should set a simple property on an object (sync)', () => {
      const obj = { x: 1 };
      const result = runtime.setPath(obj, ['y'], 2);
      expect(result).to.not.be(obj); // Immutable
      expect(result).to.eql({ x: 1, y: 2 });
      expect(obj).to.eql({ x: 1 });
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
      // setPath should return a Lazy Object (Promise wrapper) containing the promise.
      // The object itself is returned synchronously.
      const result = runtime.setPath(obj, ['items', indexPromise], 200);

      expect(result).to.not.be.a(Promise);
      // Verify items property is a Promise (lazy)
      expect(result.items).to.be.a(Promise);

      const items = await result.items;
      expect(items[0]).to.be(200);
    });

    it('should handle async value only when needed', async () => {
      const obj = { x: 1 };
      const valPromise = Promise.resolve(10);
      const result = runtime.setPath(obj, ['x'], valPromise);

      // Should be synchronous (Lazy Object) having x as promise
      expect(result).to.not.be.a(Promise);
      expect(result.x).to.be.a(Promise);

      const x = await result.x;
      expect(x).to.be(10);
    });

    it('should propagate poison from root', () => {
      const poison = createPoison(new Error('Toxic'));
      const result = runtime.setPath(poison, ['x'], 1);

      // Should result in sync poison
      expect(isPoison(result)).to.be(true);
      expect(result.errors[0].message).to.be('Toxic');
    });

    it('should propagate poison from key (async reject)', async () => {
      const obj = { x: 1 };
      const poisonKey = createPoison(new Error('Toxic Key'));

      // Poison key is identified synchronously
      const result = runtime.setPath(obj, [poisonKey], 2);
      expect(isPoison(result)).to.be(true);
      expect(result.errors[0].message).to.be('Toxic Key');
    });

    it('should propagate poison from async resolution', async () => {
      const objPromise = Promise.resolve({ x: 1 });
      const resultPromise = runtime.setPath(objPromise, ['y'], Promise.resolve(createPoison(new Error('Async Toxic'))));

      // Root is async. Result is Promise.
      const result = await resultPromise;
      // result.y is Promise<Poison>

      try {
        await result.y;
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

    it('should collect errors from mixed sync poison and async rejection', async () => {
      const poison = createPoison(new Error('Sync Error'));
      const p = Promise.reject(new Error('Async Error'));
      p.catch(() => { });

      // Root Poison (sync) + Head Promise (async).
      // isRootAsync = false (poison). isHeadAsync = true (promise).
      // Logic: !isRootAsync && !isHeadAsync => false.
      // Goes to async path.
      // Collects errors from both.
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
      // Lazy: Stop at Root. 1 Error.
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.be('Root Error');
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
        expect(e.errors).to.have.length(1);
        expect(e.errors[0].message).to.be('Root Error');
      }
    });

    it('should collect errors from both root and value (Sync Root, Async Value Verify)', async function () {
      const error1 = new Error('Root Error');
      const error2 = new Error('Value Error');
      const root = createPoison(error1);
      const valuePromise = Promise.resolve(createPoison(error2));

      // Returns Sync Poison (Root Error)
      const result = runtime.setPath(root, ['prop'], valuePromise);

      expect(isPoison(result)).to.be(true);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.be('Root Error');
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

    it('should handle Lazy Root (marked object) by resolving it', async () => {
      // Create a "Lazy Root" simulating a resolver that mutates the object
      const lazyRoot = {
        x: 0
      };
      // Explicitly attach marker property (since we can't define it inside literal easily with computed property if we need ref to obj)
      Object.defineProperty(lazyRoot, Symbol.for('cascada.resolve'), {
        value: (async () => {
          // Simulate delay
          await Promise.resolve();
          // Mutate in place (Lazy Object contract)
          lazyRoot.x = 1;
          return lazyRoot;
        })()
      });

      const resultPromise = runtime.setPath(lazyRoot, ['y'], 2);

      expect(resultPromise).to.be.a(Promise);
      const result = await resultPromise;

      expect(result).to.eql({ x: 1, y: 2 });
    });

    it('should contain error in Lazy Object when deep async path fails', async () => {
      // Setup: obj.a is a promise that resolves to empty object {}.
      // We try to set obj.a.b = 1.
      // This requires accessing 'b' on 'a's result.
      // Wait, 'a' resolves to {}. 'b' is valid assignment target?
      // Yes. obj.a.b = 1 means resolve a, then set b on it.
      // If a={} -> a.b = 1 -> a={b:1}.
      // I generally want a failure.
      // Try obj.a.b.c = 1 where obj.a -> { b: undefined }.
      // 'b' is undefined. Access 'c' on undefined -> Error.

      const obj = { a: Promise.resolve({ b: undefined }) };

      // We set ['a','b','c']
      const result = runtime.setPath(obj, ['a', 'b', 'c'], 1);

      // result is { a: Promise }.
      // result.a is Promise.
      // when awaited, result.a should fail because recursive setPath(a, ['b','c'], 1) failed.

      expect(result).to.not.be.a(Promise);
      expect(result.a).to.be.a(Promise);

      try {
        await result.a;
        expect().fail('Should have failed inside the lazy property');
      } catch (e) {
        expect(e.message).to.contain('Cannot access property');
      }
    });


    describe('Integration Scenarios', () => {



      it('should handle chained async assignments synchronously (Lazy Chaining)', async () => {
        const context = {
          getAsync: async (v) => v
        };
        const res = await evalScript(`
        var obj = {}
        obj.a = getAsync(10)
        obj.b = 20
        var res = obj
      `, context);
        expect(res).to.eql({ a: 10, b: 20 });
      });

      it('should handle deep chained modifications on lazy roots', async () => {
        const context = {
          getAsync: async (v) => v
        };
        const res = await evalScript(`
        var obj = { nested: getAsync({ val: 1 }) }
        obj.nested.val = 2
        var res = obj
      `, context);
        expect(res).to.eql({ nested: { val: 2 } });
      });

      it('should handle array manipulations with async values', async () => {
        const context = {
          getAsync: async (v) => v
        };
        const res = await evalScript(`
        var list = []
        list[] = getAsync(1)
        list[] = 2
        list[0] = getAsync(10)
        var res = list
      `, context);
        expect(res).to.eql([10, 2]);
      });

      it('should propagate poison through lazy chain', async () => {
        const context = {
          getPoison: async () => { throw new Error('Managed Poison'); }
        };

        try {
          await evalScript(`
          var obj = {}
          obj.a = getPoison()
          obj.b = 2
          var res = obj
        `, context);
          throw new Error('Should have failed');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.errors[0].message).to.contain('Managed Poison');
        }
      });

      it('should handle loop with lazy aggregation', async () => {
        const context = {
          getAsync: async (v) => v
        };
        const res = await evalScript(`
        var list = []
        for i in [1, 2, 3]
          list[] = getAsync(i)
        endfor
        var res = list
      `, context);
        expect(res).to.eql([1, 2, 3]);
      });

      it('should handle function calls passing lazy objects', async () => {
        const context = {
          getAsync: async (v) => v,
          process: function (o) { return o.x + 1; }
        };
        const res = await evalScript(`
        var obj = { x: getAsync(1) }
        var res = process(obj)
      `, context);
        expect(res).to.be(2);
      });

    });
    it('should handle complex mixed structure updates and function calls', async () => {
      const context = {
        fetchProfile: async (id) => ({ id, name: 'User ' + id, stats: { score: 10 } }),
        fetchScore: async (id) => id * 100,
        updateScore: function (profile, bonus) {
          // Accessing profile.stats.score needs it to be resolved
          return profile.stats.score + bonus;
        }
      };

      const res = await evalScript(`
        var user = fetchProfile(1)
        user.stats.extra = fetchScore(5)

        var currentScore = updateScore(user, 50)
        // user.stats.score is 10. + 50 = 60.

        user.finalScore = currentScore
        var res = user
      `, context);

      expect(res.id).to.be(1);
      expect(res.stats.score).to.be(10);
      expect(res.stats.extra).to.be(500); // fetchScore(5)
      expect(res.finalScore).to.be(60);
    });

    it('should handle array of objects with cross-references and updates (COW)', async () => {
      const context = {
        getAsync: async (v) => v
      };

      const res = await evalScript(`
         var list = [{ id: 1 }, { id: 2 }]
         list[] = getAsync({ id: 3, val: 0 })

         var last = list[2]
         list[0].ref = last

         last.val = 99

         var res = list
      `, context);

      expect(res).to.have.length(3);

      // Cascada uses Copy-On-Write logic.
      // 'last.val = 99' updates the 'last' variable's reference, not the list's element.
      expect(res[2].val).to.be(0); // Unchanged
      expect(res[0].ref.val).to.be(0); // Unchanged
    });

    it('should correctly sequence dependent async updates', async () => {
      const context = {
        delayVal: async (v, ms) => new Promise(r => setTimeout(() => r(v), ms)),
      };

      // Check race conditions / sequencing.
      // Lazy setPath preserves order by synchronous execution of statements.
      const res = await evalScript(`
         var obj = { x: 0 }
         obj.x = delayVal(1, 20)
         obj.x = delayVal(2, 10)
         var res = obj
      `, context);

      expect(res.x).to.be(2);
    });

    it('should handle deep modification of array inside object', async () => {
      const context = {
        getItems: async () => [{ id: 1 }]
      };

      const res = await evalScript(`
           var state = { list: getItems() }

           // deep array access
           state.list[0].selected = true

           // append
           state.list[] = { id: 2, selected: false }

           var res = state
        `, context);

      expect(res.list).to.have.length(2);
      expect(res.list[0].selected).to.be(true);
      expect(res.list[1].id).to.be(2);
    });

    describe('Error Collection Scenarios', () => {

      it('should collect properties parallel errors in object literal', async () => {
        const context = {
          fail1: async () => { throw new Error('First Error'); },
          fail2: async () => { throw new Error('Second Error'); }
        };

        try {
          await evalScript(`
            var res = { a: fail1(), b: fail2() }
        `, context);
          throw new Error('Should have failed');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.errors).to.have.length(2);
          const allMsg = e.errors.map(err => err.message).join('||');
          expect(allMsg).to.contain('First Error');
          expect(allMsg).to.contain('Second Error');
        }
      });

      it('should overwrite synchronous poison without issue (using raw poison value)', async () => {
        const context = {
          poisonVal: createPoison(new Error('Sync Poison'))
        };

        const res = await evalScript(`
         var obj = { a: poisonVal }
         // Overwrite property 'a'
         obj.a = 100
         var res = obj
      `, context);

        expect(res.a).to.be(100);
      });

      it('should fail to overwrite asynchronous lazy failure (Resolution Barrier)', async () => {
        const context = {
          failAsync: async () => { throw new Error('Lazy Fail'); }
        };

        try {
          await evalScript(`
           var obj = { a: failAsync() }
           obj.a = 100
           var res = obj
        `, context);
          throw new Error('Should have failed');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.errors[0].message).to.contain('Lazy Fail');
        }
      });

      it('should fail entire object if setPath has multiple sync errors', async () => {
        const context = {
          fail1: () => createPoison(new Error('Root')),
          fail2: () => createPoison(new Error('Key'))
        };

        try {
          await evalScript(`
           var obj = fail1()
           obj[fail2()] = 100
           var res = obj
        `, context);
          throw new Error('Should have failed');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.errors).to.have.length(2);
        }
      });

      it('should collect errors when setting async path on async root with failures', async () => {
        const context = {
          failRoot: async () => { throw new Error('Root Fail'); },
          failKey: async () => { throw new Error('Key Fail'); }
        };

        try {
          await evalScript(`
             var obj = failRoot()
             obj[failKey()] = 1
             var res = obj
          `, context);
          throw new Error('Should have failed');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.errors).to.have.length(2);
          const allMsg = e.errors.map(err => err.message).join('||');
          expect(allMsg).to.contain('Root Fail');
          expect(allMsg).to.contain('Key Fail');
        }
      });

      it('should NOT collect errors from previous value when setting new value on Lazy Object', async () => {
        const context = {
          failRoot: async () => { throw new Error('Root Fail'); },
          failVal: async () => { throw new Error('Value Fail'); }
        };

        try {
          await evalScript(`
           var obj = { a: failRoot() }
           obj.b = failVal() // update fails
           var res = obj
        `, context);
          throw new Error('Should have failed');
        } catch (e) {
          expect(e.errors).to.have.length(1);
          expect(e.errors[0].message).to.contain('Root Fail');
        }
      });

    });

  });
});

