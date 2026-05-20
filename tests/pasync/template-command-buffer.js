
import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';
import {parse} from '../../src/language/parser.js';
import {transform} from '../../src/language/transformer.js';
import {CompilerAsync} from '../../src/compiler/compiler.js';
import * as nodes from '../../src/language/nodes.js';
import * as runtime from '../../src/runtime/runtime.js';
import {transpiler as scriptTranspiler} from '../../src/language/script-transpiler.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null];

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
    it('should infer this.__text__ as the template text chain', function () {
      const ast = analyzeTemplateSource('{% block body %}{{ this.__text__.snapshot() }}{{ this.theme }}{% endblock %}');
      const inferred = ast._analysis.inheritanceSharedDeclarations;
      const rootTextDeclares = ast._analysis.declares.filter((declaration) => declaration.name === '__text__' && !declaration.shared);

      expect(inferred.map((declaration) => [declaration.name, declaration.type])).to.eql([
        ['__text__', 'text'],
        ['$theme', 'var']
      ]);
      expect(rootTextDeclares).to.have.length(1);
      expect(rootTextDeclares[0].type).to.be('text');
      expect(rootTextDeclares[0].shared).to.not.be(true);
    });

    it('should keep nested capture text outputs out of outer stored chain facts', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}',
        'nested-capture-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');
      const outer = captures[0]._analysis;
      const inner = captures[1]._analysis;

      expect(Array.from(outer.usedChains || [])).to.eql([outer.textOutput, 'x']);
      expect(Array.from(outer.mutatedChains || [])).to.eql([outer.textOutput]);
      expect(Array.from(inner.usedChains || [])).to.eql([inner.textOutput, 'x']);
      expect(Array.from(inner.mutatedChains || [])).to.eql([inner.textOutput]);
      expect(outer.usedChains.has(inner.textOutput)).to.be(false);
      expect(outer.mutatedChains.has(inner.textOutput)).to.be(false);
    });

    it('should preserve parent-owned mutations in stored capture chain facts', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}{% set x = "outer" %}{% set inner %}{{ x }}{% set x = "inner" %}{% endset %}{% endset %}',
        'nested-capture-mutation-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');
      const outer = captures[0]._analysis;
      const inner = captures[1]._analysis;

      expect(Array.from(outer.usedChains || [])).to.eql(['x']);
      expect(Array.from(outer.mutatedChains || [])).to.eql(['x']);
      expect(Array.from(inner.usedChains || [])).to.eql([inner.textOutput, 'x']);
      expect(Array.from(inner.mutatedChains || [])).to.eql([inner.textOutput, 'x']);
      expect(outer.usedChains.has(inner.textOutput)).to.be(false);
      expect(outer.mutatedChains.has(inner.textOutput)).to.be(false);
    });

    it('should derive boundary linked chains from stored facts minus declarations', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}',
        'nested-capture-linked-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');

      expect(Array.from(captures[0]._analysis.linkedChains || [])).to.eql(['x']);
      expect(Array.from(captures[0]._analysis.linkedMutatedChains || [])).to.eql([]);
      expect(Array.from(captures[1]._analysis.linkedChains || [])).to.eql(['x']);
      expect(Array.from(captures[1]._analysis.linkedMutatedChains || [])).to.eql([]);
    });

    it('should include parent-owned mutations in derived boundary linked chains', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% if flag %}{{ x }}{% set x = "updated" %}{% var local = "local" %}{{ local }}{% endif %}',
        'if-linked-mutation-analysis.njk'
      );
      const ifNode = collectNodesByType(ast, 'If')[0];

      expect(Array.from(ifNode._analysis.linkedChains || [])).to.eql(['__text__', 'x']);
      expect(Array.from(ifNode._analysis.linkedMutatedChains || [])).to.eql(['__text__', 'x']);
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
      expect(Array.from(includeNode._analysis.linkedChains || [])).to.eql(['__text__']);
      expect(Array.from(extendsNode._analysis.linkedChains || [])).to.eql(['__text__']);
      expect(Array.from(blockNode._analysis.linkedChains || [])).to.eql([]);
    });

    it('should derive inline-if boundary links for parent-owned command effects', function () {
      const ast = analyzeScriptSource([
        'data result',
        'var item = result.push("a") if flag else ""',
        'return result.snapshot()'
      ].join('\n'), 'inline-if-linked-analysis.casc');
      const inlineIfNode = collectNodesByType(ast, 'InlineIf')[0];

      expect(inlineIfNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(inlineIfNode._analysis.linkedChains || [])).to.eql(['result']);
      expect(Array.from(inlineIfNode._analysis.linkedMutatedChains || [])).to.eql(['result']);
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
      expect(Array.from(callerNode._analysis.linkedChains || [])).to.eql(['x']);
      expect(Array.from(callerNode._analysis.declaredChains.keys())).to.eql(['caller', '__return__', '__text__']);
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

      expect(Array.from(captureNode._analysis.linkedChains || [])).to.eql([]);
      expect(captureNode._analysis.usedChains.has('loop')).to.be(false);
      expect(captureNode._analysis.usedChains.has('item')).to.be(false);
      expect(captureNode._analysis.usedChains.has('includeTemplate')).to.be(false);
    });

    it('should not mark scope-isolated macro or root nodes as linked child buffers', function () {
      const ast = analyzeTemplateSource(
        '{% macro plain(x) %}{{ x }}{% endmacro %}{{ plain("v") }}',
        'scope-boundary-linked-analysis.njk'
      );
      const macroNode = collectNodesByType(ast, 'Macro')[0];

      expect(ast._analysis.createsLinkedChildBuffer).to.be(false);
      expect(ast._analysis.linkedChains).to.be(null);
      expect(macroNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(macroNode._analysis.linkedChains).to.be(null);
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
      expect(valueAndNode._analysis.linkedChains).to.be(null);
      expect(valueAndNode._analysis.linkedMutatedChains).to.be(null);
      expect(valueOrNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueOrNode._analysis.linkedChains).to.be(null);
      expect(valueOrNode._analysis.linkedMutatedChains).to.be(null);
      expect(valueInlineIfNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueInlineIfNode._analysis.linkedChains).to.be(null);
      expect(valueInlineIfNode._analysis.linkedMutatedChains).to.be(null);

      const commandEffectAst = analyzeScriptSource([
        'data result',
        'var a = flag and result.push("a")',
        'var b = flag or result.push("b")',
        'return result.snapshot()'
      ].join('\n'), 'effectful-short-circuit-analysis.casc');
      const commandAndNode = collectNodesByType(commandEffectAst, 'And')[0];
      const commandOrNode = collectNodesByType(commandEffectAst, 'Or')[0];

      expect(commandAndNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(commandAndNode._analysis.linkedChains || [])).to.eql(['result']);
      expect(Array.from(commandAndNode._analysis.linkedMutatedChains || [])).to.eql(['result']);
      expect(commandOrNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(commandOrNode._analysis.linkedChains || [])).to.eql(['result']);
      expect(Array.from(commandOrNode._analysis.linkedMutatedChains || [])).to.eql(['result']);
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

    it('should keep inherited text placement boundaries out of shared invocation lanes', async function () {
      const createRootBuffer = () => {
        const rootBuffer = new runtime.CommandBuffer(null);
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
      // This sibling buffer represents the incorrect text-placement boundary
      // shape: linking it into the shared lane creates an earlier source-order
      // slot that the invocation snapshot must wait behind.
      const sharedLaneSibling = new runtime.CommandBuffer(null, null, ['theme'], blockedRoot);
      const invocationBuffer = new runtime.CommandBuffer(null, null, ['theme'], blockedRoot);
      const blockedRead = invocationBuffer.addCommand(new runtime.SnapshotCommand({
        chainName: 'theme',
        errorContext: TEST_EC
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
      const textPlacementBoundary = new runtime.CommandBuffer(null, null, ['__text__'], textRoot);
      const admittedInvocation = new runtime.CommandBuffer(null, null, ['theme'], textRoot);
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
