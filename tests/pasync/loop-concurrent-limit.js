(function () {
  'use strict';

  let expect;
  let AsyncEnvironment;
  let AsyncTemplate;
  let AsyncScript;
  let StringLoader;
  let delay;
  let createPoison;
  let isPoisonError;
  let parser;
  let TextCommand;
  let CommandBuffer;
  let createChannel;
  let scopeBoundaries;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    const envModule = require('../../src/environment/environment');
    AsyncEnvironment = envModule.AsyncEnvironment;
    AsyncTemplate = envModule.AsyncTemplate;
    AsyncScript = envModule.AsyncScript;
    StringLoader = require('../util').StringLoader;
    delay = require('../util').delay;
    const runtime = require('../../src/runtime/runtime');
    createPoison = runtime.createPoison;
    isPoisonError = runtime.isPoisonError;
    parser = require('../../src/parser');
    TextCommand = runtime.TextCommand;
    CommandBuffer = runtime.CommandBuffer;
    createChannel = runtime.createChannel;
    scopeBoundaries = require('../../src/compiler/scope-boundaries');
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    AsyncTemplate = nunjucks.AsyncTemplate;
    AsyncScript = nunjucks.AsyncScript;
    StringLoader = window.util.StringLoader;
    delay = window.util.delay;
    createPoison = nunjucks.createPoison;
    isPoisonError = nunjucks.isPoisonError;
    parser = nunjucks.parser;
    TextCommand = nunjucks.runtime.TextCommand;
    CommandBuffer = nunjucks.runtime.CommandBuffer;
    createChannel = nunjucks.runtime.createChannel;
    scopeBoundaries = nunjucks.compiler.scopeBoundaries || null;
  }

  function normalizeOutput(str) {
    return str.replace(/\s+/g, '');
  }

  describe('Async mode - concurrentLimit validation', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Coverage moved from loops.js', () => {
      it('parses for-loop concurrent limit syntax', async () => {
        const template = '{% for chunk in chunks of limit %}{{ chunk }}{% endfor %}';
        const ast = parser.parse(template);
        let forNode = null;

        for (let i = 0; i < ast.children.length; i++) {
          const child = ast.children[i];
          if (child && child.typename === 'For') {
            forNode = child;
            break;
          }
        }

        expect(forNode).to.be.ok();
        expect(forNode.concurrentLimit).to.be.ok();
        expect(forNode.concurrentLimit.value).to.be('limit');

        const context = { chunks: [1, 2, 3], limit: 2 };
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('123');
      });

      it('keeps async while loops sequential despite concurrentLimit additions', async () => {
        const context = {
          state: {
            counter: 0,
            concurrentCount: 0,
            maxConcurrent: 0,
            async shouldContinue() {
              await delay(2);
              if (this.counter >= 3) {
                return false;
              }
              this.counter++;
              return true;
            },
            async doWork(index) {
              this.concurrentCount++;
              this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrentCount);
              await delay(15);
              this.concurrentCount--;
              return `work-${index}`;
            }
          }
        };

        const template = `
        {%- while state.shouldContinue() -%}
          {{ state.doWork(loop.index0) }}
        {%- endwhile -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.state.maxConcurrent).to.be(1);
      });

      it('keeps asyncEach loops sequential after concurrentLimit changes', async () => {
        const context = {
          items: [1, 2, 3],
          concurrentCount: 0,
          maxConcurrent: 0,
          async processItem(item) {
            context.concurrentCount++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrentCount);
            await delay(10);
            context.concurrentCount--;
            return `Item ${item}`;
          }
        };

        const template = `
        {%- asyncEach item in items -%}
          {{ processItem(item) }}
        {%- endeach -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.maxConcurrent).to.be(1);
      });

      it('concurrentLimit loop include reads per-iteration loop metadata', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        loader.addTemplate('cl-child.njk', 'I{{ loop.index }}|');
        loader.addTemplate('cl-parent.njk',
          '{% for item in [1,2,3,4] of 2 %}{% include "cl-child.njk" %}{% endfor %}');
        const result = await localEnv.renderTemplate('cl-parent.njk', {});
        expect(result).to.equal('I1|I2|I3|I4|');
      });

      it('nested concurrentLimit loops with include keep metadata isolated', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        loader.addTemplate('ncl-inner.njk', 'IN{{ loop.index }}|');
        loader.addTemplate('ncl-outer.njk', 'OUT{{ loop.index }}|');
        loader.addTemplate('ncl-parent.njk',
          '{% for o in [1,2] of 2 %}{% for i in ["a","b","c"] of 2 %}{% include "ncl-inner.njk" %}{% endfor %}{% include "ncl-outer.njk" %}{% endfor %}');
        const result = await localEnv.renderTemplate('ncl-parent.njk', {});
        expect(result).to.equal('IN1|IN2|IN3|OUT1|IN1|IN2|IN3|OUT2|');
      });

      it('concurrentLimit with loop target shadow keeps include reading value loop', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        loader.addTemplate('cl-shadow-child.njk', 'V{{ loop }}|');
        loader.addTemplate('cl-shadow-parent.njk',
          '{% for loop in [10,20,30] of 2 %}{% include "cl-shadow-child.njk" %}{% endfor %}');
        const result = await localEnv.renderTemplate('cl-shadow-parent.njk', {});
        expect(result).to.equal('V10|V20|V30|');
      });

      it('concurrentLimit loop super() reuses async base block content correctly inside the loop body', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        const context = {
          superActive: 0,
          async enterOuter() {
            return '';
          },
          async leaveOuter() {
            return '';
          },
          calls: 0,
          async slowBase() {
            context.superActive++;
            context.calls++;
            try {
              await delay(8);
              return 'B';
            } finally {
              context.superActive--;
            }
          }
        };

        loader.addTemplate('cl-super-base.njk', '{% block content %}{{ slowBase() }}{% endblock %}');
        loader.addTemplate('cl-super-child.njk',
          '{% extends "cl-super-base.njk" %}{% block content %}{% for item in [1,2] of 1 %}{{ enterOuter() }}{{ super() }}{{ leaveOuter() }}|{% endfor %}{% endblock %}');

        const result = await localEnv.renderTemplate('cl-super-child.njk', context);
        expect(result).to.equal('B|B|');
        expect(context.calls).to.be(1);
        expect(context.superActive).to.be(0);
      });

      it('concurrentLimit loop import waits for imported async exports before next outer iteration', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        const context = {
          importActive: 0,
          startedDuringImport: 0,
          async enterOuter() {
            if (context.importActive > 0) {
              context.startedDuringImport++;
            }
            return '';
          },
          async leaveOuter() {
            return '';
          },
          calls: 0,
          async slowImportValue() {
            context.importActive++;
            context.calls++;
            try {
              await delay(8);
              return 'I';
            } finally {
              context.importActive--;
            }
          }
        };

        loader.addTemplate('cl-import-lib.njk', '{% set imported = slowImportValue() %}');
        loader.addTemplate('cl-import-parent.njk',
          '{% for item in [1,2] of 1 %}{{ enterOuter() }}{% import "cl-import-lib.njk" as lib with context %}{{ leaveOuter() }}{{ lib.imported }}|{% endfor %}');

        const result = await localEnv.renderTemplate('cl-import-parent.njk', context);
        expect(result).to.equal('I|I|');
        expect(context.calls).to.be(2);
        expect(context.startedDuringImport).to.be(0);
      });

      it('concurrentLimit loop from-import waits for imported async exports before next outer iteration', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        const context = {
          importActive: 0,
          startedDuringImport: 0,
          async enterOuter() {
            if (context.importActive > 0) {
              context.startedDuringImport++;
            }
            return '';
          },
          async leaveOuter() {
            return '';
          },
          calls: 0,
          async slowImportValue() {
            context.importActive++;
            context.calls++;
            try {
              await delay(8);
              return 'F';
            } finally {
              context.importActive--;
            }
          }
        };

        loader.addTemplate('cl-from-lib.njk', '{% set exportedValue = slowImportValue() %}');
        loader.addTemplate('cl-from-parent.njk',
          '{% for item in [1,2] of 1 %}{{ enterOuter() }}{% from "cl-from-lib.njk" import exportedValue with context %}{{ leaveOuter() }}{{ exportedValue }}|{% endfor %}');

        const result = await localEnv.renderTemplate('cl-from-parent.njk', context);
        expect(result).to.equal('F|F|');
        expect(context.calls).to.be(2);
        expect(context.startedDuringImport).to.be(0);
      });

      it('concurrentLimit loop import poisons when imported async exports reject', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        const context = {
          async failImport() {
            await delay(4);
            throw new Error('import export failed');
          }
        };

        loader.addTemplate('cl-import-poison-lib.njk', '{% set imported = failImport() %}');
        loader.addTemplate('cl-import-poison-parent.njk',
          '{% for item in [1,2] of 1 %}{% import "cl-import-poison-lib.njk" as lib with context %}{{ lib.imported }}{% endfor %}');

        try {
          await localEnv.renderTemplate('cl-import-poison-parent.njk', context);
          expect().fail('Expected import export rejection to poison the loop');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('import export failed');
        }
      });

      it('concurrentLimit loop from-import poisons when imported async exports reject', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        const context = {
          async failImport() {
            await delay(4);
            throw new Error('from-import export failed');
          }
        };

        loader.addTemplate('cl-from-poison-lib.njk', '{% set exportedValue = failImport() %}');
        loader.addTemplate('cl-from-poison-parent.njk',
          '{% for item in [1,2] of 1 %}{% from "cl-from-poison-lib.njk" import exportedValue with context %}{{ exportedValue }}{% endfor %}');

        try {
          await localEnv.renderTemplate('cl-from-poison-parent.njk', context);
          expect().fail('Expected from-import export rejection to poison the loop');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('from-import export failed');
        }
      });

      it('concurrentLimit loop super() poisons when async base block content rejects', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        const context = {
          async failBase() {
            await delay(4);
            throw new Error('super base failed');
          }
        };

        loader.addTemplate('cl-super-poison-base.njk', '{% block content %}{{ failBase() }}{% endblock %}');
        loader.addTemplate('cl-super-poison-child.njk',
          '{% extends "cl-super-poison-base.njk" %}{% block content %}{% for item in [1,2] of 1 %}{{ super() }}{% endfor %}{% endblock %}');

        try {
          await localEnv.renderTemplate('cl-super-poison-child.njk', context);
          expect().fail('Expected async super rejection to poison the loop');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('super base failed');
        }
      });

      it('concurrentLimit loop async if branches block the next outer iteration until branch work finishes', async () => {
        const context = {
          branchActive: 0,
          startedDuringBranch: 0,
          async enterOuter() {
            if (context.branchActive > 0) {
              context.startedDuringBranch++;
            }
            return '';
          },
          async choose(item) {
            await delay(2);
            return item % 2 === 0;
          },
          async oddWork(item) {
            context.branchActive++;
            try {
              await delay(8);
              return `O${item}`;
            } finally {
              context.branchActive--;
            }
          },
          async evenWork(item) {
            context.branchActive++;
            try {
              await delay(8);
              return `E${item}`;
            } finally {
              context.branchActive--;
            }
          }
        };

        const template = '{% for item in [1,2,3] of 1 %}{{ enterOuter() }}{% if choose(item) %}{{ evenWork(item) }}{% else %}{{ oddWork(item) }}{% endif %}|{% endfor %}';
        const result = await env.renderTemplateString(template, context);

        expect(result).to.equal('O1|E2|O3|');
        expect(context.startedDuringBranch).to.be(0);
        expect(context.branchActive).to.be(0);
      });

      it('concurrentLimit loop include inside async if blocks the next outer iteration until include work finishes', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        const context = {
          includeActive: 0,
          startedDuringInclude: 0,
          async enterOuter() {
            if (context.includeActive > 0) {
              context.startedDuringInclude++;
            }
            return '';
          },
          async choose(item) {
            await delay(2);
            return item !== 2;
          },
          async slowInclude(item) {
            context.includeActive++;
            try {
              await delay(8);
              return `I${item}`;
            } finally {
              context.includeActive--;
            }
          }
        };

        loader.addTemplate('cl-branch-include-child.njk', '{{ slowInclude(item) }}');
        loader.addTemplate('cl-branch-include-parent.njk',
          '{% for item in [1,2,3] of 1 %}{{ enterOuter() }}{% if choose(item) %}{% include "cl-branch-include-child.njk" %}{% else %}S{{ item }}{% endif %}|{% endfor %}');

        const result = await localEnv.renderTemplate('cl-branch-include-parent.njk', context);
        expect(result).to.equal('I1|S2|I3|');
        expect(context.startedDuringInclude).to.be(0);
        expect(context.includeActive).to.be(0);
      });

      it('concurrentLimit loop macro text waits for final text materialization before next outer iteration', async () => {
        const context = {
          activeMacroText: 0,
          startedDuringMacroText: 0,
          enterOuter() {
            if (context.activeMacroText > 0) {
              context.startedDuringMacroText++;
            }
            return '';
          },
          async beginWrap(item) {
            context.activeMacroText++;
            await delay(8);
            return `B${item}`;
          },
          async endWrap(item) {
            await delay(8);
            context.activeMacroText--;
            return `E${item}`;
          },
          async innerValue(item) {
            await delay(2);
            return `I${item}`;
          }
        };

        const template = `
        {% macro wrap(item) %}{{ beginWrap(item) }}({{ innerValue(item) }}){{ endWrap(item) }}{% endmacro %}
        {% for item in [1,2] of 1 %}{{ enterOuter() }}{{ wrap(item) }}|{% endfor %}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('B1(I1)E1|B2(I2)E2|');
        expect(context.startedDuringMacroText).to.be(0);
        expect(context.activeMacroText).to.be(0);
      });

      it('concurrentLimit loop async if condition rejection stays in poison flow', async () => {
        const context = {
          async shouldRender(item) {
            await delay(2);
            if (item === 2) {
              throw new Error('if condition failed');
            }
            return true;
          }
        };

        const template = `
        {%- for item in [1,2] of 1 -%}
          {%- if shouldRender(item) -%}I{{ item }}{%- endif -%}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected poisoned async if condition to reject');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.message).to.contain('if condition failed');
          expect(err.message).to.not.contain('ControlFlowAsyncBlock');
        }
      });

      it('concurrentLimit loop async switch expression rejection stays in poison flow', async () => {
        const context = {
          async pick(item) {
            await delay(2);
            if (item === 2) {
              throw new Error('switch expression failed');
            }
            return item;
          }
        };

        const template = `
        {%- for item in [1,2] of 1 -%}
          {%- switch pick(item) -%}
            {%- case 1 -%}A
            {%- case 2 -%}B
            {%- default -%}C
          {%- endswitch -%}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected poisoned async switch expression to reject');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.message).to.contain('switch expression failed');
          expect(err.message).to.not.contain('ControlFlowAsyncBlock');
        }
      });

      it('hard object-loop arity failure inside async control flow remains a real error', async () => {
        const context = {
          catalog: { a: 1, b: 2 },
          async gate() {
            await delay(2);
            return true;
          }
        };

        const template = `
        {%- for item in [1] of 1 -%}
          {%- if gate() -%}
            {%- for key in catalog of 2 -%}{{ key }}{%- endfor -%}
          {%- endif -%}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected hard object-loop arity error');
        } catch (err) {
          expect(isPoisonError(err)).to.be(false);
          expect(err.message).to.contain('Expected two variables for key/value iteration');
        }
      });

      it('keeps outer of 1 blocked until nested async while work completes', async () => {
        const context = {
          innerActive: 0,
          startedDuringInner: 0,
          states: {
            1: { i: 0 },
            2: { i: 0 }
          },
          async enterOuter() {
            if (context.innerActive > 0) {
              context.startedDuringInner++;
            }
            return '';
          },
          async innerNext(item) {
            const state = context.states[item];
            await delay(2);
            state.i++;
            return state.i <= 2;
          },
          async innerWork(item) {
            const state = context.states[item];
            context.innerActive++;
            try {
              await delay(8);
              return `${item}.${state.i}`;
            } finally {
              context.innerActive--;
            }
          }
        };

        const template = '{% for item in [1,2] of 1 %}{{ enterOuter() }}{% while innerNext(item) %}{{ innerWork(item) }}|{% endwhile %}{% endfor %}';
        const result = await env.renderTemplateString(template, context);

        expect(result).to.equal('1.1|1.2|2.1|2.2|');
        expect(context.startedDuringInner).to.be(0);
        expect(context.innerActive).to.be(0);
      });

      it('inner loop concurrentLimit expression reads parent loop metadata', async () => {
        const loader = new StringLoader();
        const localEnv = new AsyncEnvironment(loader);
        loader.addTemplate('of-parent.njk',
          '{% for outer in [1,2] %}{% for inner in [1,2,3] of loop.index %}{{ loop.index }}{% endfor %}|{% endfor %}');
        const result = await localEnv.renderTemplate('of-parent.njk', {});
        expect(result).to.equal('123|123|');
      });

      it('handles hard errors from async iterator.next() in limited mode', async () => {
        const context = {
          async *makeAsyncItems() {
            yield 0;
            yield 1;
            throw new Error('Iterator failed');
          },
          async processItem(id) {
            await delay(5);
            return `Item ${id}`;
          }
        };

        const template = '{% for id in makeAsyncItems() of 2 %}{{ processItem(id) }}{% endfor %}';

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Iterator failed');
        }
      });

      it('converts yielded Error values to poison in limited mode', async () => {
        const context = {
          async *makeAsyncItems() {
            yield new Error('Soft problem');
            yield 42;
          },
          async processItem(v) {
            return `VAL-${v},`;
          }
        };

        const template = `
          {%- for v in makeAsyncItems() of 2 -%}
            {%- set result = "" -%}
            {%- if v is error -%}
              {%- set result = "POISON," -%}
            {%- else -%}
              {%- set result = processItem(v) -%}
            {%- endif -%}
            {{- result -}}
          {%- endfor -%}`;
        const result = await env.renderTemplateString(template, context);

        expect(result).to.equal('POISON,VAL-42,');
      });

      it('preserves loop-scoped set assignments across body and else in limited mode', async () => {
        const context = {
          async *makeAsyncItems() {
            yield -1;
            yield 4;
          },
          async *makeEmptyItems() { },
          async formatValue(v) {
            return `VAL-${v},`;
          }
        };

        const template = `
          {%- for v in makeAsyncItems() of 2 -%}
            {%- set status = "" -%}
            {%- if v < 0 -%}
              {%- set status = "NEG," -%}
            {%- else -%}
              {%- set status = formatValue(v) -%}
            {%- endif -%}
            {{- status -}}
          {%- else -%}
            {%- set status = "BODY_EMPTY," -%}
            {{- status -}}
          {%- endfor -%}
          {%- for v in makeEmptyItems() of 2 -%}
            {%- set status = formatValue(v) -%}
            {{- status -}}
          {%- else -%}
            {%- set status = "EMPTY," -%}
            {{- status -}}
          {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.replace(/\s+/g, '')).to.equal('NEG,VAL-4,EMPTY,');
      });

      it('handles limits greater than async iterator item count', async () => {
        const context = {
          concurrentCount: 0,
          maxConcurrent: 0,
          async *makeAsyncItems() {
            for (let i = 0; i < 3; i++) {
              yield i;
            }
          },
          async processItem(id) {
            context.concurrentCount++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrentCount);
            await delay(10);
            context.concurrentCount--;
          }
        };

        const template = '{% for id in makeAsyncItems() of 10 %}{{ processItem(id) }}{% endfor %}';
        await env.renderTemplateString(template, context);
        expect(context.maxConcurrent).to.be(3);
      });

      it('runs else when limited async iterator is empty', async () => {
        const context = {
          async *emptyGen() { }
        };

        const template = '{% for x in emptyGen() of 3 %}X{% else %}ELSE{% endfor %}';
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('ELSE');
      });

      it('does not run else when limited async iterator already iterated before error', async () => {
        const context = {
          async *makeAsyncItems() {
            yield 1;
            yield 2;
          },
          async processItem(id) {
            if (id === 2) {
              throw new Error('Boom');
            }
            return `OK-${id},`;
          }
        };

        const template = '{% for id in makeAsyncItems() of 2 %}{{ processItem(id) }}{% else %}ELSE{% endfor %}';

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
        }
      });

      it('keeps outer of 1 blocked until nested limited loop work completes', async () => {
        const context = {
          outer: [1, 2],
          inner: [1, 2, 3],
          outerActive: 0,
          outerMax: 0,
          async enterOuter(id) {
            void id;
            context.outerActive++;
            context.outerMax = Math.max(context.outerMax, context.outerActive);
            return '';
          },
          async leaveOuter(id) {
            void id;
            context.outerActive--;
            return '';
          },
          async innerWork(o, i) {
            void o;
            void i;
            await delay(8);
            return '';
          }
        };

        const template = `
        {%- for o in outer of 1 -%}
          {{ enterOuter(o) }}
          {%- for i in inner of 2 -%}
            {{ innerWork(o, i) }}
          {%- endfor -%}
          {{ leaveOuter(o) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.outerMax).to.be(1);
      });

      it('keeps outer of 1 blocked until nested unbounded loop work completes', async () => {
        const context = {
          outer: [1, 2],
          inner: [1, 2, 3],
          outerActive: 0,
          outerMax: 0,
          innerActive: 0,
          innerMax: 0,
          async enterOuter(id) {
            void id;
            context.outerActive++;
            context.outerMax = Math.max(context.outerMax, context.outerActive);
            return '';
          },
          async leaveOuter(id) {
            void id;
            context.outerActive--;
            return '';
          },
          async innerWork(o, i) {
            void o;
            void i;
            context.innerActive++;
            context.innerMax = Math.max(context.innerMax, context.innerActive);
            try {
              await delay(8);
            } finally {
              context.innerActive--;
            }
            return '';
          }
        };

        const template = `
        {%- for o in outer of 1 -%}
          {{ enterOuter(o) }}
          {%- for i in inner -%}
            {{ innerWork(o, i) }}
          {%- endfor -%}
          {{ leaveOuter(o) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.outerMax).to.be(1);
        expect(context.innerMax).to.be.greaterThan(1);
      });
    });

    describe('Object iterators with concurrent limits', () => {
      function buildCatalog() {
        return { a: 1, b: 2, c: 3, d: 4 };
      }

      function buildSmallCatalog() {
        return { a: 1, b: 2, c: 3 };
      }

      async function expectZeroLikeLimit(limitExpression) {
        const context = {
          catalog: buildCatalog(),
          concurrent: 0,
          maxConcurrent: 0,
          async process(key, value) {
            context.concurrent++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
            try {
              await delay(2);
            } finally {
              context.concurrent--;
            }
            return `${key}:${value},`;
          }
        };

        const template = `
        {%- for key, value in catalog of ${limitExpression} -%}
          {{ process(key, value) }}
        {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(normalizeOutput(result)).to.be('a:1,b:2,c:3,d:4,');
        expect(context.maxConcurrent).to.be(Object.keys(context.catalog).length);
      }

      async function renderMetadataFor(limitExpression) {
        const context = { catalog: buildSmallCatalog() };
        const template = `
        {%- for key, value in catalog${limitExpression ? ` of ${limitExpression}` : ''} -%}
          {{ key }}:{{ loop.index }}/{{ loop.index0 }}/{{ "T" if loop.first else "F" }}/{{ loop.length }}/{{ "T" if loop.last else "F" }},
        {%- endfor -%}
        `;
        const result = await env.renderTemplateString(template, context);
        return normalizeOutput(result);
      }

      async function runBoundedObjectLoop() {
        const context = {
          catalog: buildCatalog(),
          async noop() {
            await delay(1);
            return '';
          }
        };
        const template = `
        {%- for key, value in catalog of 2 -%}
          {{ noop() }}
        {%- endfor -%}
        `;
        await env.renderTemplateString(template, context);
      }

      async function renderBaselineObjectLoop(shouldThrow) {
        const context = {
          catalog: buildCatalog(),
          async process(key, value) {
            await delay(1);
            if (shouldThrow && value % 2 === 0) {
              throw new Error(`boom-${key}`);
            }
            return `${key}=${value},`;
          }
        };
        const template = `
        {%- for key, value in catalog -%}
          {{ process(key, value) }}
        {%- endfor -%}
        `;
        return env.renderTemplateString(template, context);
      }

      it('1) limits object loop concurrency according to the bound', async () => {
        const context = {
          catalog: buildCatalog(),
          tracker: { current: 0, max: 0 },
          async visit(key) {
            context.tracker.current++;
            context.tracker.max = Math.max(context.tracker.max, context.tracker.current);
            try {
              await delay(3);
            } finally {
              context.tracker.current--;
            }
            return '';
          }
        };

        const template = `
        {%- for key, value in catalog of 2 -%}
          {{ visit(key) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.tracker.max).to.be(2);
      });

      it('2) treats of 1 as sequential and matches sequential override semantics', async () => {
        const context = {
          catalog: buildCatalog(),
          limitedTracker: { current: 0, max: 0 },
          sequentialTracker: { current: 0, max: 0 },
          order: { limited: [], sequential: [] },
          async visitLimited(key) {
            context.limitedTracker.current++;
            context.limitedTracker.max = Math.max(context.limitedTracker.max, context.limitedTracker.current);
            context.order.limited.push(key);
            try {
              await delay(2);
            } finally {
              context.limitedTracker.current--;
            }
            return '';
          }
        };
        context.logger = {
          async capture(key) {
            context.sequentialTracker.current++;
            context.sequentialTracker.max = Math.max(context.sequentialTracker.max, context.sequentialTracker.current);
            context.order.sequential.push(key);
            try {
              await delay(2);
            } finally {
              context.sequentialTracker.current--;
            }
            return '';
          }
        };

        const template = `
        {%- for key, value in catalog of 1 -%}
          {{ visitLimited(key) }}
        {%- endfor -%}
        {%- for key, value in catalog -%}
          {{ logger!.capture(key) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.limitedTracker.max).to.be(1);
        expect(context.sequentialTracker.max).to.be(1);
        expect(context.order.limited).to.eql(context.order.sequential);
      });

      it('3) treats 0/null/undefined limits as unlimited for object loops', async () => {
        await expectZeroLikeLimit('0');
        await expectZeroLikeLimit('null');
        await expectZeroLikeLimit('undefined');
      });

      it('4) skips limited mode when limit exceeds object size', async () => {
        const catalog = { a: 1, b: 2, c: 3, d: 4, e: 5 };
        const context = {
          catalog,
          concurrent: 0,
          maxConcurrent: 0,
          async process(key, value) {
            context.concurrent++;
            context.maxConcurrent = Math.max(context.maxConcurrent, context.concurrent);
            try {
              await delay(1);
            } finally {
              context.concurrent--;
            }
            return `${key}:${value},`;
          }
        };

        const template = `
        {%- for key, value in catalog of 10 -%}
          {{ process(key, value) }}
        {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(normalizeOutput(result)).to.be('a:1,b:2,c:3,d:4,e:5,');
        expect(context.maxConcurrent).to.be(Object.keys(catalog).length);
      });

      it('5) requires two loop variables regardless of concurrency mode', async () => {
        async function expectTwoVarFailure(template, context, label) {
          try {
            await env.renderTemplateString(template, context);
            expect().fail(`Expected error for ${label}`);
          } catch (err) {
            const message = err && err.errors && err.errors[0] ? err.errors[0].message : err.message;
            expect(message).to.contain('Expected two variables for key/value iteration');
          }
        }

        const catalog = { a: 1, b: 2 };
        await expectTwoVarFailure(
          '{% for key in catalog %}{{ key }}{% endfor %}',
          { catalog },
          'parallel'
        );
        await expectTwoVarFailure(
          '{% for key in catalog of 3 %}{{ key }}{% endfor %}',
          { catalog },
          'limited'
        );
        await expectTwoVarFailure(
          '{% for key in catalog %}{{ logger!.log(key) }}{% endfor %}',
          {
            catalog,
            logger: {
              async log() {
                await delay(0);
                return '';
              }
            }
          },
          'sequential override'
        );
      });

      it('6) exposes correct metadata in limited object loops', async () => {
        const result = await renderMetadataFor('2');
        expect(result).to.be('a:1/0/T/3/F,b:2/1/F/3/F,c:3/2/F/3/T,');
      });

      it('7) preserves legacy metadata when no limit is provided', async () => {
        const result = await renderMetadataFor('');
        expect(result).to.be('a:1/0/T/3/F,b:2/1/F/3/F,c:3/2/F/3/T,');
      });

      it('8) keeps metadata identical when limit is ignored (0/null/undefined)', async () => {
        const expected = 'a:1/0/T/3/F,b:2/1/F/3/F,c:3/2/F/3/T,';
        expect(await renderMetadataFor('0')).to.be(expected);
        expect(await renderMetadataFor('null')).to.be(expected);
        expect(await renderMetadataFor('undefined')).to.be(expected);
      });

      it('9) nests bounded object loops inside bounded arrays without leaks', async () => {
        const context = {
          outerItems: ['O0', 'O1', 'O2', 'O3'],
          innerObject: { alpha: 1, beta: 2, gamma: 3 },
          outerTracker: { current: 0, max: 0 },
          innerTracker: {},
          outerMeta: {},
          innerMeta: {},
          async trackOuter(value) {
            context.outerTracker.current++;
            context.outerTracker.max = Math.max(context.outerTracker.max, context.outerTracker.current);
            try {
              await delay(4);
            } finally {
              context.outerTracker.current--;
            }
            return '';
          },
          async trackInner(outer, key) {
            if (!context.innerTracker[outer]) {
              context.innerTracker[outer] = { current: 0, max: 0 };
            }
            const entry = context.innerTracker[outer];
            entry.current++;
            entry.max = Math.max(entry.max, entry.current);
            try {
              await delay(2);
            } finally {
              entry.current--;
            }
            return '';
          },
          recordOuterMeta(index, index0, first, length, last) {
            context.outerMeta[index0] = { index, index0, first, length, last };
            return '';
          },
          recordInnerMeta(outer, key, index, index0, first, length, last) {
            if (!context.innerMeta[outer]) {
              context.innerMeta[outer] = {};
            }
            context.innerMeta[outer][key] = { index, index0, first, length, last };
            return '';
          }
        };

        const template = `
        {%- for outer in outerItems of 3 -%}
          {{ trackOuter(outer) }}
          {{ recordOuterMeta(loop.index, loop.index0, loop.first, loop.length, loop.last) }}
          {%- for key, value in innerObject of 2 -%}
            {{ trackInner(outer, key) }}
            {{ recordInnerMeta(outer, key, loop.index, loop.index0, loop.first, loop.length, loop.last) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.outerTracker.max).to.be.lessThan(4);
        context.outerItems.forEach((outer, idx) => {
          const meta = context.outerMeta[idx];
          expect(meta.index).to.be(idx + 1);
          expect(meta.index0).to.be(idx);
          expect(meta.length).to.be(context.outerItems.length);
          expect(meta.first).to.be(idx === 0);
          expect(meta.last).to.be(idx === context.outerItems.length - 1);
          const tracker = context.innerTracker[outer];
          expect(tracker.max).to.be(2);
          const innerMeta = context.innerMeta[outer];
          expect(Object.keys(innerMeta)).to.have.length(3);
          ['alpha', 'beta', 'gamma'].forEach((key, innerIdx) => {
            const entry = innerMeta[key];
            expect(entry.index).to.be(innerIdx + 1);
            expect(entry.index0).to.be(innerIdx);
            expect(entry.length).to.be(3);
            expect(entry.first).to.be(innerIdx === 0);
            expect(entry.last).to.be(innerIdx === 2);
          });
        });
      });

      it('10) nests bounded object loops under bounded async iterators safely', async () => {
        const context = {
          innerObject: { key0: 0, key1: 1, key2: 2 },
          outerTracker: { current: 0, max: 0 },
          innerTracker: {},
          outerMeta: [],
          innerMeta: {},
          makeOuter() {
            const values = ['A0', 'A1', 'A2', 'A3'];
            return (async function* () {
              for (const value of values) {
                await delay(1);
                yield value;
              }
            }());
          },
          async trackOuter(value) {
            context.outerTracker.current++;
            context.outerTracker.max = Math.max(context.outerTracker.max, context.outerTracker.current);
            try {
              await delay(3);
            } finally {
              context.outerTracker.current--;
            }
            return '';
          },
          async trackInner(outer, key) {
            if (!context.innerTracker[outer]) {
              context.innerTracker[outer] = { current: 0, max: 0 };
            }
            const holder = context.innerTracker[outer];
            holder.current++;
            holder.max = Math.max(holder.max, holder.current);
            try {
              await delay(1);
            } finally {
              holder.current--;
            }
            return '';
          },
          recordOuterMeta(index, index0, first, length, last) {
            context.outerMeta[index0] = { index, index0, first, length, last };
            return '';
          },
          recordInnerMeta(outer, key, index, index0, first, length, last) {
            if (!context.innerMeta[outer]) {
              context.innerMeta[outer] = {};
            }
            context.innerMeta[outer][key] = { index, index0, first, length, last };
            return '';
          }
        };

        const template = `
        {%- for outer in makeOuter() of 3 -%}
          {{ trackOuter(outer) }}
          {{ recordOuterMeta(loop.index, loop.index0, loop.first, loop.length, loop.last) }}
          {%- for key, value in innerObject of 2 -%}
            {{ trackInner(outer, key) }}
            {{ recordInnerMeta(outer, key, loop.index, loop.index0, loop.first, loop.length, loop.last) }}
          {%- endfor -%}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.outerTracker.max).to.be.lessThan(4);
        context.outerMeta.forEach((meta, idx) => {
          expect(meta.index).to.be(idx + 1);
          expect(meta.index0).to.be(idx);
          expect(meta.first).to.be(idx === 0);
          expect(meta.length).to.be(undefined);
          expect(meta.last).to.be(false);
        });
        Object.values(context.innerTracker).forEach(tracker => {
          expect(tracker.max).to.be(2);
        });
        Object.entries(context.innerMeta).forEach(([, innerMeta]) => {
          expect(Object.keys(innerMeta)).to.have.length(3);
          Object.values(innerMeta).forEach(entry => {
            expect(entry.length).to.be(3);
            expect(entry.last).to.be(entry.index === entry.length);
          });
        });
      });

      it('11) poisons object loops when concurrentLimit expression is poisoned', async () => {
        const context = {
          catalog: buildSmallCatalog(),
          events: [],
          didIterate: false,
          record(event) {
            context.events.push(event);
            return '';
          },
          markIter() {
            context.didIterate = true;
            return '';
          },
          poisonLimit() {
            return createPoison(new Error('object limit poisoned'));
          }
        };

        const template = `
        {%- for key, value in catalog of poisonLimit() -%}
          {{ markIter() }}
          {{ record('body-' ~ key) }}
        {%- else -%}
          {{ record('else') }}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected poisoned concurrentLimit to reject');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('object limit poisoned');
          expect(context.events).to.have.length(0);
          expect(context.didIterate).to.be(false);
        }
      });

      it('12) rejects invalid concurrentLimit values for object loops', async () => {
        function buildInvalidContext() {
          const ctx = {
            catalog: buildCatalog(),
            events: [],
            didIterate: false,
            record(event) {
              ctx.didIterate = true;
              ctx.events.push(event);
              return '';
            },
            negLimit: -1,
            nanLimit: NaN,
            infLimit: Infinity,
            stringLimit: 'foo',
            async promiseLimit() {
              await delay(0);
              return -5;
            }
          };
          return ctx;
        }

        const cases = [
          { desc: 'negative', expr: 'negLimit' },
          { desc: 'NaN', expr: 'nanLimit' },
          { desc: 'Infinity', expr: 'infLimit' },
          { desc: 'string', expr: 'stringLimit' },
          { desc: 'promise', expr: 'promiseLimit()' }
        ];

        for (const testCase of cases) {
          const context = buildInvalidContext();
          const template = `
          {%- for key, value in catalog of ${testCase.expr} -%}
            {{ record('body-' ~ key) }}
          {%- endfor -%}
          `;
          try {
            await env.renderTemplateString(template, context);
            expect().fail(`Expected invalid limit error for ${testCase.desc}`);
          } catch (err) {
            expect(isPoisonError(err)).to.be(true);
            expect(err.errors[0].message).to.contain('concurrentLimit must be a positive number or 0 / null / undefined');
            expect(context.events).to.have.length(0);
            expect(context.didIterate).to.be(false);
          }
        }
      });

      it('13) aggregates errors from limited object loops with async bodies', async () => {
        const context = {
          catalog: { a: 1, b: 2, c: 3, d: 4 },
          successes: [],
          didIterate: false,
          async handle(key, value) {
            context.didIterate = true;
            await delay(1);
            if (value % 2 === 0) {
              throw new Error(`fail-${key}`);
            }
            context.successes.push(key);
            return '';
          }
        };

        const template = `
        {%- for key, value in catalog of 2 -%}
          {{ handle(key, value) }}
        {%- endfor -%}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Expected aggregated errors');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors).to.have.length(2);
          const messages = err.errors.map(e => e.message);
          expect(messages.some(msg => msg.includes('fail-b'))).to.be(true);
          expect(messages.some(msg => msg.includes('fail-d'))).to.be(true);
          expect(context.didIterate).to.be(true);
          expect(context.successes.sort()).to.eql(['a', 'c']);
        }
      });

      it('14) completes large bounded object loops without deadlocks', async function () {
        this.timeout(5000);
        const size = 1200;
        const catalog = {};
        for (let i = 0; i < size; i++) {
          catalog[`k${i}`] = i;
        }
        const context = {
          catalog,
          processed: 0,
          tracker: { current: 0, max: 0 },
          async process(key) {
            context.tracker.current++;
            context.tracker.max = Math.max(context.tracker.max, context.tracker.current);
            try {
              await delay(key.endsWith('0') ? 1 : 0);
            } finally {
              context.tracker.current--;
            }
            context.processed++;
            return '';
          }
        };

        const template = `
        {%- for key, value in catalog of 5 -%}
          {{ process(key) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.processed).to.be(size);
        expect(context.tracker.max).to.be.lessThan(6);
      });

      it('15) treats oversized limits like unbounded object loops', async () => {
        const catalog = { k0: 0, k1: 1, k2: 2 };
        const context = {
          catalog,
          tracker: { current: 0, max: 0 },
          async process(key, value) {
            context.tracker.current++;
            context.tracker.max = Math.max(context.tracker.max, context.tracker.current);
            try {
              await delay(1);
            } finally {
              context.tracker.current--;
            }
            return `${key}:${value},`;
          }
        };

        const template = `
        {%- for key, value in catalog of 100 -%}
          {{ process(key, value) }}
        {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(normalizeOutput(result)).to.be('k0:0,k1:1,k2:2,');
        expect(context.tracker.max).to.be(Object.keys(catalog).length);
      });

      it('16) skips non-enumerable and inherited properties under bounded mode', async () => {
        const base = { inherited: 99 };
        const source = Object.create(base);
        Object.defineProperty(source, 'hidden', { value: 'secret', enumerable: false });
        source.alpha = 'A';
        source.beta = 'B';
        const context = {
          source,
          visited: [],
          tracker: { current: 0, max: 0 },
          async record(key) {
            context.tracker.current++;
            context.tracker.max = Math.max(context.tracker.max, context.tracker.current);
            context.visited.push(key);
            try {
              await delay(1);
            } finally {
              context.tracker.current--;
            }
            return '';
          }
        };

        const template = `
        {%- for key, value in source of 2 -%}
          {{ record(key) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.visited).to.eql(['alpha', 'beta']);
        expect(context.tracker.max).to.be(2);
      });

      it('17) ignores symbol keys regardless of concurrency mode', async () => {
        const symA = Symbol('symA');
        const symB = Symbol('symB');
        const catalog = { alpha: 1, beta: 2 };
        catalog[symA] = 10;
        Object.defineProperty(catalog, symB, { value: 20, enumerable: true });
        const context = {
          catalog,
          records: { limited: [], parallel: [] },
          async recordLimited(key) {
            context.records.limited.push(key);
            await delay(0);
            return '';
          },
          async recordParallel(key) {
            context.records.parallel.push(key);
            await delay(0);
            return '';
          }
        };

        const template = `
        {%- for key, value in catalog of 2 -%}
          {{ recordLimited(key) }}
        {%- endfor -%}
        {%- for key, value in catalog -%}
          {{ recordParallel(key) }}
        {%- endfor -%}
        `;

        await env.renderTemplateString(template, context);
        expect(context.records.limited).to.eql(['alpha', 'beta']);
        expect(context.records.parallel).to.eql(['alpha', 'beta']);
      });

      it('18) leaves plain object loops unchanged before and after bounded loops run', async () => {
        const successBefore = await renderBaselineObjectLoop(false);
        await runBoundedObjectLoop();
        const successAfter = await renderBaselineObjectLoop(false);
        expect(successAfter).to.equal(successBefore);

        async function captureErrors() {
          try {
            await renderBaselineObjectLoop(true);
            expect().fail('Expected poison error');
          } catch (err) {
            expect(isPoisonError(err)).to.be(true);
            return err.errors.map(e => e.message).sort();
          }
        }

        const errorsBefore = await captureErrors();
        await runBoundedObjectLoop();
        const errorsAfter = await captureErrors();
        expect(errorsAfter).to.eql(errorsBefore);
      });
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

      it('should expose array metadata even when limit is 1', async () => {
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
          {{ loop.length }}-{{ "T" if loop.last else "F" }},
        {%- endfor -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(normalizeOutput(result)).to.equal('3-F,3-F,3-T,');
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

  describe('Compiler waited-channel scaffolding', function () {
    function countWaitResolveCommands(source) {
      const matches = source.match(/new runtime\.WaitResolveCommand/g);
      return matches ? matches.length : 0;
    }

    it('declares internal __waited__ channel for limited loop iterations', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{{ x }}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(source).to.contain('__waited__');
      expect(source).to.contain('runtime.declareChannel(frame,');
    });

    it('emits canonical loop runtime aliases with loop#<id>', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{{ loop.index }}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(/loop#\d+/.test(source)).to.be(true);
    });

    it('exposes canonical scope boundary coverage table in scope-boundaries', function () {
      if (!scopeBoundaries) {
        this.skip();
      }
      const fields = scopeBoundaries.SCOPE_BOUNDARY_FIELDS_BY_NODE;
      const nodeNames = scopeBoundaries.SCOPE_BOUNDARY_NODE_NAMES;
      expect(fields).to.be.ok();
      expect(Array.isArray(nodeNames)).to.be(true);
      nodeNames.forEach((name) => {
        expect(Array.isArray(fields[name])).to.be(true);
      });
    });

    it('does not declare internal __waited__ channel for unbounded loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs %}{{ x }}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(source).to.not.contain('__waited__');
    });

    it('emits WaitResolveCommand for limited-loop top-level channel expressions', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{{ x + 1 }}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(source).to.contain('new runtime.WaitResolveCommand');
    });

    it('does not emit WaitResolveCommand for unbounded loop channel expressions', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs %}{{ x + 1 }}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(source).to.not.contain('new runtime.WaitResolveCommand');
    });

    it('emits exactly one WaitResolveCommand for an aggregate root expression in a limited loop', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{{ [x + 1, x * 2, (x + 3)] }}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('does not emit extra child waits for aggregate children: only the aggregate root', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{{ [foo(x), bar(x), baz(x)] }}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits WaitResolveCommand for limited-loop set roots', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% set y = foo(x) %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits WaitResolveCommand for limited-loop do roots', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% do foo(x) %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits WaitResolveCommand for limited-loop script var roots', function () {
      const env = new AsyncEnvironment();
      const script = new AsyncScript('for x in xs of 2\n  var y = foo(x)\nendfor\nreturn data.snapshot()', env);
      const source = script._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits WaitResolveCommand for limited-loop return roots', function () {
      const env = new AsyncEnvironment();
      const script = new AsyncScript('for x in xs of 2\n  return foo(x)\nendfor\nreturn data.snapshot()', env);
      const source = script._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits WaitResolveCommand for limited-loop var-channel initializer roots', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% var y = foo(x) %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits WaitResolveCommand for include boundary completion in limited loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% include "inc.njk" %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be.greaterThan(0);
      expect(source).to.contain('._setBoundaryAliases(');
    });

    it('emits WaitResolveCommand for import boundary completion in limited loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% import "m.njk" as m %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be.greaterThan(0);
    });

    it('emits WaitResolveCommand for from-import boundary completion in limited loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% from "m.njk" import foo %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be.greaterThan(0);
    });

    it('emits WaitResolveCommand for block-invocation boundary completion in limited loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% block b %}B{{ x }}{% endblock %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be.greaterThan(0);
    });

    it('does not emit boundary WaitResolveCommand for include in unbounded loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs %}{% include "inc.njk" %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(0);
    });

    it('does not emit boundary WaitResolveCommand for import in unbounded loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs %}{% import "m.njk" as m %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(0);
    });

    it('does not emit boundary WaitResolveCommand for from-import in unbounded loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs %}{% from "m.njk" import foo %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(0);
    });

    it('does not emit boundary WaitResolveCommand for block invocation in unbounded loops', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs %}{% block b %}B{{ x }}{% endblock %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(0);
    });



    it('emits no WaitResolveCommand when body has no async expressions (source expr alone)', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in makeItems() of 2 %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(0);
    });

    it('emits no WaitResolveCommand when body has no async expressions (concurrentLimit expr alone)', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of limitExpr() %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(0);
    });

    it('emits one WaitResolveCommand for async control-flow completion when body has no top-level async expressions', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% if cond(x) %}{% endif %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits parent and child WaitResolveCommands when async work appears only in if/elif conditions', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% if condA(x) %}{% elif condB(x) %}{% endif %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(2);
    });

    it('emits control-flow and branch-root WaitResolveCommands when async text branch roots are wrapped by async control flow', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% if cond(x) %}{{ foo(x) }}{% else %}{{ bar(x) }}{% endif %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(3);
    });

    it('emits parent and child WaitResolveCommands for a nested limited loop statement with no body roots', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% for y in ys of 2 %}{% endfor %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(2);
    });

    it('emits one WaitResolveCommand for async switch completion inside a limited loop', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% for x in xs of 2 %}{% switch pick(x) %}{% case 1 %}{% case 2 %}{% default %}{% endswitch %}{% endfor %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be(1);
    });

    it('emits WaitResolveCommand for super boundary usage inside limited-loop block body', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% extends "base.njk" %}{% block b %}{% for x in xs of 2 %}{{ super() }}{% endfor %}{% endblock %}', env);
      const source = tmpl._compileSource();
      expect(countWaitResolveCommands(source)).to.be.greaterThan(0);
    });
  });

  describe('CommandBuffer boundary alias canonicalization', function () {
    it('maps base channel names to canonical aliases in add()', function () {
      const ctx = { path: 'alias-add.njk' };
      const buffer = new CommandBuffer(ctx, null);
      createChannel(buffer, 'loop#4', ctx, 'text');
      buffer._setBoundaryAliases({ loop: 'loop#4' });

      buffer.add(new TextCommand({
        channelName: 'text',
        args: ['x'],
        pos: { lineno: 1, colno: 1 }
      }), 'loop');

      expect(buffer.arrays.loop).to.be(undefined);
      expect(buffer.arrays['loop#4']).to.have.length(1);
    });

    it('resolves addSnapshot() through boundary aliases', async function () {
      const ctx = { path: 'alias-snapshot.njk' };
      const buffer = new CommandBuffer(ctx, null);
      createChannel(buffer, 'loop#4', ctx, 'text');
      buffer._setBoundaryAliases({ loop: 'loop#4' });

      buffer.addText('A', { lineno: 1, colno: 1 }, 'loop');
      buffer.markFinishedAndPatchLinks();

      const snap = await buffer.addSnapshot('loop', { lineno: 1, colno: 1 });
      expect(snap).to.be('A');
    });

    it('inherits boundary aliases for child buffers linked through addBuffer', function () {
      const ctx = { path: 'alias-child.njk' };
      const parent = new CommandBuffer(ctx, null);
      const child = new CommandBuffer(ctx, null);
      parent._setBoundaryAliases({ loop: 'loop#4', someVar: 'someVar#9' });

      parent.addBuffer(child, 'loop');

      expect(child._boundaryAliases.loop).to.be('loop#4');
      expect(child._boundaryAliases.someVar).to.be('someVar#9');
      child.add(new TextCommand({
        channelName: 'text',
        args: ['x'],
        pos: { lineno: 1, colno: 1 }
      }), 'someVar');
      expect(child.arrays.someVar).to.be(undefined);
      expect(child.arrays['someVar#9']).to.have.length(1);
    });

    it('reuses parent alias map reference when child has no own aliases', function () {
      const ctx = { path: 'alias-reuse.njk' };
      const parent = new CommandBuffer(ctx, null);
      const child = new CommandBuffer(ctx, null);
      parent._setBoundaryAliases({ loop: 'loop#4' });

      parent.addBuffer(child, 'loop');

      expect(child._boundaryAliases).to.be(parent._boundaryAliases);
    });

    it('merges parent aliases when child already has own aliases', function () {
      const ctx = { path: 'alias-merge.njk' };
      const parent = new CommandBuffer(ctx, null);
      const child = new CommandBuffer(ctx, null);
      parent._setBoundaryAliases({ loop: 'loop#4', shared: 'shared#1' });
      child._setBoundaryAliases({ own: 'own#7', shared: 'shared#9' });

      parent.addBuffer(child, 'loop');

      expect(child._boundaryAliases).to.not.be(parent._boundaryAliases);
      expect(child._boundaryAliases.loop).to.be('loop#4');
      expect(child._boundaryAliases.own).to.be('own#7');
      expect(child._boundaryAliases.shared).to.be('shared#9');
    });

    it('keeps canonical input names unchanged', function () {
      const ctx = { path: 'alias-canonical.njk' };
      const buffer = new CommandBuffer(ctx, null);
      createChannel(buffer, 'loop#4', ctx, 'text');
      buffer._setBoundaryAliases({ loop: 'loop#4' });

      buffer.add(new TextCommand({
        channelName: 'text',
        args: ['x'],
        pos: { lineno: 1, colno: 1 }
      }), 'loop#4');

      expect(buffer.arrays['loop#4']).to.have.length(1);
    });
  });
}());
