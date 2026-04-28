
(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var AsyncTemplate;
  var Context;
  var StringLoader;
  var DEFAULT_TEMPLATE_TEXT_OUTPUT;
  var runtime;
  var inheritanceStateRuntime;


  function esmDefault(module) {
    return module.default || module;
  }

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    const envModule = require('../../src/environment/environment');
    AsyncEnvironment = envModule.AsyncEnvironment;
    AsyncTemplate = envModule.AsyncTemplate;
    Context = envModule.Context;
    StringLoader = require('../util').StringLoader;
    DEFAULT_TEMPLATE_TEXT_OUTPUT = require('../../src/compiler/buffer').DEFAULT_TEMPLATE_TEXT_OUTPUT;
    runtime = esmDefault(require('../../src/runtime/runtime'));
    inheritanceStateRuntime = require('../../src/runtime/inheritance-state');
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    AsyncTemplate = nunjucks.AsyncTemplate;
    Context = nunjucks.Context;
    StringLoader = window.util.StringLoader;
    runtime = nunjucks.runtime;
    inheritanceStateRuntime = null;
  }

  describe('Async template command buffering parity', function () {
    it('should compile async template output to text commands on text output', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{{ value }}', env);
      const source = tmpl._compileSource();
      expect(source).to.contain(`channelName: "${DEFAULT_TEMPLATE_TEXT_OUTPUT}"`);
      expect(source).to.contain('new runtime.TextCommand');
    });

    it('should not emit caller scheduling machinery for macros without caller()', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% macro plain(x) %}{{ x }}{% endmacro %}{{ plain("v") }}', env);
      const source = tmpl._compileSource();
      expect(source).to.not.contain('__caller__');
      expect(source).to.not.contain('__callerUsedChannels');
    });

    it('should preserve literal/interpolation parity and source ordering', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString('A{{ one() }}B{{ two() }}C', {
        one: async () => '1',
        two: async () => '2'
      });
      expect(result).to.equal('A1B2C');
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
        '{% extends "base.njk" %}{% import "macros.njk" as m %}{% block body %}{% include "part.njk" with value %}{% endblock %} {{ m.hi(user) }}'
      );

      const result = await env.renderTemplate('child.njk', { value: 'V', user: 'U' });
      expect(result.replace(/\s+/g, ' ').trim()).to.equal('B[<i>V</i>] Hi U');
    });

    it('should keep canonical include input keys for duplicated branch-local vars', function () {
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
      const source = tmpl._compileSource();

      expect(source).to.contain('scopedValue#');
      expect(source).to.contain('["scopedValue"]');
      expect(source).to.not.contain('["scopedValue#');
    });

    it('should compile async import with context and explicit inputs without parent-var linking', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi() %}{{ theme }}{{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m with context, theme %}{{ m.hi() }}',
        env,
        'import-with-context-and-vars.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('context.getRenderContextVariables()');
      expect(source).to.not.contain('linkWithParentCompositionBuffer');
    });

    it('should keep canonical exported names for from-import bindings renamed in local scopes', function () {
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
      const source = tmpl._compileSource();

      expect(source).to.contain('cannot import \'show\'');
      expect(source).to.contain('exported["show"]');
      expect(source).to.not.contain('cannot import \'show#');
      expect(source).to.not.contain('exported["show#');
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
      expect(exported[runtime.RESOLVE_MARKER]).to.be.ok();

      const first = await Promise.race([
        Promise.resolve().then(() => 'exported'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 0))
      ]);
      expect(first).to.be('exported');

      resolveValue('ready');
      expect(await exported.x).to.be('ready');
      await exported[runtime.RESOLVE_MARKER];
      expect(exported.x).to.be('ready');
    });

    it('should reject an early returned exported value when its channel fails', async function () {
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

    it('should collect multiple exported value failures before rejecting the exported namespace', async function () {
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

      try {
        await exported[runtime.RESOLVE_MARKER];
        expect().fail('Expected exported namespace marker to reject');
      } catch (err) {
        const messages = (err.errors || [err]).map((error) => error.message);
        expect(messages.some((message) => message.indexOf('export failed A') !== -1)).to.be(true);
        expect(messages.some((message) => message.indexOf('export failed B') !== -1)).to.be(true);
      }
    });

    it('should keep individual resolved exports usable while the exported namespace reports other failures', async function () {
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
        await exported[runtime.RESOLVE_MARKER];
        expect().fail('Expected exported namespace marker to reject');
      } catch (err) {
        expect(err.message).to.contain('root export value failed');
      }
    });

    it('should export root script channels through final snapshots', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('channels.script', [
        'text log',
        'data result',
        'log("hello")',
        'result.user.name = "Ada"'
      ].join('\n'));

      const rendered = await env.renderScriptString([
        'import "channels.script" as lib',
        'return { log: lib.log, result: lib.result }'
      ].join('\n'));

      expect(rendered).to.eql({
        log: 'hello',
        result: { user: { name: 'Ada' } }
      });
    });

    it('should skip deferred export resolution when rendering in component mode', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate('{% import "macros.njk" as m %}{{ m.hi("x") }}', env, 'component-mode-export-guard.njk');
      tmpl.compile();

      const context = tmpl._createContext({});
      let resolveCount = 0;
      context.resolveExports = function () {
        resolveCount += 1;
        throw new Error('resolveExports should be skipped in component mode');
      };
      const buffer = runtime.createCommandBuffer(context, null, null, null);
      runtime.declareBufferChannel(buffer, DEFAULT_TEMPLATE_TEXT_OUTPUT, 'text', context, null);
      const inheritanceState = runtime.createInheritanceState();
      inheritanceState.sharedRootBuffer = buffer;
      inheritanceStateRuntime.setComponentCompositionMode(inheritanceState, true);

      let callbackError = null;
      tmpl.rootRenderFunc(
        env,
        context,
        runtime,
        function (err) {
          callbackError = err || null;
        },
        true,
        buffer,
        inheritanceState,
        true
      );

      const startupPromise = inheritanceStateRuntime.awaitInheritanceStartup(inheritanceState);
      if (startupPromise && typeof startupPromise.then === 'function') {
        await startupPromise;
      }

      expect(resolveCount).to.be(0);
      expect(callbackError).to.be(null);
    });

    it('should assert when a deferred export is missing its explicit producer record', function () {
      const env = new AsyncEnvironment();
      const context = new Context({}, {}, env, 'missing-export-producer.njk');

      context.addDeferredExport('value', 'value', null);

      expect(function () {
        context.resolveExports();
      }).to.throwException(/missing an explicit producer record/);
    });

    it('should initialize base-block with inputs as local async var channels', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% block content(user) %}{{ user }}{% endblock %}', env, 'block-input-vars.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('function b_content(env, context, runtime, cb, parentBuffer = null, blockPayload = null, blockRenderCtx = undefined, inheritanceState = null, methodData) {');
      expect(source).to.contain('runtime.invokeInheritedMethod(inheritanceState, "content"');
      expect(source).to.contain('blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {}');
      expect(source).to.not.contain('blockPayload && blockPayload.localsByTemplate');
      expect(source).to.contain('context.forkForComposition("block-input-vars.njk"');
      expect(source).to.contain('runtime.linkCurrentBufferToParentChannels(parentBuffer, output');
      expect(source).to.not.contain('runtime.linkCurrentBufferToParentSharedChannels(');
      expect(source).to.not.contain('context.getBlockContract("content")');
      expect(source).to.not.contain('context.getCompositionSourceBuffer(');
      expect(source).to.contain(`new runtime.VarCommand({ channelName: name, args: [`);
    });

    it('should initialize inherited block arguments as local async var channels in overriding blocks', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');

      const tmpl = new AsyncTemplate(
        '{% extends "base.njk" %}{% block content %}Child {{ user }}{% endblock %}',
        env,
        'child-inherited-block-inputs.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('function b_content(env, context, runtime, cb, parentBuffer = null, blockPayload = null, blockRenderCtx = undefined, inheritanceState = null, methodData) {');
      expect(source).to.contain('context.forkForComposition("child-inherited-block-inputs.njk"');
      expect(source).to.contain('runtime.linkCurrentBufferToParentChannels(parentBuffer, output');
      expect(source).to.not.contain('runtime.linkCurrentBufferToParentSharedChannels(');
      expect(source).to.not.contain('blockPayload && blockPayload.localsByTemplate');
      expect(source).to.not.contain('context.getBlockContract("content")');
      expect(source).to.not.contain('context.getCompositionSourceBuffer(');
      expect(source).to.not.contain('findChannel(name)?.finalSnapshot()');
    });

    it('should keep async block/super compilation free of caller scheduling machinery', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');

      const tmpl = new AsyncTemplate(
        '{% extends "base.njk" %}{% block content %}{% set user = "Grace" %}{{ super() }} / {{ user }}{% endblock %}',
        env,
        'block-super-no-caller-scheduling.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('blockPayload = null');
      expect(source).to.contain('blockRenderCtx = undefined');
      expect(source).to.contain('runtime.invokeSuperMethod(inheritanceState, "content"');
      expect(source).to.not.contain('blockContext = null');
      expect(source).to.not.contain('context.getBlockContract(');
      expect(source).to.not.contain('context.getCompositionSourceBuffer(');
      expect(source).to.not.contain('context.getAsyncSuper(');
      expect(source).to.not.contain('context.createSuperInheritancePayload(');
      expect(source).to.not.contain('__caller__');
      expect(source).to.not.contain('__callerUsedChannels');
      expect(source).to.not.contain('CALLER_SCHED_CHANNEL_NAME');
      expect(source).to.not.contain('WaitResolveCommand({ channelName: "__caller__"');
    });

    it('should keep caller scheduling machinery on async macros that use caller()', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate(
        '{% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}{% call wrap("span") %}X{{ value }}Y{% endcall %}',
        env,
        'macro-caller-scheduling.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('__caller__');
      expect(source).to.contain('__callerUsedChannels');
      expect(source).to.contain('WaitResolveCommand({ channelName: "__caller__"');
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

    it('should not link unrelated locals into an imported namespace call boundary', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi() %}Hi{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m %}{% var scopedValue = "A" %}{{ m.hi() }}',
        env,
        'imported-member-boundary-links-only-import.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.runValueBoundary(output, ["m","__text__"]');
      expect(source).to.not.contain('runtime.runValueBoundary(output, ["m","scopedValue","__text__"]');
    });

    it('should not link unrelated locals into a from-import call boundary', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi() %}Hi{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% from "macros.njk" import hi %}{% var scopedValue = "A" %}{{ hi() }}',
        env,
        'from-import-boundary-links-only-import.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.runValueBoundary(output, ["hi","__text__"]');
      expect(source).to.not.contain('runtime.runValueBoundary(output, ["hi","scopedValue","__text__"]');
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
