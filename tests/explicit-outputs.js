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

    it('should support multiple output declarations', async () => {
      const script = `
        data myData
        text textOut
        var result
        myData.x = 1
        textOut("hi")
        result = 7
        return { data: myData.snapshot(), text: textOut.snapshot(), value: result }
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

    it('should overwrite text output with assignment', async () => {
      const script = `
        text textOut
        textOut("Hello")
        textOut = "World"
        return textOut.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be('World');
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
        var result
        result = 42
        result = 100
        return result
      `;
      const result = await render(script);
      expect(result).to.be(100);
    });

    it('should implicitly snapshot value outputs in expressions', async () => {
      const script = `
        var x
        x = 5
        var y = x * 2
        return y
      `;
      const result = await render(script);
      expect(result).to.be(10);
    });

    it('should allow value output initializer and use it in expressions', async () => {
      const script = `
        var x = 3
        var y = x + 4
        return y
      `;
      const result = await render(script);
      expect(result).to.be(7);
    });

    it('should support async value initializer in expressions', async () => {
      const script = `
        var x = delayed(11, 20)
        var y = x * 3
        return y
      `;
      const result = await render(script, {
        delayed: (v, ms) => delay(ms, v)
      });
      expect(result).to.be(33);
    });

    it('should use initialized value output across chained expressions', async () => {
      const script = `
        var score = 10
        var boosted = score + 5
        var finalScore = boosted * score
        return finalScore
      `;
      const result = await render(script);
      expect(result).to.be(150);
    });

    it('should reject bare symbol reads for non-value outputs', async () => {
      const script = `
        data myData
        text textOut
        sink logger = makeLogger()
        var a = myData
        var b = textOut
        var c = logger
        return { a: a, b: b, c: c }
      `;
      try {
        await render(script, {
          makeLogger: () => ({
            snapshot() { return []; }
          })
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('cannot be used as a bare symbol');
        expect(err.message).to.contain('snapshot()');
      }
    });

    it('should support implicit value snapshots inside for loops', async () => {
      const script = `
        var current = 0
        for i in [1, 2, 3]
          current = i * 10
        endfor
        var doubled = current * 2
        return { current: current, doubled: doubled }
      `;
      const result = await render(script);
      expect(result).to.eql({ current: 30, doubled: 60 });
    });

    it('should preserve source-order value result when parallel loop writes resolve out of order', async () => {
      const finished = [];
      const script = `
        var current = 0
        for item in [{v: 1, d: 30}, {v: 2, d: 5}, {v: 3, d: 20}]
          current = delayed(item.v, item.d)
        endfor
        var doubled = current * 2
        return { current: current, doubled: doubled }
      `;
      const result = await render(script, {
        delayed: (v, ms) => delay(ms, v).then((resolved) => {
          finished.push(resolved);
          return resolved;
        })
      });

      expect(finished).to.eql([2, 3, 1]);
      expect(result).to.eql({ current: 3, doubled: 6 });
    });

    it('should support implicit value snapshots inside while loops', async () => {
      const script = `
        var last = 0
        var i = 1
        while i <= 4
          last = i
          i = i + 1
        endwhile
        var plus = last + 6
        return { last: last, plus: plus }
      `;
      const result = await render(script);
      expect(result).to.eql({ last: 4, plus: 10 });
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
        var result
        return { data: myData.snapshot(), text: textOut.snapshot(), value: result }
      `;
      const result = await render(script);
      expect(result).to.eql({ data: {}, text: '', value: null });
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
    it('should return values from sequence calls and reads', async () => {
      const script = `
        sequence db = makeDb()
        var user = db.getUser(1)
        var state = db.connectionState
        var id = db.api.client.getId()
        var missing = db.notThere
        return { user: user, state: state, id: id, missing: missing }
      `;
      const result = await render(script, {
        makeDb: () => ({
          connectionState: 'connected',
          getUser(id) { return { id: id, name: 'u' + id }; },
          api: {
            client: {
              id: 42,
              getId() { return this.id; }
            }
          }
        })
      });
      expect(result).to.eql({
        user: { id: 1, name: 'u1' },
        state: 'connected',
        id: 42,
        missing: undefined
      });
    });

    it('should return values from sequence subpath property reads', async () => {
      const script = `
        sequence db = makeDb()
        var status = db.api.client.status
        return status
      `;
      const result = await render(script, {
        makeDb: () => ({
          api: {
            client: {
              status: 'ready'
            }
          }
        })
      });
      expect(result).to.be('ready');
    });

    it('should support async sequence call return values', async () => {
      const script = `
        sequence db = makeDb()
        var user = db.getUserAsync(9)
        return user
      `;
      const result = await render(script, {
        makeDb: () => ({
          async getUserAsync(id) {
            await delay(5);
            return { id: id };
          }
        })
      });
      expect(result).to.eql({ id: 9 });
    });

    it('should preserve source order for sequence calls', async () => {
      const script = `
        sequence db = makeDb()
        var a = db.step("a")
        var b = db.step("b")
        return db.snapshot()
      `;
      const result = await render(script, {
        makeDb: () => ({
          log: [],
          step(label) { this.log.push(label); return label; },
          snapshot() { return this.log.slice(); }
        })
      });
      expect(result).to.eql(['a', 'b']);
    });

    it('should run sequence guard transactions (begin/commit and begin/rollback)', async () => {
      const successScript = `
        sequence db = makeDb()
        guard db
          var r = db.write("ok")
        endguard
        return db.snapshot()
      `;
      const success = await render(successScript, {
        makeDb: () => ({
          events: [],
          begin() { this.events.push('begin'); return { tx: 1 }; },
          commit() { this.events.push('commit'); },
          rollback() { this.events.push('rollback'); },
          write(v) { this.events.push('write:' + v); return v; },
          snapshot() { return this.events.slice(); }
        })
      });
      expect(success).to.eql(['begin', 'write:ok', 'commit']);

      const failureScript = `
        sequence db = makeDb()
        var flag = "ok"
        guard db, flag
          var r = db.write("fail")
          flag = fail()
        endguard
        return db.snapshot()
      `;
      const failure = await render(failureScript, {
        makeDb: () => ({
          events: [],
          begin() { this.events.push('begin'); return { tx: 2 }; },
          commit() { this.events.push('commit'); },
          rollback() { this.events.push('rollback'); },
          write(v) {
            this.events.push('write:' + v);
            return v;
          },
          snapshot() { return this.events.slice(); }
        }),
        fail: () => createPoison([new Error('guard failure')])
      });
      expect(failure).to.eql(['begin', 'write:fail', 'rollback']);
    });

    it('should pass begin token to commit/rollback hooks', async () => {
      const successScript = `
        sequence tx = makeTx()
        guard tx
          var runResult = tx.run("ok")
        endguard
        return tx.snapshot()
      `;
      const success = await render(successScript, {
        makeTx: () => {
          const events = [];
          return {
            begin() {
              events.push('begin');
              return 't1';
            },
            run(v) {
              events.push('run:' + v);
              return v;
            },
            commit(token) {
              events.push('commit:' + token);
            },
            rollback(token) {
              events.push('rollback:' + token);
            },
            snapshot() {
              return events.slice();
            }
          };
        }
      });
      expect(success).to.eql(['begin', 'run:ok', 'commit:t1']);

      const failureScript = `
        sequence tx = makeTx()
        var runState = "ok"
        guard tx, runState
          tx.run("ok")
          runState = fail()
        endguard
        return tx.snapshot()
      `;
      const failure = await render(failureScript, {
        fail: () => createPoison([new Error('guard-fail')]),
        makeTx: () => {
          const events = [];
          return {
            begin() {
              events.push('begin');
              return 't2';
            },
            run(v) {
              events.push('run:' + v);
              return v;
            },
            commit(token) {
              events.push('commit:' + token);
            },
            rollback(token) {
              events.push('rollback:' + token);
            },
            snapshot() {
              return events.slice();
            }
          };
        }
      });
      expect(failure).to.eql(['begin', 'run:ok', 'rollback:t2']);
    });

    it('should skip sequence transaction hooks when they are missing', async () => {
      const script = `
        sequence db = makeDb()
        var flag = "ok"
        guard db, flag
          db.write("x")
          flag = fail()
        endguard
        return { events: db.snapshot(), flag: flag }
      `;
      const result = await render(script, {
        fail: () => createPoison([new Error('guard-fail')]),
        makeDb: () => ({
          events: [],
          write(v) {
            this.events.push('write:' + v);
            return v;
          },
          snapshot() {
            return this.events.slice();
          }
        })
      });
      expect(result.events).to.eql(['write:x']);
      expect(result.flag).to.be('ok');
    });

    it('should treat begin/commit hook failures as guard errors', async () => {
      const beginFailScript = `
        sequence tx = makeTx()
        var state = "ok"
        guard tx, state
          state = "changed"
          tx.run("x")
        endguard
        return { state: state, events: tx.snapshot() }
      `;
      const beginFail = await render(beginFailScript, {
        makeTx: () => ({
          events: [],
          begin() { this.events.push('begin'); throw new Error('begin-fail'); },
          run(v) { this.events.push('run:' + v); return v; },
          snapshot() { return this.events.slice(); }
        })
      });
      expect(beginFail.state).to.be('ok');
      expect(beginFail.events).to.contain('begin');
      expect(beginFail.events.some(e => e.indexOf('commit:') === 0)).to.be(false);

      const commitFailScript = `
        sequence tx = makeTx()
        var state = "ok"
        guard tx, state
          state = "changed"
          tx.run("x")
        endguard
        return { state: state, events: tx.snapshot() }
      `;
      const commitFail = await render(commitFailScript, {
        makeTx: () => ({
          events: [],
          begin() { this.events.push('begin'); return 't'; },
          run(v) { this.events.push('run:' + v); return v; },
          commit(token) { this.events.push('commit:' + token); throw new Error('commit-fail'); },
          rollback(token) { this.events.push('rollback:' + token); },
          snapshot() { return this.events.slice(); }
        })
      });
      expect(commitFail.state).to.be('ok');
      expect(commitFail.events).to.eql(['begin', 'run:x', 'commit:t', 'rollback:t']);
    });

    it('should unwind multi-handler sequence transactions in LIFO order', async () => {
      const successEvents = [];
      const successScript = `
        sequence a = makeA()
        sequence b = makeB()
        guard a, b
          a.run()
          b.run()
        endguard
        return events
      `;
      const success = await render(successScript, {
        events: successEvents,
        makeA: function () {
          const ev = successEvents;
          return {
            begin() { ev.push('a:begin'); return 'ta'; },
            run() { ev.push('a:run'); },
            commit(t) { ev.push('a:commit:' + t); },
            rollback(t) { ev.push('a:rollback:' + t); }
          };
        },
        makeB: function () {
          const ev = successEvents;
          return {
            begin() { ev.push('b:begin'); return 'tb'; },
            run() { ev.push('b:run'); },
            commit(t) { ev.push('b:commit:' + t); },
            rollback(t) { ev.push('b:rollback:' + t); }
          };
        }
      });
      expect(success).to.eql(['a:begin', 'b:begin', 'a:run', 'b:run', 'b:commit:tb', 'a:commit:ta']);

      const failureEvents = [];
      const failureScript = `
        sequence a = makeA()
        sequence b = makeB()
        var gate = "ok"
        guard a, b, gate
          a.run()
          b.run()
          gate = fail()
        endguard
        return events
      `;
      const failure = await render(failureScript, {
        events: failureEvents,
        fail: () => createPoison([new Error('guard-fail')]),
        makeA: function () {
          const ev = failureEvents;
          return {
            begin() { ev.push('a:begin'); return 'ta'; },
            run() { ev.push('a:run'); },
            commit(t) { ev.push('a:commit:' + t); },
            rollback(t) { ev.push('a:rollback:' + t); }
          };
        },
        makeB: function () {
          const ev = failureEvents;
          return {
            begin() { ev.push('b:begin'); return 'tb'; },
            run() { ev.push('b:run'); },
            commit(t) { ev.push('b:commit:' + t); },
            rollback(t) { ev.push('b:rollback:' + t); }
          };
        }
      });
      expect(failure).to.eql(['a:begin', 'b:begin', 'a:run', 'b:run', 'b:rollback:tb', 'a:rollback:ta']);
    });

    it('should avoid deadlock for sequence call expressions while guard buffer is paused', async function () {
      this.timeout(4000);
      const script = `
        data payload
        sequence db = makeDb()
        var gate = "ok"
        guard payload, gate
          payload.value = db.getValue()
          gate = fail()
        endguard
        return { data: payload.snapshot(), events: db.snapshot(), gate: gate }
      `;

      const run = render(script, {
        fail: () => createPoison([new Error('guard-fail')]),
        makeDb: () => ({
          events: [],
          async getValue() {
            await delay(10);
            this.events.push('call');
            return 7;
          },
          snapshot() {
            return this.events.slice();
          }
        })
      });

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out (possible paused-buffer deadlock)')), 2000)
      );
      const result = await Promise.race([run, timeout]);
      expect(result.data.value).to.be(undefined);
      expect(result.events).to.eql(['call']);
      expect(result.gate).to.be('ok');
    });

    it('should avoid deadlock for sequence expressions in foreign async child buffers', async function () {
      this.timeout(4000);
      const script = `
        sequence db = makeDb()
        data out
        var cond = asyncTrue()
        if cond
          out.value = db.next(5)
        endif
        return { out: out.snapshot(), events: db.snapshot() }
      `;

      const run = render(script, {
        asyncTrue: async () => {
          await delay(5);
          return true;
        },
        makeDb: () => ({
          events: [],
          async next(v) {
            await delay(10);
            this.events.push('call:' + v);
            return v * 2;
          },
          snapshot() {
            return this.events.slice();
          }
        })
      });

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out (possible foreign-buffer deadlock)')), 2000)
      );
      const result = await Promise.race([run, timeout]);
      expect(result.out.value).to.be(10);
      expect(result.events).to.eql(['call:5']);
    });
  });

  describe('Buffer Tree Ordering', function () {
    it('should preserve source order for root output writes emitted from async child blocks (data)', async () => {
      const script = `
        data out
        var cond = slowTrue()
        if cond
          out.items.push(slowValue("inner", 40))
        endif
        out.items.push(slowValue("outer", 5))
        return out.snapshot()
      `;
      const result = await render(script, {
        slowTrue: async () => {
          await delay(15);
          return true;
        },
        slowValue: (value, ms) => delay(ms, value)
      });
      expect(result).to.eql({ items: ['inner', 'outer'] });
    });

    it('should preserve source order for sink writes emitted from async child blocks', async () => {
      const script = `
        sink logger = makeLogger()
        var cond = slowTrue()
        if cond
          logger.write(slowValue("inner", 40))
        endif
        logger.write(slowValue("outer", 5))
        return logger.snapshot()
      `;
      const result = await render(script, {
        slowTrue: async () => {
          await delay(15);
          return true;
        },
        slowValue: (value, ms) => delay(ms, value),
        makeLogger: () => ({
          msgs: [],
          write(msg) { this.msgs.push(msg); },
          snapshot() { return this.msgs.slice(); }
        })
      });
      expect(result).to.eql(['inner', 'outer']);
    });

    it('should preserve sequence call order across async child and parent buffers with irregular timings', async () => {
      const script = `
        sequence db = makeDb()
        data out
        var cond = slowTrue()
        if cond
          out.first = db.next(slowValue("inner", 40))
        endif
        out.second = db.next(slowValue("outer", 5))
        return { out: out.snapshot(), events: db.snapshot() }
      `;
      const result = await render(script, {
        slowTrue: async () => {
          await delay(15);
          return true;
        },
        slowValue: (value, ms) => delay(ms, value),
        makeDb: () => ({
          events: [],
          next(label) {
            this.events.push(label);
            return label;
          },
          snapshot() {
            return this.events.slice();
          }
        })
      });
      expect(result.out.first).to.be('inner');
      expect(result.out.second).to.be('outer');
      expect(result.events).to.eql(['inner', 'outer']);
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

    it('should reject macro outputs that shadow parent scope outputs', async () => {
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
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('parent scope');
      }
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

    it('should not export macros declared inside macro bodies', async () => {
      const script = `
        macro outer()
          macro inner()
            return 42
          endmacro
          return inner()
        endmacro
        var outerResult = outer()
        var leaked = inner()
        return { outerResult: outerResult, leaked: leaked }
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('unknown variable/function: inner');
      }
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

    it('should reject reserved keywords as macro parameter names', async () => {
      const script = `
        macro bad(data)
          return data
        endmacro
        return bad(1)
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('is reserved');
      }
    });

    it('should reject duplicate macro parameter names', async () => {
      const script = `
        macro bad(x, x=1)
          return x
        endmacro
        return bad(2)
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('already been declared');
      }
    });

    it('should pass output snapshots as regular values', async () => {
      const script = `
        data myData
        myData.x = 1
        macro wrap(payload)
          return payload
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
          var out
          out = num * 2
          return out
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
    it('should reject same-name nested outputs that shadow parent scope', async () => {
      const script = `
        data myData
        myData.x = 1
        if true
          data myData
          myData.y = 2
        endif
        return myData.snapshot()
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('parent scope');
      }
    });

    it('should reject nested outputs that shadow parent outputs across types', async () => {
      const script = `
        data out
        if true
          text out
          out("x")
        endif
        return out.snapshot()
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('parent scope');
      }
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
        var fetchedValue = fetchValue()
        myData.x = fetchedValue
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
        var fetchedValue = fetchValue()
        return { result: fetchedValue }
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

    it('should overwrite text outputs when assigning with =', async () => {
      const script = `
        text textOut
        textOut = "hi"
        return textOut.snapshot()
      `;
      const result = await render(script);
      expect(result).to.be('hi');
    });

    it('should call snapshot() as a regular method on var values', async () => {
      const script = `
        var result = makeObj()
        return result.snapshot()
      `;
      const result = await render(script, {
        makeObj: () => ({
          snapshot() {
            return 1;
          }
        })
      });
      expect(result).to.be(1);
    });

    it('should allow value outputs with initializers', async () => {
      const script = `
        var result = 1
        return result
      `;
      const result = await render(script);
      expect(result).to.be(1);
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

    it('should throw on mixed assignment targets (declared value + undeclared variable)', async () => {
      const script = `
        var x
        x, y = 1
        return x
      `;
      try {
        await render(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Cannot assign to undeclared variable');
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

    it('should reject reserved keywords as output names', async () => {
      const scripts = [
        'data data',
        'var var = 1',
        'text var',
        'sink sequence = makeSink()'
      ];

      for (const script of scripts) {
        try {
          await render(script, {
            makeSink() {
              return { snapshot() { return null; } };
            }
          });
          expect().fail(`Should have thrown for script: ${script}`);
        } catch (err) {
          expect(err.message).to.contain('is reserved');
        }
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

    it('should reject sequence property assignment syntax', async () => {
      const script = `
        sequence db = makeDb()
        db.connectionState = "x"
      `;
      try {
        await render(script, { makeDb: () => ({ connectionState: 'ok' }) });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('does not support property assignment');
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
        var result
        sink logger = makeLogger()
        myData.x = 1
        textOut("hi")
        result = 5
        logger.write("log")
        return { data: myData.snapshot(), text: textOut.snapshot(), value: result, sink: logger.snapshot() }
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

    it('should reject sink snapshot() inside guard', async () => {
      const script = `
        sink logger = makeLogger()
        guard logger
          var snap = logger.snapshot()
          logger.write("x")
        endguard
        return logger.snapshot()
      `;
      try {
        await render(script, {
          makeLogger() {
            return {
              msgs: [],
              write(msg) { this.msgs.push(msg); },
              snapshot() { return this.msgs.slice(); }
            };
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sink snapshot() is not allowed inside guard blocks');
      }
    });

    it('should reject sink snapshot() inside nested guard with recover', async () => {
      const script = `
        sink logger = makeLogger()
        guard logger
          guard logger
            logger.write("x")
            var snap = logger.snapshot()
          recover
            logger.write("r")
          endguard
        endguard
        return logger.snapshot()
      `;
      try {
        await render(script, {
          makeLogger() {
            return {
              msgs: [],
              write(msg) { this.msgs.push(msg); },
              snapshot() { return this.msgs.slice(); }
            };
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('sink snapshot() is not allowed inside guard blocks');
      }
    });
  });
});
