import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate, Script} from '../../src/environment/environment.js';
import {parse} from '../../src/language/parser.js';
import * as nodes from '../../src/language/nodes.js';
import {transform} from '../../src/language/transformer.js';
import {CompilerAsync} from '../../src/compiler/compiler.js';
import {transpiler as scriptTranspiler} from '../../src/language/script-transpiler.js';
import * as runtime from '../../src/runtime/runtime.js';
import {StringLoader} from '../util.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const TEST_REPORT_ERROR = () => {};

function createTestRenderState(reportError = TEST_REPORT_ERROR) {
  return runtime.createRenderState(reportError);
}

function createIdPool() {
  return {
    value: 0,
    next() {
      this.value += 1;
      return this.value;
    }
  };
}

function analyzeProgram(src, { scriptMode = false, name = scriptMode ? 'analysis.casc' : 'analysis.njk' } = {}) {
  const opts = {
    asyncMode: true,
    scriptMode,
    idPool: createIdPool()
  };
  const compiler = new CompilerAsync(name, opts);
  const templateSource = scriptMode ? scriptTranspiler.scriptToTemplate(src) : src;
  const ast = transform(parse(templateSource, [], opts), [], name, opts);
  // analysis.run invokes analyze and postAnalyze hooks, including postAnalyzeRoot.
  compiler.analysis.run(ast);
  return { ast, compiler, facts: ast._analysis.inheritance };
}

function analyzeSource(src, options = {}) {
  return analyzeProgram(src, options).facts;
}

function analyzeCallableEntries(src, options = {}) {
  const { ast } = analyzeProgram(src, options);
  return (ast._analysis.inheritanceCallableDefinitions ?? []).map((callableNode) => ({
    name: callableNode.name.value,
    signature: { argNames: callableNode._analysis.callableSignatureFacts.argNames }
  }));
}

function analyzeSharedSchemaInputs(src, options = {}) {
  const { ast } = analyzeProgram(src, options);
  return (ast._analysis.inheritanceSharedDeclarations ?? []).map((declaration) => ({
    name: declaration.name,
    type: declaration.type,
    hasDefault: !!declaration.initializer
  }));
}

function compileSource(src, { scriptMode = false, name = scriptMode ? 'compiled.casc' : 'compiled.njk' } = {}) {
  return scriptMode
    ? new Script(src, null, name).compileSource()
    : new AsyncTemplate(src, null, name).compileSource();
}

function compileProps(src, options = {}) {
  const source = compileSource(src, options);
  return new Function('runtime', source)(runtime);
}

function compactTestErrorContext(errorContext) {
  if (!errorContext) {
    return null;
  }
  if (Array.isArray(errorContext)) {
    return errorContext;
  }
  return [
    errorContext.lineno ?? 0,
    errorContext.colno ?? 0,
    errorContext.label ?? null,
    errorContext.path ?? null,
    errorContext.addedContext ?? null,
    errorContext.renderState ?? null
  ];
}

function testErrorContextPath(errorContext) {
  return errorContext[3];
}

function sharedSchemaEntry(type, options = {}) {
  return {
    type,
    __testErrorContext: compactTestErrorContext(
      options.errorContext || { path: `${type}-shared.owner`, lineno: 1, colno: 1 }
    ),
    hasDefault: !!options.hasDefault
  };
}

