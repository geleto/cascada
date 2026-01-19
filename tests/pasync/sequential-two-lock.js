'use strict';

var expect;
var AsyncEnvironment;
var delay;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const index = require('../../src/index');
  AsyncEnvironment = index.AsyncEnvironment;
  const util = require('../util');
  delay = util.delay;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  delay = window.util.delay;
}

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
