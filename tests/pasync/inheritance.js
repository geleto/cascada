import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate, Script} from '../../src/environment/environment.js';
import {parse} from '../../src/language/parser.js';
import * as nodes from '../../src/language/nodes.js';
import {transform} from '../../src/language/transformer.js';
import {CompilerAsync} from '../../src/compiler/compiler.js';
import {transpiler as scriptTranspiler} from '../../src/language/script-transpiler.js';
import * as runtime from '../../src/runtime/runtime.js';

function createIdPool() {
  return {
    value: 0,
    next() {
      this.value += 1;
      return this.value;
    }
  };
}

function analyzeSource(src, { scriptMode = false, name = scriptMode ? 'analysis.casc' : 'analysis.njk' } = {}) {
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
  return ast._analysis.inheritance;
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
      const parent = await props.resolveInheritanceParent(null, null, runtime, null);

      expect(Object.keys(props).sort()).to.eql(['inheritanceSpec', 'resolveInheritanceParent', 'root']);
      expect(parent).to.eql({ parentTemplateOrScript: null, origin: null });
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

      expect(Object.keys(props).sort()).to.eql(['inheritanceSpec', 'resolveInheritanceParent', 'root']);
      expect(Object.keys(props.inheritanceSpec).sort()).to.eql(['hasExtends', 'methodEntries', 'sharedSchema']);
      expect(props.inheritanceSpec.setup).to.be(undefined);
      expect(props.inheritanceSpec.invokedMethodRefs).to.be(undefined);
      expect(props.resolveInheritanceParent.length).to.be(4);
      expect(props.inheritanceSpec.methodEntries.build.origin.path).to.be('shape.script');
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
        expect(Object.keys(props).sort()).to.eql(['inheritanceSpec', 'resolveInheritanceParent', 'root']);
      });
    });

    it('emits no removed setup/startup constructs for participants', function () {
      const source = compileSource('{% extends parentTemplate %}{% block body %}x{% endblock %}');

      removedStartupFragments.forEach((fragment) => {
        expect(source).not.to.contain(fragment);
      });
      expect(source).to.contain('async function resolveInheritanceParent(env, context, runtime, origin)');
      expect(source).to.contain('function root(env, context, runtime, cb)');
    });

    it('emits constructor entries only for concrete constructor bodies', function () {
      const concreteScript = compileProps('extends none\nreturn "ok"', { scriptMode: true });
      const concreteTemplate = compileProps('{% block body %}x{% endblock %}');
      const extendingTemplateWithText = compileProps('{% extends "base.njk" %}child text{% block body %}x{% endblock %}');
      const declarationOnlyTemplate = compileProps('{% extends "base.njk" %}{% block body %}x{% endblock %}');

      expect(concreteScript.inheritanceSpec.methodEntries.__constructor__.isConstructor).to.be(true);
      expect(concreteTemplate.inheritanceSpec.methodEntries.__constructor__.isConstructor).to.be(true);
      expect(extendingTemplateWithText.inheritanceSpec.methodEntries.__constructor__.isConstructor).to.be(true);
      expect(extendingTemplateWithText.inheritanceSpec.methodEntries.__constructor__.origin.path).to.be('compiled.njk');
      expect(declarationOnlyTemplate.inheritanceSpec.methodEntries.__constructor__).to.be(undefined);
    });

    it('returns data-only parent selection from a no-extends resolver', async function () {
      const props = compileProps('method build()\n  return 1\nendmethod\nreturn this.build()', {
        scriptMode: true
      });

      expect(await props.resolveInheritanceParent(null, null, runtime, null)).to.eql({
        parentTemplateOrScript: null,
        origin: null
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

  describe('analysis and validation', function () {
    it('lets inherited methods and template blocks read render context by default', function () {
      const scriptFacts = analyzeSource('method title()\n  return siteName\nendmethod\nreturn this.title()', { scriptMode: true });
      const templateFacts = analyzeSource('{% block body %}{{ siteName }}{% endblock %}');

      expect(scriptFacts.methodEntries[0].name).to.be('title');
      expect(templateFacts.methodEntries[0].name).to.be('body');
    });

    it('uses only ordered argument names for block signatures', function () {
      const facts = analyzeSource('{% block item(user = selectedUser) %}{{ user }}{% endblock %}');

      expect(facts.methodEntries[0].signature).to.eql({ argNames: ['user'] });
    });

    it('emits named block placement bindings by declared argument name', function () {
      const props = compileProps('{% set selectedUser = "Ada" %}{% block item(user = selectedUser) %}{{ user }}{% endblock %}');

      expect(props.inheritanceSpec.methodEntries.item.signature).to.eql({ argNames: ['user'] });
    });

    it('supports mixed positional and named block placement bindings', function () {
      const facts = analyzeSource('{% block item(user, label = selectedLabel) %}x{% endblock %}');

      expect(facts.methodEntries[0].signature).to.eql({ argNames: ['user', 'label'] });
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

    it('rejects all template channel declarations', function () {
      ['shared var theme', 'shared text log', 'shared data state', 'shared sequence db', 'data result'].forEach((source) => {
        expect(function () {
          new AsyncTemplate(`{% ${source} %}`, env, `${source.replace(/\s+/g, '-')}.njk`).compile();
        }).to.throwException(/Channel declarations are only supported in script mode/);
      });
    });

    it('treats template this as the reserved inheritance surface', function () {
      const facts = analyzeSource('{{ this.data }}');
      const props = compileProps('{{ this.data }}');

      expect(facts.participates).to.be(true);
      expect(facts.sharedSchemaInputs).to.eql([
        { name: 'data', type: 'var' }
      ]);
      expect(props.inheritanceSpec.sharedSchema).to.eql({ data: 'var' });
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
        await props.resolveInheritanceParent(null, { lookup: () => null, path: 'dynamic-null.njk' }, runtime, null);
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
      }).to.throwException(/cannot read inferred shared var 'this.parentTemplate'/);
    });

    it('infers template shared declarations from analyzed this reads and writes', function () {
      const facts = analyzeSource(
        '{{ this.theme }}{% block body %}{% set this.mode = "compact" %}{{ this.mode }}{% endblock %}'
      );

      expect(facts.sharedSchemaInputs.sort((left, right) => left.name.localeCompare(right.name))).to.eql([
        { name: 'mode', type: 'var' },
        { name: 'theme', type: 'var' },
      ]);
    });

    it('infers template shared declarations without extends or blocks', function () {
      const facts = analyzeSource('{{ this.theme }}');

      expect(facts.participates).to.be(true);
      expect(facts.sharedSchemaInputs).to.eql([
        { name: 'theme', type: 'var' }
      ]);
    });

    it('keeps template shared reads and inherited calls separate for the same name', function () {
      const facts = analyzeSource('{{ this.card }}{{ this.card() }}');

      expect(facts.participates).to.be(true);
      expect(facts.sharedSchemaInputs).to.eql([
        { name: 'card', type: 'var' }
      ]);
    });

    it('treats template this calls as inherited callable calls without inferring shared vars', function () {
      const facts = analyzeSource('{{ this.card() }}');

      expect(facts.participates).to.be(true);
      expect(facts.sharedSchemaInputs).to.eql([]);
    });

    it('does not let template locals block implicit this shared declarations', function () {
      const facts = analyzeSource('{% set theme = "local" %}{{ this.theme }}');

      expect(facts.participates).to.be(true);
      expect(facts.sharedSchemaInputs).to.eql([
        { name: 'theme', type: 'var' }
      ]);
    });

    it('emits implicit template shared vars in the compiled shared schema', function () {
      const props = compileProps('{% set this.theme = "dark" %}{{ this.theme }}');

      expect(props.inheritanceSpec.sharedSchema).to.eql({ theme: 'var' });
    });

    it('rejects template shared and block name collisions', function () {
      expect(function () {
        new AsyncTemplate('{{ this.card }}{% block card %}x{% endblock %}', env, 'template-shared-block-collision.njk').compile();
      }).to.throwException(/shared channel 'card' conflicts with method 'card'/);
    });

    it('resolves dynamic template extends from context before constructor locals', async function () {
      const props = compileProps('{% extends parentTemplate %}{% set parentTemplate = "ignored.njk" %}{% block body %}child{% endblock %}');
      const calls = [];
      const parent = { name: 'base' };
      const origin = { path: 'caller-origin.njk' };
      const result = await props.resolveInheritanceParent({
        async getTemplate(name) {
          calls.push(name);
          return parent;
        }
      }, {
        lookup(name) {
          return name === 'parentTemplate' ? 'base.njk' : undefined;
        },
        path: 'child.njk'
      }, runtime, origin);

      expect(calls).to.eql(['base.njk']);
      expect(result.parentTemplateOrScript).to.be(parent);
      expect(result.origin).to.be(origin);
    });

    it('fails dynamic template extends naturally when context does not provide the target', async function () {
      const props = compileProps('{% extends parentTemplate %}{% set parentTemplate = "base.njk" %}{% block body %}child{% endblock %}');
      try {
        await props.resolveInheritanceParent(null, {
          lookup() {
            return undefined;
          },
          path: 'missing-dynamic.njk'
        }, runtime, null);
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
        'componentOperations',
        'componentSharedObservations',
        'hasDynamicExtends',
        'hasExtends',
        'localExtendsNode',
        'methodEntries',
        'participates',
        'sharedSchemaInputs'
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

      expect(script.inheritanceSpec.methodEntries.__constructor__.invokedMethodRefs.build.name).to.be('build');
      expect(script.inheritanceSpec.methodEntries.__constructor__.invokedMethodRefs.decorate).to.be(undefined);
      expect(script.inheritanceSpec.methodEntries.__constructor__.super).to.be(false);
      expect(script.inheritanceSpec.methodEntries.build.invokedMethodRefs.decorate.name).to.be('decorate');
      expect(script.inheritanceSpec.methodEntries.build.invokedMethodRefs.build).to.be(undefined);
      expect(script.inheritanceSpec.methodEntries.build.super).to.be(true);
      expect(script.inheritanceSpec.methodEntries.build.superOrigin.path).to.be('callable-metadata.script');
    });

    it('records root constructor super metadata through callable facts', function () {
      const script = new Script(
        'extends "base.script"\nreturn super()',
        env,
        'root-constructor-super.script'
      );

      script.compile();

      expect(script.inheritanceSpec.methodEntries.__constructor__.super).to.be(true);
      expect(script.inheritanceSpec.methodEntries.__constructor__.superOrigin.path).to.be('root-constructor-super.script');
    });
  });
});
