(function () {
  'use strict';

  let expect;
  let AsyncEnvironment;
  let delay;
  let createPoison;
  let isPoisonError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    delay = require('../util').delay;
    const runtime = require('../../src/runtime/runtime');
    createPoison = runtime.createPoison;
    isPoisonError = runtime.isPoisonError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    delay = window.util.delay;
    createPoison = nunjucks.createPoison;
    isPoisonError = nunjucks.isPoisonError;
  }

  function normalizeOutput(str) {
    return str.replace(/\s+/g, '');
  }

  describe('Async mode - concurrentLimit step 5 validation', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Nested loop isolation and metadata', () => {
      it('should keep outer and inner bounded pools independent and preserve metadata', async () => {
        const context = {
          outerItems: ['A', 'B', 'C', 'D'],
          innerItems: ['x', 'y', 'z'],
          concurrency: {
            outerCurrent: 0,
            outerMax: 0,
            inner: {}
          },
          async trackOuter(value) {
            context.concurrency.outerCurrent++;
            context.concurrency.outerMax = Math.max(context.concurrency.outerMax, context.concurrency.outerCurrent);
            await delay(5);
            context.concurrency.outerCurrent--;
            return '';
          },
          async trackInner(outer) {
            if (!context.concurrency.inner[outer]) {
              context.concurrency.inner[outer] = { current: 0, max: 0 };
            }
            const entry = context.concurrency.inner[outer];
            entry.current++;
            entry.max = Math.max(entry.max, entry.current);
            await delay(2);
            entry.current--;
            return '';
          },
          outerMeta: {},
          innerMeta: {},
          recordOuterMeta(index, index0, first) {
            context.outerMeta[index0] = { index, index0, first };
            return '';
          },
          recordInnerMeta(outer, index, index0, first) {
            if (!context.innerMeta[outer]) {
              context.innerMeta[outer] = {};
            }
            context.innerMeta[outer][index0] = { index, index0, first };
            return '';
          }
        };

        const template = `
        {%- for outer in outerItems of 2 -%}
          {{ trackOuter(outer) }}
          {{ recordOuterMeta(loop.index, loop.index0, loop.first) }}
          {%- for inner in innerItems of 2 -%}
            {{ trackInner(outer) }}
            {{ recordInnerMeta(outer, loop.index, loop.index0, loop.first) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.concurrency.outerMax).to.be(2);
        context.outerItems.forEach((value, idx) => {
          const meta = context.outerMeta[idx];
          expect(meta).to.be.ok();
          expect(meta.index).to.be(idx + 1);
          expect(meta.index0).to.be(idx);
          expect(meta.first).to.be(idx === 0);
          const innerTracker = context.concurrency.inner[value];
          expect(innerTracker).to.be.ok();
          expect(innerTracker.max).to.be(2);
          const innerMeta = context.innerMeta[value];
          expect(Object.keys(innerMeta)).to.have.length(context.innerItems.length);
          context.innerItems.forEach((_, innerIdx) => {
            const entry = innerMeta[innerIdx];
            expect(entry).to.be.ok();
            expect(entry.index).to.be(innerIdx + 1);
            expect(entry.index0).to.be(innerIdx);
            expect(entry.first).to.be(innerIdx === 0);
          });
        });
      });

      it('should allow unbounded inner arrays even when outer loop is limited', async () => {
        const context = {
          outerItems: [0, 1, 2, 3],
          innerItems: ['a', 'b', 'c', 'd'],
          outerTracker: { current: 0, max: 0 },
          innerTracker: {},
          async trackOuter(value) {
            context.outerTracker.current++;
            context.outerTracker.max = Math.max(context.outerTracker.max, context.outerTracker.current);
            await delay(4);
            context.outerTracker.current--;
            return '';
          },
          async trackInner(outer) {
            if (!context.innerTracker[outer]) {
              context.innerTracker[outer] = { current: 0, max: 0 };
            }
            const slot = context.innerTracker[outer];
            slot.current++;
            slot.max = Math.max(slot.max, slot.current);
            await delay(1);
            slot.current--;
            return '';
          }
        };

        const template = `
        {%- for outer in outerItems of 2 -%}
          {{ trackOuter(outer) }}
          {%- for inner in innerItems -%}
            {{ trackInner(outer) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.outerTracker.max).to.be(2);
        context.outerItems.forEach((outer) => {
          const tracker = context.innerTracker[outer];
          expect(tracker).to.be.ok();
          expect(tracker.max).to.be(context.innerItems.length);
        });
      });

      it('should limit inner arrays even when outer loop is unbounded', async () => {
        const context = {
          outerItems: [0, 1, 2],
          innerItems: ['x', 'y', 'z', 'w'],
          outerTracker: { current: 0, max: 0 },
          innerTracker: {},
          async trackOuter(value) {
            context.outerTracker.current++;
            context.outerTracker.max = Math.max(context.outerTracker.max, context.outerTracker.current);
            await delay(2);
            context.outerTracker.current--;
            return '';
          },
          async trackInner(outer) {
            if (!context.innerTracker[outer]) {
              context.innerTracker[outer] = { current: 0, max: 0 };
            }
            const slot = context.innerTracker[outer];
            slot.current++;
            slot.max = Math.max(slot.max, slot.current);
            await delay(1);
            slot.current--;
            return '';
          }
        };

        const template = `
        {%- for outer in outerItems -%}
          {{ trackOuter(outer) }}
          {%- for inner in innerItems of 2 -%}
            {{ trackInner(outer) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.outerTracker.max).to.be(context.outerItems.length);
        context.outerItems.forEach((outer) => {
          const tracker = context.innerTracker[outer];
          expect(tracker).to.be.ok();
          expect(tracker.max).to.be(2);
        });
      });

      it('should let sequential requirements override a bounded inner limit', async () => {
        const context = {
          outerItems: ['one', 'two'],
          innerItems: ['a', 'b', 'c'],
          tracker: { current: 0, max: 0 }
        };
        context.logger = {
          async record(label) {
            context.tracker.current++;
            context.tracker.max = Math.max(context.tracker.max, context.tracker.current);
            await delay(3);
            context.tracker.current--;
            return '';
          }
        };

        const template = `
        {%- for outer in outerItems of 3 -%}
          {%- for inner in innerItems of 5 -%}
            {{ logger!.record(outer ~ '-' ~ inner) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.tracker.max).to.be(1);
      });
    });

    describe('Arrays mixed with async iterators', () => {
      it('should respect bounds when outer array and inner async iterator are both limited', async () => {
        const outerLimit = 2;
        const innerLimit = 3;
        const context = {
          outerItems: ['O0', 'O1', 'O2'],
          innerValues: ['i0', 'i1', 'i2', 'i3'],
          outerTracker: { current: 0, max: 0 },
          innerTracker: {},
          async trackOuter(value) {
            context.outerTracker.current++;
            context.outerTracker.max = Math.max(context.outerTracker.max, context.outerTracker.current);
            await delay(2);
            context.outerTracker.current--;
            return '';
          },
          async processInner(outer) {
            if (!context.innerTracker[outer]) {
              context.innerTracker[outer] = { current: 0, max: 0 };
            }
            const slot = context.innerTracker[outer];
            slot.current++;
            slot.max = Math.max(slot.max, slot.current);
            await delay(1);
            slot.current--;
            return '';
          },
          makeInner(outer) {
            const values = context.innerValues.slice();
            return (async function* () {
              for (const value of values) {
                await delay(1);
                yield `${outer}-${value}`;
              }
            }());
          }
        };

        const template = `
        {%- for outer in outerItems of ${outerLimit} -%}
          {{ trackOuter(outer) }}
          {%- for value in makeInner(outer) of ${innerLimit} -%}
            {{ processInner(outer) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.outerTracker.max).to.be.lessThan(outerLimit + 1);
        Object.values(context.innerTracker).forEach(entry => {
          expect(entry.max).to.be.lessThan(innerLimit + 1);
          expect(entry.max > 0).to.be(true);
        });
      });

      it('should leave inner async iterators unbounded when only the outer array is limited', async () => {
        const context = {
          outerItems: ['A', 'B'],
          async makeInner(outer) {
            const values = ['p', 'q'];
            return (async function* () {
              for (const value of values) {
                yield `${outer}-${value}`;
              }
            }());
          },
          async metaString(length, last) {
            if (length && typeof length.then === 'function') {
              length = await length;
            }
            if (last && typeof last.then === 'function') {
              last = await last;
            }
            return `${length}-${last ? 'T' : 'F'},`;
          }
        };

        const template = `
        {%- for outer in outerItems of 2 -%}
          {%- for value in makeInner(outer) -%}
            {{ metaString(loop.length, loop.last) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('2-F,2-T,2-F,2-T,');
      });

      it('should limit inner arrays when the outer async iterator is bounded', async () => {
        const innerLimit = 2;
        const context = {
          innerItems: ['h', 'i', 'j'],
          outerTracker: { current: 0, max: 0 },
          innerTracker: {}
        };
        context.makeOuterAsync = function () {
          const values = ['X0', 'X1', 'X2', 'X3'];
          return (async function* () {
            for (const value of values) {
              await delay(1);
              yield value;
            }
          }());
        };
        context.trackOuter = async function () {
          context.outerTracker.current++;
          context.outerTracker.max = Math.max(context.outerTracker.max, context.outerTracker.current);
          await delay(2);
          context.outerTracker.current--;
          return '';
        };
        context.trackInner = async function (outer) {
          if (!context.innerTracker[outer]) {
            context.innerTracker[outer] = { current: 0, max: 0 };
          }
          const slot = context.innerTracker[outer];
          slot.current++;
          slot.max = Math.max(slot.max, slot.current);
          await delay(1);
          slot.current--;
          return '';
        };

        const template = `
        {%- for outer in makeOuterAsync() of 2 -%}
          {{ trackOuter(outer) }}
          {%- for inner in innerItems of ${innerLimit} -%}
            {{ trackInner(outer) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.outerTracker.max).to.be(2);
        Object.values(context.innerTracker).forEach(entry => {
          expect(entry.max).to.be.lessThan(innerLimit + 1);
        });
      });

      it('should allow unbounded inner arrays when the outer async iterator is limited', async () => {
        const context = {
          innerItems: ['a', 'b', 'c', 'd'],
          outerTracker: { current: 0, max: 0 },
          innerTracker: {}
        };
        context.makeOuterAsync = function () {
          const values = ['P0', 'P1', 'P2'];
          return (async function* () {
            for (const value of values) {
              await delay(1);
              yield value;
            }
          }());
        };
        context.trackOuter = async function () {
          context.outerTracker.current++;
          context.outerTracker.max = Math.max(context.outerTracker.max, context.outerTracker.current);
          await delay(2);
          context.outerTracker.current--;
          return '';
        };
        context.trackInner = async function (outer) {
          if (!context.innerTracker[outer]) {
            context.innerTracker[outer] = { current: 0, max: 0 };
          }
          const slot = context.innerTracker[outer];
          slot.current++;
          slot.max = Math.max(slot.max, slot.current);
          await delay(1);
          slot.current--;
          return '';
        };

        const template = `
        {%- for outer in makeOuterAsync() of 2 -%}
          {{ trackOuter(outer) }}
          {%- for inner in innerItems -%}
            {{ trackInner(outer) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.outerTracker.max).to.be(2);
        Object.values(context.innerTracker).forEach(entry => {
          expect(entry.max).to.be(context.innerItems.length);
        });
      });
    });

    describe('Poisoning and invalid concurrentLimit handling', () => {
      it('should poison nested loops when the outer concurrentLimit is poisoned', async () => {
        const context = {
          outerItems: [0, 1],
          innerItems: ['a', 'b'],
          events: [],
          record(event) {
            context.events.push(event);
            return '';
          },
          poisonLimit() {
            return createPoison(new Error('outer limit poisoned'));
          }
        };

        const template = `
        {%- for outer in outerItems of poisonLimit() -%}
          {{ record('outer:' ~ outer) }}
          {%- for inner in innerItems -%}
            {{ record('inner:' ~ outer ~ '-' ~ inner) }}
          {%- endfor -%}
        {%- else -%}
          {{ record('else') }}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected the poisoned concurrentLimit to reject');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('outer limit poisoned');
          expect(context.events).to.have.length(0);
        }
      });

      it('should poison only the affected outer iteration when an inner concurrentLimit is poisoned', async () => {
        const context = {
          outerItems: ['first', 'second', 'third'],
          innerItems: ['x', 'y'],
          events: [],
          async record(event) {
            await delay(0);
            context.events.push(event);
            return '';
          },
          limitFor(outer) {
            if (outer === 'second') {
              return createPoison(new Error('inner limit poisoned'));
            }
            return 2;
          }
        };

        const template = `
        {%- for outer in outerItems of 1 -%}
          {{ record('outer-start-' ~ outer) }}
          {%- for inner in innerItems of limitFor(outer) -%}
            {{ record('inner-' ~ outer ~ '-' ~ inner) }}
          {%- endfor -%}
          {{ record('outer-end-' ~ outer) }}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected inner poisoned limit to reject');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('inner limit poisoned');
          expect(context.events).to.contain('outer-start-first');
          expect(context.events).to.contain('inner-first-x');
          expect(context.events).to.contain('inner-first-y');
          expect(context.events.some(event => event.startsWith('inner-second'))).to.be(false);
        }
      });

      it('should aggregate errors and preserve metadata for limited arrays', async () => {
        const context = {
          items: [0, 1, 2, 3],
          seen: [],
          recordMeta(index0, first) {
            context.seen.push({ index0, first });
            return '';
          },
          async maybeFail(value) {
            await delay(1);
            if (value % 2 === 0) {
              throw new Error(`bad-${value}`);
            }
            return '';
          }
        };

        const template = `
        {%- for item in items of 2 -%}
          {{ recordMeta(loop.index0, loop.first) }}
          {{ maybeFail(item) }}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected loop body errors to aggregate');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(2);
          expect(err.errors[0].message).to.contain('bad-0');
          expect(err.errors[1].message).to.contain('bad-2');
          const indexes = context.seen.map(entry => entry.index0).sort();
          expect(indexes).to.eql([0, 1, 2, 3].sort());
          const firstFlag = context.seen.find(entry => entry.index0 === 0);
          expect(firstFlag.first).to.be(true);
          context.seen.filter(entry => entry.index0 !== 0).forEach(entry => {
            expect(entry.first).to.be(false);
          });
        }
      });

      it('should aggregate errors and preserve metadata for limited async iterators', async () => {
        const context = {
          seen: [],
          recordMeta(index0, first) {
            context.seen.push({ index0, first });
            return '';
          },
          async *makeValues() {
            yield 0;
            yield 1;
            yield 2;
            yield 3;
          },
          async maybeFail(value) {
            await delay(1);
            if (value === 1 || value === 3) {
              throw new Error(`boom-${value}`);
            }
            return '';
          }
        };

        const template = `
        {%- for value in makeValues() of 3 -%}
          {{ recordMeta(loop.index0, loop.first) }}
          {{ maybeFail(value) }}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected async iterator loop errors to aggregate');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(2);
          expect(err.errors[0].message).to.contain('boom-1');
          expect(err.errors[1].message).to.contain('boom-3');
          const indexes = context.seen.map(entry => entry.index0).sort();
          expect(indexes).to.eql([0, 1, 2, 3].sort());
        }
      });

      it('should reject invalid concurrentLimit values on outer loops without running body or else', async () => {
        const invalidCases = [
          { desc: 'negative numbers', expr: 'negLimit' },
          { desc: 'NaN', expr: 'nanLimit' },
          { desc: 'Infinity', expr: 'infLimit' },
          { desc: 'strings', expr: 'stringLimit' },
          { desc: 'promises', expr: 'promiseLimit()' }
        ];

        for (const testCase of invalidCases) {
          const context = buildInvalidContext();
          const template = `
          {%- for value in outerItems of ${testCase.expr} -%}
            {{ record('body') }}
          {%- else -%}
            {{ record('else') }}
          {%- endfor -%}
          `;
          try {
            await env.renderTemplateString(template, context);
            expect().fail(`Expected invalid concurrentLimit for ${testCase.desc}`);
          } catch (err) {
            expect(isPoisonError(err)).to.be(true);
            expect(err.errors[0].message).to.contain('concurrentLimit must be a positive number or 0 / null / undefined');
            const innerEvents = context.events.filter(event => event.startsWith('inner'));
            expect(innerEvents).to.have.length(0);
          }
        }
      });

      it('should reject invalid concurrentLimit values on inner loops before any body executes', async () => {
        const invalidCases = [
          { desc: 'negative numbers', expr: 'negLimit' },
          { desc: 'NaN', expr: 'nanLimit' },
          { desc: 'Infinity', expr: 'infLimit' },
          { desc: 'strings', expr: 'stringLimit' },
          { desc: 'promises', expr: 'promiseLimit()' }
        ];

        for (const testCase of invalidCases) {
          const context = buildInvalidContext();
          const template = `
          {%- for outer in outerItems -%}
            {%- for inner in innerItems of ${testCase.expr} -%}
              {{ record('inner') }}
            {%- endfor -%}
            {{ record('outer-finished-' ~ outer) }}
          {%- endfor -%}
          `;
          try {
            await env.renderTemplateString(template, context);
            expect().fail(`Expected invalid concurrentLimit for ${testCase.desc} inside nested loop`);
          } catch (err) {
            expect(isPoisonError(err)).to.be(true);
            expect(err.errors[0].message).to.contain('concurrentLimit must be a positive number or 0 / null / undefined');
            const innerEvents = context.events.filter(event => event.startsWith('inner'));
            expect(innerEvents).to.have.length(0);
          }
        }
      });

      function buildInvalidContext() {
        const ctx = {
          outerItems: [0, 1],
          innerItems: ['x', 'y'],
          events: []
        };
        ctx.record = async function (event) {
          await delay(0);
          ctx.events.push(event);
          return '';
        };
        ctx.negLimit = -1;
        ctx.nanLimit = NaN;
        ctx.infLimit = Infinity;
        ctx.stringLimit = 'foo';
        ctx.promiseLimit = async function () {
          await delay(1);
          return -5;
        };
        return ctx;
      }
    });

    describe('Ignored limits and metadata regressions', () => {
      it('should treat 0/null/undefined limits as unbounded for async iterators with full metadata', async () => {
        async function expectAsyncCase(limitExpression) {
          const context = {
            concurrent: 0,
            maxConcurrent: 0,
            async process() {
              context.concurrent++;
              context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
              await delay(3);
              context.concurrent--;
              return '';
            },
            async *makeLetters() {
              yield 'a';
              yield 'b';
              yield 'c';
            }
          };
          const template = `
          {%- for letter in makeLetters() of ${limitExpression} -%}
            {{ process(letter) }}
            {{ loop.length }}-{{ "T" if loop.last else "F" }},
          {%- endfor -%}
          `;
          const result = await env.renderTemplateString(template, context);
          expect(normalizeOutput(result)).to.equal('3-F,3-F,3-T,');
          expect(context.maxConcurrent).to.be(3);
        }

        await expectAsyncCase('0');
        await expectAsyncCase('null');
        await expectAsyncCase('undefined');
      });

      it('should ignore zero-like limits for arrays while preserving metadata and parallelism', async () => {
        async function expectArrayCase(limitExpression) {
          const context = {
            items: ['a', 'b', 'c', 'd'],
            concurrent: 0,
            maxConcurrent: 0,
            async process() {
              context.concurrent++;
              context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
              await delay(3);
              context.concurrent--;
              return '';
            }
          };
          const template = `
          {%- for item in items of ${limitExpression} -%}
            {{ process(item) }}
            {{ loop.length }}-{{ "T" if loop.last else "F" }},
          {%- endfor -%}
          `;
          const result = await env.renderTemplateString(template, context);
          expect(normalizeOutput(result)).to.equal('4-F,4-F,4-F,4-T,');
          expect(context.maxConcurrent).to.be(context.items.length);
        }

        await expectArrayCase('0');
        await expectArrayCase('null');
        await expectArrayCase('undefined');
      });
    });

    describe('Termination, integrity, and performance', () => {
      it('should finish thousands of array iterations under a bounded pool', async () => {
        const count = 1024;
        const context = {
          items: Array.from({ length: count }, (_, i) => i),
          processed: 0,
          concurrent: 0,
          maxConcurrent: 0,
          async processItem(value) {
            context.concurrent++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
            if (value % 50 === 0) {
              await delay(1);
            }
            context.concurrent--;
            context.processed++;
            return '';
          }
        };

        const template = `
        {%- for value in items of 5 -%}
          {{ processItem(value) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.processed).to.be(count);
        expect(context.maxConcurrent).to.be(5);
      });

      it('should finish thousands of async iterator iterations under a bounded pool', async function () {
        this.timeout(5000);
        const total = 300;
        const limit = 25;
        const context = {
          processed: 0,
          concurrent: 0,
          maxConcurrent: 0,
          async *makeMany() {
            for (let i = 0; i < total; i++) {
              await delay(0);
              yield i;
            }
          },
          async handle(value) {
            context.concurrent++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
            if (value % 60 === 0) {
              await delay(1);
            } else {
              await delay(0);
            }
            context.concurrent--;
            context.processed++;
            return '';
          }
        };

        const template = `
        {%- for value in makeMany() of ${limit} -%}
          {{ handle(value) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.processed).to.be(total);
        expect(context.maxConcurrent).to.be.lessThan(limit + 1);
        expect(context.maxConcurrent > 1).to.be(true);
      });

      it('should keep bounded arrays with limit 1 sequential without while-style metadata', async () => {
        const context = {
          items: ['a', 'b', 'c'],
          concurrent: 0,
          maxConcurrent: 0,
          async process() {
            context.concurrent++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
            await delay(2);
            context.concurrent--;
            return '';
          }
        };

        const template = `
        {%- for item in items of 1 -%}
          {{ process(item) }}
          {{ "HAS" if loop.length else "NO" }},
        {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(normalizeOutput(result)).to.equal('NO,NO,NO,');
        expect(context.maxConcurrent).to.be(1);
      });

      it('should keep bounded async iterators with limit 1 sequential without metadata', async () => {
        const context = {
          concurrent: 0,
          maxConcurrent: 0,
          async *makeLetters() {
            yield 'a';
            yield 'b';
            yield 'c';
          },
          async process(value) {
            context.concurrent++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
            await delay(2);
            context.concurrent--;
            return '';
          }
        };

        const template = `
        {%- for letter in makeLetters() of 1 -%}
          {{ process(letter) }}
          {{ "HAS" if loop.length else "NO" }},
        {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(normalizeOutput(result)).to.equal('NO,NO,NO,');
        expect(context.maxConcurrent).to.be(1);
      });

      it('should keep outstanding async iterator reads bounded by the pool size', async () => {
        const limit = 4;
        const context = {
          size: 40,
          state: { requested: 0, completed: 0, maxOutstanding: 0 },
          makeLimitedIterator() {
            const state = context.state;
            const size = context.size;
            return (async function* () {
              for (let i = 0; i < size; i++) {
                state.requested++;
                state.maxOutstanding = Math.max(state.maxOutstanding, state.requested - state.completed);
                await delay(0);
                yield i;
              }
            }());
          },
          async process(value) {
            if (value % 5 === 0) {
              await delay(1);
            } else {
              await delay(0);
            }
            context.state.completed++;
            return '';
          }
        };

        const template = `
        {%- for value in makeLimitedIterator() of ${limit} -%}
          {{ process(value) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);

        expect(context.state.requested).to.be(context.size);
        expect(context.state.completed).to.be(context.size);
        expect(context.state.maxOutstanding).to.be.lessThan(limit + 1);
      });
    });
  });
}());

