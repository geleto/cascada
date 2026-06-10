
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/index.js';
import {delay} from '../util.js';

describe('Sequential Operations - Two Lock System', function () {
  let env;
  let context;
  let logs;

  beforeEach(() => {
    env = new AsyncEnvironment();
    logs = [];
    context = {
      logs: logs,
      // A sequenced object
      db: {
        // Write: Method call
        async write(id, ms) {
          logs.push(`start-write-${id}`);
          await delay(ms);
          logs.push(`end-write-${id}`);
          return `W${id}`;
        },
        // Read: Property (Simulated async getter)
        get readSimple() {
          // Instant read
          logs.push('read-simple');
          return 'R';
        },
        // Read: Async Property
        // We use a function that returns a promise, but identifying it as a property lookup in template
        get readAsync() {
          logs.push('start-read');
          return (async () => {
            await delay(20);
            logs.push('end-read');
            return 'R';
          })();
        },
        async readMethod(id, ms) {
          logs.push(`start-readMethod-${id}`);
          await delay(ms);
          logs.push(`end-readMethod-${id}`);
          return `RM${id}`;
        }
      }
    };
  });

  it('should allow parallel reads (property lookups) after a write', async () => {
    // db!.write("1", 20) -> Write. Should block reads.
    // db.readDynamic -> Read. Should wait for W1, runs 20ms.
    // db.readDynamic -> Read. Should wait for W1, runs 20ms.
    // PARALLEL: Total time for reads should be ~20ms, not 40ms.
    // db!.write("2", 10) -> Write. Should wait for BOTH reads.

    // Template:
    // {{ db!.write("1", 20) + (db.readDynamic + db.readDynamic) + db!.write("2", 10) }}

    // Note: The getter `readAsync` is called immediately when the property is looked up.
    // But the `sequentialMemberLookupAsync` wrapper ensures this lookup waits for the Write lock.

    // Constructing a slightly manual mocked getter for precise timing control/logging unique IDs
    let readCount = 0;
    Object.defineProperty(context.db, 'readDynamic', {
      get: function () {
        const id = ++readCount;
        logs.push(`req-read-${id}`); // Request started
        return (async () => {
          logs.push(`start-read-${id}`);
          await delay(20);
          logs.push(`end-read-${id}`);
          return `R${id}`;
        })();
      }
    });

    // Reads should wait for the last write, but do not need !! (repair).
    const template = `{{ db!.write("1", 20) }} {{ db.readDynamic }} {{ db.readDynamic }} {{ db!.write("2", 10) }}`;
    const res = await env.renderTemplateString(template, context);

    expect(res.replace(/\s+/g, '')).to.equal('W1R1R2W2');

    // Analyse logs
    // sequence:
    // start-write-1
    // end-write-1
    // req-read-1 (Wait passed)
    // req-read-2 (Wait passed)
    // start-read-1 & start-read-2 (Should be close)
    // end-read-1 & end-read-2 (Should be close)
    // start-write-2 (Only after both reads)

    const write1End = logs.indexOf('end-write-1');
    const read1Start = logs.indexOf('start-read-1');
    const read2Start = logs.indexOf('start-read-2');
    const write2Start = logs.indexOf('start-write-2');

    // Writes must block reads
    expect(read1Start).to.be.greaterThan(write1End);
    expect(read2Start).to.be.greaterThan(write1End);

    // Reads must block subsequent write
    const read1End = logs.indexOf('end-read-1');
    const read2End = logs.indexOf('end-read-2');
    expect(write2Start).to.be.greaterThan(read1End);
    expect(write2Start).to.be.greaterThan(read2End);

    // Reads should be parallel
    // If sequential: read2Start > read1End (or vice versa)
    // If parallel: read2Start < read1End && read1Start < read2End
    expect(read1Start).to.be.lessThan(read2End);
    expect(read2Start).to.be.lessThan(read1End);
  });

  it('should sequence bare reads that appear before a later write definition', async () => {
    Object.defineProperty(context.db, 'readBeforeDefinition', {
      get: function () {
        logs.push('start-read-before-definition');
        return (async () => {
          await delay(20);
          logs.push('end-read-before-definition');
          return 'R-before';
        })();
      }
    });

    const script = `
      var read = db.readBeforeDefinition
      var write = db!.write("after", 1)
      return { read: read, write: write, logs: logs }
    `;

    const result = await env.renderScriptString(script, context);

    expect(result.read).to.equal('R-before');
    expect(result.write).to.equal('Wafter');
    expect(logs.indexOf('start-write-after')).to.be.greaterThan(logs.indexOf('end-read-before-definition'));
  });

  it('should sequence loop bare reads that appear before a later write definition', async () => {
    let readCount = 0;
    Object.defineProperty(context.db, 'loopReadBeforeDefinition', {
      get: function () {
        const id = ++readCount;
        logs.push(`start-loop-read-${id}`);
        return (async () => {
          await delay(20);
          logs.push(`end-loop-read-${id}`);
          return `R${id}`;
        })();
      }
    });

    const script = `
      data out
      for item in [1, 2]
        out.items.push(db.loopReadBeforeDefinition)
      endfor
      var write = db!.write("loop", 1)
      return { out: out.snapshot(), write: write, logs: logs }
    `;

    const result = await env.renderScriptString(script, context);

    expect(result.out.items).to.eql(['R1', 'R2']);
    expect(result.write).to.equal('Wloop');
    const writeStart = logs.indexOf('start-write-loop');
    expect(writeStart).to.be.greaterThan(logs.indexOf('end-loop-read-1'));
    expect(writeStart).to.be.greaterThan(logs.indexOf('end-loop-read-2'));
  });

  it('should sequence nested bare reads (deep path) that appear before a later write definition', async () => {
    // Exercises the outermost-lookup walk in _getBareSequenceLockLookup: the
    // deep path db.users.nestedBeforeDefinition has no exact lock key, so it
    // must be matched to the base lock !db by walking to the root symbol. The
    // reads appear BEFORE the db!.write that defines !db, so this only works if
    // the bare-read matching runs in post-analysis against the completed root
    // sequenceLocks set rather than the partial set seen during the walk.
    let readCount = 0;
    context.db.users = {};
    Object.defineProperty(context.db.users, 'nestedBeforeDefinition', {
      get: function () {
        const id = ++readCount;
        logs.push(`start-nested-${id}`);
        return (async () => {
          await delay(20);
          logs.push(`end-nested-${id}`);
          return `N${id}`;
        })();
      }
    });

    const script = `
      var r1 = db.users.nestedBeforeDefinition
      var r2 = db.users.nestedBeforeDefinition
      var write = db!.write("nested", 1)
      return { r1: r1, r2: r2, write: write, logs: logs }
    `;

    const result = await env.renderScriptString(script, context);

    expect(result.r1).to.equal('N1');
    expect(result.r2).to.equal('N2');
    expect(result.write).to.equal('Wnested');

    // The base-path write must wait for both nested reads under !db.
    const write = logs.indexOf('start-write-nested');
    expect(write).to.be.greaterThan(logs.indexOf('end-nested-1'));
    expect(write).to.be.greaterThan(logs.indexOf('end-nested-2'));
    // The two reads share no ordering dependency, so they run in parallel.
    expect(logs.indexOf('start-nested-2')).to.be.lessThan(logs.indexOf('end-nested-1'));
  });

  it('should keep two independent locks separate when bare reads precede their definitions', async () => {
    // Two distinct sequenced bases (!db and !api), each read BEFORE its own !
    // definition. Verifies the reordered bare-read matching keeps locks
    // independent: the slow db read must not block the fast api lane.
    context.api = {
      async write(id, ms) {
        logs.push(`start-write-${id}`);
        await delay(ms);
        logs.push(`end-write-${id}`);
        return `W${id}`;
      },
      get beforeRead() {
        logs.push('start-read-api');
        return (async () => {
          await delay(5);
          logs.push('end-read-api');
          return 'R-api';
        })();
      }
    };
    Object.defineProperty(context.db, 'beforeRead', {
      get: function () {
        logs.push('start-read-db');
        return (async () => {
          await delay(50);
          logs.push('end-read-db');
          return 'R-db';
        })();
      }
    });

    const script = `
      var dbRead = db.beforeRead
      var apiRead = api.beforeRead
      var dbWrite = db!.write("db", 1)
      var apiWrite = api!.write("api", 1)
      return { dbRead: dbRead, apiRead: apiRead, dbWrite: dbWrite, apiWrite: apiWrite, logs: logs }
    `;

    const result = await env.renderScriptString(script, context);

    expect(result.dbRead).to.equal('R-db');
    expect(result.apiRead).to.equal('R-api');
    expect(result.dbWrite).to.equal('Wdb');
    expect(result.apiWrite).to.equal('Wapi');

    // Each write waits for the read on its OWN lock.
    expect(logs.indexOf('start-write-db')).to.be.greaterThan(logs.indexOf('end-read-db'));
    expect(logs.indexOf('start-write-api')).to.be.greaterThan(logs.indexOf('end-read-api'));

    // The locks are independent: the fast api lane is not blocked by the slow db read.
    expect(logs.indexOf('start-write-api')).to.be.lessThan(logs.indexOf('end-read-db'));
  });

  it('should treat marked method calls as writes (exclusive)', async () => {
    // db!.readMethod("1", 20) + db!.readMethod("2", 20)
    // Since method calls are Writes, these should invoke SEQUENTIALLY.

    const start = Date.now();
    const template = `{{ db!.readMethod("1", 20) }} {{ db!.readMethod("2", 20) }}`;
    await env.renderTemplateString(template, context);
    const duration = Date.now() - start;

    // 20 + 20 = 40ms.
    // If they were parallel: 20ms.
    expect(duration).to.be.greaterThan(30);

    const start2 = logs.indexOf('start-readMethod-2');
    const end1 = logs.indexOf('end-readMethod-1');
    expect(start2).to.be.greaterThan(end1);
  });

  it('should handle Mixed Read/Write sequence correctly', async () => {
    // W1 -> [R1, R2] -> W2 -> R3
    let readCount = 0;
    Object.defineProperty(context.db, 'r', {
      get: function () {
        const id = ++readCount;
        return (async () => {
          await delay(20);
          return `R${id}`;
        })();
      }
    });

    const template = `{{ db!.write("1", 10) }} {{ db.r }} {{ db.r }} {{ db!.write("2", 10) }} {{ db.r }}`;
    const res = await env.renderTemplateString(template, context);
    expect(res.replace(/\s+/g, '')).to.equal('W1R1R2W2R3');
  });

  it('should sequence nested lookups under a sequenced base path', async () => {
    let readCount = 0;
    context.db.users = {};
    Object.defineProperty(context.db.users, 'readNested', {
      get: function () {
        const id = ++readCount;
        logs.push(`req-nested-${id}`);
        return (async () => {
          logs.push(`start-nested-${id}`);
          await delay(20);
          logs.push(`end-nested-${id}`);
          return `N${id}`;
        })();
      }
    });

    const template = `{{ db!.write("1", 20) }} {{ db.users.readNested }} {{ db.users.readNested }} {{ db!.write("2", 10) }}`;
    const res = await env.renderTemplateString(template, context);
    expect(res.replace(/\s+/g, '')).to.equal('W1N1N2W2');

    const write1End = logs.indexOf('end-write-1');
    const nested1Start = logs.indexOf('start-nested-1');
    const nested2Start = logs.indexOf('start-nested-2');
    const write2Start = logs.indexOf('start-write-2');

    expect(nested1Start).to.be.greaterThan(write1End);
    expect(nested2Start).to.be.greaterThan(write1End);

    const nested1End = logs.indexOf('end-nested-1');
    const nested2End = logs.indexOf('end-nested-2');
    expect(write2Start).to.be.greaterThan(nested1End);
    expect(write2Start).to.be.greaterThan(nested2End);
  });

});
