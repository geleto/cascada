
import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate, Context, Script} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';
import {DEFAULT_TEMPLATE_TEXT_OUTPUT} from '../../src/compiler/buffer.js';
import {parse} from '../../src/parser.js';
import {transform} from '../../src/transformer.js';
import {CompilerAsync} from '../../src/compiler/compiler.js';
import * as nodes from '../../src/nodes.js';
import * as runtime from '../../src/runtime/runtime.js';
import * as inheritanceStateRuntime from '../../src/runtime/inheritance-state.js';
import {transpiler as scriptTranspiler} from '../../src/script/script-transpiler.js';

(function () {
  function createIdPool() {
    return {
      value: 0,
      next() {
        this.value += 1;
        return this.value;
      }
    };
  }

  function analyzeTemplateSource(src, name = 'analysis-test.njk') {
    const opts = {
      asyncMode: true,
      scriptMode: false,
      idPool: createIdPool()
    };
    const compiler = new CompilerAsync(name, opts);
    const ast = transform(parse(src, [], opts), [], name, opts);
    compiler.analysis.run(ast);
    return ast;
  }

  function analyzeScriptSource(src, name = 'analysis-test.casc') {
    const opts = {
      asyncMode: true,
      scriptMode: true,
      idPool: createIdPool()
    };
    const compiler = new CompilerAsync(name, opts);
    const ast = transform(parse(scriptTranspiler.scriptToTemplate(src), [], opts), [], name, opts);
    compiler.analysis.run(ast);
    return ast;
  }

  function collectNodesByType(node, typename, out = []) {
    if (!node) {
      return out;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => collectNodesByType(child, typename, out));
      return out;
    }
    if (!(node instanceof nodes.Node)) {
      return out;
    }
    if (node.typename === typename) {
      out.push(node);
    }
    node.fields.forEach((field) => collectNodesByType(node[field], typename, out));
    return out;
  }

  describe('Async template command buffering parity', function () {
    it('should compile async template output to text commands on text output', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{{ value }}', env);
      const source = tmpl._compileSource();
      expect(source).to.contain(`channelName: "${DEFAULT_TEMPLATE_TEXT_OUTPUT}"`);
      expect(source).to.contain('new runtime.TextCommand');
    });

    it('should declare root template channels after creating the command buffer', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% set x = "a" %}{{ x }}', env, 'declared-lanes.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.createCommandBuffer(context, parentBuffer, null, parentBuffer)');
      expect(source).to.contain('runtime.declareBufferChannel(output, "__text__", "text", context, null)');
      expect(source).to.contain('runtime.declareBufferChannel(output, "x", "var", context, null)');
    });

    it('should declare script root channels after creating the command buffer', function () {
      const env = new AsyncEnvironment();
      const script = new Script('var x = "a"\nreturn x', env, 'declared-lanes.casc');
      const source = script._compileSource();

      expect(source).to.contain('runtime.createCommandBuffer(context, parentBuffer, null, parentBuffer)');
      expect(source).to.contain('runtime.declareBufferChannel(output, "__return__", "var", context, runtime.RETURN_UNSET)');
      expect(source).to.contain('runtime.declareBufferChannel(output, "x", "var", context, null)');
    });

    it('should declare render-boundary text channels after creating the boundary buffer', function () {
      class TestExtension {
        constructor() {
          this.tags = ['test'];
        }

        parse(parser, nodesArg) {
          parser.advanceAfterBlockEnd();
          const content = parser.parseUntilBlocks('endtest');
          const tag = new nodesArg.CallExtension(this, 'run', null, [content]);
          parser.advanceAfterBlockEnd();
          return tag;
        }

        run(context, content) {
          return content();
        }
      }

      const env = new AsyncEnvironment();
      env.addExtension('TestExtension', new TestExtension());
      const tmpl = new AsyncTemplate('{% test %}{{ value }}{% endtest %}', env, 'render-boundary-lanes.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.runRenderBoundary(context, cb, async');
      expect(source).to.contain('runtime.declareBufferChannel(currentBuffer, "__text__", "text", context, null)');
    });

    it('should keep nested capture text outputs out of outer stored channel facts', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}',
        'nested-capture-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');
      const outer = captures[0]._analysis;
      const inner = captures[1]._analysis;

      expect(Array.from(outer.usedChannels || [])).to.eql([outer.textOutput, 'x']);
      expect(Array.from(outer.mutatedChannels || [])).to.eql([outer.textOutput]);
      expect(Array.from(inner.usedChannels || [])).to.eql([inner.textOutput, 'x']);
      expect(Array.from(inner.mutatedChannels || [])).to.eql([inner.textOutput]);
      expect(outer.usedChannels.has(inner.textOutput)).to.be(false);
      expect(outer.mutatedChannels.has(inner.textOutput)).to.be(false);
    });

    it('should preserve parent-owned mutations in stored capture channel facts', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}{% set x = "outer" %}{% set inner %}{{ x }}{% set x = "inner" %}{% endset %}{% endset %}',
        'nested-capture-mutation-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');
      const outer = captures[0]._analysis;
      const inner = captures[1]._analysis;

      expect(Array.from(outer.usedChannels || [])).to.eql(['x']);
      expect(Array.from(outer.mutatedChannels || [])).to.eql(['x']);
      expect(Array.from(inner.usedChannels || [])).to.eql([inner.textOutput, 'x']);
      expect(Array.from(inner.mutatedChannels || [])).to.eql([inner.textOutput, 'x']);
      expect(outer.usedChannels.has(inner.textOutput)).to.be(false);
      expect(outer.mutatedChannels.has(inner.textOutput)).to.be(false);
    });

    it('should derive boundary linked channels from stored facts minus declarations', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}',
        'nested-capture-linked-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');

      expect(Array.from(captures[0]._analysis.linkedChannels || [])).to.eql(['x']);
      expect(Array.from(captures[0]._analysis.linkedMutatedChannels || [])).to.eql([]);
      expect(Array.from(captures[1]._analysis.linkedChannels || [])).to.eql(['x']);
      expect(Array.from(captures[1]._analysis.linkedMutatedChannels || [])).to.eql([]);
    });

    it('should include parent-owned mutations in derived boundary linked channels', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% if flag %}{{ x }}{% set x = "updated" %}{% var local = "local" %}{{ local }}{% endif %}',
        'if-linked-mutation-analysis.njk'
      );
      const ifNode = collectNodesByType(ast, 'If')[0];

      expect(Array.from(ifNode._analysis.linkedChannels || [])).to.eql(['__text__', 'x']);
      expect(Array.from(ifNode._analysis.linkedMutatedChannels || [])).to.eql(['__text__', 'x']);
    });

    it('should mark include, extends, and block nodes as linked child buffers', function () {
      const ast = analyzeTemplateSource(
        '{% extends parentTemplate %}' +
        '{% include includeTemplate %}' +
        '{% block body %}{{ value }}{% endblock %}',
        'linked-child-buffer-surfaces.njk'
      );

      const includeNode = collectNodesByType(ast, 'Include')[0];
      const extendsNode = collectNodesByType(ast, 'Extends')[0];
      const blockNode = collectNodesByType(ast, 'Block')[0];

      expect(includeNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(extendsNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(blockNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(includeNode._analysis.linkedChannels || [])).to.eql(['__text__']);
      expect(Array.from(extendsNode._analysis.linkedChannels || [])).to.eql(['__text__']);
      expect(Array.from(blockNode._analysis.linkedChannels || [])).to.eql(['__text__']);
    });

    it('should derive inline-if boundary links for parent-owned command effects', function () {
      const ast = analyzeScriptSource([
        'data result',
        'var item = result.push("a") if flag else ""',
        'return result.snapshot()'
      ].join('\n'), 'inline-if-linked-analysis.casc');
      const inlineIfNode = collectNodesByType(ast, 'InlineIf')[0];

      expect(inlineIfNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(inlineIfNode._analysis.linkedChannels || [])).to.eql(['result']);
      expect(Array.from(inlineIfNode._analysis.linkedMutatedChannels || [])).to.eql(['result']);
    });

    it('should derive caller invocation links from analysis-owned caller facts', function () {
      const ast = analyzeTemplateSource(
        '{% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}' +
        '{% set x = "v" %}' +
        '{% call wrap("span") %}X{{ x }}Y{% endcall %}',
        'caller-linked-analysis.njk'
      );
      const callerNode = collectNodesByType(ast, 'Caller')[0];

      expect(callerNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(callerNode._analysis.linkedChannels || [])).to.eql(['x']);
      expect(Array.from(callerNode._analysis.declaredChannels.keys())).to.eql(['caller', '__return__', '__text__']);
    });

    it('should keep call-block caller locals out of emitted parent boundary links', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate(
        '{% macro wrap() %}{{ caller() }}{% endmacro %}' +
        '{% call wrap() %}{% do seq!.run() %}{% endcall %}',
        env,
        'caller-parent-link-analysis.njk'
      );
      const source = tmpl._compileSource();

      const outputBoundaryMatches = Array.from(source.matchAll(/runtime\.runControlFlowBoundary\(output, \[([^\]]+)\]/g));
      expect(outputBoundaryMatches.length).to.be.greaterThan(0);
      expect(outputBoundaryMatches.some((match) => match[1].includes('"wrap"'))).to.be(true);
      expect(outputBoundaryMatches.some((match) => match[1].includes('"!seq'))).to.be(true);
      outputBoundaryMatches.forEach((match) => {
        expect(match[1]).to.not.contain('"caller"');
      });
    });

    it('should emit inherited block text placement boundaries without shared callable links', function () {
      const env = new AsyncEnvironment();
      const templateSource = '{% shared var theme %}Base[{% block body %}{{ theme }}{% endblock %}]';
      const ast = analyzeTemplateSource(templateSource, 'block-text-placement-links.njk');
      const blockNode = collectNodesByType(ast, 'Block')[0];
      const tmpl = new AsyncTemplate(templateSource, env, 'block-text-placement-links.njk');
      const source = tmpl._compileSource();

      expect(Array.from(blockNode._analysis.linkedChannels || [])).to.eql(['__text__', 'theme']);
      expect(Array.from(blockNode._analysis.linkedMutatedChannels || [])).to.eql(['__text__']);
      expect(source).to.contain('runtime.runControlFlowBoundary(output, ["__text__"], ["__text__"], context, cb, async (blockBuffer)');
      expect(source).to.not.contain('runtime.runControlFlowBoundary(output, ["__text__","theme"]');
    });

    it('should emit template extends startup without shared callable links', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate(
        '{% shared var theme = "light" %}' +
        '{% extends layout %}' +
        '{% set theme = "dark" %}' +
        '{% block body %}{{ theme }}{% endblock %}',
        env,
        'extends-startup-text-placement-links.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('__rootStartupPromise = runtime.runControlFlowBoundary(output, ["__text__"], ["__text__"], context, cb, async (currentBuffer)');
      expect(source).to.not.contain('__rootStartupPromise = runtime.runControlFlowBoundary(output, ["__text__","theme"]');
    });

    it('should keep loop and include-owned facts local inside captures', function () {
      const ast = analyzeTemplateSource(
        '{% set outer %}' +
        '{% for item in items %}{{ loop.index }}{{ item }}{% endfor %}' +
        '{% include includeTemplate %}' +
        '{% var local = "local" %}{{ local }}' +
        '{% endset %}',
        'capture-loop-include-linked-analysis.njk'
      );
      const captureNode = collectNodesByType(ast, 'Capture')[0];

      expect(Array.from(captureNode._analysis.linkedChannels || [])).to.eql([]);
      expect(captureNode._analysis.usedChannels.has('loop')).to.be(false);
      expect(captureNode._analysis.usedChannels.has('item')).to.be(false);
      expect(captureNode._analysis.usedChannels.has('includeTemplate')).to.be(false);
    });

    it('should emit capture links from analysis-owned linked channels', function () {
      const env = new AsyncEnvironment();
      const templateSource =
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}';
      const tmpl = new AsyncTemplate(
        templateSource,
        env,
        'capture-analysis-linked-emission.njk'
      );
      const ast = analyzeTemplateSource(templateSource, 'capture-analysis-linked-emission.njk');
      const captures = collectNodesByType(ast, 'Capture');
      const outerCapture = captures[0];
      const innerCapture = captures[1];
      const source = tmpl._compileSource();
      const outerBoundaryStart =
        'runtime.runControlFlowBoundary(output, ["x"], null';
      const innerBoundaryStart =
        'runtime.runControlFlowBoundary(currentBuffer, ["x"], null';

      expect(source).to.contain(outerBoundaryStart);
      expect(source).to.contain(innerBoundaryStart);
      expect(source).to.contain(`runtime.declareBufferChannel(currentBuffer, "${outerCapture._analysis.textOutput}", "text", context, null)`);
      expect(source).to.contain('runtime.declareBufferChannel(currentBuffer, "inner", "var", context, null)');
      expect(source).to.contain(`runtime.declareBufferChannel(currentBuffer, "${innerCapture._analysis.textOutput}", "text", context, null)`);
      expect(source).to.not.contain(
        `runtime.runControlFlowBoundary(output, ["x","${innerCapture._analysis.textOutput}"]`
      );
    });

    it('should not mark scope-isolated macro or root nodes as linked child buffers', function () {
      const ast = analyzeTemplateSource(
        '{% macro plain(x) %}{{ x }}{% endmacro %}{{ plain("v") }}',
        'scope-boundary-linked-analysis.njk'
      );
      const macroNode = collectNodesByType(ast, 'Macro')[0];

      expect(ast._analysis.createsLinkedChildBuffer).to.be(false);
      expect(ast._analysis.linkedChannels).to.be(null);
      expect(macroNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(macroNode._analysis.linkedChannels).to.be(null);
    });

    it('should derive short-circuit expression links only when command effects are present', function () {
      const valueOnlyAst = analyzeTemplateSource(
        '{% set x = "a" %}{{ x and "b" }}{{ x or "c" }}{{ "a" if x else "b" }}',
        'value-only-short-circuit-analysis.njk'
      );
      const valueAndNode = collectNodesByType(valueOnlyAst, 'And')[0];
      const valueOrNode = collectNodesByType(valueOnlyAst, 'Or')[0];
      const valueInlineIfNode = collectNodesByType(valueOnlyAst, 'InlineIf')[0];

      expect(valueAndNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueAndNode._analysis.linkedChannels).to.be(null);
      expect(valueAndNode._analysis.linkedMutatedChannels).to.be(null);
      expect(valueOrNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueOrNode._analysis.linkedChannels).to.be(null);
      expect(valueOrNode._analysis.linkedMutatedChannels).to.be(null);
      expect(valueInlineIfNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueInlineIfNode._analysis.linkedChannels).to.be(null);
      expect(valueInlineIfNode._analysis.linkedMutatedChannels).to.be(null);

      const commandEffectAst = analyzeScriptSource([
        'data result',
        'var a = flag and result.push("a")',
        'var b = flag or result.push("b")',
        'return result.snapshot()'
      ].join('\n'), 'effectful-short-circuit-analysis.casc');
      const commandAndNode = collectNodesByType(commandEffectAst, 'And')[0];
      const commandOrNode = collectNodesByType(commandEffectAst, 'Or')[0];

      expect(commandAndNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(commandAndNode._analysis.linkedChannels || [])).to.eql(['result']);
      expect(Array.from(commandAndNode._analysis.linkedMutatedChannels || [])).to.eql(['result']);
      expect(commandOrNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(commandOrNode._analysis.linkedChannels || [])).to.eql(['result']);
      expect(Array.from(commandOrNode._analysis.linkedMutatedChannels || [])).to.eql(['result']);
    });

    it('should not emit caller scheduling machinery for macros without caller()', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% macro plain(x) %}{{ x }}{% endmacro %}{{ plain("v") }}', env);
      const source = tmpl._compileSource();
      expect(source).to.not.contain('__caller__');
      expect(source).to.not.contain('__callerLinkedChannels');
      expect(source).to.not.contain('__callerDeclaredChannels');
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

    it('should read post-extends shared mutations from invocation-time block links', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', '{% shared var theme %}Base[{% block body %}{{ theme }}{% endblock %}]');
      loader.addTemplate(
        'child.njk',
        '{% shared var theme = "light" %}{% extends "base.njk" %}{% set theme = "dark" %}{% block body %}{{ theme }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('Base[dark]');
    });

    it('should keep inherited text placement boundaries out of shared invocation lanes', async function () {
      const createRootBuffer = () => {
        const rootBuffer = runtime.createCommandBuffer(null);
        runtime.declareBufferChannel(rootBuffer, '__text__', 'text', null, null);
        runtime.declareBufferChannel(rootBuffer, 'theme', 'var', null, null);
        rootBuffer.addCommand(new runtime.VarCommand({
          channelName: 'theme',
          args: ['dark'],
          pos: { lineno: 1, colno: 1 }
        }), 'theme');
        return rootBuffer;
      };

      const blockedRoot = createRootBuffer();
      // This sibling buffer represents the incorrect text-placement boundary
      // shape: linking it into the shared lane creates an earlier source-order
      // slot that the invocation snapshot must wait behind.
      const sharedLaneSibling = runtime.createCommandBuffer(null, null, ['theme'], blockedRoot);
      const invocationBuffer = runtime.createCommandBuffer(null, null, ['theme'], blockedRoot);
      const blockedRead = invocationBuffer.addCommand(new runtime.SnapshotCommand({
        channelName: 'theme',
        pos: { lineno: 1, colno: 1 }
      }), 'theme');
      let blockedReadSettled = false;
      blockedRead.then(() => {
        blockedReadSettled = true;
      });

      await Promise.resolve();
      expect(blockedReadSettled).to.be(false);
      sharedLaneSibling.finish();
      invocationBuffer.finish();
      blockedRoot.finish();
      expect(await blockedRead).to.be('dark');

      const textRoot = createRootBuffer();
      const textPlacementBoundary = runtime.createCommandBuffer(null, null, ['__text__'], textRoot);
      const admittedInvocation = runtime.createCommandBuffer(null, null, ['theme'], textRoot);
      const admittedRead = admittedInvocation.addCommand(new runtime.SnapshotCommand({
        channelName: 'theme',
        pos: { lineno: 1, colno: 1 }
      }), 'theme');

      expect(await admittedRead).to.be('dark');
      textPlacementBoundary.finish();
      admittedInvocation.finish();
      textRoot.finish();
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

      expect(source).to.contain('function b_content(');
      expect(source).to.contain('blockPayload = null');
      expect(source).to.contain('methodData) {');
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

      expect(source).to.contain('function b_content(');
      expect(source).to.contain('blockPayload = null');
      expect(source).to.contain('methodData) {');
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
      expect(source).to.not.contain('__callerLinkedChannels');
      expect(source).to.not.contain('__callerDeclaredChannels');
      expect(source).to.not.contain('CALLER_SCHED_CHANNEL_NAME');
      expect(source).to.not.contain('WaitResolveCommand({ channelName: "__caller__"');
    });

    it('should keep caller scheduling machinery on async macros that use caller()', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate(
        '{% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}{% set x = "v" %}{% call wrap("span") %}X{{ x }}Y{% endcall %}',
        env,
        'macro-caller-scheduling.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('__caller__');
      expect(source).to.contain('__callerLinkedChannels');
      expect(source).to.contain('__callerLinkedChannels = ["x"];');
      expect(source).to.contain('.__callerLinkedChannels || null, null, ');
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
