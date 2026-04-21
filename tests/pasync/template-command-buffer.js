(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var AsyncTemplate;
  var Context;
  var StringLoader;
  var DEFAULT_TEMPLATE_TEXT_OUTPUT;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    const envModule = require('../../src/environment/environment');
    AsyncEnvironment = envModule.AsyncEnvironment;
    AsyncTemplate = envModule.AsyncTemplate;
    Context = envModule.Context;
    StringLoader = require('../util').StringLoader;
    DEFAULT_TEMPLATE_TEXT_OUTPUT = require('../../src/compiler/buffer').DEFAULT_TEMPLATE_TEXT_OUTPUT;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    AsyncTemplate = nunjucks.AsyncTemplate;
    Context = nunjucks.Context;
    StringLoader = window.util.StringLoader;
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
      loader.addTemplate('part.njk', '{% extern value %}<i>{{ value }}</i>');
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
      loader.addTemplate('child.njk', '{% extern scopedValue %}[{{ scopedValue }}]');

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
      loader.addTemplate('macros.njk', '{% extern theme %}{% macro hi() %}{{ theme }}{{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m with context, theme %}{{ m.hi() }}',
        env,
        'import-with-context-and-vars.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('context.getRenderContextVariables()');
      expect(source).to.contain('runtime.validateExternInputs(');
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

    it('should initialize root externs in declaration order without redundant required-value context writes', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% extern user %}{% extern theme = "light" %}{{ user }}{{ theme }}', env, 'root-extern-init.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.declareBufferChannel(output, "user", "var", context, null);');
      expect(source).to.contain('runtime.declareBufferChannel(output, "theme", "var", context, null);');
      expect(source).to.not.contain('context.setVariable("user"');
      expect(source).to.contain('context.setVariable("theme"');
    });

    it('should resolve deferred exports without emitting visibility-link compatibility calls', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate('{% import "macros.njk" as m %}{{ m.hi("x") }}', env, 'deferred-export-producer-records.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('context.addDeferredExport("m", "m", output);');
      expect(source).to.contain('context.resolveExports();');
      expect(source).to.not.contain('context.linkDeferredExportsToBuffer(');
      expect(source).to.not.contain('linkVisibleChannel(');
    });

    it('should guard template deferred export resolution when rendering in component mode', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate('{% import "macros.njk" as m %}{{ m.hi("x") }}', env, 'component-mode-export-guard.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('if (!(inheritanceState && inheritanceState.componentCompositionMode === runtime.COMPONENT_COMPOSITION_MODE)) {');
      expect(source).to.contain('  context.resolveExports();');
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

      expect(source).to.contain('function b_content(env, context, runtime, cb, parentBuffer = null, blockPayload = null, blockRenderCtx = undefined, inheritanceState = null) {');
      expect(source).to.contain('runtime.invokeInheritedMethod(inheritanceState, "content"');
      expect(source).to.contain('blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {}');
      expect(source).to.not.contain('blockPayload && blockPayload.localsByTemplate');
      expect(source).to.contain('context.forkForComposition("block-input-vars.njk"');
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

      expect(source).to.contain('function b_content(env, context, runtime, cb, parentBuffer = null, blockPayload = null, blockRenderCtx = undefined, inheritanceState = null) {');
      expect(source).to.contain('context.forkForComposition("child-inherited-block-inputs.njk"');
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

    it('should keep imported member calls on the imported-callable boundary', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate('{% import "macros.njk" as m %}{{ m.hi("x") }}', env, 'imported-member-boundary.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.memberLookupAsync((runtime.channelLookup("m", currentBuffer))');
      expect(source).to.contain('runtime.callWrapAsync(');
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

    it('should not treat a macro parameter shadowing a from-import binding as imported callable', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro foo(name) %}Foo {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% from "macros.njk" import foo %}{% macro use(foo) %}{{ foo("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-from-import-call.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.match(/runtime\.channelLookup\("foo", t_\d+\)/);
      expect(source).to.not.contain('currentBuffer.addSnapshot("foo"');
    });

    it('should not treat a macro parameter shadowing an imported namespace as imported callable', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m %}{% macro use(m) %}{{ m("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-import-namespace-call.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.match(/runtime\.channelLookup\("m", t_\d+\)/);
      expect(source).to.not.contain('currentBuffer.addSnapshot("m"');
    });

  });
}());
