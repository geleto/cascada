import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate, Script} from '../../src/environment/environment.js';
import {parse} from '../../src/language/parser.js';
import {transform} from '../../src/language/transformer.js';
import {CompilerAsync} from '../../src/compiler/compiler.js';
import {transpiler as scriptTranspiler} from '../../src/language/script-transpiler.js';
import {StringLoader} from '../util.js';

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

describe('Inheritance rebuild', function () {
  let env;

  beforeEach(function () {
    env = new AsyncEnvironment();
  });

  describe('parser and transpiler surface', function () {
    it('accepts and renders script extends none as a parentless inheritance participant', async function () {
      const plainResult = await env.renderScriptString(
        'extends none\nreturn "ok"',
        {}
      );
      const methodResult = await env.renderScriptString(
        'extends none\nmethod buildValue()\n  return 1\nendmethod\nreturn this.buildValue()',
        {}
      );

      expect(plainResult).to.be('ok');
      expect(methodResult).to.be(1);
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

  describe('analysis and validation', function () {
    it('lets inherited methods and template blocks read render context by default', async function () {
      const scriptResult = await env.renderScriptString(
        'method title()\n  return siteName\nendmethod\nreturn this.title()',
        { siteName: 'Docs' }
      );
      const templateResult = await env.renderTemplateString(
        '{% block body %}{{ siteName }}{% endblock %}',
        { siteName: 'Docs' }
      );

      expect(scriptResult).to.be('Docs');
      expect(templateResult).to.be('Docs');
    });

    it('uses only ordered argument names for block signatures', function () {
      const facts = analyzeSource('{% block item(user = selectedUser) %}{{ user }}{% endblock %}');

      expect(facts.methodEntries[0].signature).to.eql({ argNames: ['user'] });
    });

    it('passes named block placement bindings by declared argument name', async function () {
      const result = await env.renderTemplateString(
        '{% set selectedUser = "Ada" %}{% block item(user = selectedUser) %}{{ user }}{% endblock %}',
        {}
      );

      expect(result).to.be('Ada');
    });

    it('rejects mixed positional and named block placement bindings', function () {
      expect(function () {
        new AsyncTemplate('{% block item(user, label = selectedLabel) %}x{% endblock %}', env, 'mixed-block-bindings.njk').compile();
      }).to.throwException(/cannot mix positional and named bindings/);
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

    it('treats template this as the reserved inheritance surface', async function () {
      const result = await env.renderTemplateString('{{ this.data }}', { this: { data: 42 } });
      const facts = analyzeSource('{{ this.data }}');

      expect(result).to.be('');
      expect(facts.participates).to.be(true);
      expect(facts.sharedSchemaInputs).to.eql([
        { name: 'data', type: 'var' }
      ]);
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

    it('rejects dynamic template extends resolving to no parent at runtime', async function () {
      try {
        await env.renderTemplateString('{% extends parentTemplate %}{% block body %}x{% endblock %}', { parentTemplate: null });
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

    it('renders implicit template shared vars', async function () {
      const result = await env.renderTemplateString('{% set this.theme = "dark" %}{{ this.theme }}');

      expect(result).to.be('dark');
    });

    it('rejects template shared and block name collisions', function () {
      expect(function () {
        new AsyncTemplate('{{ this.card }}{% block card %}x{% endblock %}', env, 'template-shared-block-collision.njk').compile();
      }).to.throwException(/shared channel 'card' conflicts with method 'card'/);
    });

    it('resolves dynamic template extends from context before constructor locals', async function () {
      const loader = new StringLoader();
      loader.addTemplate('base.njk', 'Base:{% block body %}base{% endblock %}');
      const templateEnv = new AsyncEnvironment(loader);
      const result = await templateEnv.renderTemplateString(
        '{% extends parentTemplate %}{% set parentTemplate = "ignored.njk" %}{% block body %}child{% endblock %}',
        { parentTemplate: 'base.njk' }
      );

      expect(result).to.be('Base:child');
    });

    it('fails dynamic template extends naturally when context does not provide the target', async function () {
      try {
        await env.renderTemplateString('{% extends parentTemplate %}{% set parentTemplate = "base.njk" %}{% block body %}child{% endblock %}');
        expect().fail('Expected missing dynamic template extends target to fail');
      } catch (error) {
        expect(String(error)).to.contain('template extends must select a parent template');
      }
    });

    it('ignores whitespace output before template extends', async function () {
      const loader = new StringLoader();
      loader.addTemplate('base.njk', 'Base:{% block body %}base{% endblock %}');
      const templateEnv = new AsyncEnvironment(loader);
      const result = await templateEnv.renderTemplateString(
        '\n  {# comment #}\n{% extends "base.njk" %}{% block body %}child{% endblock %}'
      );

      expect(result).to.be('Base:child');
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

      expect(script.inheritanceSpec.invokedMethodRefs.build.name).to.be('build');
      expect(script.inheritanceSpec.invokedMethodRefs.decorate.name).to.be('decorate');
      expect(script.inheritanceSpec.methodEntries.build.invokedMethodRefs.decorate.name).to.be('decorate');
      expect(script.inheritanceSpec.methodEntries.build.invokedMethodRefs.build).to.be(undefined);
      expect(script.inheritanceSpec.methodEntries.build.super).to.be(true);
      expect(script.inheritanceSpec.methodEntries.build.superOrigin.path).to.be('callable-metadata.script');
    });
  });
});