describe('Inheritance rebuild', function () {
  let env;

  beforeEach(function () {
    env = new AsyncEnvironment();
  });

  describe('parser and transpiler surface', function () {
    it('accepts script extends none as a parentless inheritance participant', async function () {
      const props = compileProps('extends none\nreturn "ok"', {
        scriptMode: true,
        name: 'script-none.script'
      });
      const parent = await props.resolveInheritanceParent.call({ path: 'script-none.script' }, null, null, runtime, null, null);

      expect(Object.keys(props).sort()).to.eql(['getErrorContexts', 'inheritanceSpec', 'resolveInheritanceParent', 'root']);
      expect(parent).to.eql({ parentTemplateOrScript: null, errorContext: null });
    });

    it('rejects template extends none through the public template compiler', function () {
      expect(function () {
        new AsyncTemplate('{% extends none %}{% block body %}x{% endblock %}', env, 'template-none.njk').compile();
      }).to.throwException(/templates do not support extends none/);
    });

    it('rejects script extends after constructor statements', function () {
      expect(function () {
        new Script('var theme = "dark"\nextends none\nreturn theme', env, 'script-order.script').compileSource();
      }).to.throwException(/only shared declarations may appear before script extends/);
    });

    it('allows whitespace, comments, and shared declarations before script extends', function () {
      expect(function () {
        new Script('\n// parentless component\nshared var theme = "dark"\nextends none\nreturn this.theme', env, 'script-pre-extends.script').compileSource();
      }).not.to.throwException();
    });
  });

  describe('compiled ABI shape', function () {
    const removedStartupFragments = [
      'b___setup__',
      'runCompiledRootStartup',
      '__rootStartupPromise',
      'compositionMode',
      'componentMode',
      'extendsState'
    ];

    it('keeps ordinary templates and scripts on the plain compiled shape', function () {
      [
        compileSource('Hello {{ name }}'),
        compileSource('return "ok"', { scriptMode: true })
      ].forEach((source) => {
        const props = new Function('runtime', source)({});

        expect(Object.keys(props).sort()).to.eql(['root']);
        expect(source).not.to.contain('inheritanceSpec');
        expect(source).not.to.contain('resolveInheritanceParent');
        expect(source).not.to.contain('__constructor__');
        expect(source).not.to.contain('inheritanceState');
        removedStartupFragments.forEach((fragment) => {
          expect(source).not.to.contain(fragment);
        });
      });
    });

    it('emits the exact participant ABI shape', function () {
      const props = compileProps('method build()\n  return 1\nendmethod\nreturn this.build()', {
        scriptMode: true,
        name: 'shape.script'
      });

      expect(Object.keys(props).sort()).to.eql(['getErrorContexts', 'inheritanceSpec', 'resolveInheritanceParent', 'root']);
      expect(Object.keys(props.inheritanceSpec).sort()).to.eql(['hasExtends', 'methodEntries', 'sharedSchema']);
      expect(props.inheritanceSpec.setup).to.be(undefined);
      expect(props.inheritanceSpec.inheritedMethodDependencies).to.be(undefined);
      expect(props.resolveInheritanceParent.length).to.be(5);
      expect(props.inheritanceSpec.methodEntries.build.errorContextIndex).to.be.a('number');
    });

    it('emits participant ABI for every participation reason', function () {
      [
        ['{% extends "base.njk" %}{% block body %}x{% endblock %}', {}],
        ['{% extends parentTemplate %}{% block body %}x{% endblock %}', {}],
        ['{% block body %}x{% endblock %}', {}],
        ['{{ this.theme }}', {}],
        ['shared var theme\nreturn this.theme', { scriptMode: true }],
        ['method body()\n  return "x"\nendmethod\nreturn this.body()', { scriptMode: true }],
        ['return this.body()', { scriptMode: true }],
        ['method body()\n  return super()\nendmethod\nreturn this.body()', { scriptMode: true }]
      ].forEach(([source, options]) => {
        const props = compileProps(source, options);
        expect(Object.keys(props).sort()).to.eql(['getErrorContexts', 'inheritanceSpec', 'resolveInheritanceParent', 'root']);
      });
    });

    it('emits structured shared schema entries with explicit defaults', function () {
      const props = compileProps('shared var theme = none\nextends none\nreturn this.theme', {
        scriptMode: true,
        name: 'shared-default.script'
      });

      expect(props.inheritanceSpec.sharedSchema.$theme.type).to.be('var');
      expect(props.inheritanceSpec.sharedSchema.$theme.hasDefault).to.be(true);
      expect(props.inheritanceSpec.sharedSchema.$theme.errorContextIndex).to.be.a('number');
    });

    it('emits structured shared schema entries without defaults', function () {
      const props = compileProps('shared var theme\nextends none\nreturn this.theme', {
        scriptMode: true,
        name: 'shared-no-default.script'
      });

      expect(props.inheritanceSpec.sharedSchema.$theme.type).to.be('var');
      expect(props.inheritanceSpec.sharedSchema.$theme.hasDefault).to.be(false);
      expect(props.inheritanceSpec.sharedSchema.$theme.errorContextIndex).to.be.a('number');
    });

    it('emits no removed setup/startup constructs for participants', function () {
      const source = compileSource('{% extends parentTemplate %}{% block body %}x{% endblock %}');

      removedStartupFragments.forEach((fragment) => {
        expect(source).not.to.contain(fragment);
      });
      expect(source).to.contain('async function resolveInheritanceParent(env, context, runtime, errorContext, renderState)');
      expect(source).to.contain('function root(env, context, runtime, renderState)');
    });

    it('emits clean finalized invocation calls for this and super', function () {
      const source = compileSource(
        'method build(user)\n  this.decorate(user)\n  return super()\nendmethod\nreturn this.build(profile)',
        { scriptMode: true, name: 'invoke-source.script' }
      );

      expect(source).to.contain('currentInstance.invokeFromCurrentBuffer("decorate"');
      expect(source).to.contain('currentInstance.invokeSuper(methodData, []');
      expect(source).not.to.contain('blockPayload ? blockPayload.originalArgs : null');
      expect(source).not.to.contain('runtime.invokeSuperCallable');
    });

    it('resolves implicit template constructor super before finishing text', function () {
      const source = compileSource('{% extends "base.njk" %}child text{% block body %}x{% endblock %}');

      expect(source).to.contain('runtime.resolveThen(currentInstance.invokeSuper(methodData, []');
      expect(source).not.to.contain('Promise.resolve(currentInstance.invokeSuper');
    });

    it('emits constructor entries only for concrete constructor bodies', function () {
      const concreteScript = compileProps('extends none\nreturn "ok"', { scriptMode: true });
      const concreteTemplate = compileProps('{% block body %}x{% endblock %}');
      const extendingTemplateWithText = compileProps('{% extends "base.njk" %}child text{% block body %}x{% endblock %}');
      const declarationOnlyTemplate = compileProps('{% extends "base.njk" %}{% block body %}x{% endblock %}');

      expect(concreteScript.inheritanceSpec.methodEntries.__constructor__.isConstructor).to.be(true);
      expect(concreteTemplate.inheritanceSpec.methodEntries.__constructor__.isConstructor).to.be(true);
      expect(extendingTemplateWithText.inheritanceSpec.methodEntries.__constructor__.isConstructor).to.be(true);
      expect(extendingTemplateWithText.inheritanceSpec.methodEntries.__constructor__.errorContextIndex).to.be.a('number');
      expect(declarationOnlyTemplate.inheritanceSpec.methodEntries.__constructor__).to.be(undefined);
    });

    it('returns data-only parent selection from a no-extends resolver', async function () {
      const props = compileProps('method build()\n  return 1\nendmethod\nreturn this.build()', {
        scriptMode: true
      });

      expect(await props.resolveInheritanceParent.call({ path: 'compiled.casc' }, null, null, runtime, null, null)).to.eql({
        parentTemplateOrScript: null,
        errorContext: null
      });
    });

    it('uses runtime callback promisification for async extension tags', function () {
      class AsyncTagExtension {
        constructor() {
          this.tags = ['atag'];
        }

        parse(parserInstance) {
          const token = parserInstance.nextToken();
          parserInstance.advanceAfterBlockEnd(token.value);
          return new nodes.CallExtensionAsync(this, 'run');
        }
      }

      const extensionEnv = new AsyncEnvironment();
      extensionEnv.addExtension('AsyncTagExtension', new AsyncTagExtension());
      const source = new AsyncTemplate('{% atag %}', extensionEnv, 'async-tag.njk').compileSource();

      expect(source).to.contain('runtime.invokeCallbackExtension');
      expect(source).not.to.contain('function b___promisify');
    });
  });

  describe('direct render lifecycle', function () {
    function createEnvironment(templates) {
      const loader = new StringLoader();
      Object.entries(templates).forEach(([name, source]) => loader.addTemplate(name, source));
      return new AsyncEnvironment(loader);
    }

    it('emits participant roots as thin instance lifecycle orchestration', function () {
      const source = compileSource('extends none\nreturn "ok"', {
        scriptMode: true,
        name: 'direct-root.script'
      });

      expect(source).to.contain('runtime.renderInheritanceParticipantRoot');
      expect(source).to.contain('entryTemplateOrScript: this');
      expect(source).to.contain('errorContext: __ec[0]');
      expect(source).not.to.contain('runtime.loadInheritanceChain');
      expect(source).not.to.contain('runtime.finalizeInheritanceChain');
      expect(source).not.to.contain('currentInstance.invoke("__constructor__"');
      expect(source).not.to.contain('currentInstance.finishRender(entryResult)');
      expect(source).not.to.contain(';(async () =>');
      expect(source).not.to.contain('rootFunction');
      expect(source).not.to.contain('props.root');
      expect(source).not.to.contain('inheritanceState');
    });

    it('renders standalone participant templates through the constructor lifecycle', async function () {
      const result = await env.renderTemplateString('{% block body %}Hi{% endblock %}');

      expect(result).to.be('Hi');
    });

    it('keeps standalone template block signatures on render-context values rather than placement locals', async function () {
      const result = await env.renderTemplateString(
        '{% set user = "Local" %}{% block implicit %}{{ user or "missing" }}{% endblock %}|{% block explicit(user) %}{{ user }}{% endblock %}',
        { user: 'Context' }
      );

      expect(result).to.be('Context|Context');
    });

    it('passes multiple standalone template block render-context arguments by signature order', async function () {
      const result = await env.renderTemplateString(
        '{% block name(first, second) %}{{ second }}, {{ first }}{% endblock %}',
        { first: 'Ada', second: 'Lovelace' }
      );

      expect(result).to.be('Lovelace, Ada');
    });

    it('renders inherited templates through the selected constructor chain', async function () {
      const localEnv = createEnvironment({
        'base.njk': 'Base:{% block body(user = "guest") %}{{ user }}{% endblock %}',
        'child.njk': '{% extends "base.njk" %}{% block body(user = "guest") %}Child {{ user }}{% endblock %}'
      });

      expect(await localEnv.renderTemplate('child.njk', {})).to.be('Base:Child guest');
    });

    it('keeps template block overriding and super chained through constructors', async function () {
      const localEnv = createEnvironment({
        'grand.njk': 'Grand[{% block body %}grand{% endblock %}]',
        'parent.njk': '{% extends "grand.njk" %}{% block body %}parent>{{ super() }}{% endblock %}',
        'child.njk': '{% extends "parent.njk" %}{% block body %}child>{{ super() }}{% endblock %}'
      });

      expect(await localEnv.renderTemplate('child.njk', {})).to.be('Grand[child>parent>grand]');
    });

    it('passes parent block arguments into overriding template blocks', async function () {
      const localEnv = createEnvironment({
        'base.njk': 'Base[{% block body(user) %}{{ user }}{% endblock %}]',
        'child.njk': '{% extends "base.njk" %}{% block body(user) %}{{ user }}{% endblock %}'
      });

      expect(await localEnv.renderTemplate('child.njk', { user: 'Ada' })).to.be('Base[Ada]');
    });

    it('passes explicit template super arguments to the parent block', async function () {
      const localEnv = createEnvironment({
        'base.njk': 'Base[{% block body(user) %}{{ user }}{% endblock %}]',
        'child.njk': '{% extends "base.njk" %}{% block body(user) %}{{ user }}>{{ super("Grace") }}{% endblock %}'
      });

      expect(await localEnv.renderTemplate('child.njk', { user: 'Ada' })).to.be('Base[Ada>Grace]');
    });

    it('rejects template super calls with too many arguments through public render', async function () {
      const localEnv = createEnvironment({
        'base.njk': 'Base[{% block body(user) %}{{ user }}{% endblock %}]',
        'child.njk': '{% extends "base.njk" %}{% block body(user) %}{{ super("Ada", "Lovelace") }}{% endblock %}'
      });

      try {
        await localEnv.renderTemplate('child.njk', {});
        expect().fail('Expected template super arity rejection');
      } catch (error) {
        expect(String(error)).to.contain('super(...) for block "body" received too many arguments');
      }
    });

    it('rejects template super calls without a parent implementation through public render', async function () {
      try {
        await env.renderTemplateString('{% block body %}{{ super() }}{% endblock %}');
        expect().fail('Expected missing template super parent rejection');
      } catch (error) {
        expect(String(error)).to.contain('super() in \'body\' has no parent implementation');
      }
    });

    it('exports macros from a template that also extends', async function () {
      const localEnv = createEnvironment({
        'base.njk': 'Base[{% block body %}base{% endblock %}]',
        'child.njk': '{% extends "base.njk" %}{% macro show(name) %}{{ name }}{% endmacro %}{% block body %}child{% endblock %}',
        'main.njk': '{% import "child.njk" as child %}{{ child.show("Ada") }}'
      });

      expect(await localEnv.renderTemplate('main.njk', {})).to.be('Ada');
    });

    it('writes and reads inferred template shared vars in constructor bodies', async function () {
      const result = await env.renderTemplateString('{% set this.theme = "dark" %}{{ this.theme }}');

      expect(result).to.be('dark');
    });

    it('lets parent template constructor writes overwrite child shared writes after implicit super', async function () {
      const localEnv = createEnvironment({
        'base.njk': '{% set this.theme = "parent" %}Base:{{ this.theme }}{% block body %}{{ this.theme }}{% endblock %}',
        'child.njk': '{% extends "base.njk" %}{% set this.theme = "child" %}{% block body %}Child:{{ this.theme }}{% endblock %}'
      });

      expect(await localEnv.renderTemplate('child.njk', {})).to.be('Base:parentChild:parent');
    });

    it('returns direct script constructor results through public render', async function () {
      const localEnv = createEnvironment({
        'base.script': 'extends none\nreturn "base"',
        'child.script': 'extends "base.script"\nreturn super() + ":child"'
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('base:child');
    });

    it('runs every explicit constructor super call through public render', async function () {
      const localEnv = createEnvironment({
        'base.script': 'shared text trace\nextends none\nthis.trace("base|")',
        'child.script': 'shared text trace\nextends "base.script"\nsuper()\nsuper()\nreturn this.trace.snapshot()'
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('base|base|');
    });

    it('rejects constructor super arguments through public render', async function () {
      const localEnv = createEnvironment({
        'base.script': 'extends none\nreturn "base"',
        'child.script': 'extends "base.script"\nsuper("unused")\nreturn "child"'
      });

      try {
        await localEnv.renderScript('child.script', {});
        expect().fail('Expected constructor super arity rejection');
      } catch (error) {
        expect(String(error)).to.contain('super(...) for method "__constructor__" received too many arguments');
      }
    });

    it('resolves script super through each inherited method implementation', async function () {
      const localEnv = createEnvironment({
        'base.script': 'method build(name)\n  return "base(" + name + ")"\nendmethod',
        'middle.script': 'extends "base.script"\nmethod build(name)\n  return "middle>" + super(name)\nendmethod',
        'child.script': 'extends "middle.script"\nmethod build(name)\n  return "child>" + super(name)\nendmethod\nreturn this.build("Ada")'
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('child>middle>base(Ada)');
    });

    it('keeps inherited method shared-chain writes ordered at the call site', async function () {
      const localEnv = createEnvironment({
        'base.script': 'shared text trace\nmethod build(name)\n  this.trace("method|" + name + "|")\n  return "done:" + name\nendmethod',
        'child.script': 'shared text trace\nextends "base.script"\nthis.trace("before|")\nvar result = this.build("Ada")\nthis.trace("after|")\nthis.trace(result)\nreturn this.trace.snapshot()'
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('before|method|Ada|after|done:Ada');
    });

    it('returns null from an inherited script method without an explicit return', async function () {
      const localEnv = createEnvironment({
        'base.script': [
          'shared text trace',
          'method mark()',
          '  this.trace("marked|")',
          'endmethod'
        ].join('\n'),
        'child.script': [
          'shared text trace',
          'extends "base.script"',
          'var result = this.mark()',
          'this.trace("after:" ~ result ~ "|")',
          'return this.trace.snapshot()'
        ].join('\n')
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('marked|after:null|');
    });

    it('orders transitive inherited method shared-chain dependencies', async function () {
      const localEnv = createEnvironment({
        'base.script': [
          'shared text trace',
          'method touch()',
          '  this.trace("touch|")',
          'endmethod'
        ].join('\n'),
        'middle.script': [
          'shared text trace',
          'extends "base.script"',
          'method outer()',
          '  this.touch()',
          'endmethod'
        ].join('\n'),
        'child.script': [
          'shared text trace',
          'extends "middle.script"',
          'this.outer()',
          'this.trace("after|")',
          'return this.trace.snapshot()'
        ].join('\n')
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('touch|after|');
    });

    it('shares typed text chains across constructors and methods', async function () {
      const localEnv = createEnvironment({
        'base.script': 'shared text log\nthis.log("base|")',
        'child.script': 'shared text log\nextends "base.script"\nsuper()\nthis.log("child|")\nreturn this.log.snapshot()'
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('base|child|');
    });

    it('shares typed data chains across inherited method calls', async function () {
      const localEnv = createEnvironment({
        'base.script': [
          'shared data state',
          'method addBase()',
          '  this.state.items.push("base")',
          'endmethod'
        ].join('\n'),
        'child.script': [
          'shared data state',
          'extends "base.script"',
          'this.state.items.push("child")',
          'this.addBase()',
          'return this.state.snapshot()'
        ].join('\n')
      });

      expect(await localEnv.renderScript('child.script', {})).to.eql({ items: ['child', 'base'] });
    });

    it('keeps constructor value-consumption failures on the shared chain error path', async function () {
      const localEnv = createEnvironment({
        'child.script': [
          'extends none',
          'shared var status',
          'this.status = fail()',
          'return [this.status is error, this.status#.message]'
        ].join('\n')
      });

      const result = await localEnv.renderScript('child.script', {
        fail() {
          return Promise.reject(new Error('constructor value failed'));
        }
      });

      expect(result[0]).to.be(true);
      expect(result[1]).to.contain('constructor value failed');
    });

    it('keeps inherited method value-consumption failures on the shared chain error path', async function () {
      const localEnv = createEnvironment({
        'base.script': [
          'shared var status',
          'method breakStatus()',
          '  this.status = fail()',
          '  return "done"',
          'endmethod'
        ].join('\n'),
        'child.script': [
          'shared var status',
          'extends "base.script"',
          'var result = this.breakStatus()',
          'return [result, this.status is error, this.status#.message]'
        ].join('\n')
      });

      const result = await localEnv.renderScript('child.script', {
        fail() {
          return Promise.reject(new Error('method value failed'));
        }
      });

      expect(result[0]).to.be('done');
      expect(result[1]).to.be(true);
      expect(result[2]).to.contain('method value failed');
    });

    it('normalizes lazy script constructor results at the public render boundary', async function () {
      const result = await env.renderScriptString('extends none\nreturn { value: delayed() }', {
        async delayed() {
          return 'ready';
        }
      });

      expect(result).to.eql({ value: 'ready' });
    });

    it('dispatches a script without a concrete constructor to the nearest ancestor constructor', async function () {
      const localEnv = createEnvironment({
        'base.script': 'extends none\nreturn "base"',
        'child.script': 'extends "base.script"'
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('base');
    });

    it('does not let a parent constructor return override the child direct-render result', async function () {
      const localEnv = createEnvironment({
        'base.script': 'extends none\nreturn "base"',
        'child.script': 'extends "base.script"\nsuper()\nreturn "child"'
      });

      expect(await localEnv.renderScript('child.script', {})).to.be('child');
    });

    it('selects shared defaults child-to-parent without evaluating unselected parent defaults', async function () {
      const localEnv = createEnvironment({
        'base.script': 'extends none\nshared var theme = fail()\nreturn this.theme',
        'child.script': 'extends "base.script"\nshared var theme = "child"\nreturn this.theme'
      });

      expect(await localEnv.renderScript('child.script', {
        fail() {
          throw new Error('parent default should not run');
        }
      })).to.be('child');
    });

    it('keeps shared declaration initializers ambient before later local declarations', async function () {
      const localEnv = createEnvironment({
        'child.script': 'shared var theme = localTheme\nextends none\nvar localTheme = "local"\nreturn this.theme'
      });

      expect(await localEnv.renderScript('child.script', {
        localTheme: 'ambient'
      })).to.be('ambient');
    });

    it('fails shared declaration initializers naturally when later locals are not ambient', async function () {
      const localEnv = createEnvironment({
        'child.script': 'shared var theme = localTheme\nextends none\nvar localTheme = "local"\nreturn this.theme'
      });

      try {
        await localEnv.renderScript('child.script', {});
        expect().fail('Expected shared initializer to ignore the later local declaration');
      } catch (error) {
        expect(String(error)).to.contain('Can not look up unknown variable/function: localTheme');
      }
    });

    it('propagates constructor errors through public render context', async function () {
      const localEnv = createEnvironment({
        'child.script': 'extends none\nreturn thrower()'
      });

      try {
        await localEnv.renderScript('child.script', {
          thrower() {
            throw new Error('constructor failed');
          }
        });
        expect().fail('Expected constructor failure');
      } catch (error) {
        expect(String(error)).to.contain('constructor failed');
        expect(String(error)).to.contain('child.script');
      }
    });

    it('propagates dynamic parent load failures through public render', async function () {
      const localEnv = createEnvironment({
        'child.script': 'extends parentScript\nreturn "child"'
      });

      try {
        await localEnv.renderScript('child.script', { parentScript: 'missing.script' });
        expect().fail('Expected parent load failure');
      } catch (error) {
        expect(String(error)).to.contain('missing.script');
        expect(error.path).to.be('child.script');
      }
    });

    it('lets script dynamic null render only the entry constructor', async function () {
      const localEnv = createEnvironment({
        'child.script': 'extends parentScript\nreturn "child-only"'
      });

      expect(await localEnv.renderScript('child.script', { parentScript: null })).to.be('child-only');
    });

    it('propagates dynamic selection errors through public render', async function () {
      const localEnv = createEnvironment({
        'child.script': 'extends pickParent()\nreturn "child"'
      });

      try {
        await localEnv.renderScript('child.script', {
          pickParent() {
            throw new Error('selection failed');
          }
        });
        expect().fail('Expected dynamic selection failure');
      } catch (error) {
        expect(String(error)).to.contain('selection failed');
        expect(String(error)).to.contain('child.script');
      }
    });

    it('fails promised dynamic template null parent selection through public render', async function () {
      const localEnv = createEnvironment({
        'child.njk': '{% extends parentTemplate %}constructor text{% block body %}child{% endblock %}'
      });

      try {
        await localEnv.renderTemplate('child.njk', { parentTemplate: Promise.resolve(null) });
        expect().fail('Expected promised null template parent to fail');
      } catch (error) {
        expect(String(error)).to.contain('template extends must select a parent template');
        expect(String(error)).to.contain('child.njk');
      }
    });

    it('propagates dynamic template parent load failures through public render', async function () {
      const localEnv = createEnvironment({
        'child.njk': '{% extends parentTemplate %}{% block body %}child{% endblock %}'
      });

      try {
        await localEnv.renderTemplate('child.njk', { parentTemplate: 'missing-parent.njk' });
        expect().fail('Expected missing dynamic template parent to fail');
      } catch (error) {
        expect(String(error)).to.contain('missing-parent.njk');
        expect(String(error)).to.contain('child.njk');
      }
    });

    it('preserves loader errors while resolving a selected template parent', async function () {
      class ThrowingParentLoader extends StringLoader {
        getSource(name) {
          if (name === 'throwing-parent.njk') {
            throw new Error('loader exploded for selected parent');
          }
          return super.getSource(name);
        }
      }
      const loader = new ThrowingParentLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '{% extends parentTemplate %}{% block body %}child{% endblock %}');

      try {
        await localEnv.renderTemplate('child.njk', { parentTemplate: 'throwing-parent.njk' });
        expect().fail('Expected selected parent loader error');
      } catch (error) {
        expect(String(error)).to.contain('loader exploded for selected parent');
        expect(String(error)).to.contain('child.njk');
      }
    });
  });

  describe('metadata loader', function () {
    function createContext(values = {}, path = 'loader-entry.njk') {
      return {
        path,
        lookup(name) {
          return values[name];
        },
        lookupScript(name) {
          if (!(name in values)) {
            return runtime.createPoison(runtime.PoisonError.create(
              `Can not look up unknown variable/function: ${name}`,
              [1, 1, 'Lookup', path, null, null],
              'UnknownVariable'
            ));
          }
          return values[name];
        },
        getCompositionPayloadVariables() {
          return values;
        }
      };
    }

    async function loadTemplateChain(templates, entryName, context = createContext({}, entryName)) {
      const loader = new StringLoader();
      Object.entries(templates).forEach(([name, source]) => loader.addTemplate(name, source));
      const localEnv = new AsyncEnvironment(loader);
      const entry = await localEnv.getTemplate(entryName, true, null, false);
      return runtime.loadInheritanceChain({
        templateOrScript: entry,
        env: localEnv,
        context,
        runtime,
        errorContext: [1, 0, 'Extends', entryName, null, null],
        renderState: createTestRenderState()
      });
    }

    async function loadScriptChain(scripts, entryName, context = createContext({}, entryName)) {
      const loader = new StringLoader();
      Object.entries(scripts).forEach(([name, source]) => loader.addTemplate(name, source));
      const localEnv = new AsyncEnvironment(loader);
      const entry = await localEnv.getScript(entryName, true, null, false);
      return runtime.loadInheritanceChain({
        templateOrScript: entry,
        env: localEnv,
        context,
        runtime,
        errorContext: [1, 0, 'Extends', entryName, null, null],
        renderState: createTestRenderState()
      });
    }

    it('loads a static template chain child-to-parent without rendering roots', async function () {
      const chain = await loadTemplateChain({
        'base.njk': '{% block body %}base{% endblock %}',
        'mid.njk': '{% extends "base.njk" %}{% block body %}mid{% endblock %}',
        'child.njk': '{% extends "mid.njk" %}{% block body %}child{% endblock %}'
      }, 'child.njk');

      expect(chain.entries.map((entry) => entry.path)).to.eql(['child.njk', 'mid.njk', 'base.njk']);
      expect(chain.entries.map((entry) => entry.spec.methodEntries.body.name)).to.eql(['body', 'body', 'body']);
    });

    it('loads a static script chain child-to-parent without rendering roots', async function () {
      const chain = await loadScriptChain({
        'base.script': 'method title()\n  return "base"\nendmethod',
        'mid.script': 'extends "base.script"\nmethod title()\n  return "mid"\nendmethod',
        'child.script': 'extends "mid.script"\nmethod title()\n  return "child"\nendmethod'
      }, 'child.script');

      expect(chain.entries.map((entry) => entry.path)).to.eql(['child.script', 'mid.script', 'base.script']);
      expect(chain.entries.map((entry) => entry.spec.methodEntries.title.name)).to.eql(['title', 'title', 'title']);
    });

    it('does not call compiled roots while loading metadata', async function () {
      const parent = Object.freeze({
        path: 'parent.njk',
        compile() {},
        inheritanceSpec: { methodEntries: {}, sharedSchema: {}, hasExtends: false },
        async resolveInheritanceParent() {
          return runtime.noInheritanceParent();
        },
        getErrorContexts() {
          return [];
        },
        root() {
          throw new Error('parent root should not run');
        }
      });
      const child = Object.freeze({
        path: 'child.njk',
        compile() {},
        inheritanceSpec: { methodEntries: {}, sharedSchema: {}, hasExtends: true },
        async resolveInheritanceParent() {
          return { parentTemplateOrScript: parent, errorContext: [0, 0, null, 'child.njk', null, null] };
        },
        getErrorContexts() {
          return [];
        },
        root() {
          throw new Error('child root should not run');
        }
      });

      const chain = await runtime.loadInheritanceChain({
        templateOrScript: child,
        env: null,
        context: createContext(),
        runtime,
        errorContext: [1, 0, 'Extends', 'child.njk', null, null],
        renderState: createTestRenderState()
      });

      expect(chain.entries.map((entry) => entry.path)).to.eql(['child.njk', 'parent.njk']);
    });

    it('wraps selected parent compile failures with the selecting extends error context', async function () {
      const parent = Object.freeze({
        path: 'parent.njk',
        compile() {
          throw new Error('parent compile failed');
        }
      });
      const child = Object.freeze({
        path: 'child.njk',
        compile() {},
        inheritanceSpec: { methodEntries: {}, sharedSchema: {}, hasExtends: true },
        getErrorContexts() {
          return [];
        },
        async resolveInheritanceParent() {
          return {
            parentTemplateOrScript: parent,
            errorContext: [7, 3, 'Extends', 'child.njk', null, null]
          };
        }
      });

      try {
        await runtime.loadInheritanceChain({
          templateOrScript: child,
          env: null,
          context: createContext({}, 'entry.njk'),
          runtime,
          errorContext: [1, 0, 'Extends', 'child.njk', null, null],
          renderState: createTestRenderState()
        });
        expect().fail('Expected selected parent compile failure');
      } catch (error) {
        expect(String(error)).to.contain('parent compile failed');
        expect(error.path).to.be('child.njk');
        expect(error.lineno).to.be(7);
      }
    });

    it('wraps entry compile failures with the supplied entry error context', async function () {
      const entry = Object.freeze({
        path: 'entry.njk',
        compile() {
          throw new Error('entry compile failed');
        }
      });

      try {
        await runtime.loadInheritanceChain({
          templateOrScript: entry,
          env: null,
          context: createContext({}, 'entry-context.njk'),
          runtime,
          errorContext: [4, 2, 'Extends', 'entry-context.njk', null, null],
          renderState: createTestRenderState()
        });
        expect().fail('Expected entry compile failure');
      } catch (error) {
        expect(String(error)).to.contain('entry compile failed');
        expect(error.path).to.be('entry-context.njk');
        expect(error.lineno).to.be(4);
      }
    });


    it('does not require or create a CommandBuffer while loading', async function () {
      const strictRuntime = {
        ...runtime,
        CommandBuffer: function CommandBuffer() {
          throw new Error('metadata loading must not create command buffers');
        }
      };
      const chain = await loadTemplateChain({
        'base.njk': '{% block body %}base{% endblock %}',
        'child.njk': '{% extends "base.njk" %}{% block body %}child{% endblock %}'
      }, 'child.njk', createContext({}, 'child.njk'));

      expect(chain.entries.length).to.be(2);
      await runtime.loadInheritanceChain({
        templateOrScript: chain.entries[0].templateOrScript,
        env: chain.entries[0].templateOrScript.env,
        context: createContext({}, 'child.njk'),
        runtime: strictRuntime,
        errorContext: [1, 0, 'Extends', 'child.njk', null, null],
        renderState: createTestRenderState()
      });
    });

    it('returns an immutable chain value', async function () {
      const chain = await loadTemplateChain({
        'base.njk': '{% block body %}base{% endblock %}',
        'child.njk': '{% extends "base.njk" %}{% block body %}child{% endblock %}'
      }, 'child.njk');

      expect(Object.isFrozen(chain)).to.be(true);
      expect(Object.isFrozen(chain.entries)).to.be(true);
      expect(Object.isFrozen(chain.entries[0])).to.be(true);
    });

    it('rejects static inheritance cycles with source context', async function () {
      try {
        await loadTemplateChain({
          'a.njk': '{% extends "b.njk" %}{% block body %}a{% endblock %}',
          'b.njk': '{% extends "a.njk" %}{% block body %}b{% endblock %}'
        }, 'a.njk');
        expect().fail('Expected inheritance cycle to fail');
      } catch (error) {
        expect(String(error)).to.contain('inheritance cycle detected');
        expect(error.path).to.be('b.njk');
      }
    });

    it('rejects dynamic inheritance cycles with source context', async function () {
      try {
        await loadTemplateChain({
          'a.njk': '{% extends parentA %}{% block body %}a{% endblock %}',
          'b.njk': '{% extends parentB %}{% block body %}b{% endblock %}'
        }, 'a.njk', createContext({ parentA: 'b.njk', parentB: 'a.njk' }, 'a.njk'));
        expect().fail('Expected dynamic inheritance cycle to fail');
      } catch (error) {
        expect(String(error)).to.contain('inheritance cycle detected');
        expect(error.path).to.be('b.njk');
      }
    });

    it('preserves parent load failure source context', async function () {
      try {
        await loadTemplateChain({
          'child.njk': '{% extends "missing.njk" %}{% block body %}child{% endblock %}'
        }, 'child.njk');
        expect().fail('Expected missing parent to fail');
      } catch (error) {
        expect(String(error)).to.contain('missing.njk');
        expect(error.path).to.be('child.njk');
      }
    });

    it('resolves dynamic parent selection once during loading', async function () {
      let lookupCount = 0;
      const chain = await loadTemplateChain({
        'base.njk': '{% block body %}base{% endblock %}',
        'child.njk': '{% extends parentTemplate %}{% block body %}child{% endblock %}'
      }, 'child.njk', {
        path: 'child.njk',
        lookup(name) {
          if (name === 'parentTemplate') {
            lookupCount += 1;
            return 'base.njk';
          }
          return undefined;
        },
        lookupScript() {
          return undefined;
        },
        getCompositionPayloadVariables() {
          return {};
        }
      });

      expect(chain.entries.map((entry) => entry.path)).to.eql(['child.njk', 'base.njk']);
      expect(lookupCount).to.be(1);
    });

    it('loads only the script itself for parentless script inheritance', async function () {
      const staticChain = await loadScriptChain({
        'child.script': 'extends none\nreturn "child"'
      }, 'child.script');
      const dynamicChain = await loadScriptChain({
        'child.script': 'extends parentScript\nreturn "child"'
      }, 'child.script', createContext({ parentScript: null }, 'child.script'));

      expect(staticChain.entries.map((entry) => entry.path)).to.eql(['child.script']);
      expect(dynamicChain.entries.map((entry) => entry.path)).to.eql(['child.script']);
    });

    it('fails dynamic template null parent selection before constructor execution', async function () {
      try {
        await loadTemplateChain({
          'child.njk': '{% extends parentTemplate %}constructor text{% block body %}child{% endblock %}'
        }, 'child.njk', createContext({ parentTemplate: null }, 'child.njk'));
        expect().fail('Expected null template parent to fail');
      } catch (error) {
        expect(String(error)).to.contain('template extends must select a parent template');
        expect(error.path).to.be('child.njk');
      }
    });

    it('does not let script shared declarations satisfy dynamic extends', async function () {
      try {
        await loadScriptChain({
          'child.script': 'shared var parentScript = "base.script"\nextends parentScript\nreturn "child"'
        }, 'child.script', createContext({}, 'child.script'));
        expect().fail('Expected shared declaration parent target to be ignored');
      } catch (error) {
        expect(String(error)).to.contain('Can not look up unknown variable/function: parentScript');
      }
    });

    it('allows static script extends with same-name local declarations', function () {
      expect(function () {
        new Script('extends "base.script"\nvar parentScript = "local"\nreturn parentScript', env, 'static-local.script').compileSource();
      }).not.to.throwException();
    });

    it('keeps dynamic script extends ambient before a later local declaration', async function () {
      const chain = await loadScriptChain({
        'base.script': 'extends none\nreturn "base"',
        'child.script': 'extends parentScript\nvar parentScript = "local.script"\nreturn parentScript'
      }, 'child.script', createContext({ parentScript: 'base.script' }, 'child.script'));

      expect(chain.entries.map((entry) => entry.path)).to.eql(['child.script', 'base.script']);
    });
  });

  describe('metadata finalization', function () {
    function compactDependencies(dependencies) {
      return Object.fromEntries(Object.entries(dependencies).map(([name, dependency]) => [
        name,
        { ...dependency }
      ]));
    }

    function compiledMethod(name, options = {}) {
      return {
        name,
        fn: options.fn || function compiledInheritanceMethod() {},
        signature: { argNames: options.argNames || [] },
        __testErrorContext: compactTestErrorContext(options.errorContext || { path: `${name}.owner`, lineno: 1, colno: 1 }),
        isConstructor: !!options.isConstructor,
        super: !!options.super,
        __testSuperErrorContext: compactTestErrorContext(options.superErrorContext),
        inheritedMethodDependencies: compactDependencies(options.inheritedMethodDependencies || {}),
        ownLinkedChains: options.ownLinkedChains || [],
        ownMutatedChains: options.ownMutatedChains || []
      };
    }

    function addTestErrorContext(errorContextTable, errorContext) {
      if (!errorContext) {
        return null;
      }
      errorContextTable.push(compactTestErrorContext(errorContext));
      return errorContextTable.length - 1;
    }

    function indexTestMetadata(entrySpec, entryErrorContextTable) {
      Object.values(entrySpec.methodEntries || {}).forEach((methodEntry) => {
        if (methodEntry.errorContextIndex == null) {
          methodEntry.errorContextIndex = addTestErrorContext(entryErrorContextTable, methodEntry.__testErrorContext);
        }
        delete methodEntry.__testErrorContext;
        if (methodEntry.superErrorContextIndex == null) {
          methodEntry.superErrorContextIndex = addTestErrorContext(entryErrorContextTable, methodEntry.__testSuperErrorContext);
        }
        delete methodEntry.__testSuperErrorContext;
        Object.values(methodEntry.inheritedMethodDependencies || {}).forEach((dependency) => {
          if (dependency.errorContextIndex == null) {
            dependency.errorContextIndex = addTestErrorContext(entryErrorContextTable, dependency.errorContext);
          }
          delete dependency.errorContext;
        });
      });

      Object.values(entrySpec.sharedSchema || {}).forEach((schemaEntry) => {
        if (schemaEntry.errorContextIndex == null) {
          schemaEntry.errorContextIndex = addTestErrorContext(entryErrorContextTable, schemaEntry.__testErrorContext);
        }
        delete schemaEntry.__testErrorContext;
      });
    }

    function loadedEntry(path, options = {}) {
      const spec = {
        methodEntries: options.methodEntries || {},
        sharedSchema: options.sharedSchema || {},
        hasExtends: !!options.hasExtends
      };
      const errorContextTable = options.errorContextTable || [];
      indexTestMetadata(spec, errorContextTable);
      return {
        templateOrScript: {
          path,
          scriptMode: !!options.scriptMode,
          compile() {},
          getErrorContexts(runtimeArg, ownerPath, renderState) {
            return errorContextTable.map((entry) => [
              entry[0],
              entry[1],
              entry[2],
              ownerPath ?? entry[3],
              entry[4] ?? null,
              renderState ?? entry[5] ?? null
            ]);
          }
        },
        spec,
        path,
        errorContextTable,
        errorContext: compactTestErrorContext(options.errorContext || { path, lineno: 1, colno: 1 })
      };
    }

    function finalizeEntries(entries) {
      return runtime.finalizeInheritanceChain({ entries }, { path: 'finalize-entry.njk' });
    }

    function createRuntimeContext(values = {}, path = 'instance.script') {
      return {
        path,
        lookup(name) {
          return values[name];
        },
        lookupScript(name) {
          return values[name];
        },
        getCompositionContextVariables() {
          return values;
        },
        getCompositionPayloadVariables() {
          return values;
        },
        getRenderContextVariables() {
          return values;
        },
        forkForComposition(nextPath, payload = {}) {
          return createRuntimeContext(Object.assign({}, values, payload), nextPath);
        },
        forkForPath(nextPath) {
          return createRuntimeContext(values, nextPath);
        }
      };
    }

    function inheritanceParticipant(path, options = {}) {
      const spec = {
        methodEntries: options.methodEntries || {},
        sharedSchema: options.sharedSchema || {},
        hasExtends: !!options.hasExtends
      };
      const errorContextTable = options.errorContextTable || [];
      indexTestMetadata(spec, errorContextTable);
      const participant = {
        path,
        scriptMode: !!options.scriptMode,
        compileCalls: 0,
        compile() {
          this.compileCalls += 1;
        },
        inheritanceSpec: spec,
        getErrorContexts(runtimeArg, ownerPath, renderState) {
          return errorContextTable.map((entry) => [
            entry[0],
            entry[1],
            entry[2],
            ownerPath ?? entry[3],
            entry[4] ?? null,
            renderState ?? entry[5] ?? null
          ]);
        },
        async resolveInheritanceParent() {
          return runtime.noInheritanceParent();
        }
      };
      return participant;
    }

    async function loadTemplateChainForFinalization(templates, entryName) {
      const loader = new StringLoader();
      Object.entries(templates).forEach(([name, source]) => loader.addTemplate(name, source));
      const localEnv = new AsyncEnvironment(loader);
      const entry = await localEnv.getTemplate(entryName, true, null, false);
      return runtime.loadInheritanceChain({
        templateOrScript: entry,
        env: localEnv,
        context: {
          path: entryName,
          lookup() {
            return undefined;
          },
          getCompositionPayloadVariables() {
            return {};
          }
        },
        runtime,
        errorContext: [1, 0, 'Extends', entryName, null, null],
        renderState: createTestRenderState()
      });
    }

    async function createCompiledScriptInstance(scripts, entryName, ctx = {}) {
      const loader = new StringLoader();
      Object.entries(scripts).forEach(([name, source]) => loader.addTemplate(name, source));
      const localEnv = new AsyncEnvironment(loader);
      const entry = await localEnv.getScript(entryName, true, null, false);
      return runtime.InheritanceInstance.create({
        entryTemplateOrScript: entry,
        env: localEnv,
        context: entry._createContext(ctx),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });
    }

    async function createCompiledTemplateInstance(templates, entryName, ctx = {}) {
      const loader = new StringLoader();
      Object.entries(templates).forEach(([name, source]) => loader.addTemplate(name, source));
      const localEnv = new AsyncEnvironment(loader);
      const entry = await localEnv.getTemplate(entryName, true, null, false);
      return runtime.InheritanceInstance.create({
        entryTemplateOrScript: entry,
        env: localEnv,
        context: entry._createContext(ctx),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });
    }

    it('finalizes a loaded static template chain', async function () {
      const chain = await loadTemplateChainForFinalization({
        'base.njk': '{% block body %}base{% endblock %}',
        'child.njk': '{% extends "base.njk" %}{% block body %}child{% endblock %}'
      }, 'child.njk');
      const state = runtime.finalizeInheritanceChain(chain, { path: 'child.njk' });

      expect(Object.keys(state.methods).sort()).to.eql(['__constructor__', 'body']);
      expect(state.methods.body.ownerEntry.path).to.be('child.njk');
      expect(state.methods.body.super.ownerEntry.path).to.be('base.njk');
    });

    it('finalizes a static child-to-root chain into one dispatch table', function () {
      const childFn = function childBody() {};
      const midFn = function midBody() {};
      const rootFn = function rootBody() {};
      const state = finalizeEntries([
        loadedEntry('child.njk', { hasExtends: true, methodEntries: { body: compiledMethod('body', { fn: childFn }) } }),
        loadedEntry('mid.njk', { hasExtends: true, methodEntries: { body: compiledMethod('body', { fn: midFn }) } }),
        loadedEntry('root.njk', { methodEntries: { body: compiledMethod('body', { fn: rootFn }) } })
      ]);

      expect(Object.keys(state.methods)).to.eql(['body']);
      expect(state.methods.body.fn).to.be(childFn);
      expect(state.methods.body.super.fn).to.be(midFn);
      expect(state.methods.body.super.super.fn).to.be(rootFn);
      expect(state.methods.body.super.super.super).to.be(null);
    });

    it('does not call compiled functions while finalizing', function () {
      const state = finalizeEntries([
        loadedEntry('child.script', {
          scriptMode: true,
          methodEntries: {
            build: compiledMethod('build', {
              fn() {
                throw new Error('method should not run');
              }
            })
          }
        })
      ]);

      expect(state.methods.build.name).to.be('build');
    });

    it('wires super to the exact parent implementation without name lookup', function () {
      const childBuild = compiledMethod('build', { super: true });
      const midOther = compiledMethod('other');
      const rootBuild = compiledMethod('build');
      const state = finalizeEntries([
        loadedEntry('child.script', { scriptMode: true, hasExtends: true, methodEntries: { build: childBuild } }),
        loadedEntry('mid.script', { scriptMode: true, hasExtends: true, methodEntries: { other: midOther } }),
        loadedEntry('root.script', { scriptMode: true, methodEntries: { build: rootBuild } })
      ]);

      expect(testErrorContextPath(state.methods.build.errorContext)).to.be('build.owner');
      expect(state.methods.build.super.fn).to.be(rootBuild.fn);
      expect(state.methods.build.super.name).to.be('build');
    });

    it('fails non-constructor super calls with no parent implementation', function () {
      expect(function () {
        finalizeEntries([
          loadedEntry('child.script', {
            scriptMode: true,
            methodEntries: {
              build: compiledMethod('build', { super: true, superErrorContext: { path: 'child.script', lineno: 4, colno: 10 } })
            }
          })
        ]);
      }).to.throwException((error) => {
        expect(String(error)).to.contain('super() in \'build\' has no parent implementation');
        expect(error.path).to.be('child.script');
      });
    });

    it('wires a no-op topmost constructor target for constructor super calls', function () {
      const state = finalizeEntries([
        loadedEntry('child.script', {
          scriptMode: true,
          methodEntries: {
            __constructor__: compiledMethod('__constructor__', { isConstructor: true, super: true })
          }
        })
      ]);

      expect(state.methods.__constructor__.isConstructor).to.be(true);
      expect(state.methods.__constructor__.super.isConstructor).to.be(true);
      expect(state.methods.__constructor__.super.super).to.be(null);
    });

    it('wires constructor super to an existing parent constructor', function () {
      const childConstructor = compiledMethod('__constructor__', { isConstructor: true, super: true });
      const rootConstructor = compiledMethod('__constructor__', { isConstructor: true });
      const state = finalizeEntries([
        loadedEntry('child.script', {
          scriptMode: true,
          hasExtends: true,
          methodEntries: { __constructor__: childConstructor }
        }),
        loadedEntry('root.script', {
          scriptMode: true,
          methodEntries: { __constructor__: rootConstructor }
        })
      ]);

      expect(state.methods.__constructor__.fn).to.be(childConstructor.fn);
      expect(state.methods.__constructor__.super.fn).to.be(rootConstructor.fn);
      expect(state.methods.__constructor__.super.super).to.be(null);
    });

    it('allows overrides with more or fewer trailing arguments', function () {
      expect(function () {
        finalizeEntries([
          loadedEntry('child.script', {
            scriptMode: true,
            hasExtends: true,
            methodEntries: {
              build: compiledMethod('build', { argNames: ['user'] }),
              card: compiledMethod('card', { argNames: ['user', 'variant'] })
            }
          }),
          loadedEntry('root.script', {
            scriptMode: true,
            methodEntries: {
              build: compiledMethod('build', { argNames: ['user', 'variant'] }),
              card: compiledMethod('card', { argNames: ['user'] })
            }
          })
        ]);
      }).not.to.throwException();
    });

    it('fails fast on the first deterministic finalization error', function () {
      expect(function () {
        finalizeEntries([
          loadedEntry('child.script', {
            scriptMode: true,
            hasExtends: true,
            sharedSchema: { theme: sharedSchemaEntry('var', { errorContext: { path: 'child.script', lineno: 1, colno: 1 } }) },
            methodEntries: {
              build: compiledMethod('build', {
                argNames: ['profile'],
                inheritedMethodDependencies: {
                  missing: { name: 'missing', errorContext: { path: 'child.script', lineno: 2, colno: 3 } }
                }
              })
            }
          }),
          loadedEntry('root.script', {
            scriptMode: true,
            sharedSchema: { theme: sharedSchemaEntry('text', { errorContext: { path: 'root.script', lineno: 1, colno: 1 } }) },
            methodEntries: {
              build: compiledMethod('build', { argNames: ['user'] })
            }
          })
        ]);
      }).to.throwException((error) => {
        expect(String(error)).to.contain('shared chain \'theme\' has conflicting types');
        expect(error.path).to.be('root.script');
        expect(error.lineno).to.be(1);
        expect(error.colno).to.be(1);
      });
    });

    it('reports shared and method collisions across files', function () {
      expect(function () {
        finalizeEntries([
          loadedEntry('child.njk', { sharedSchema: { card: sharedSchemaEntry('var', { errorContext: { path: 'child.njk', lineno: 1, colno: 1 } }) } }),
          loadedEntry('root.njk', { methodEntries: { card: compiledMethod('card') } })
        ]);
      }).to.throwException((error) => {
        expect(String(error)).to.contain('shared chain \'card\' conflicts with inherited method \'card\'');
        expect(error.path).to.be('child.njk');
        expect(error.lineno).to.be(1);
        expect(error.colno).to.be(1);
      });
    });

    it('keeps the child-most shared schema declaration and first available default', function () {
      const state = finalizeEntries([
        loadedEntry('child.script', {
          scriptMode: true,
          hasExtends: true,
          sharedSchema: {
            theme: sharedSchemaEntry('var', {
              errorContext: { path: 'child.script', lineno: 2, colno: 1 },
              hasDefault: false
            })
          }
        }),
        loadedEntry('root.script', {
          scriptMode: true,
          sharedSchema: {
            theme: sharedSchemaEntry('var', {
              errorContext: { path: 'root.script', lineno: 2, colno: 1 },
              hasDefault: true
            })
          }
        })
      ]);

      expect(state.sharedSchema.theme.type).to.be('var');
      expect(testErrorContextPath(state.sharedSchema.theme.errorContext)).to.be('child.script');
      expect(state.sharedSchema.theme.hasDefault).to.be(true);
      expect(testErrorContextPath(state.sharedSchema.theme.defaultErrorContext)).to.be('root.script');
    });

    it('merges chain footprints across overridden entries', function () {
      const state = finalizeEntries([
        loadedEntry('child.script', {
          scriptMode: true,
          hasExtends: true,
          methodEntries: {
            build: compiledMethod('build', {
              ownLinkedChains: ['childRead'],
              ownMutatedChains: ['childWrite']
            })
          }
        }),
        loadedEntry('root.script', {
          scriptMode: true,
          methodEntries: {
            build: compiledMethod('build', {
              ownLinkedChains: ['rootRead'],
              ownMutatedChains: ['rootWrite']
            })
          }
        })
      ]);

      expect(state.methods.build.mergedLinkedChains.slice().sort()).to.eql(['childRead', 'rootRead']);
      expect(state.methods.build.mergedMutatedChains.slice().sort()).to.eql(['childWrite', 'rootWrite']);
    });

    it('prunes finalization-only method fields and attaches owner entries', function () {
      const state = finalizeEntries([
        loadedEntry('root.njk', {
          methodEntries: {
            body: compiledMethod('body', {
              inheritedMethodDependencies: {},
              ownLinkedChains: ['theme'],
              ownMutatedChains: ['theme']
            })
          }
        })
      ]);
      const entry = state.methods.body;

      expect(entry.inheritedMethodDependencies).to.be(undefined);
      expect(entry.superErrorContext).to.be(undefined);
      expect(entry.ownLinkedChains).to.be(undefined);
      expect(entry.ownMutatedChains).to.be(undefined);
      expect(entry.name).to.be('body');
      expect(entry.fn).to.be.a(Function);
      expect(entry.signature).to.eql({ argNames: [] });
      expect(testErrorContextPath(entry.errorContext)).to.be('body.owner');
      expect(entry.isConstructor).to.be(false);
      expect(entry.ownerEntry.path).to.be('root.njk');
      expect(entry.ownerEntry.isStructuralTemplate).to.be(true);
    });

    it('keeps participant shared declaration output off legacy shared-buffer helpers', function () {
      const source = compileSource('shared var theme\nextends none\nreturn this.theme', {
        scriptMode: true,
        name: 'shared-helper.script'
      });

      expect(source).to.contain('sharedSchema');
      expect(source).not.to.contain('runtime.getInheritanceSharedBuffer');
      expect(source).not.to.contain('runtime.getInheritanceSharedRootBuffer');
    });

    it('initializes shared sequence targets through declaration', function () {
      const buffer = new runtime.CommandBuffer(
        { path: 'shared-sequence.script' },
        null,
        null,
        null,
        null,
        runtime.cloneWithAddedContext(TEST_EC, { branch: 'test' }),
        null,
        createTestRenderState()
      );
      const firstTarget = { name: 'first' };
      const secondTarget = { name: 'second' };

      const chain = runtime.declareInheritanceSharedChain(buffer, 'db', 'sequence', null, firstTarget, TEST_EC);
      runtime.declareInheritanceSharedChain(buffer, 'db', 'sequence', null, secondTarget, TEST_EC);

      expect(chain._sequencedObject).to.be(secondTarget);
    });

    it('creates an inheritance instance without invoking constructors', async function () {
      let invoked = false;
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: {
          __constructor__: compiledMethod('__constructor__', {
            isConstructor: true,
            fn() {
              invoked = true;
            }
          })
        }
      });
      const context = createRuntimeContext();
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: participant,
        env: {},
        context,
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });

      expect(participant.compileCalls).to.be(1);
      expect(instance.runtimeState.methods.__constructor__.isConstructor).to.be(true);
      expect(invoked).to.be(false);
    });

    it('finishes owned instance buffers when inheritance loading fails', async function () {
      const renderState = createTestRenderState();
      const context = createRuntimeContext();
      const rootBuffer = new runtime.CommandBuffer(context, null, null, null, null, TEST_EC, null, renderState);
      const sharedRootBuffer = new runtime.CommandBuffer(context, null, null, null, null, TEST_EC, null, renderState);
      const participant = {
        path: 'broken.script',
        compile() {
          throw new Error('instance load failed');
        }
      };

      try {
        await runtime.InheritanceInstance.create({
          entryTemplateOrScript: participant,
          env: {},
          context,
          runtime,
          renderState,
          rootBuffer,
          sharedRootBuffer,
          errorContext: TEST_EC
        });
        expect().fail('Expected inheritance instance creation to fail');
      } catch (error) {
        expect(error.message).to.contain('instance load failed');
      }

      await Promise.all([rootBuffer.getFinishedPromise(), sharedRootBuffer.getFinishedPromise()]);
      expect(rootBuffer.finished).to.be(true);
      expect(sharedRootBuffer.finished).to.be(true);
    });

    it('finishes owned instance buffers when inheritance loading detects a cycle', async function () {
      const renderState = createTestRenderState();
      const context = createRuntimeContext();
      const rootBuffer = new runtime.CommandBuffer(context, null, null, null, null, TEST_EC, null, renderState);
      const sharedRootBuffer = new runtime.CommandBuffer(context, null, null, null, null, TEST_EC, null, renderState);
      const participant = inheritanceParticipant('cycle.script', {
        scriptMode: true,
        hasExtends: true
      });
      participant.resolveInheritanceParent = async () => ({
        parentTemplateOrScript: participant,
        errorContext: TEST_EC
      });

      try {
        await runtime.InheritanceInstance.create({
          entryTemplateOrScript: participant,
          env: {},
          context,
          runtime,
          renderState,
          rootBuffer,
          sharedRootBuffer,
          errorContext: TEST_EC
        });
        expect().fail('Expected inheritance instance cycle to fail');
      } catch (error) {
        expect(String(error)).to.contain('inheritance cycle detected');
      }

      await Promise.all([rootBuffer.getFinishedPromise(), sharedRootBuffer.getFinishedPromise()]);
      expect(rootBuffer.finished).to.be(true);
      expect(sharedRootBuffer.finished).to.be(true);
    });

    it('invokes finalized methods through the instance dispatch table', async function () {
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: {
          greet: compiledMethod('greet', {
            argNames: ['user'],
            fn(envArg, contextArg, runtimeArg, renderState, invocationBuffer, payload, renderContext, methodData, currentInstance) {
              expect(currentInstance.runtimeState.methods.greet).to.be(methodData);
              expect(invocationBuffer.parent).to.be(currentInstance.sharedRootBuffer);
              return `hello ${payload.originalArgs.user}`;
            }
          })
        }
      });
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: participant,
        env: {},
        context: createRuntimeContext(),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });

      expect(await instance.invoke('greet', ['Ada'], [1, 1, null, 'call.script', null, null])).to.be('hello Ada');
    });

    it('maps keyword arguments through the inherited callable signature', async function () {
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: {
          greet: compiledMethod('greet', {
            argNames: ['user', 'fallback'],
            fn(envArg, contextArg, runtimeArg, renderState, invocationBuffer, payload) {
              return `${payload.originalArgs.user}:${payload.originalArgs.fallback}`;
            }
          })
        }
      });
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: participant,
        env: {},
        context: createRuntimeContext(),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });

      const result = await instance.invoke(
        'greet',
        ['Ada', runtime.makeKeywordArgs({ fallback: 'guest' })],
        [1, 1, null, 'call.script', null, null]
      );
      expect(result).to.be('Ada:guest');
    });

    it('uses call-site context for direct invocation argument failures', async function () {
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: {
          greet: compiledMethod('greet', {
            argNames: ['user'],
            errorContext: [7, 5, null, 'component.script', null, null]
          })
        }
      });
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: participant,
        env: {},
        context: createRuntimeContext(),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });

      try {
        await instance.invoke('greet', ['Ada', 'extra'], [3, 2, null, 'call.script', null, null]);
        throw new Error('expected invocation to fail');
      } catch (error) {
        expect(error.name).to.be('RuntimeError');
        expect(error.path).to.be('call.script');
        expect(error.lineno).to.be(3);
        expect(error.colno).to.be(2);
      }
    });

    it('keeps existing macro keyword argument behavior unchanged', async function () {
      const rendered = await env.renderTemplateString(
        '{% macro greet(user, fallback="guest") %}{{ user }}:{{ fallback }}{% endmacro %}{{ greet("Ada", fallback="friend") }}'
      );

      expect(rendered).to.be('Ada:friend');
    });

    it('lets compiled inherited methods call other methods through the current instance', async function () {
      const instance = await createCompiledScriptInstance({
        'component.script': [
          'method outer(user)',
          '  return this.inner(user)',
          'endmethod',
          'method inner(user)',
          '  return user',
          'endmethod'
        ].join('\n')
      }, 'component.script');

      expect(await instance.invoke('outer', ['Ada'], [1, 1, null, 'call.script', null, null])).to.be('Ada');
    });

    it('invokes template blocks through the instance dispatch table', async function () {
      const instance = await createCompiledTemplateInstance({
        'component.njk': '{% block body(user) %}Hello {{ user }}{% endblock %}'
      }, 'component.njk');

      expect(String(await instance.invoke('body', ['Ada'], [1, 1, null, 'call.njk', null, null]))).to.be('Hello Ada');
    });

    it('links internal inherited calls under the current invocation buffer', async function () {
      let outerBuffer = null;
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: {
          outer: compiledMethod('outer', {
            fn(envArg, contextArg, runtimeArg, renderState, invocationBuffer, payload, renderContext, methodData, currentInstance) {
              outerBuffer = invocationBuffer;
              return currentInstance.invokeFromCurrentBuffer(
                'inner',
                [],
                contextArg,
                invocationBuffer,
                [1, 1, null, 'outer.script', null, null]
              );
            }
          }),
          inner: compiledMethod('inner', {
            fn(envArg, contextArg, runtimeArg, renderState, invocationBuffer) {
              expect(invocationBuffer.parent).to.be(outerBuffer);
              return 'inner';
            }
          })
        }
      });
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: participant,
        env: {},
        context: createRuntimeContext(),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });

      expect(await instance.invoke('outer', [], [1, 1, null, 'outer.script', null, null])).to.be('inner');
    });

    it('invokes super through finalized method data', async function () {
      const child = compiledMethod('build', {
        argNames: ['user'],
        super: true,
        fn(envArg, contextArg, runtimeArg, renderState, invocationBuffer, payload, renderContext, methodData, currentInstance) {
          return currentInstance.invokeSuper(
            methodData,
            [payload.originalArgs.user],
            contextArg,
            invocationBuffer,
            [1, 1, null, 'child.script', null, null]
          );
        }
      });
      const parent = compiledMethod('build', {
        argNames: ['user'],
        fn(envArg, contextArg, runtimeArg, renderState, invocationBuffer, payload) {
          return payload.originalArgs.user;
        }
      });
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: { build: child }
      });
      participant.inheritanceSpec.hasExtends = true;
      const parentParticipant = inheritanceParticipant('base.script', {
        scriptMode: true,
        methodEntries: { build: parent }
      });
      participant.resolveInheritanceParent = async function () {
        return {
          parentTemplateOrScript: parentParticipant,
          errorContext: [1, 1, null, 'component.script', null, null]
        };
      };
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: participant,
        env: {},
        context: createRuntimeContext({ user: 'Ada' }),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });

      expect(await instance.invoke('build', ['Grace'], [1, 1, null, 'call.script', null, null])).to.be('Grace');
    });

    it('lets explicit super arguments preserve parent defaults', async function () {
      const instance = await createCompiledScriptInstance({
        'child.script': [
          'extends "base.script"',
          'method build(user)',
          '  return super(user)',
          'endmethod'
        ].join('\n'),
        'base.script': [
          'method build(user, fallback = "guest")',
          '  return user + ":" + fallback',
          'endmethod'
        ].join('\n')
      }, 'child.script');

      expect(await instance.invoke('build', ['Ada'], [1, 1, null, 'call.script', null, null])).to.be('Ada:guest');
    });

    it('does not let an ignored super return replace the caller return value', async function () {
      const instance = await createCompiledScriptInstance({
        'child.script': [
          'extends "base.script"',
          'method build(user)',
          '  super(user)',
          '  return "child:" + user',
          'endmethod'
        ].join('\n'),
        'base.script': [
          'method build(user)',
          '  return "base:" + user',
          'endmethod'
        ].join('\n')
      }, 'child.script');

      expect(await instance.invoke('build', ['Ada'], [1, 1, null, 'call.script', null, null])).to.be('child:Ada');
    });

    it('fails missing instance methods as fatal structural errors', async function () {
      const participant = inheritanceParticipant('component.script', { scriptMode: true });
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: participant,
        env: {},
        context: createRuntimeContext(),
        runtime,
        renderState: createTestRenderState(),
        errorContext: TEST_EC
      });

      try {
        await instance.invoke('missing', [], [2, 3, null, 'call.script', null, null]);
        throw new Error('expected missing method to fail');
      } catch (error) {
        expect(error.name).to.be('RuntimeError');
        expect(String(error)).to.contain('missing inherited method \'missing\'');
      }
    });

    it('creates components through the inheritance instance lifecycle before method calls', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', [
        'shared var theme',
        'this.theme = "ready"',
        'method read()',
        '  return this.theme',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "component.script" as card',
        'return card.read()'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', {})).to.be('ready');
    });

    it('uses the same component instance across an inherited component chain', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', [
        'shared var theme = "base"',
        'method read()',
        '  return this.theme',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('child.script', [
        'shared var theme',
        'extends "base.script"',
        'this.theme = "child"'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "child.script" as card',
        'return [card.theme, card.read()]'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', {})).to.eql(['child', 'child']);
    });

    it('keeps independent component instances from sharing shared state', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', [
        'shared var count = 0',
        'method next()',
        '  this.count = this.count + 1',
        '  return this.count',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "component.script" as left',
        'component "component.script" as right',
        'return [left.next(), left.next(), right.next(), left.count, right.count]'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', {})).to.eql([1, 2, 1, 2, 1]);
    });

    it('lets component payload select a dynamic inheritance parent', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', [
        'shared var theme',
        'method read()',
        '  return "base:" + this.theme',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('child.script', [
        'shared var theme = "child"',
        'extends parentScript',
        'method read()',
        '  return "child>" + super()',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "child.script" as card with { parentScript: "base.script" }',
        'return card.read()'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', {})).to.be('child>base:child');
    });

    it('propagates component payload-selected parent load failures', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.script', [
        'extends parentScript',
        'return "child"'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "child.script" as card with { parentScript: "missing-parent.script" }',
        'return card.anything'
      ].join('\n'));

      try {
        await localEnv.renderScript('main.script', {});
        expect().fail('Expected missing component parent to fail');
      } catch (error) {
        expect(String(error)).to.contain('missing-parent.script');
        expect(String(error)).to.contain('child.script');
      }
    });

    it('keeps component payload vars separate from inherited shared storage', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', [
        'shared var theme = "shared"',
        'method read()',
        '  return theme + ":" + this.theme',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "component.script" as card with { theme: "payload" }',
        'return card.read()'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', {})).to.be('payload:shared');
    });

    it('lets component with context opt into caller context visibility', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', [
        'method read()',
        '  return site + ":" + label',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "component.script" as card with context, { label: "card" }',
        'return card.read()'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', { site: 'docs' })).to.be('docs:card');
    });

    it('observes component shared vars without invoking same-named methods', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', [
        'shared var theme = "dark"',
        'method readTheme()',
        '  this.theme = "method"',
        '  return this.theme',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "component.script" as card',
        'return [card.theme, card.readTheme(), card.theme]'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', {})).to.eql(['dark', 'method', 'method']);
    });

    it('observes component shared text chains through explicit snapshots', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', [
        'shared text log',
        'this.log("ready|")',
        'method add(item)',
        '  this.log(item)',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "component.script" as card',
        'card.add("done|")',
        'return card.log.snapshot()'
      ].join('\n'));

      expect(await localEnv.renderScript('main.script', {})).to.be('ready|done|');
    });

    it('rejects bare component reads of non-var shared chains', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', 'shared text log\nthis.log("ready")');
      loader.addTemplate('main.script', 'component "component.script" as card\nreturn card.log');

      try {
        await localEnv.renderScript('main.script', {});
        expect().fail('Expected bare component text-chain read to fail');
      } catch (error) {
        expect(String(error)).to.contain('Shared chain');
        expect(String(error)).to.contain('this.log');
        expect(String(error)).to.contain('snapshot()');
      }
    });

    it('rejects private and unknown component shared observations clearly', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', 'shared var _secret = "dark"');
      loader.addTemplate('private.script', 'component "component.script" as card\nreturn card._secret');
      loader.addTemplate('missing.script', 'component "component.script" as card\nreturn card.missing');

      const expectations = {
        'private.script': 'is private and cannot be accessed through a component',
        'missing.script': 'was not found'
      };
      for (const name of Object.keys(expectations)) {
        try {
          await localEnv.renderScript(name, {});
          throw new Error('expected component observation to fail');
        } catch (error) {
          expect(String(error)).to.contain('Shared chain');
          expect(String(error)).to.contain(expectations[name]);
        }
      }
    });

    it('closes component instances through owner side-chain completion and rejects later operations', async function () {
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: {
          ping: compiledMethod('ping', {
            fn() {
              return 'pong';
            }
          })
        }
      });
      const ownerContext = createRuntimeContext({}, 'main.script');
      const ownerBuffer = new runtime.CommandBuffer(
        ownerContext,
        null,
        null,
        null,
        null,
        runtime.cloneWithAddedContext(TEST_EC, { branch: 'test' }),
        null,
        createTestRenderState()
      );
      runtime.declareBufferChain(ownerBuffer, 'card', 'var', ownerContext, null);
      const instance = await runtime.createComponentInstance({
        componentScriptOrTemplate: participant,
        payload: {},
        ownerContext,
        env: {},
        runtime,
        ownerBuffer,
        bindingName: 'card',
        renderState: createTestRenderState(),
        errorContext: [1, 1, null, 'main.script', null, null]
      });
      ownerBuffer.addCommand(new runtime.VarCommand({
        chainName: 'card',
        args: [instance],
        errorContext: TEST_EC
      }), 'card');
      const sideChainFinished = ownerBuffer.getChain('card').finalSnapshot();
      ownerBuffer.finish();
      await sideChainFinished;
      await Promise.resolve();

      expect(function () {
        instance.invoke('ping', [], [2, 1, null, 'main.script', null, null]);
      }).to.throwException((error) => {
        expect(error).to.be.a(runtime.RuntimeError);
        expect(error.message).to.contain('cannot accept new operations');
      });
      expect(function () {
        instance.close();
      }).not.to.throwException();
    });

    it('rejects component creation when the constructor fails', async function () {
      const failure = new runtime.RuntimeError('constructor failed', [1, 1, null, 'component.script', null, null]);
      const participant = inheritanceParticipant('component.script', {
        scriptMode: true,
        methodEntries: {
          __constructor__: compiledMethod('__constructor__', {
            isConstructor: true,
            fn() {
              throw failure;
            }
          }),
          ping: compiledMethod('ping', {
            fn() {
              return 'pong';
            }
          })
        }
      });
      try {
        await runtime.createComponentInstance({
          componentScriptOrTemplate: participant,
          payload: {},
          ownerContext: createRuntimeContext({}, 'main.script'),
          env: {},
          runtime,
          renderState: createTestRenderState(),
          errorContext: [1, 1, null, 'main.script', null, null]
        });
        expect().fail('Expected component creation failure');
      } catch (error) {
        expect(error).to.be(failure);
      }
    });

    it('rejects later component operations when constructor initialization fails', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('component.script', [
        'shared var theme',
        'this.theme = fail()',
        'method read()',
        '  return this.theme',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('main.script', [
        'component "component.script" as card with context',
        'return card.read()'
      ].join('\n'));

      try {
        await localEnv.renderScript('main.script', {
          fail() {
            return Promise.reject(new Error('constructor value failed'));
          }
        });
        expect().fail('Expected component constructor failure');
      } catch (error) {
        expect(String(error)).to.contain('constructor value failed');
      }
    });
  });

  describe('include participant render', function () {
    it('keeps plain template includes on the ordinary include path', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('plain.njk', 'plain');
      loader.addTemplate('main.njk', 'before [{% include "plain.njk" %}] after');

      expect(await localEnv.renderTemplate('main.njk', { name: 'Ada' })).to.be('before [plain] after');
    });

    it('renders an included inheritance participant through its constructor chain', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'base({% block body %}base-body{% endblock %})');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block body %}child-body{% endblock %}');
      loader.addTemplate('main.njk', 'before [{% include "child.njk" %}] after');

      expect(await localEnv.renderTemplate('main.njk', {})).to.be('before [base(child-body)] after');
    });

    it('preserves source-order output around an async included participant', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      localEnv.addGlobal('slow', (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10)));
      loader.addTemplate('base.njk', 'base({% block body %}base-body{% endblock %})');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block body %}{{ slow("child-body") }}{% endblock %}');
      loader.addTemplate('main.njk', 'before [{% include "child.njk" %}] after');

      expect(await localEnv.renderTemplate('main.njk', {})).to.be('before [base(child-body)] after');
    });

    it('uses include payload rules for dynamic participant parent selection', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('base-a.njk', 'A({% block body %}base{% endblock %})');
      loader.addTemplate('base-b.njk', 'B({% block body %}base{% endblock %})');
      loader.addTemplate('child.njk', '{% extends parentName %}{% block body %}child{% endblock %}');
      loader.addTemplate('main.njk', '{% include "child.njk" with { parentName: "base-b.njk" } %}');

      expect(await localEnv.renderTemplate('main.njk', {})).to.be('B(child)');
    });

    it('lets included participants combine explicit payload with caller context', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% block body %}{{ label }}:{{ site }}{% endblock %}');
      loader.addTemplate('child.njk', '{% extends parentName %}{% block body %}{{ super() }}{% endblock %}');
      loader.addTemplate('main.njk', '{% include "child.njk" with context, { parentName: "base.njk", label: "card" } %}');

      expect(await localEnv.renderTemplate('main.njk', { site: 'Example' })).to.be('card:Example');
    });

    it('propagates include payload-selected parent load failures', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '{% extends parentName %}{% block body %}child{% endblock %}');
      loader.addTemplate('main.njk', '{% include "child.njk" with { parentName: "missing-parent.njk" } %}');

      try {
        await localEnv.renderTemplate('main.njk', {});
        expect().fail('Expected missing include-selected parent to fail');
      } catch (error) {
        expect(String(error)).to.contain('missing-parent.njk');
        expect(String(error)).to.contain('child.njk');
      }
    });

    it('propagates participant load failures through include rendering', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '{% extends "missing-parent.njk" %}{% block body %}child{% endblock %}');
      loader.addTemplate('main.njk', [
        'before',
        '{% include "child.njk" %}'
      ].join('\n'));

      try {
        await localEnv.renderTemplate('main.njk', {});
        expect().fail('Expected include participant load failure');
      } catch (error) {
        expect(error.message).to.contain('(child.njk)');
        expect(error.message).to.contain('missing-parent.njk');
      }
    });

    it('propagates participant constructor failures through include rendering', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      const failure = new Error('constructor boom');
      localEnv.addGlobal('explode', () => Promise.reject(failure));
      loader.addTemplate('child.njk', '{% set this.value = explode() %}{{ this.value }}');
      loader.addTemplate('main.njk', [
        'before',
        '{% include "child.njk" %}'
      ].join('\n'));

      try {
        await localEnv.renderTemplate('main.njk', {});
        expect().fail('Expected include participant constructor failure');
      } catch (error) {
        expect(error.message).to.contain('(child.njk)');
        expect(error.message).to.contain('constructor boom');
      }
    });

    it('waits for participant include completion inside limited loops', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      const tracker = { current: 0, max: 0 };
      localEnv.addGlobal('mark', (value) => {
        tracker.current++;
        tracker.max = Math.max(tracker.max, tracker.current);
        return new Promise((resolve) => {
          setTimeout(() => {
            tracker.current--;
            resolve(value);
          }, value === 'A' ? 20 : 5);
        });
      });
      loader.addTemplate('child.njk', '{% set this.value = mark(value) %}{{ this.value }}');
      loader.addTemplate('main.njk', '{% for value in values of 1 %}[{% include "child.njk" with { value: value } %}]{% endfor %}');

      expect(await localEnv.renderTemplate('main.njk', { values: ['A', 'B'] })).to.be('[A][B]');
      expect(tracker.max).to.be(1);
    });

    it('does not share included participant instance state across include sites', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', [
        '{% if this.count %}',
        '{% set this.count = this.count + 1 %}',
        '{% else %}',
        '{% set this.count = 1 %}',
        '{% endif %}',
        '{{ this.count }}'
      ].join(''));
      loader.addTemplate('main.njk', '{% include "child.njk" %}|{% include "child.njk" %}');

      expect(await localEnv.renderTemplate('main.njk', {})).to.be('1|1');
    });

    it('does not expose included participants as caller-side component bindings', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '{% set this.theme = "dark" %}{{ this.theme }}');
      loader.addTemplate('main.njk', '{% include "child.njk" %}|{{ child is defined }}|{{ child.theme }}');

      expect(await localEnv.renderTemplate('main.njk', {})).to.be('dark|false|');
    });

    it('does not expose included participant methods through a caller-side name', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '{% set this.theme = "dark" %}{{ this.theme }}');
      loader.addTemplate('main.njk', '{% include "child.njk" %}|{{ child.build() }}');

      try {
        await localEnv.renderTemplate('main.njk', {});
        expect().fail('Expected missing include component binding failure');
      } catch (error) {
        expect(error.message).to.contain('(main.njk)');
        expect(error.message).to.contain('child["build"]');
      }
    });

    it('does not share nested included participant instance state', async function () {
      const loader = new StringLoader();
      const localEnv = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', [
        '{% if this.count %}',
        '{% set this.count = this.count + 1 %}',
        '{% else %}',
        '{% set this.count = 1 %}',
        '{% endif %}',
        '{{ this.count }}'
      ].join(''));
      loader.addTemplate('wrapper.njk', '[{% include "child.njk" %}]');
      loader.addTemplate('main.njk', '{% include "wrapper.njk" %}|{% include "wrapper.njk" %}');

      expect(await localEnv.renderTemplate('main.njk', {})).to.be('[1]|[1]');
    });
  });

  describe('analysis and validation', function () {
    it('lets inherited methods and template blocks read render context by default', function () {
      const scriptEntries = analyzeCallableEntries('method title()\n  return siteName\nendmethod\nreturn this.title()', { scriptMode: true });
      const templateEntries = analyzeCallableEntries('{% block body %}{{ siteName }}{% endblock %}');

      expect(scriptEntries[0].name).to.be('title');
      expect(templateEntries[0].name).to.be('body');
    });

    it('keeps nested callable shared reads out of the outer inherited callable footprint', function () {
      const props = compileProps([
        'shared var theme',
        'method outer()',
        '  function inner()',
        '    return this.theme',
        '  endfunction',
        '  return "outer"',
        'endmethod',
        'return this.outer()'
      ].join('\n'), { scriptMode: true });

      expect(props.inheritanceSpec.methodEntries.outer.ownLinkedChains).to.eql([]);
    });

    it('keeps local vars with shared names out of inherited callable footprints', function () {
      const props = compileProps([
        'shared var theme',
        'method outer()',
        '  var theme = "local"',
        '  return theme',
        'endmethod',
        'return this.outer()'
      ].join('\n'), { scriptMode: true });

      expect(props.inheritanceSpec.methodEntries.outer.ownLinkedChains).to.eql([]);
    });

    it('records this shared accesses under internal storage names', function () {
      const props = compileProps([
        'shared var theme',
        'method outer()',
        '  return this.theme',
        'endmethod',
        'return this.outer()'
      ].join('\n'), { scriptMode: true });

      expect(props.inheritanceSpec.sharedSchema.$theme.type).to.be('var');
      expect(props.inheritanceSpec.methodEntries.outer.ownLinkedChains).to.eql(['$theme']);
    });

    it('uses only ordered argument names for block signatures', function () {
      const entries = analyzeCallableEntries('{% block item(user = selectedUser) %}{{ user }}{% endblock %}');

      expect(entries[0].signature).to.eql({ argNames: ['user'] });
    });

    it('emits named block placement bindings by declared argument name', function () {
      const props = compileProps('{% set selectedUser = "Ada" %}{% block item(user = selectedUser) %}{{ user }}{% endblock %}');

      expect(props.inheritanceSpec.methodEntries.item.signature).to.eql({ argNames: ['user'] });
    });

    it('supports mixed positional and named block placement bindings', function () {
      const entries = analyzeCallableEntries('{% block item(user, label = selectedLabel) %}x{% endblock %}');

      expect(entries[0].signature).to.eql({ argNames: ['user', 'label'] });
    });

    it('supports keyword defaults in script method signatures', function () {
      const props = compileProps(
        'method label(user, fallback = "guest")\n  return fallback\nendmethod\nreturn this.label(profile)',
        { scriptMode: true }
      );

      expect(props.inheritanceSpec.methodEntries.label.signature).to.eql({ argNames: ['user', 'fallback'] });
    });

    it('requires script this shared access to target a shared declaration', function () {
      [
        'return this.theme',
        'this.theme = "dark"\nreturn null'
      ].forEach((source) => {
        expect(function () {
          new Script(source, env, 'script-missing-shared.script').compileSource();
        }).to.throwException(/this\.theme requires a root shared declaration/);
      });
    });

    it('rejects __proto__ inheritance names before they reach generated maps', function () {
      expect(function () {
        new Script('method __proto__()\n  return 1\nendmethod', env, 'proto-method.script').compileSource();
      }).to.throwException(/reserved/);

      expect(function () {
        new Script('shared var __proto__\nextends none', env, 'proto-shared.script').compileSource();
      }).to.throwException(/reserved/);

      expect(function () {
        new AsyncTemplate('{% block __proto__ %}x{% endblock %}', env, 'proto-block.njk').compileSource();
      }).to.throwException(/reserved/);
    });

    it('rejects bare script method references as inherited method lookups', function () {
      expect(function () {
        new Script(
          'method body()\n  return "x"\nendmethod\nreturn this.body',
          env,
          'bare-script-method.script'
        ).compileSource();
      }).to.throwException(/bare inherited-method references are not supported/);
    });

    it('rejects all template chain declarations', function () {
      ['shared var theme', 'shared text log', 'shared data state', 'shared sequence db', 'data result'].forEach((source) => {
        expect(function () {
          new AsyncTemplate(`{% ${source} %}`, env, `${source.replace(/\s+/g, '-')}.njk`).compile();
        }).to.throwException(/Chain declarations are only supported in script mode/);
      });
    });

    it('treats template this as the reserved inheritance surface', function () {
      const facts = analyzeSource('{{ this.data }}');
      const sharedSchemaInputs = analyzeSharedSchemaInputs('{{ this.data }}');
      const props = compileProps('{{ this.data }}');

      expect(facts.participates).to.be(true);
      expect(sharedSchemaInputs).to.eql([
        { name: '$data', type: 'var', hasDefault: false }
      ]);
      expect(props.inheritanceSpec.sharedSchema.$data.type).to.be('var');
      expect(props.inheritanceSpec.sharedSchema.$data.hasDefault).to.be(false);
    });

    it('allows top-level dynamic template extends to compile', function () {
      expect(function () {
        new AsyncTemplate('{% extends parentTemplate %}{% block body %}x{% endblock %}', env, 'dynamic-extends.njk').compile();
      }).not.to.throwException();
    });

    it('rejects template extends inside runtime control flow', function () {
      [
        '{% if useParent %}{% extends parentTemplate %}{% endif %}',
        '{% if useParent %}{% extends "base.njk" %}{% endif %}',
        '{% for item in items %}{% extends parentTemplate %}{% endfor %}',
        '{% block body %}{% extends parentTemplate %}{% endblock %}'
      ].forEach((source) => {
        expect(function () {
          new AsyncTemplate(source, env, 'nested-dynamic-extends.njk').compile();
        }).to.throwException(/template extends must be a top-level declaration/);
      });
    });

    it('rejects dynamic template extends resolving to no parent through the resolver', async function () {
      const props = compileProps('{% extends parentTemplate %}{% block body %}x{% endblock %}');
      try {
        await props.resolveInheritanceParent.call(
          { path: 'dynamic-null.njk' },
          null,
          { lookup: () => null, path: 'dynamic-null.njk' },
          runtime,
          null,
          null
        );
        expect().fail('Expected null dynamic template extends to fail');
      } catch (error) {
        expect(String(error)).to.contain('template extends must select a parent template');
      }
    });

    it('rejects template declarations before extends', function () {
      [
        ['{% set theme = "dark" %}{% extends parentTemplate %}', /template extends must appear before template code/],
        ['{% block body %}x{% endblock %}{% extends parentTemplate %}', /template extends must appear before template code/],
        ['{% import "macros.njk" as macros %}{% extends parentTemplate %}', /template extends must appear before template code/],
        ['{{ parentTemplate }}{% extends parentTemplate %}', /template extends must appear before template code/]
      ].forEach(([source, message]) => {
        const compile = function () {
          new AsyncTemplate(source, env, 'declaration-before-extends.njk').compile();
        };
        expect(compile).to.throwException(message);
      });
    });

    it('rejects extends expressions that read inferred shared vars', function () {
      expect(function () {
        new AsyncTemplate('{% extends this.parentTemplate %}', env, 'shared-extends-target.njk').compile();
      }).to.throwException(/dynamic extends target cannot read this\.<shared> state/);
    });

    it('infers template shared declarations from analyzed this reads and writes', function () {
      const sharedSchemaInputs = analyzeSharedSchemaInputs(
        '{{ this.theme }}{% block body %}{% set this.mode = "compact" %}{{ this.mode }}{% endblock %}'
      );

      expect(sharedSchemaInputs.sort((left, right) => left.name.localeCompare(right.name))).to.eql([
        { name: '$mode', type: 'var', hasDefault: false },
        { name: '$theme', type: 'var', hasDefault: false },
      ]);
    });

    it('infers template shared declarations without extends or blocks', function () {
      const facts = analyzeSource('{{ this.theme }}');
      const sharedSchemaInputs = analyzeSharedSchemaInputs('{{ this.theme }}');

      expect(facts.participates).to.be(true);
      expect(sharedSchemaInputs).to.eql([
        { name: '$theme', type: 'var', hasDefault: false }
      ]);
    });

    it('keeps template shared reads and inherited calls separate for the same name', function () {
      const facts = analyzeSource('{{ this.card }}{{ this.card() }}');
      const sharedSchemaInputs = analyzeSharedSchemaInputs('{{ this.card }}{{ this.card() }}');

      expect(facts.participates).to.be(true);
      expect(sharedSchemaInputs).to.eql([
        { name: '$card', type: 'var', hasDefault: false }
      ]);
    });

    it('treats template this calls as inherited callable calls without inferring shared vars', function () {
      const facts = analyzeSource('{{ this.card() }}');
      const sharedSchemaInputs = analyzeSharedSchemaInputs('{{ this.card() }}');

      expect(facts.participates).to.be(true);
      expect(sharedSchemaInputs).to.eql([]);
    });

    it('does not let template locals block implicit this shared declarations', function () {
      const facts = analyzeSource('{% set theme = "local" %}{{ this.theme }}');
      const sharedSchemaInputs = analyzeSharedSchemaInputs('{% set theme = "local" %}{{ this.theme }}');

      expect(facts.participates).to.be(true);
      expect(sharedSchemaInputs).to.eql([
        { name: '$theme', type: 'var', hasDefault: false }
      ]);
    });

    it('emits implicit template shared vars in the compiled shared schema', function () {
      const props = compileProps('{% set this.theme = "dark" %}{{ this.theme }}');

      expect(props.inheritanceSpec.sharedSchema.$theme.type).to.be('var');
      expect(props.inheritanceSpec.sharedSchema.$theme.hasDefault).to.be(false);
    });

    it('rejects template shared and block name collisions', function () {
      expect(function () {
        new AsyncTemplate('{{ this.card }}{% block card %}x{% endblock %}', env, 'template-shared-block-collision.njk').compile();
      }).to.throwException(/shared chain 'card' conflicts with method 'card'/);
    });

    it('fails dynamic template extends naturally when context does not provide the target', async function () {
      const props = compileProps('{% extends parentTemplate %}{% block body %}child{% endblock %}');
      try {
        await props.resolveInheritanceParent.call(
          { path: 'missing-dynamic.njk' },
          null,
          {
            lookup() {
              return undefined;
            },
            path: 'missing-dynamic.njk'
          },
          runtime,
          null,
          null
        );
        expect().fail('Expected missing dynamic template extends target to fail');
      } catch (error) {
        expect(String(error)).to.contain('template extends must select a parent template');
      }
    });

    it('ignores whitespace output before template extends', function () {
      const props = compileProps('\n  {# comment #}\n{% extends "base.njk" %}{% block body %}child{% endblock %}');

      expect(props.inheritanceSpec.hasExtends).to.be(true);
    });

    it('computes exact inheritance participation facts', function () {
      const contractedFields = [
        'hasExtends',
        'localExtendsNode',
        'participates'
      ];
      const participants = [
        analyzeSource('{% extends "base.njk" %}'),
        analyzeSource('{% extends parentTemplate %}'),
        analyzeSource('{% block body %}x{% endblock %}'),
        analyzeSource('{{ this.theme }}{% block body %}x{% endblock %}'),
        analyzeSource('shared var theme\nreturn this.theme', { scriptMode: true }),
        analyzeSource('method body()\n  return "x"\nendmethod\nreturn this.body()', { scriptMode: true }),
        analyzeSource('return this.body()', { scriptMode: true }),
        analyzeSource('method body()\n  return super()\nendmethod\nreturn this.body()', { scriptMode: true })
      ];
      const ordinary = [
        analyzeSource('{% set x = 1 %}{% if x %}{{ x }}{% endif %}{% include "part.njk" %}'),
        analyzeSource('var x = 1\nfunction local()\n  return x\nendfunction\nreturn local()', { scriptMode: true })
      ];

      expect(Object.keys(participants[0]).sort()).to.eql(contractedFields);
      participants.forEach((facts) => {
        expect(facts.participates).to.be(true);
      });
      ordinary.forEach((facts) => {
        expect(facts.participates).to.be(false);
      });

      const parentlessScriptFacts = analyzeSource('extends none\nreturn "ok"', { scriptMode: true });
      expect(parentlessScriptFacts.participates).to.be(true);
      expect(parentlessScriptFacts.hasExtends).to.be(false);
      expect(parentlessScriptFacts.localExtendsNode).to.be.ok();
    });

    it('records inherited call and super metadata during analysis', function () {
      const script = new Script(
        [
          'method build(user)',
          '  this.decorate(user)',
          '  return super(user)',
          'endmethod',
          'return this.build(profile)'
        ].join('\n'),
        env,
        'callable-metadata.script'
      );

      script.compile();

      expect(script.inheritanceSpec.methodEntries.__constructor__.inheritedMethodDependencies.build.name).to.be('build');
      expect(script.inheritanceSpec.methodEntries.__constructor__.inheritedMethodDependencies.decorate).to.be(undefined);
      expect(script.inheritanceSpec.methodEntries.__constructor__.super).to.be(false);
      expect(script.inheritanceSpec.methodEntries.build.inheritedMethodDependencies.decorate.name).to.be('decorate');
      expect(script.inheritanceSpec.methodEntries.build.inheritedMethodDependencies.build).to.be(undefined);
      expect(script.inheritanceSpec.methodEntries.build.super).to.be(true);
      expect(script.inheritanceSpec.methodEntries.build.superErrorContextIndex).to.be.a('number');
    });

    it('records root constructor super metadata through callable facts', function () {
      const script = new Script(
        'extends "base.script"\nreturn super()',
        env,
        'root-constructor-super.script'
      );

      script.compile();

      expect(script.inheritanceSpec.methodEntries.__constructor__.super).to.be(true);
      expect(script.inheritanceSpec.methodEntries.__constructor__.superErrorContextIndex).to.be.a('number');
    });
  });
});

