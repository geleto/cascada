import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';
import * as runtime from '../../src/runtime/runtime.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const TEST_DIAGNOSTIC_CONTEXT = runtime.cloneWithAddedContext(TEST_EC, { branch: 'test' });

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class DeferredObservation extends runtime.Command {
  constructor(label, deferred, events) {
    super();
    this._createResultPromise();
    this.chainName = 'value';
    this.errorContext = TEST_EC;
    this.label = label;
    this.deferred = deferred;
    this.events = events;
  }

  observe(chain) {
    this.events.push(`observe:${this.label}`);
    return this.deferred.promise.then(() => {
      this.events.push(`observed:${this.label}`);
      this.resolveResult(chain._getCurrentResult());
    });
  }
}

class RecordingMutation extends runtime.Command {
  constructor(label, value, events) {
    super();
    this.chainName = 'value';
    this.errorContext = TEST_EC;
    this.label = label;
    this.value = value;
    this.events = events;
  }

  mutate(chain) {
    this.events.push(`mutate:${this.label}`);
    chain._setTarget(this.value);
  }
}

(function () {
  describe('Async template command buffering parity', function () {
    it('should preserve literal/interpolation parity and source ordering', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString('A{{ one() }}B{{ two() }}C', {
        one: async () => '1',
        two: async () => '2'
      });
      expect(result).to.equal('A1B2C');
    });

    it('should dispatch runtime commands through observe and mutate methods', async function () {
      const calls = [];

      class PhaseOnlyMutation extends runtime.Command {
        constructor() {
          super();
          this.chainName = 'value';
          this.errorContext = TEST_EC;
        }

        mutate(chain) {
          calls.push('mutate');
          chain._setTarget('mutated');
        }

        apply() {
          throw new Error('mutating apply should not be called');
        }
      }

      class PhaseOnlyObservation extends runtime.Command {
        constructor() {
          super();
          this._createResultPromise();
          this.chainName = 'value';
          this.errorContext = TEST_EC;
        }

        observe(chain) {
          calls.push('observe');
          this.resolveResult(chain._getCurrentResult());
        }

        apply() {
          throw new Error('observable apply should not be called');
        }
      }

      const buffer = new runtime.CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      runtime.declareBufferChain(buffer, 'value', 'var', null, null);
      buffer.addCommand(new PhaseOnlyMutation(), 'value');
      const result = buffer.addCommand(new PhaseOnlyObservation(), 'value');

      buffer.finish();

      expect(await result).to.be('mutated');
      expect(calls).to.eql(['mutate', 'observe']);
    });

    it('should run adjacent observations concurrently before a mutation barrier', async function () {
      const events = [];
      const first = createDeferred();
      const second = createDeferred();

      const buffer = new runtime.CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = runtime.declareBufferChain(buffer, 'value', 'var', null, 'initial');
      buffer.addCommand(new DeferredObservation('first', first, events), 'value');
      buffer.addCommand(new DeferredObservation('second', second, events), 'value');
      buffer.addCommand(new RecordingMutation('mutate', 'done', events), 'value');

      expect(events).to.eql(['observe:first', 'observe:second']);
      first.resolve();
      await flushAsync();
      expect(events).to.eql(['observe:first', 'observe:second', 'observed:first']);

      second.resolve();
      buffer.finish();

      expect(await chain.finalSnapshot()).to.be('done');
      expect(events).to.eql([
        'observe:first',
        'observe:second',
        'observed:first',
        'observed:second',
        'mutate:mutate'
      ]);
    });

    it('should treat a mixed child buffer as a full-completion mutation barrier', async function () {
      const events = [];
      const beforeMutation = createDeferred();
      const afterMutation = createDeferred();

      const parent = new runtime.CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      const chain = runtime.declareBufferChain(parent, 'value', 'var', null, 'initial');
      const child = new runtime.CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
      child._installLinkedChain('value', chain);

      child.addCommand(new DeferredObservation('child-before', beforeMutation, events), 'value');
      child.addCommand(new RecordingMutation('child-mutate', 'child', events), 'value');
      child.addCommand(new DeferredObservation('child-after', afterMutation, events), 'value');
      child.finish();

      parent.addBuffer(child, 'value');
      parent.addCommand(new RecordingMutation('parent-mutate', 'parent', events), 'value');

      expect(events).to.eql(['observe:child-before']);
      beforeMutation.resolve();
      await flushAsync();
      expect(events).to.eql([
        'observe:child-before',
        'observed:child-before',
        'mutate:child-mutate',
        'observe:child-after'
      ]);

      afterMutation.resolve();
      parent.finish();

      expect(await chain.finalSnapshot()).to.be('parent');
      expect(events).to.eql([
        'observe:child-before',
        'observed:child-before',
        'mutate:child-mutate',
        'observe:child-after',
        'observed:child-after',
        'mutate:parent-mutate'
      ]);
    });

    it('should preserve loop/conditional output parity', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString(
        '{% for n in nums %}{% if n % 2 === 0 %}E{{ n }}{% else %}O{{ n }}{% endif %}|{% endfor %}',
        { nums: [1, 2, 3, 4] }
      );
      expect(result).to.equal('O1|E2|O3|E4|');
    });

    it('should preserve macro/call/set-block parity', async function () {
      const env = new AsyncEnvironment();
      const template = `
        {% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}
        {% set captured %}X{{ value }}Y{% endset %}
        {% call wrap("span") %}{{ captured }}{% endcall %}
      `;
      const result = await env.renderTemplateString(template, { value: 'v' });
      expect(result.replace(/\s+/g, '')).to.equal('<span>XvY</span>');
    });

    it('should preserve include/import/extends parity', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'B[{% block body %}{% endblock %}]');
      loader.addTemplate('part.njk', '<i>{{ value }}</i>');
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');
      loader.addTemplate(
        'child.njk',
        '{% extends "base.njk" %}{% block body %}{% import "macros.njk" as m %}{% include "part.njk" with value %} {{ m.hi(user) }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', { value: 'V', user: 'U' });
      expect(result.replace(/\s+/g, ' ').trim()).to.equal('B[<i>V</i> Hi U]');
    });

    it('should keep canonical include input keys for duplicated branch-local vars', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '[{{ scopedValue }}]');

      const tmpl = new AsyncTemplate(`
        {% if flag %}
          {% var scopedValue = "A" %}
          {% include "child.njk" with scopedValue %}
        {% else %}
          {% var scopedValue = "B" %}
          {% include "child.njk" with scopedValue %}
        {% endif %}
      `, env, 'branch-include-shadow.njk');

      expect((await tmpl.render({ flag: true })).trim()).to.be('[A]');
      expect((await tmpl.render({ flag: false })).trim()).to.be('[B]');
    });

    it('should render async import with context and explicit inputs', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi() %}{{ theme }} {{ name }} {{ localName }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% var localName = "hidden" %}{% import "macros.njk" as m with context, theme %}{{ m.hi() }}',
        env,
        'import-with-context-and-vars.njk'
      );

      const result = await tmpl.render({ theme: 'dark', name: 'Ada' });
      expect(result).to.be('dark Ada ');
    });

    it('should keep canonical exported names for from-import bindings renamed in local scopes', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro show() %}Hi{% endmacro %}');

      const tmpl = new AsyncTemplate(`
        {% if usePrimary %}
          {% from "macros.njk" import show %}
          {{ show() }}
        {% else %}
          {% from "macros.njk" import show %}
          {{ show() }}
        {% endif %}
      `, env, 'from-import-canonical-export-name.njk');

      expect((await tmpl.render({ usePrimary: true })).trim()).to.be('Hi');
      expect((await tmpl.render({ usePrimary: false })).trim()).to.be('Hi');
    });

    it('should resolve deferred exports through the normal render path', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const result = await env.renderTemplateString('{% import "macros.njk" as m %}{{ m.hi("x") }}');
      expect(result).to.be('Hi x');
    });

    it('should return the exported namespace before async exported values settle', async function () {
      const env = new AsyncEnvironment();
      let resolveValue;
      const pendingValue = new Promise((resolve) => {
        resolveValue = resolve;
      });
      env.addGlobal('slowValue', () => pendingValue);
      const tmpl = new AsyncTemplate('{% set x = slowValue() %}', env, 'deferred-export-namespace.njk');

      const exported = tmpl.getExported({});
      expect(exported).to.have.key('x');
      expect(typeof exported.then).to.be('undefined');
      expect(exported.x && typeof exported.x.then).to.be('function');

      const first = await Promise.race([
        Promise.resolve().then(() => 'exported'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 0))
      ]);
      expect(first).to.be('exported');

      resolveValue('ready');
      expect(await exported.x).to.be('ready');
    });

    it('should reject an early returned exported value when its chain fails', async function () {
      const env = new AsyncEnvironment();
      env.addGlobal('failValue', () => {
        throw new Error('export failed');
      });
      const tmpl = new AsyncTemplate('{% set x = failValue() %}', env, 'failed-deferred-export.njk');

      const exported = tmpl.getExported({});
      expect(exported).to.have.key('x');

      try {
        await exported.x;
        expect().fail('Expected exported value to reject');
      } catch (err) {
        expect(err.message).to.contain('export failed');
      }
    });

    it('should let observe-only shared-lane siblings run concurrently with invocation reads', async function () {
      const createRootBuffer = () => {
        const rootBuffer = new runtime.CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
        runtime.declareBufferChain(rootBuffer, '__text__', 'text', null, null);
        runtime.declareBufferChain(rootBuffer, 'theme', 'var', null, null);
        rootBuffer.addCommand(new runtime.VarCommand({
          chainName: 'theme',
          args: ['dark'],
          errorContext: TEST_EC
        }), 'theme');
        return rootBuffer;
      };

      const blockedRoot = createRootBuffer();
      // Observe-only child buffers are observable entries in Stage 1, so an
      // empty earlier sibling in the same shared lane must not block a later
      // invocation snapshot.
      const sharedLaneSibling = new runtime.CommandBuffer(null, null, [["theme"]], null, blockedRoot, TEST_DIAGNOSTIC_CONTEXT);
      const invocationBuffer = new runtime.CommandBuffer(null, null, [["theme"]], null, blockedRoot, TEST_DIAGNOSTIC_CONTEXT);
      const blockedRead = invocationBuffer.addCommand(new runtime.SnapshotCommand({
        chainName: 'theme',
        errorContext: TEST_EC
      }), 'theme');
      let blockedReadSettled = false;
      blockedRead.then(() => {
        blockedReadSettled = true;
      });

      await Promise.resolve();
      expect(blockedReadSettled).to.be(true);
      sharedLaneSibling.finish();
      invocationBuffer.finish();
      blockedRoot.finish();
      expect(await blockedRead).to.be('dark');

      const textRoot = createRootBuffer();
      const textPlacementBoundary = new runtime.CommandBuffer(null, null, [["__text__"]], null, textRoot, TEST_DIAGNOSTIC_CONTEXT);
      const admittedInvocation = new runtime.CommandBuffer(null, null, [["theme"]], null, textRoot, TEST_DIAGNOSTIC_CONTEXT);
      const admittedRead = admittedInvocation.addCommand(new runtime.SnapshotCommand({
        chainName: 'theme',
        errorContext: TEST_EC
      }), 'theme');

      expect(await admittedRead).to.be('dark');
      textPlacementBoundary.finish();
      admittedInvocation.finish();
      textRoot.finish();
    });

    it('should keep individual exported value failures independent', async function () {
      const env = new AsyncEnvironment();
      env.addGlobal('failA', () => {
        throw new Error('export failed A');
      });
      env.addGlobal('failB', () => {
        throw new Error('export failed B');
      });
      const tmpl = new AsyncTemplate([
        '{% set a = failA() %}',
        '{% set b = failB() %}'
      ].join(''), env, 'multi-failed-deferred-export.njk');

      const exported = tmpl.getExported({});
      const results = await Promise.allSettled([exported.a, exported.b]);

      expect(results[0].status).to.be('rejected');
      expect(results[0].reason.message).to.contain('export failed A');
      expect(results[1].status).to.be('rejected');
      expect(results[1].reason.message).to.contain('export failed B');
    });

    it('should keep individual resolved exports usable while sibling exports fail', async function () {
      const env = new AsyncEnvironment();
      env.addGlobal('failValue', () => {
        throw new Error('root export value failed');
      });
      const tmpl = new AsyncTemplate([
        '{% macro ok() %}OK{% endmacro %}',
        '{% set x = failValue() %}'
      ].join(''), env, 'resolved-export-with-failed-sibling.njk');

      const exported = tmpl.getExported({});
      const ok = await exported.ok;
      expect(typeof ok).to.be('function');

      try {
        await exported.x;
        expect().fail('Expected failed exported value to reject');
      } catch (err) {
        expect(err.message).to.contain('root export value failed');
      }
    });

    it('should export root script chains through final snapshots', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('chains.script', [
        'text log',
        'data result',
        'log("hello")',
        'result.user.name = "Ada"'
      ].join('\n'));

      const rendered = await env.renderScriptString([
        'import "chains.script" as lib',
        'return { log: lib.log, result: lib.result }'
      ].join('\n'));

      expect(rendered).to.eql({
        log: 'hello',
        result: { user: { name: 'Ada' } }
      });
    });

    it('should keep observed vs unobserved async errors behavior', async function () {
      const env = new AsyncEnvironment();
      const context = {
        bad: async () => {
          throw new Error('boom');
        }
      };

      const safeResult = await env.renderTemplateString('{% if false %}{{ bad() }}{% endif %}ok', context);
      expect(safeResult).to.equal('ok');

      try {
        await env.renderTemplateString('{{ bad() }}', context);
        expect().fail('Expected observed error');
      } catch (err) {
        expect(err.message).to.contain('boom');
      }
    });

    it('should keep imported member calls working through imported namespaces', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m %}{{ m.hi("x") }}',
        env,
        'imported-member-boundary.njk'
      );
      const result = await tmpl.render({});

      expect(result).to.be('Hi x');
    });

    it('should not treat a macro parameter shadowing a from-import binding as imported callable', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro foo(name) %}Foo {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% from "macros.njk" import foo %}{% macro use(foo) %}{{ foo("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-from-import-call.njk'
      );
      const result = await tmpl.render({
        helper(name) {
          return 'Helper ' + name;
        }
      });

      expect(result).to.be('Helper x');
    });

    it('should not treat a macro parameter shadowing an imported namespace as imported callable', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m %}{% macro use(m) %}{{ m("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-import-namespace-call.njk'
      );
      const result = await tmpl.render({
        helper(name) {
          return 'Helper ' + name;
        }
      });

      expect(result).to.be('Helper x');
    });

  });
}());
