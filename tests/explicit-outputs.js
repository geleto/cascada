'use strict';

let expect;
let AsyncEnvironment;
let createPoison;
let isPoisonError;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../src/environment/environment').AsyncEnvironment;
  const runtime = require('../src/runtime/runtime');
  createPoison = runtime.createPoison;
  isPoisonError = runtime.isPoisonError;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  createPoison = nunjucks.runtime.createPoison;
  isPoisonError = nunjucks.runtime.isPoisonError;
}

describe('Cascada Script: Explicit Output Declarations', function () {
  let env;

  const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

  const render = async (script, context) => {
    return env.renderScriptString(script, context || {});
  };

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Basic Declarations', function () {
    it('should declare data output', async () => {
      const script = `
        data myData
        myData.key = 'value'
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ key: 'value' });
    });

    it('should declare text output', async () => {
      const script = `
        text textOut
        textOut("hello")
        textOut(" world")
        return textOut.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be('hello world');
    });

    it('should declare value output', async () => {
      const script = `
        value result
        result(42)
        return result.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be(42);
    });

    it('should declare sink output with initializer', async () => {
      const context = {
        makeLogger() {
          return {
            msgs: [],
            write(msg) { this.msgs.push(msg); },
            snapshot() { return this.msgs; }
          };
        }
      };
      const script = `
        sink logger = makeLogger()
        logger.write("message")
        return logger.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql(['message']);
    });

    it('should declare sequence output with initializer', async () => {
      const context = {
        makeSequence() {
          return {
            getUser(id) { return { id: id, name: 'u' + id }; },
            snapshot() { return { ok: true }; }
          };
        }
      };
      const script = `
        sequence db = makeSequence()
        var user = db.getUser(1)
        return user
      `;
      const result = await render(script, context);
      expect(result).to.eql({ id: 1, name: 'u1' });
    });

    it('should support multiple output declarations', async () => {
      const script = `
        data myData
        text textOut
        value result
        myData.x = 1
        textOut("hi")
        result(7)
        return { data: myData.snapshot(), text: textOut.snapshot(), value: result.snapshot() }
      `;
      const result = await render(script);
      expect(result).to.eql({ data: { x: 1 }, text: 'hi', value: 7 });
    });
  });

  describe('Output Operations', function () {
    it('should support data set operation', async () => {
      const script = `
        data myData
        myData.user = { name: "Alice", age: 30 }
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ user: { name: 'Alice', age: 30 } });
    });

    it('should support data push operation', async () => {
      const script = `
        data myData
        myData.items.push('a')
        myData.items.push('b')
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ items: ['a', 'b'] });
    });

    it('should support data merge operation', async () => {
      const script = `
        data myData
        myData.user = { name: "Alice" }
        myData.user.merge({ age: 30 })
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ user: { name: 'Alice', age: 30 } });
    });

    it('should support text concatenation', async () => {
      const script = `
        text textOut
        textOut("a")
        textOut("b")
        textOut("c")
        return textOut.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be('abc');
    });

    it('should support text output with expressions', async () => {
      const script = `
        text textOut
        var name = "World"
        textOut("Hello " + name)
        return textOut.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be('Hello World');
    });

    it('should support nested path set operation', async () => {
      const script = `
        data myData
        myData.set(['user', 'address', 'city'], 'London')
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ user: { address: { city: 'London' } } });
    });

    it('should overwrite the same key (last write wins)', async () => {
      const script = `
        data myData
        myData.x = 1
        myData.x = 2
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 2 });
    });

    it('should allow multiple value assignments (last wins)', async () => {
      const script = `
        value result
        result(42)
        result(100)
        return result.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be(100);
    });

    it('should handle null and undefined in data output', async () => {
      const context = { undef: undefined };
      const script = `
        data myData
        myData.x = none
        myData.y = undef
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ x: null });
    });

    it('should return empty/default snapshots for unused outputs', async () => {
      const script = `
        data myData
        text textOut
        value result
        return { data: myData.snapshot(), text: textOut.snapshot(), value: result.snapshot() }
      `;
      const result = await render(script);
      expect(result).to.eql({ data: {}, text: '', value: undefined });
    });
  });

  describe('Snapshots and Returns', function () {
    it('should return a single output snapshot directly', async () => {
      const script = `
        data myData
        myData.x = 1
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });

    it('should return multiple outputs in an object', async () => {
      const script = `
        data myData
        text textOut
        myData.x = 1
        textOut("hi")
        return { data: myData.snapshot(), text: textOut.snapshot() }
      `;
      const result = await render(script);
      expect(result).to.eql({ data: { x: 1 }, text: 'hi' });
    });

    it('should return a plain value without outputs', async () => {
      const script = `
        return { value: 42 }
      `;
      const result = await render(script);
      expect(result).to.eql({ value: 42 });
    });

    it('should allow multiple snapshots at different points', async () => {
      const script = `
        data myData
        myData.x = 1
        var snap1 = myData.snapshot()
        myData.y = 2
        var snap2 = myData.snapshot()
        return { snap1: snap1, snap2: snap2 }
      `;
      const result = await render(script);
      expect(result.snap1).to.eql({ x: 1 });
      expect(result.snap2).to.eql({ x: 1, y: 2 });
    });

    it('should keep snapshot values immutable after further writes', async () => {
      const script = `
        data myData
        myData.x = 1
        var snap = myData.snapshot()
        myData.y = 2
        return { snap: snap, current: myData.snapshot() }
      `;
      const result = await render(script);
      expect(result.snap).to.eql({ x: 1 });
      expect(result.current).to.eql({ x: 1, y: 2 });
    });

    it('should allow snapshot usage inside conditionals', async () => {
      const script = `
        data myData
        myData.x = 1
        var ok = false
        if myData.snapshot().x == 1
          ok = true
        endif
        return { ok: ok }
      `;
      const result = await render(script);
      expect(result).to.eql({ ok: true });
    });

    it('should preserve snapshot point with async writes interleaving', async () => {
      const script = `
        data myData
        myData.x = 1
        var snap1 = myData.snapshot()
        myData.y = slowValue()
        var snap2 = myData.snapshot()
        return { snap1: snap1, snap2: snap2 }
      `;
      const result = await render(script, {
        slowValue: () => delay(10, 2)
      });
      expect(result.snap1).to.eql({ x: 1 });
      expect(result.snap2).to.eql({ x: 1, y: 2 });
    });

    it('should keep earlier snapshot resolved even if later output command fails', async () => {
      const script = `
        text out
        out("A")
        var snap = out.snapshot()
        out(explode())
        return snap
      `;
      const result = await render(script, {
        explode: () => {
          throw new Error('later failure');
        }
      });
      expect(result).to.be('A');
    });

    // Skipped: early return is not supported yet.
    it.skip('should support early return', async () => {
      const script = `
        data myData
        myData.x = 1
        if true
          return myData.snapshot()
        endif
        myData.y = 2
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });

    // Skipped: early return is not supported yet.
    it.skip('should support conditional return branches', async () => {
      const script = `
        data myData
        if flag
          myData.x = 1
          return myData.snapshot()
        else
          myData.y = 2
          return myData.snapshot()
        endif
      `;
      const resultTrue = await render(script, { flag: true });
      const resultFalse = await render(script, { flag: false });
      expect(resultTrue).to.eql({ x: 1 });
      expect(resultFalse).to.eql({ y: 2 });
    });

    // Skipped: early return is not supported yet.
    it.skip('should only execute the first return statement', async () => {
      const script = `
        if true
          return { early: 1 }
        endif
        return { late: 2 }
      `;
      const result = await render(script);
      expect(result).to.eql({ early: 1 });
    });

    // Skipped: early return is not supported yet.
    it.skip('should support return inside loops', async () => {
      const script = `
        for item in [1, 2, 3]
          if item == 2
            return { value: item }
          endif
        endfor
        return { value: 0 }
      `;
      const result = await render(script);
      expect(result).to.eql({ value: 2 });
    });

    it('should support return with no expression', async () => {
      const script = `
        return
      `;
      const result = await render(script);
      expect(result).to.be(undefined);
    });

    it('should support mixed return values with snapshots', async () => {
      const script = `
        data myData
        myData.x = 1
        return { data: myData.snapshot(), other: 42, flag: true }
      `;
      const result = await render(script);
      expect(result).to.eql({ data: { x: 1 }, other: 42, flag: true });
    });

    // Skipped: early return is not supported yet.
    it.skip('should support return inside guard/recover blocks', async () => {
      const script = `
        data myData
        guard
          myData.x = 1
          return myData.snapshot()
        recover err
          return { error: err#message }
        endguard
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });
  });

  describe('Sink Outputs', function () {
    it('should execute sink methods during flattening', async () => {
      const context = {
        makeLogger() {
          return {
            msgs: [],
            write(msg) { this.msgs.push(msg); },
            snapshot() { return this.msgs.slice(); }
          };
        }
      };
      const script = `
        sink logger = makeLogger()
        logger.write("msg")
        return logger.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql(['msg']);
    });

    it.skip('should await async sink methods', async () => {
      const context = {
        makeLogger() {
          return {
            msgs: [],
            async writeAsync(msg) {
              await delay(5);
              this.msgs.push(msg);
            },
            snapshot() { return this.msgs.slice(); }
          };
        },
      };
      const script = `
        sink logger = makeLogger()
        logger.writeAsync("msg")
        return logger.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql(['msg']);
    });

    it('should preserve sink method call order', async () => {
      const context = {
        makeLogger() {
          return {
            msgs: [],
            write(msg) { this.msgs.push(msg); },
            snapshot() { return this.msgs.slice(); }
          };
        },
      };
      const script = `
        sink logger = makeLogger()
        logger.write("a")
        logger.write("b")
        return logger.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql(['a', 'b']);
    });

    it('should support sink method calls through subpaths', async () => {
      const context = {
        makeLogger() {
          return {
            nested: {
              msgs: [],
              write(msg) { this.msgs.push(msg); }
            },
            snapshot() { return this.nested.msgs.slice(); }
          };
        }
      };
      const script = `
        sink logger = makeLogger()
        logger.nested.write("msg")
        return logger.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql(['msg']);
    });

    it('should use getReturnValue when snapshot is missing', async () => {
      const context = {
        makeLogger() {
          return {
            msgs: [],
            write(msg) { this.msgs.push(msg); },
            getReturnValue() { return this.msgs.slice(); }
          };
        }
      };
      const script = `
        sink logger = makeLogger()
        logger.write("msg")
        return logger.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql(['msg']);
    });

    it('should use finalize when snapshot and getReturnValue are missing', async () => {
      const context = {
        makeLogger() {
          return {
            msgs: [],
            write(msg) { this.msgs.push(msg); },
            finalize() { return this.msgs.slice(); }
          };
        }
      };
      const script = `
        sink logger = makeLogger()
        logger.write("msg")
        return logger.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql(['msg']);
    });

    it('should surface synchronous sink snapshot errors', async () => {
      const script = `
        sink logger = makeLogger()
        return logger.snapshot()
      `;
      try {
        await render(script, {
          makeLogger: () => ({
            snapshot: () => {
              throw new Error('sink snapshot failed');
            }
          })
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sink snapshot failed');
      }
    });

    it('should surface async sink snapshot rejections', async () => {
      const script = `
        sink logger = makeLogger()
        return logger.snapshot()
      `;
      try {
        await render(script, {
          makeLogger: () => ({
            snapshot: async () => {
              await delay(5);
              throw new Error('sink snapshot rejected');
            }
          })
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sink snapshot rejected');
      }
    });
  });

  describe('Sequence Outputs', function () {
    it('should return values from sequence method calls', async () => {
      const result = await render(`
        sequence db = makeSequence()
        var user = db.getUser(2)
        return user
      `, {
        makeSequence: () => ({
          getUser(id) { return { id: id, role: 'member' }; }
        })
      });
      expect(result).to.eql({ id: 2, role: 'member' });
    });

    it('should return values from sequence property reads', async () => {
      const result = await render(`
        sequence db = makeSequence()
        var state = db.connectionState
        return state
      `, {
        makeSequence: () => ({
          connectionState: 'ready'
        })
      });
      expect(result).to.be('ready');
    });

    it('should return undefined for missing sequence properties', async () => {
      const result = await render(`
        sequence db = makeSequence()
        var state = db.missing
        return state
      `, {
        makeSequence: () => ({})
      });
      expect(result).to.be(undefined);
    });

    it('should preserve method receiver binding for sequence methods', async () => {
      const result = await render(`
        sequence db = makeSequence()
        var value = db.read()
        return value
      `, {
        makeSequence: () => ({
          value: 42,
          read() { return this.value; }
        })
      });
      expect(result).to.be(42);
    });

    it('should support async return values from sequence methods', async () => {
      const result = await render(`
        sequence db = makeSequence()
        var value = db.getAsync()
        return value
      `, {
        makeSequence: () => ({
          async getAsync() {
            await delay(5);
            return 7;
          }
        })
      });
      expect(result).to.be(7);
    });

    it('should preserve sequence call order', async () => {
      const result = await render(`
        sequence db = makeSequence()
        var a = db.next()
        var b = db.next()
        return { a: a, b: b, events: db.snapshot() }
      `, {
        makeSequence: () => ({
          i: 0,
          events: [],
          next() {
            this.i += 1;
            this.events.push(this.i);
            return this.i;
          },
          snapshot() {
            return this.events.slice();
          }
        })
      });
      expect(result).to.eql({ a: 1, b: 2, events: [1, 2] });
    });

    it('should support sequence subpath method calls', async () => {
      const result = await render(`
        sequence db = makeSequence()
        var value = db.api.read(3)
        return value
      `, {
        makeSequence: () => ({
          api: {
            read(v) { return v * 2; }
          }
        })
      });
      expect(result).to.be(6);
    });
  });

  describe('Macros', function () {
    it('should support explicit outputs inside macros', async () => {
      const script = `
        macro buildUser()
          data myData
          myData.name = "Alice"
          return myData.snapshot()
        endmacro
        var result = buildUser()
        return result
      `;
      const result = await render(script);
      expect(result).to.eql({ name: 'Alice' });
    });

    it('should isolate macro outputs from outer scope', async () => {
      const script = `
        data myData
        myData.outer = true
        macro inner()
          data myData
          myData.inner = true
          return myData.snapshot()
        endmacro
        var innerResult = inner()
        return { outer: myData.snapshot(), inner: innerResult }
      `;
      const result = await render(script);
      expect(result).to.eql({ outer: { outer: true }, inner: { inner: true } });
    });

    it('should support text output inside macros', async () => {
      const script = `
        macro greet()
          text textOut
          textOut("hello")
          textOut(" world")
          return textOut.snapshot()
        endmacro
        var result = greet()
        return result
      `;
      const result = await render(script);
      expect(result).to.be('hello world');
    });

    it('should support multiple outputs inside macros', async () => {
      const script = `
        macro bundle()
          data myData
          text textOut
          myData.x = 1
          textOut("ok")
          return { data: myData.snapshot(), text: textOut.snapshot() }
        endmacro
        var result = bundle()
        return result
      `;
      const result = await render(script);
      expect(result).to.eql({ data: { x: 1 }, text: 'ok' });
    });

    it('should handle nested macros with same output name', async () => {
      const script = `
        macro inner()
        data myData
        myData.level = 'inner'
        return myData.snapshot()
      endmacro
      macro outer()
        data myData
        myData.level = 'outer'
        var innerRes = inner()
        myData.inner = innerRes
        return myData.snapshot()
      endmacro
      return outer()
    `;
      const result = await render(script);
      expect(result).to.eql({ level: 'outer', inner: { level: 'inner' } });
    });

    it('should throw when macro parameter conflicts with output name', async () => {
      const script = `
        macro conflict(x)
          data x
          x.a = 1
          return x.snapshot()
        endmacro
        return conflict(1)
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Cannot declare output');
      }
    });

    it('should pass output snapshots as regular values', async () => {
      const script = `
        data myData
        myData.x = 1
        macro wrap(value)
          return value
        endmacro
        var snap = myData.snapshot()
        var result = wrap(snap)
        return result
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });
  });

  describe('Capture', function () {
    // Skipped: capture block syntax is not yet removed.
    it.skip('should reject capture blocks', async () => {
      // TODO: Remove capture once the new explicit output model fully replaces it.
      const script = `
        var result = capture
          var x = 1
        endcapture
        return result
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.match(/capture|Unexpected|Invalid/);
      }
    });
  });

  describe('Caller', function () {
    it('should support caller blocks with explicit outputs', async () => {
      const script = `
        macro collect(items)
          data myData
          for item in items
            var itemVal = caller(item)
            myData.items.push(itemVal)
          endfor
          return myData.snapshot()
        endmacro

        var callRes = call collect([1, 2, 3]) (num)
          value out
          out(num * 2)
          return out.snapshot()
        endcall

        return callRes
      `;
      const result = await render(script);
      expect(result).to.eql({ items: [2, 4, 6] });
    });

    it('should support caller blocks that return text and data', async () => {
      const script = `
        macro collect(items)
          data myData
          for item in items
            var res = caller(item)
            myData.items.push(res.data)
            myData.texts.push(res.text)
          endfor
          return myData.snapshot()
        endmacro

        var callRes = call collect([1, 2]) (num)
          data outData
          text outText
          outData.value = num
          outText("v" + num)
          return { data: outData.snapshot(), text: outText.snapshot() }
        endcall

        return callRes
      `;
      const result = await render(script);
      expect(result).to.eql({ items: [{ value: 1 }, { value: 2 }], texts: ['v1', 'v2'] });
    });

    // Skipped: caller with arguments is not supported yet.
    it.skip('should keep macro and caller outputs isolated', async () => {
      const script = `
        data outer
        macro collect(items)
          data collected
          collected.results = []
          for item in items
            var result = caller(item)
            collected.results.push(result)
          endfor
          return collected.snapshot()
        endmacro

        var macroResult = call collect([1, 2]) (num)
          data itemData
          itemData.value = num + 1
          return itemData.snapshot()
        endcall

        outer.macro = macroResult
        return outer.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ macro: { results: [{ value: 2 }, { value: 3 }] } });
    });
  });

  describe('Scoping', function () {
    it('should shadow outputs in nested scopes', async () => {
      const script = `
        data myData
        myData.x = 1
        if true
          data myData
          myData.y = 2
        endif
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });

    it('should allow inner scopes to use parent outputs', async () => {
      const script = `
        data myData
        if true
          myData.x = 1
        endif
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });

    it('should allow outputs inside loops', async () => {
      const script = `
        data myData
        for item in [1, 2, 3]
          myData.items.push(item)
        endfor
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ items: [1, 2, 3] });
    });

    it('should keep block-scoped outputs inaccessible outside the block', async () => {
      const script = `
        if true
          data scoped
          scoped.x = 1
        endif
        return scoped.snapshot()
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.match(/Cannot read|not defined|undefined|Can not look up/);
      }
    });
  });

  describe('Async', function () {
    it('should handle async values when writing to outputs', async () => {
      const context = {
        fetchValue() { return delay(5, 10); }
      };
      const script = `
        data myData
        var value = fetchValue()
        myData.x = value
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ x: 10 });
    });

    it('should combine multiple async writes to the same output', async () => {
      const context = {
        fetchA() { return delay(5, 'a'); },
        fetchB() { return delay(1, 'b'); }
      };
      const script = `
        data myData
        myData.a = fetchA()
        myData.b = fetchB()
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ a: 'a', b: 'b' });
    });

    it('should wait for async values in return expressions', async () => {
      const context = {
        fetchValue() { return delay(5, 99); }
      };
      const script = `
        var value = fetchValue()
        return { result: value }
      `;
      const result = await render(script, context);
      expect(result).to.eql({ result: 99 });
    });

    it('should handle nested async dependencies with outputs', async () => {
      const context = {
        fetchUser() { return delay(5, { id: 3, name: 'Ana' }); },
        fetchProfile(id) { return delay(5, { userId: id, theme: 'light' }); }
      };
      const script = `
        data myData
        var user = fetchUser()
        var profile = fetchProfile(user.id)
        myData.user = user
        myData.profile = profile
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ user: { id: 3, name: 'Ana' }, profile: { userId: 3, theme: 'light' } });
    });

    it('should support sequential each loops with outputs', async () => {
      const context = {
        fetchValue(v) { return delay(2, v * 2); }
      };
      const script = `
        data myData
        each item in [1, 2, 3]
          myData.items.push(fetchValue(item))
        endeach
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ items: [2, 4, 6] });
    });
  });

  describe('Error Cases', function () {
    it('should throw on redeclaration of an output', async () => {
      const script = `
        data myData
        data myData
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('already declared');
      }
    });

    it('should throw when data outputs have initializers', async () => {
      const script = `
        data myData = 1
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('cannot have initializers');
      }
    });

    it('should throw when text outputs have initializers', async () => {
      const script = `
        text textOut = "hi"
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('cannot have initializers');
      }
    });

    it('should throw when value outputs have initializers', async () => {
      const script = `
        value result = 1
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('cannot have initializers');
      }
    });

    it('should throw when sink outputs have no initializer', async () => {
      const script = `
        sink logger
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sink outputs must have an initializer');
      }
    });

    it('should throw when sequence outputs have no initializer', async () => {
      const script = `
        sequence db
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sequence outputs must have an initializer');
      }
    });

    it('should throw on sequence property assignment in phase 1', async () => {
      const script = `
        sequence db = makeSequence()
        db.state = "x"
      `;
      try {
        await render(script, { makeSequence: () => ({ state: 'y' }) });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('does not support property assignment');
      }
    });

    it('should throw when using undeclared outputs', async () => {
      const script = `
        myData.x = 1
        return myData.snapshot()
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.match(/Cannot read|not defined|undefined|Can not look up|Cannot assign to undeclared variable/);
      }
    });

    it('should throw when output name conflicts with variable', async () => {
      const script = `
        var x = 1
        data x
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Cannot declare output');
      }
    });

    it('should throw when variable name conflicts with output', async () => {
      const script = `
        data x
        var x = 1
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Cannot declare variable');
      }
    });

    it('should throw on invalid output method', async () => {
      const script = `
        data myData
        myData.x.nonExistentMethod(1)
        return myData.snapshot()
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('has no method');
      }
    });

    it('should surface sink initialization errors', async () => {
      const context = {
        fail() { throw new Error('init failed'); }
      };
      const script = `
        sink logger = fail()
        return logger.snapshot()
      `;
      try {
        await render(script, context);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('init failed');
      }
    });

    it('should surface sink method call errors', async () => {
      const context = {
        makeLogger() {
          return {
            write() { throw new Error('sink write failed'); },
            snapshot() { return []; }
          };
        }
      };
      const script = `
        sink logger = makeLogger()
        logger.write("msg")
        return logger.snapshot()
      `;
      try {
        await render(script, context);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sink write failed');
      }
    });

    it('should throw on invalid push target', async () => {
      const script = `
        data myData
        myData.x = 'string'
        myData.x.push('value')
        return myData.snapshot()
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Target for');
      }
    });
  });

  describe('Revert Operations', function () {
    // Skipped: output _revert() syntax is removed.
    it.skip('should reject _revert() on outputs', async () => {
      // TODO: Remove _revert once guard/revert semantics are updated to the new model.
      const script = `
        data myData
        myData.x = 1
        myData._revert()
        return myData.snapshot()
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.match(/_revert|Unknown|Invalid|has no method/);
      }
    });
  });

  describe('Edge Cases', function () {
    it('should allow very long output names', async () => {
      const script = `
        data thisIsAReallyLongOutputNameForTestingPurposesOnly
        thisIsAReallyLongOutputNameForTestingPurposesOnly.x = 1
        return thisIsAReallyLongOutputNameForTestingPurposesOnly.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });

    it('should allow output names with underscores', async () => {
      const script = `
        data my_output_data
        my_output_data.x = 1
        return my_output_data.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });

    it('should allow single character output names', async () => {
      const script = `
        data x
        x.value = 10
        return x.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ value: 10 });
    });

    it('should support all output types in a single script', async () => {
      const context = {
        makeLogger() {
          return {
            items: [],
            write(msg) { this.items.push(msg); },
            snapshot() { return this.items; }
          };
        }
      };
      const script = `
        data myData
        text textOut
        value result
        sink logger = makeLogger()
        myData.x = 1
        textOut("hi")
        result(5)
        logger.write("log")
        return { data: myData.snapshot(), text: textOut.snapshot(), value: result.snapshot(), sink: logger.snapshot() }
      `;
      const result = await render(script, context);
      expect(result).to.eql({ data: { x: 1 }, text: 'hi', value: 5, sink: ['log'] });
    });

    it('should support outputs in for, while, and each loops', async () => {
      const script = `
        data myData
        for item in [1, 2]
          myData.forItems.push(item)
        endfor
        var i = 0
        while i < 2
          myData.whileItems.push(i)
          i = i + 1
        endwhile
        each item in [3, 4]
          myData.eachItems.push(item)
        endeach
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ forItems: [1, 2], whileItems: [0, 1], eachItems: [3, 4] });
    });

    it('should support complex nested structures', async () => {
      const script = `
        data myData
        myData.a.b.c = 1
        myData.a.b.d = 2
        myData.a.e = { f: 3 }
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ a: { b: { c: 1, d: 2 }, e: { f: 3 } } });
    });

    it('should support sink snapshots returning null/undefined', async () => {
      const context = {
        makeNullSink() {
          return { snapshot() { return null; } };
        },
        makeUndefSink() {
          return { snapshot() { return undefined; } };
        }
      };
      const script = `
        sink nullSink = makeNullSink()
        sink undefSink = makeUndefSink()
        return { n: nullSink.snapshot(), u: undefSink.snapshot() }
      `;
      const result = await render(script, context);
      expect(result).to.eql({ n: null, u: undefined });
    });

    it('should preserve special characters in text outputs', async () => {
      env = new AsyncEnvironment(null, { autoescape: false });
      const script = `
        text textOut
        textOut("line1\\nline2")
        textOut("\\tindent")
        textOut("\\"quote\\"")
        return textOut.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be('line1\nline2\tindent"quote"');
    });
  });

  describe('Error Propagation', function () {
    it('should surface errors during data operations', async () => {
      const context = {
        boom() { throw new Error('boom'); }
      };
      const script = `
        data myData
        myData.x = boom()
        return myData.snapshot()
      `;
      try {
        await render(script, context);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('boom');
      }
    });

    it('should propagate poison through outputs', async () => {
      const context = {
        failAsync() { return Promise.reject(new Error('async fail')); }
      };
      const script = `
        data myData
        myData.x = failAsync()
        return myData.snapshot()
      `;
      try {
        await render(script, context);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('async fail');
      }
    });

    it('should collect multiple output errors', async () => {
      const context = {
        failA() { return Promise.reject(new Error('fail A')); },
        failB() { return Promise.reject(new Error('fail B')); }
      };
      const script = `
        data myData
        myData.a = failA()
        myData.b = failB()
        return myData.snapshot()
      `;
      try {
        await render(script, context);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        const messages = err.errors.map(e => e.message).join(' | ');
        expect(messages).to.contain('fail A');
        expect(messages).to.contain('fail B');
      }
    });

    it('should propagate errors from sink methods', async () => {
      const context = {
        makeLogger() {
          return {
            write() { throw new Error('sink error'); },
            snapshot() { return []; }
          };
        }
      };
      const script = `
        sink logger = makeLogger()
        logger.write("msg")
        return logger.snapshot()
      `;
      try {
        await render(script, context);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sink error');
      }
    });
  });

  describe('Guard Operations', function () {
    it('should allow guard blocks with explicit outputs', async () => {
      const script = `
        data myData
        guard
          myData.x = 1
        endguard
        return myData.snapshot()
      `;
      const result = await render(script);
      expect(result).to.eql({ x: 1 });
    });

    it('should revert outputs when guard fails', async () => {
      const context = {
        fail() { return createPoison([new Error('guard fail')]); }
      };
      const script = `
        data myData
        myData.before = 1
        guard
          myData.temp = fail()
        endguard
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ before: 1 });
    });

    it('should revert only guard changes on failure', async () => {
      const context = {
        fail() { return createPoison([new Error('guard fail')]); }
      };
      const script = `
        data myData
        myData.x = 1
        guard
          myData.y = fail()
        endguard
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ x: 1 });
    });

    it('should handle nested guards with output reverts', async () => {
      const context = {
        fail() { return createPoison([new Error('inner fail')]); }
      };
      const script = `
        data myData
        guard
          myData.outer = 1
          guard
            myData.inner = fail()
          endguard
        endguard
        return myData.snapshot()
      `;
      const result = await render(script, context);
      expect(result).to.eql({ outer: 1 });
    });
  });
});
