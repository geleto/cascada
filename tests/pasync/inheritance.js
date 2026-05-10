// Focused integration tests for the new inheritance runtime.
// Add new inheritance coverage here so the runtime grows against one readable
// end-to-end test surface.

import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate} from '../../src/environment/environment.js';
import {Context} from '../../src/environment/context.js';
import * as runtime from '../../src/runtime/runtime.js';
import {StringLoader} from '../util.js';

describe('Inheritance runtime', function () {
  describe('metadata-only chain loading', function () {
    async function loadTemplatePlan(loader, templateName, ctx = {}) {
      const env = new AsyncEnvironment(loader);
      const template = await env.getTemplate(templateName, false, null, false);
      const context = new Context(ctx, {}, env, templateName, false);
      const inheritanceState = runtime.createInheritanceState();
      const plan = await runtime.loadInheritanceChain({
        root: template,
        context,
        env,
        runtime,
        inheritanceState,
        origin: {
          lineno: 1,
          colno: 1,
          errorContextString: 'test load',
          path: templateName
        }
      });
      return { env, template, context, inheritanceState, plan };
    }

    async function loadScriptPlan(loader, scriptName, ctx = {}) {
      const env = new AsyncEnvironment(loader);
      const script = await env.getScript(scriptName, false, null, false);
      const context = new Context(ctx, {}, env, scriptName, true);
      const inheritanceState = runtime.createInheritanceState();
      const plan = await runtime.loadInheritanceChain({
        root: script,
        context,
        env,
        runtime,
        inheritanceState,
        origin: {
          lineno: 1,
          colno: 1,
          errorContextString: 'test load',
          path: scriptName
        }
      });
      return { env, script, context, inheritanceState, plan };
    }

    it('loads a static three-level chain child-to-parent without running root code', async function () {
      const loader = new StringLoader();
      const events = [];

      loader.addTemplate('root.njk', 'R{{ mark("root") }}{% block body %}root{% endblock %}');
      loader.addTemplate('mid.njk', '{% extends "root.njk" %}M{{ mark("mid") }}{% block body %}mid{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "mid.njk" %}C{{ mark("child") }}{% block body %}child{% endblock %}');

      const { env, inheritanceState, plan } = await loadTemplatePlan(loader, 'child.njk', {});
      env.addGlobal('mark', (name) => {
        events.push(name);
        return '';
      });

      expect(plan.chain.map((entry) => entry.path)).to.eql(['child.njk', 'mid.njk', 'root.njk']);
      expect(plan.structuralEntry.path).to.be('root.njk');
      expect(plan.hasParent).to.be(true);
      expect(inheritanceState.loading.files).to.have.length(3);
      expect(events).to.eql([]);
    });

    it('loads a static script chain child-to-parent without running root code', async function () {
      const loader = new StringLoader();
      loader.addTemplate('base.script', 'shared text trace\nthis.trace("base|")\nmethod label()\n  return "base"\nendmethod');
      loader.addTemplate('child.script', 'extends "base.script"\nthis.trace("child|")\nmethod label()\n  return "child"\nendmethod');

      const { plan, inheritanceState } = await loadScriptPlan(loader, 'child.script');

      expect(plan.chain.map((entry) => entry.path)).to.eql(['child.script', 'base.script']);
      expect(plan.structuralEntry).to.be(null);
      expect(plan.hasParent).to.be(true);
      expect(inheritanceState.loading.files).to.have.length(2);
    });

    it('fails during metadata loading on a static inheritance cycle', async function () {
      const loader = new StringLoader();
      loader.addTemplate('a.njk', '{% extends "b.njk" %}{% block body %}a{% endblock %}');
      loader.addTemplate('b.njk', '{% extends "a.njk" %}{% block body %}b{% endblock %}');

      try {
        await loadTemplatePlan(loader, 'a.njk');
        expect().fail('Expected cycle detection to fail');
      } catch (err) {
        expect(String(err)).to.contain('Inheritance cycle detected');
        expect(String(err)).to.contain('a.njk -> b.njk -> a.njk');
      }
    });

    it('creates a local-fallback render plan for extends none', async function () {
      const loader = new StringLoader();
      loader.addTemplate('child.njk', '{% extends none %}{% block body %}child{% endblock %}');

      const { plan } = await loadTemplatePlan(loader, 'child.njk');

      expect(plan.chain.map((entry) => entry.path)).to.eql(['child.njk']);
      expect(plan.structuralEntry).to.be(null);
      expect(plan.hasParent).to.be(false);
    });

    it('creates a local-fallback render plan when dynamic extends resolves to none', async function () {
      const loader = new StringLoader();
      loader.addTemplate('child.njk', '{% extends parentName %}{% block body %}child{% endblock %}');

      const { plan } = await loadTemplatePlan(loader, 'child.njk', { parentName: null });

      expect(plan.chain.map((entry) => entry.path)).to.eql(['child.njk']);
      expect(plan.structuralEntry).to.be(null);
      expect(plan.hasParent).to.be(false);
    });

    it('evaluates dynamic parent selection once during metadata loading', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      let calls = 0;
      env.addGlobal('chooseParent', () => {
        calls += 1;
        return 'base.njk';
      });
      loader.addTemplate('base.njk', 'B{% block body %}base{% endblock %}');
      loader.addTemplate('child.njk', '{% extends chooseParent() %}{% block body %}child{% endblock %}');

      const template = await env.getTemplate('child.njk', false, null, false);
      const context = new Context({}, {}, env, 'child.njk', false);
      const inheritanceState = runtime.createInheritanceState();

      const plan = await runtime.loadInheritanceChain({
        root: template,
        context,
        env,
        runtime,
        inheritanceState,
        origin: { lineno: 1, colno: 1, errorContextString: 'test load', path: 'child.njk' }
      });

      expect(calls).to.be(1);
      expect(plan.chain.map((entry) => entry.path)).to.eql(['child.njk', 'base.njk']);
    });

    it('passes context-sourced extends payloads through the metadata render plan', async function () {
      const loader = new StringLoader();
      loader.addTemplate('base.njk', 'B{% block body %}base{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "base.njk" with theme %}{% block body %}child{% endblock %}');

      const { plan } = await loadTemplatePlan(loader, 'child.njk', { theme: 'dark' });

      expect(plan.chain.map((entry) => entry.path)).to.eql(['child.njk', 'base.njk']);
      expect(plan.chain[1].compositionPayload.payloadContext.theme).to.be('dark');
    });

    it('does not evaluate extends payloads when dynamic extends resolves to none', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      let calls = 0;
      env.addGlobal('explode', () => {
        calls += 1;
        throw new Error('payload should not run');
      });
      loader.addTemplate(
        'child.njk',
        '{% extends parentName with { theme: explode() } %}{% block body %}child{% endblock %}'
      );

      const template = await env.getTemplate('child.njk', false, null, false);
      const context = new Context({ parentName: null }, {}, env, 'child.njk', false);
      const inheritanceState = runtime.createInheritanceState();

      const plan = await runtime.loadInheritanceChain({
        root: template,
        context,
        env,
        runtime,
        inheritanceState,
        origin: { lineno: 1, colno: 1, errorContextString: 'test load', path: 'child.njk' }
      });

      expect(calls).to.be(0);
      expect(plan.chain.map((entry) => entry.path)).to.eql(['child.njk']);
    });

    it('rejects dynamic extends that depend on root-program locals during metadata loading', async function () {
      const loader = new StringLoader();
      loader.addTemplate('base.njk', 'B{% block body %}base{% endblock %}');
      loader.addTemplate(
        'child.njk',
        '{% set parentName = "base.njk" %}{% extends parentName %}{% block body %}child{% endblock %}'
      );

      try {
        await loadTemplatePlan(loader, 'child.njk');
        expect().fail('Expected metadata loading to reject a root-program local');
      } catch (err) {
        expect(String(err)).to.contain('dynamic extends cannot depend on locally declared channels or variables');
      }
    });

    it('rejects extends payloads that depend on root-program locals during metadata loading', async function () {
      const loader = new StringLoader();
      loader.addTemplate('base.njk', 'B{% block body %}base{% endblock %}');
      loader.addTemplate(
        'child.njk',
        '{% set theme = "dark" %}{% extends "base.njk" with theme %}{% block body %}child{% endblock %}'
      );

      try {
        await loadTemplatePlan(loader, 'child.njk');
        expect().fail('Expected metadata loading to reject a root-program payload local');
      } catch (err) {
        expect(String(err)).to.contain('dynamic extends cannot depend on locally declared channels or variables');
      }
    });

    it('rejects missing metadata loader entry roots', async function () {
      const inheritanceState = runtime.createInheritanceState();
      const fakeRuntime = {
        resolveSingle(value) {
          return Promise.resolve(value);
        }
      };

      try {
        await runtime.loadInheritanceChain({
          root: null,
          context: { path: 'missing.njk' },
          env: {},
          runtime: fakeRuntime,
          inheritanceState,
          origin: { lineno: 1, colno: 1, errorContextString: 'test load', path: 'missing.njk' }
        });
        expect().fail('Expected missing entry root to fail');
      } catch (err) {
        expect(String(err)).to.contain('loadInheritanceChain requires a selected root');
      }
    });

    it('rejects loading the same inheritance state twice before finalization', async function () {
      const loader = new StringLoader();
      loader.addTemplate('child.njk', '{% block body %}child{% endblock %}');
      const { env, template, context, inheritanceState } = await loadTemplatePlan(loader, 'child.njk');

      try {
        await runtime.loadInheritanceChain({
          root: template,
          context,
          env,
          runtime,
          inheritanceState,
          origin: { lineno: 1, colno: 1, errorContextString: 'test load', path: 'child.njk' }
        });
        expect().fail('Expected second metadata load to fail');
      } catch (err) {
        expect(String(err)).to.contain('Cannot load inheritance chain more than once');
      }
    });

    it('can load metadata without constructing command buffers', async function () {
      const inheritanceState = runtime.createInheritanceState();
      const fakeRoot = {
        path: 'fake.njk',
        scriptMode: false,
        compile() {},
        inheritanceSpec: {
          methodEntries: {},
          sharedSchema: {},
          invokedMethodRefs: {},
          hasExtends: false
        },
        resolveInheritanceParent() {
          return { parentRoot: null, compositionPayload: null, origin: null };
        }
      };
      const fakeRuntime = {
        resolveSingle(value) {
          return value && typeof value.then === 'function'
            ? value
            : Promise.resolve(value);
        }
      };

      const plan = await runtime.loadInheritanceChain({
        root: fakeRoot,
        context: { path: 'fake.njk' },
        env: {},
        runtime: fakeRuntime,
        inheritanceState,
        origin: { lineno: 1, colno: 1, errorContextString: 'test load', path: 'fake.njk' }
      });

      expect(plan.chain.map((entry) => entry.path)).to.eql(['fake.njk']);
      expect(inheritanceState.loading.files).to.have.length(1);
    });
  });

  describe('standalone template blocks', function () {
    it('renders a standalone zero-argument template block at its placement site', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('A{% block content %}B{% endblock %}C');

      expect(result).to.be('ABC');
    });

    it('renders multiple standalone blocks from the finalized method table', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('A{% block first %}B{% endblock %}C{% block second %}D{% endblock %}E');

      expect(result).to.be('ABCDE');
    });

    it('lets a standalone block read render context by default', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('A{% block content %}{{ name }}{% endblock %}C', {
        name: 'Ada'
      });

      expect(result).to.be('AAdaC');
    });

    it('does not let placement locals enter a block without explicit arguments', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('{% set user = "Ada" %}A{% block content %}{{ user or "missing" }}{% endblock %}C');

      expect(result).to.be('AmissingC');
    });

    it('lets render context win over placement locals when no block argument is declared', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('{% set user = "LocalUser" %}A{% block content %}{{ user }}{% endblock %}C', {
        user: 'RenderUser'
      });

      expect(result).to.be('ARenderUserC');
    });

    it('passes a placement-local value as a positional block argument', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('{% set user = "Ada" %}A{% block content(user) %}{{ user }}{% endblock %}C');

      expect(result).to.be('AAdaC');
    });

    it('evaluates a missing placement local against the render context', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('A{% block content(user) %}{{ user }}{% endblock %}C', {
        user: 'Ada'
      });

      expect(result).to.be('AAdaC');
    });

    it('lets placement locals shadow render context even when the local value is none', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('{% set user = none %}A{% block content(user) %}{{ user or "none" }}{% endblock %}C', {
        user: 'RenderUser'
      });

      expect(result).to.be('AnoneC');
    });

    it('passes multiple positional block arguments by signature order', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString(
        '{% set first = "Ada" %}{% set second = "Lovelace" %}{% block name(first, second) %}{{ second }}, {{ first }}{% endblock %}'
      );

      expect(result).to.be('Lovelace, Ada');
    });

    it('passes a local value through a named block argument binding', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('{% set person = "Ada" %}A{% block content(user = person) %}{{ user }}{% endblock %}C');

      expect(result).to.be('AAdaC');
    });

    it('passes a render-context value through a named block argument binding', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('A{% block content(user = person) %}{{ user }}{% endblock %}C', {
        person: 'Ada'
      });

      expect(result).to.be('AAdaC');
    });

    it('passes multiple named block argument bindings by declared name', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString(
        '{% set given = "Ada" %}{% set family = "Lovelace" %}{% block name(first = given, last = family) %}{{ last }}, {{ first }}{% endblock %}'
      );

      expect(result).to.be('Lovelace, Ada');
    });

    it('rejects mixed positional and named block argument bindings', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% set person = "Ada" %}{% block content(user, title = person) %}{{ user }}{% endblock %}');
        expect().fail('Expected mixed block argument binding rejection');
      } catch (err) {
        expect(String(err)).to.contain('block signature cannot mix positional arguments and named bindings');
      }
    });

    it('rejects duplicate named block argument bindings', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% block content(user = first, user = second) %}{{ user }}{% endblock %}');
        expect().fail('Expected duplicate named block argument rejection');
      } catch (err) {
        expect(String(err)).to.contain(`block argument 'user' is declared more than once`);
      }
    });

    it('rejects non-identifier named block argument bindings', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% block content(user.name = person) %}{{ user }}{% endblock %}');
        expect().fail('Expected invalid named block argument rejection');
      } catch (err) {
        expect(String(err)).to.contain('block signature only supports identifier named arguments');
      }
    });

    it('rejects named block argument bindings in static-extending templates', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% block content(user) %}{{ user }}{% endblock %}');

      try {
        await env.renderTemplateString('{% extends "base.njk" %}{% block content(user = person) %}{{ user }}{% endblock %}');
        expect().fail('Expected static-extending named block binding rejection');
      } catch (err) {
        expect(String(err)).to.contain('named block argument bindings require local block placement');
      }
    });

    it('fails clearly when dispatch runs before metadata is finalized', function () {
      const inheritanceState = runtime.createInheritanceState();

      expect(() => {
        runtime.invokeInheritedCallable(inheritanceState, 'content', [], null, null, runtime, null, null);
      }).to.throwException(/requires finalized inheritance metadata/);
    });

    it('fails clearly when metadata bootstrap receives no state', function () {
      expect(() => {
        runtime.bootstrapInheritanceMetadata(null, {
          setup: null,
          methodEntries: {},
          sharedSchema: {},
          invokedMethodRefs: {},
          hasExtends: false
        }, null);
      }).to.throwException(/requires an inheritance state/);
    });

    it('fails clearly when invocation receives too many arguments', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: ['name'] },
            ownerKey: 'test.njk',
            ownLinkedChannels: [],
            ownMutatedChannels: [],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(() => {
        runtime.invokeInheritedCallable(inheritanceState, 'content', ['Ada', 'extra'], null, null, runtime, null, null);
      }).to.throwException(/received too many arguments/);
    });

    it('fails clearly when invocation receives too few arguments', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: ['name'] },
            ownerKey: 'test.njk',
            ownLinkedChannels: [],
            ownMutatedChannels: [],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(() => {
        runtime.invokeInheritedCallable(inheritanceState, 'content', [], null, null, runtime, null, null);
      }).to.throwException(/received too few arguments/);
    });

    it('fails clearly when invocation receives malformed argument metadata', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: ['name', 'title'] },
            ownerKey: 'test.njk',
            ownLinkedChannels: [],
            ownMutatedChannels: [],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(() => {
        runtime.invokeInheritedCallable(inheritanceState, 'content', { values: ['Ada'], names: 'name' }, null, null, runtime, null, null);
      }).to.throwException(/received invalid argument names/);
      expect(() => {
        runtime.invokeInheritedCallable(inheritanceState, 'content', { values: ['Ada', 'Dr.'], names: ['name', 'name'] }, null, null, runtime, null, null);
      }).to.throwException(/received duplicate argument "name"/);
    });

    it('merges invoked callable footprints through cycles', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          first: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'test.njk',
            origin: null,
            ownLinkedChannels: ['firstRead'],
            ownMutatedChannels: ['firstWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: { second: { name: 'second', origin: null } }
          },
          second: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'test.njk',
            origin: null,
            ownLinkedChannels: ['secondRead'],
            ownMutatedChannels: ['secondWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: { first: { name: 'first', origin: null } }
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);

      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(runtime.getCallableLinkedChannels(inheritanceState.methods.first).sort()).to.eql(['firstRead', 'secondRead']);
      expect(runtime.getCallableMutatedChannels(inheritanceState.methods.first).sort()).to.eql(['firstWrite', 'secondWrite']);
      expect(runtime.getCallableLinkedChannels(inheritanceState.methods.second).sort()).to.eql(['firstRead', 'secondRead']);
      expect(runtime.getCallableMutatedChannels(inheritanceState.methods.second).sort()).to.eql(['firstWrite', 'secondWrite']);
    });

    it('merges invoked callable footprints through a linear chain', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          first: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'test.njk',
            origin: null,
            ownLinkedChannels: ['firstRead'],
            ownMutatedChannels: ['firstWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: { second: { name: 'second', origin: null } }
          },
          second: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'test.njk',
            origin: null,
            ownLinkedChannels: ['secondRead'],
            ownMutatedChannels: ['secondWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: { third: { name: 'third', origin: null } }
          },
          third: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'test.njk',
            origin: null,
            ownLinkedChannels: ['thirdRead'],
            ownMutatedChannels: ['thirdWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);

      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(runtime.getCallableLinkedChannels(inheritanceState.methods.first).sort()).to.eql(['firstRead', 'secondRead', 'thirdRead']);
      expect(runtime.getCallableMutatedChannels(inheritanceState.methods.first).sort()).to.eql(['firstWrite', 'secondWrite', 'thirdWrite']);
      expect(runtime.getCallableLinkedChannels(inheritanceState.methods.second).sort()).to.eql(['secondRead', 'thirdRead']);
      expect(runtime.getCallableMutatedChannels(inheritanceState.methods.second).sort()).to.eql(['secondWrite', 'thirdWrite']);
    });

    it('does not merge parent footprints when an override does not call super', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'child.njk',
            origin: null,
            ownLinkedChannels: ['childRead'],
            ownMutatedChannels: ['childWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: true
      }, null);
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'parent.njk',
            origin: null,
            ownLinkedChannels: ['parentRead'],
            ownMutatedChannels: ['parentWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);

      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(runtime.getCallableLinkedChannels(inheritanceState.methods.content)).to.eql(['childRead']);
      expect(runtime.getCallableMutatedChannels(inheritanceState.methods.content)).to.eql(['childWrite']);
    });

    it('validates invoked refs from overridden parent entries', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'child.njk',
            origin: null,
            ownLinkedChannels: [],
            ownMutatedChannels: [],
            super: true,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: true
      }, null);
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'parent.njk',
            origin: null,
            ownLinkedChannels: [],
            ownMutatedChannels: [],
            super: false,
            superOrigin: null,
            invokedMethodRefs: { missing: { name: 'missing', origin: null } }
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);

      expect(() => {
        runtime.finalizeInheritanceMetadata(inheritanceState, null);
      }).to.throwException(/Missing inherited callable "missing"/);
    });

    it('merges parent invoked-callable footprints through super', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'child.njk',
            origin: null,
            ownLinkedChannels: ['childRead'],
            ownMutatedChannels: ['childWrite'],
            super: true,
            superOrigin: null,
            invokedMethodRefs: {}
          },
          helper: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'child.njk',
            origin: null,
            ownLinkedChannels: ['helperRead'],
            ownMutatedChannels: ['helperWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: true
      }, null);
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {},
            signature: { argNames: [] },
            ownerKey: 'parent.njk',
            origin: null,
            ownLinkedChannels: ['parentRead'],
            ownMutatedChannels: ['parentWrite'],
            super: false,
            superOrigin: null,
            invokedMethodRefs: { helper: { name: 'helper', origin: null } }
          }
        },
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);

      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(runtime.getCallableLinkedChannels(inheritanceState.methods.content).sort()).to.eql(['childRead', 'helperRead', 'parentRead']);
      expect(runtime.getCallableMutatedChannels(inheritanceState.methods.content).sort()).to.eql(['childWrite', 'helperWrite', 'parentWrite']);
    });

    it('links only callable footprint shared channels before invocation', function () {
      const inheritanceState = runtime.createInheritanceState();
      const context = null;
      const sharedRootBuffer = new runtime.CommandBuffer(context);
      const currentBuffer = new runtime.CommandBuffer(context, sharedRootBuffer);
      inheritanceState.sharedRootBuffer = sharedRootBuffer;
      runtime.declareInheritanceSharedChannel(sharedRootBuffer, 'theme', 'var', context);
      runtime.declareInheritanceSharedChannel(sharedRootBuffer, 'unused', 'var', context);
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn(env, renderContext, rt, cb, buffer) {
              expect(buffer.getChannelIfExists('theme')).to.be.ok();
              expect(buffer.getChannelIfExists('unused')).to.be(undefined);
              return 'ok';
            },
            signature: { argNames: [] },
            ownerKey: 'test.njk',
            origin: null,
            ownLinkedChannels: ['theme'],
            ownMutatedChannels: [],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: { theme: 'var', unused: 'var' },
        invokedMethodRefs: {},
        hasExtends: false
      }, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      const result = runtime.invokeInheritedCallable(inheritanceState, 'content', [], context, null, runtime, null, currentBuffer);

      expect(result).to.be('ok');
    });

    it('rejects shared links that would hide a local channel of the same name', function () {
      const inheritanceState = runtime.createInheritanceState();
      const context = null;
      const sharedRootBuffer = new runtime.CommandBuffer(context);
      const currentBuffer = new runtime.CommandBuffer(context, sharedRootBuffer);
      inheritanceState.sharedRootBuffer = sharedRootBuffer;
      runtime.declareInheritanceSharedChannel(sharedRootBuffer, 'theme', 'var', context);
      runtime.declareBufferChannel(currentBuffer, 'theme', 'var', context, null);
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {
          content: {
            fn() {
              return 'unreachable';
            },
            signature: { argNames: [] },
            ownerKey: 'test.njk',
            origin: null,
            ownLinkedChannels: ['theme'],
            ownMutatedChannels: [],
            super: false,
            superOrigin: null,
            invokedMethodRefs: {}
          }
        },
        sharedSchema: { theme: 'var' },
        invokedMethodRefs: {},
        hasExtends: false
      }, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(() => {
        runtime.invokeInheritedCallable(inheritanceState, 'content', [], context, null, runtime, null, currentBuffer);
      }).to.throwException((err) => {
        expect(String(err)).to.contain('Cannot link shared channel');
      });
    });
  });

  describe('template inheritance', function () {
    it('renders a child override at the parent block position', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content %}Child{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChildC');
    });

    it('renders the most-derived override through a multi-level parent chain', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('root.njk', 'A{% block content %}Root{% endblock %}C');
      loader.addTemplate('mid.njk', '{% extends "root.njk" %}{% block content %}Mid{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "mid.njk" %}{% block content %}Child{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChildC');
    });

    it('uses parent definitions for non-overridden blocks', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block main %}Base main{% endblock %}B{% block aside %}Base aside{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block main %}Child main{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChild mainBBase asideC');
    });

    it('resolves overrides per block across a multi-level parent chain', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('root.njk', 'A{% block main %}Root main{% endblock %}B{% block aside %}Root aside{% endblock %}C');
      loader.addTemplate('mid.njk', '{% extends "root.njk" %}{% block main %}Mid main{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "mid.njk" %}{% block aside %}Child aside{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AMid mainBChild asideC');
    });

    it('rejects static parent-chain cycles', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('a.njk', '{% extends "b.njk" %}{% block content %}A{% endblock %}');
      loader.addTemplate('b.njk', '{% extends "a.njk" %}{% block content %}B{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "a.njk" %}{% block content %}Child{% endblock %}');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected inheritance cycle rejection');
      } catch (err) {
        expect(String(err)).to.contain('Inheritance cycle detected');
      }
    });

    it('renders the parent block when no child override exists', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('ABaseC');
    });

    it('passes parent block placement arguments into the child override', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% set person = "Ada" %}A{% block content(user = person) %}Base {{ user }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content(user) %}Child {{ user }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChild AdaC');
    });

    it('passes positional parent block placement arguments into the child override', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% set person = "Ada" %}A{% block content(person) %}Base {{ person }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content(user) %}Child {{ user }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChild AdaC');
    });

    it('passes parent block placement arguments into parent fallback blocks', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% set person = "Ada" %}A{% block content(person) %}Base {{ person }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('ABase AdaC');
    });

    it('renders super from the owner-relative parent block', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content %}Child {{ super() }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChild BaseC');
    });

    it('renders super through each owner-relative level', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('root.njk', 'A{% block content %}Root{% endblock %}C');
      loader.addTemplate('mid.njk', '{% extends "root.njk" %}{% block content %}Mid {{ super() }}{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "mid.njk" %}{% block content %}Child {{ super() }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChild Mid RootC');
    });

    it('forwards original arguments through each super level', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('root.njk', '{% set person = "Ada" %}A{% block content(person) %}Root {{ person }}{% endblock %}C');
      loader.addTemplate('mid.njk', '{% extends "root.njk" %}{% block content(midUser) %}Mid {{ midUser }} / {{ super() }}{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "mid.njk" %}{% block content(childUser) %}Child {{ childUser }} / {{ super() }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChild Ada / Mid Ada / Root AdaC');
    });

    it('passes original and explicit arguments to super', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% set person = "Ada" %}A{% block content(person) %}Base {{ person }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content(user) %}Child {{ user }} / {{ super() }} / {{ super("Grace") }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AChild Ada / Base Ada / Base GraceC');
    });

    it('rejects super calls with too many arguments', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content(name) %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content(name) %}{{ super("Ada", "Lovelace") }}{% endblock %}');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected invalid super call rejection');
      } catch (err) {
        expect(String(err)).to.contain('super(...) for block "content" received too many arguments');
      }
    });

    it('rejects super calls with keyword arguments', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content(name) %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content(name) %}{{ super(name = name) }}{% endblock %}');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected keyword super call rejection');
      } catch (err) {
        expect(String(err)).to.contain('super(...) does not support keyword arguments');
      }
    });

    it('rejects super without a parent implementation', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('A{% block content %}{{ super() }}{% endblock %}C');
        expect().fail('Expected missing super parent rejection');
      } catch (err) {
        expect(String(err)).to.contain('uses super() but has no parent implementation');
      }
    });

    it('rejects intermediate super without an ancestor implementation', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('root.njk', 'A{% block other %}Root{% endblock %}C');
      loader.addTemplate('mid.njk', '{% extends "root.njk" %}{% block content %}Mid {{ super() }}{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "mid.njk" %}{% block content %}Child{% endblock %}');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected missing intermediate super parent rejection');
      } catch (err) {
        expect(String(err)).to.contain('uses super() but has no parent implementation');
      }
    });

    it('rejects incompatible override signatures', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content(name, title) %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content(name) %}Child{% endblock %}');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected incompatible signature rejection');
      } catch (err) {
        expect(String(err)).to.contain('signature is not compatible with its parent');
      }
    });

    it('rejects parent named block placement arguments missing from the child override', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{% set person = "Ada" %}A{% block content(user = person) %}Base {{ user }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block content(name) %}Child {{ name }}{% endblock %}');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected parent argument name validation failure');
      } catch (err) {
        expect(String(err)).to.contain('Inherited callable "content" received unknown argument "user"');
      }
    });

    it('dispatches this.blockName to the selected inherited block', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content %}Base {{ this.helper("Ada") }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block helper(name) %}[{{ name }}]{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('ABase [Ada]C');
    });

    it('reads and writes shared vars through this.sharedName in inherited template blocks', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block body %}{{ this.theme }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block body %}{% set this.theme = "dark" %}{{ this.theme }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AdarkC');
    });

    it('reads template startup shared writes from later blocks', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('{% set this.theme = "dark" %}A{% block body %}{{ this.theme }}{% endblock %}C');

      expect(result).to.be('AdarkC');
    });

    it('reads post-extends startup shared writes from inherited block placement', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block body %}{{ this.theme }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% set this.theme = "dark" %}{% block body %}{{ this.theme }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AdarkC');
    });

    it('waits for async post-extends startup before inherited block placement', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      env.addGlobal('ready', () => Promise.resolve(true));
      loader.addTemplate('base.njk', 'A{% block body %}{{ this.theme }}{% endblock %}C');
      loader.addTemplate(
        'child.njk',
        '{% extends "base.njk" %}{% if ready() %}{% set this.theme = "dark" %}{% endif %}{% block body %}{{ this.theme }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AdarkC');
    });

    it('rejects explicit shared declarations in templates', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% shared var theme %}{% block body %}{{ this.theme }}{% endblock %}');
        expect().fail('Expected template shared declaration rejection');
      } catch (err) {
        expect(String(err)).to.contain('Templates infer shared vars from this.<name>');
      }
    });

    it('rejects explicit typed shared declarations in templates', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% shared text log %}{% block body %}{{ this.log }}{% endblock %}');
        expect().fail('Expected template typed shared declaration rejection');
      } catch (err) {
        expect(String(err)).to.contain('Templates infer shared vars from this.<name>');
      }
    });

    it('rejects nested explicit shared declarations in templates with the template-specific diagnostic', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% if true %}{% shared var theme %}{% endif %}{% block body %}{{ this.theme }}{% endblock %}');
        expect().fail('Expected nested template shared declaration rejection');
      } catch (err) {
        expect(String(err)).to.contain('Templates infer shared vars from this.<name>');
      }
    });

    it('rejects shared channel and inherited callable name collisions', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', '{{ this.body }}{% block content %}Base{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}{% block body %}Child{% endblock %}');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected shared/method name conflict');
      } catch (err) {
        expect(String(err)).to.contain('conflicts with shared channel "body"');
      }
    });

    it('rejects missing inherited callable references during finalization', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% block content %}{{ this.missing() }}{% endblock %}');
        expect().fail('Expected missing inherited callable reference');
      } catch (err) {
        expect(String(err)).to.contain('Missing inherited callable "missing"');
      }
    });

    it('rejects missing inherited block dispatch after finalization', function () {
      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, {
        setup: null,
        methodEntries: {},
        sharedSchema: {},
        invokedMethodRefs: {},
        hasExtends: false
      }, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, null);

      expect(() => {
        runtime.invokeInheritedCallable(inheritanceState, 'content', [], null, null, runtime, null, null);
      }).to.throwException(/Missing inherited callable "content"/);
    });

    it('rejects duplicate blocks in one template', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% block content %}One{% endblock %}{% block content %}Two{% endblock %}');
        expect().fail('Expected duplicate block rejection');
      } catch (err) {
        expect(String(err)).to.contain('Block "content" defined more than once');
      }
    });

    it('renders local block placement for literal extends none', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString('{% extends none %}{% block content %}Local{% endblock %}');

      expect(result).to.be('Local');
    });

    it('renders local fallback when dynamic extends resolves to no parent', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '{% extends parentName %}{% block content %}Local{% endblock %}');

      const result = await env.renderTemplate('child.njk', { parentName: null });

      expect(result).to.be('Local');
    });

    it('renders parent placement when dynamic extends resolves to a parent', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends parentName %}{% block content %}Child{% endblock %}');

      const result = await env.renderTemplate('child.njk', { parentName: 'base.njk' });

      expect(result).to.be('AChildC');
    });

    it('waits for dynamic parent selection when a block appears before extends', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% block content %}Child{% endblock %}{% extends parentName %}');

      const result = await env.renderTemplate('child.njk', { parentName: 'base.njk' });

      expect(result).to.be('AChildC');
    });

    it('resolves dynamic parent selection once for multiple block placements', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      let calls = 0;
      env.addGlobal('chooseParent', () => {
        calls += 1;
        return Promise.resolve('base.njk');
      });
      loader.addTemplate('base.njk', 'A{% block one %}1{% endblock %}B{% block two %}2{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends chooseParent() %}{% block one %}X{% endblock %}{% block two %}Y{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});

      expect(result).to.be('AXBYC');
      expect(calls).to.be(1);
    });

    it('propagates dynamic parent selection failures to block placement', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '{% block content %}Child{% endblock %}{% extends parentName %}');

      try {
        await env.renderTemplate('child.njk', { parentName: 'missing.njk' });
        expect().fail('Expected missing dynamic parent rejection');
      } catch (err) {
        expect(String(err)).to.contain('Template not found: missing.njk');
      }
    });

    it('rejects dynamic extends inside template control flow', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.njk', 'A{% block content %}Base{% endblock %}C');
      loader.addTemplate('child.njk', '{% if useParent %}{% extends parentName %}{% endif %}{% block content %}Child{% endblock %}');

      try {
        await env.renderTemplate('child.njk', { useParent: true, parentName: 'base.njk' });
        expect().fail('Expected deferred dynamic extends rejection');
      } catch (err) {
        expect(String(err)).to.contain('dynamic template extends must be a top-level declaration');
      }
    });

    it('does not evaluate local named block bindings when dynamic extends selects a parent', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      env.addGlobal('explode', () => {
        throw new Error('local placement binding should not run');
      });
      loader.addTemplate('base.njk', '{% set person = "Ada" %}A{% block content(user = person) %}Base {{ user }}{% endblock %}C');
      loader.addTemplate('child.njk', '{% extends parentName %}{% block content(user = explode()) %}Child {{ user }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', { parentName: 'base.njk' });

      expect(result).to.be('AChild AdaC');
    });

    it('rejects dynamic template extends cycles clearly', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('a.njk', '{% extends parentName %}{% block content %}A{% endblock %}');
      loader.addTemplate('b.njk', '{% extends "a.njk" %}{% block content %}B{% endblock %}');

      try {
        await env.renderTemplate('a.njk', { parentName: 'b.njk' });
        expect().fail('Expected dynamic inheritance cycle rejection');
      } catch (err) {
        expect(String(err)).to.contain('Inheritance cycle detected');
      }
    });
  });

  describe('script inheritance', function () {
    it('uses the entry script return value after loading parent metadata', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'return "base"');
      loader.addTemplate('child.script', 'extends "base.script"\nreturn "child"');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('child');
    });

    it('dispatches inherited script methods through the finalized callable table', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'method label(name)\n  return "Hello " + name\nendmethod');
      loader.addTemplate('child.script', 'extends "base.script"\nreturn this.label("Ada")');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('Hello Ada');
    });

    it('lets script methods read the render context by default', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'method label(name)\n  return name + "@" + site\nendmethod');
      loader.addTemplate('child.script', 'extends "base.script"\nreturn this.label("Ada")');

      const result = await env.renderScript('child.script', { site: 'cascada' });

      expect(result).to.be('Ada@cascada');
    });

    it('resolves script method super through the owner-relative method chain', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'method label(name)\n  return "base:" + name\nendmethod');
      loader.addTemplate('child.script', 'extends "base.script"\nmethod label(name)\n  return "child:" + super(name)\nendmethod\nreturn this.label("Ada")');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('child:base:Ada');
    });

    it('dispatches this.method from a script method to an ancestor implementation', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'method helper(name)\n  return "base:" + name\nendmethod');
      loader.addTemplate('mid.script', 'extends "base.script"');
      loader.addTemplate('child.script', 'extends "mid.script"\nmethod label(name)\n  return this.helper(name)\nendmethod\nreturn this.label("Ada")');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('base:Ada');
    });

    it('runs script constructor super through the owner-relative constructor chain', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('root.script', 'method noop()\n  return null\nendmethod');
      loader.addTemplate('mid.script', 'shared text trace\nextends "root.script"\nthis.trace("mid|")');
      loader.addTemplate('child.script', 'shared text trace\nextends "mid.script"\nsuper()\nthis.trace("child|")\nreturn this.trace.snapshot()');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('mid|child|');
    });

    it('runs every level in a three-level constructor super chain', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('root.script', 'shared text trace\nthis.trace("root|")');
      loader.addTemplate('mid.script', 'shared text trace\nextends "root.script"\nsuper()\nthis.trace("mid|")');
      loader.addTemplate('child.script', 'shared text trace\nextends "mid.script"\nsuper()\nthis.trace("child|")\nreturn this.trace.snapshot()');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('root|mid|child|');
    });

    it('coalesces repeated bare constructor super calls into one parent startup', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'shared text trace\nthis.trace("base|")');
      loader.addTemplate('child.script', 'shared text trace\nextends "base.script"\nsuper()\nsuper()\nreturn this.trace.snapshot()');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('base|');
    });

    it('rejects constructor super arguments', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'method noop()\n  return null\nendmethod');
      loader.addTemplate('child.script', 'extends "base.script"\nsuper("x")\nreturn null');

      try {
        await env.renderScript('child.script', {});
        expect().fail('Expected constructor super argument rejection');
      } catch (err) {
        expect(String(err)).to.contain('super(...) for method "__constructor__" received too many arguments');
      }
    });

    it('lets topmost constructor super resolve to a no-op', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'method noop()\n  return null\nendmethod');
      loader.addTemplate('child.script', 'extends "base.script"\nsuper()\nreturn "child"');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('child');
    });

    it('ignores ancestor constructor return values when the entry has no return', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'return "base"');
      loader.addTemplate('mid.script', 'extends "base.script"\nreturn "mid"');
      loader.addTemplate('child.script', 'extends "mid.script"');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be(null);
    });

    it('routes shared reads and writes through inherited script methods', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('base.script', 'shared text trace\nmethod add(item)\n  this.trace(item)\n  return "done"\nendmethod');
      loader.addTemplate('child.script', 'shared text trace\nextends "base.script"\nvar result = this.add("method|")\nthis.trace(result)\nreturn this.trace.snapshot()');

      const result = await env.renderScript('child.script', {});

      expect(result).to.be('method|done');
    });
  });

  describe('components', function () {
    it('runs component startup before method calls', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('Component.script', 'shared var item = incoming\nmethod label()\n  return this.item\nendmethod');
      loader.addTemplate('Main.script', 'component "Component.script" as card with { incoming: "ready" }\nreturn card.label()');

      const result = await env.renderScript('Main.script', {});

      expect(result).to.be('ready');
    });

    it('dispatches component methods through the finalized callable table', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('Component.script', 'method label(name)\n  return "Hello " + name\nendmethod');
      loader.addTemplate('Main.script', 'component "Component.script" as card\nreturn card.label("Ada")');

      const result = await env.renderScript('Main.script', {});

      expect(result).to.be('Hello Ada');
    });

    it('keeps component instances independent', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('Component.script', 'shared var item = incoming\nmethod get()\n  return this.item\nendmethod');
      loader.addTemplate('Main.script', [
        'component "Component.script" as left with { incoming: "L" }',
        'component "Component.script" as right with { incoming: "R" }',
        'return [left.get(), right.get()]'
      ].join('\n'));

      const result = await env.renderScript('Main.script', {});

      expect(result).to.eql(['L', 'R']);
    });

    it('observes component shared channels from the caller', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('Component.script', 'shared var theme = incomingTheme');
      loader.addTemplate('Main.script', 'component "Component.script" as card with { incomingTheme: "dark" }\nreturn card.theme');

      const result = await env.renderScript('Main.script', {});

      expect(result).to.be('dark');
    });

    it('observes component shared text channels only through explicit snapshots', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('Component.script', 'shared text log\nthis.log("ready")');
      loader.addTemplate('Main.script', 'component "Component.script" as card\nreturn card.log.snapshot()');

      const result = await env.renderScript('Main.script', {});

      expect(result).to.be('ready');
    });

    it('rejects implicit component reads of non-var shared channels', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('Component.script', 'shared text log\nthis.log("ready")');
      loader.addTemplate('Main.script', 'component "Component.script" as card\nreturn card.log');

      try {
        await env.renderScript('Main.script', {});
        expect().fail('Expected component shared read to fail');
      } catch (error) {
        expect(error).to.be.a(runtime.RuntimeFatalError);
        expect(error.message).to.contain('cannot be used as a bare symbol');
      }
    });

    it('rejects unknown component shared channel observations', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('Component.script', 'shared var theme = "dark"');
      loader.addTemplate('Main.script', 'component "Component.script" as card\nreturn card.missing');

      try {
        await env.renderScript('Main.script', {});
        expect().fail('Expected component shared read to fail');
      } catch (error) {
        expect(error).to.be.a(runtime.RuntimeFatalError);
        expect(error.message).to.contain('Shared channel "missing" was not found');
      }
    });

    it('runs template component instances through the finalized callable table', async function () {
      const env = new AsyncEnvironment();
      const ownerContext = new Context({}, {}, env, 'Main.script', true);
      const ownerBuffer = new runtime.CommandBuffer(ownerContext, null, null, null);
      const template = new AsyncTemplate(
        '{% block label(name) %}Hello {{ name }}{% endblock %}',
        env,
        'Component.njk',
        false
      );

      const instance = await runtime.createComponentInstance({
        templateOrPromise: template,
        payload: {},
        ownerContext,
        env,
        runtime,
        cb: () => {},
        ownerBuffer,
        errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
      });

      const result = await runtime.resolveSingle(instance.callMethod(
        'label',
        runtime.createArray(['Ada']),
        runtime,
        () => {},
        { lineno: 1, colno: 1, path: 'Main.script' }
      ));

      expect(result).to.be('Hello Ada');
    });

    it('rejects operations after an explicit component close', function () {
      const context = { path: 'Component.script' };
      const rootBuffer = new runtime.CommandBuffer(context, null, null, null);
      const instance = new runtime.ComponentInstance({
        context,
        rootBuffer,
        inheritanceState: runtime.createInheritanceState(),
        env: {}
      });

      instance.close();

      expect(() => {
        instance.callMethod(
          'label',
          [],
          runtime,
          () => {},
          { lineno: 1, colno: 1, path: 'Main.script' }
        );
      }).to.throwException((error) => {
        expect(error).to.be.a(runtime.RuntimeFatalError);
        expect(error.message).to.contain('cannot accept new operations');
      });
    });

    it('records constructor startup failures and closes the component buffer', async function () {
      const seenErrors = [];
      const ownerContext = {
        path: 'Main.script',
        getRenderContextVariables() {
          return {};
        },
        forkForComposition(nextPath, rootContext, renderCtx, payloadContext) {
          return { path: nextPath, rootContext, renderCtx, payloadContext };
        }
      };
      const ownerBuffer = new runtime.CommandBuffer(ownerContext, null, null, null);
      let componentRootBuffer = null;
      const constructorError = new runtime.RuntimeFatalError(
        'constructor failed',
        1,
        1,
        null,
        'Component.script'
      );

      try {
        await runtime.createComponentInstance({
          templateOrPromise: {
            compile() {},
            rootRenderFunc(envArg, contextArg, runtimeArg, cbArg, compositionMode, output, inheritanceState) {
              void envArg;
              void runtimeArg;
              void cbArg;
              void compositionMode;
              componentRootBuffer = output;
              runtime.bootstrapInheritanceMetadata(
                inheritanceState,
                {
                  path: 'Component.script',
                  methodEntries: {
                    __constructor__: {
                      fn() {
                        return Promise.reject(constructorError);
                      },
                      signature: { argNames: [] },
                      ownerKey: 'Component.script',
                      origin: { lineno: 1, colno: 1, errorContextString: null, path: 'Component.script' },
                      ownLinkedChannels: [],
                      ownMutatedChannels: [],
                      super: false,
                      superOrigin: null,
                      invokedMethodRefs: {}
                    }
                  },
                  sharedSchema: {},
                  invokedMethodRefs: {},
                  hasExtends: false
                },
                contextArg
              );
            },
            path: 'Component.script'
          },
          payload: {},
          ownerContext,
          env: {},
          runtime,
          cb: (error) => {
            seenErrors.push(error);
          },
          ownerBuffer,
          errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
        });
        expect().fail('Expected component creation to fail');
      } catch (error) {
        expect(error.message).to.contain('constructor failed');
      }

      expect(seenErrors).to.have.length(1);
      expect(seenErrors[0].message).to.contain('constructor failed');
      expect(componentRootBuffer.isFinished()).to.be(true);
    });

    it('rethrows component startup failures on later operations', async function () {
      const seenErrors = [];
      const ownerContext = {
        path: 'Main.script',
        getRenderContextVariables() {
          return {};
        },
        forkForComposition(nextPath, rootContext, renderCtx, payloadContext) {
          return { path: nextPath, rootContext, renderCtx, payloadContext };
        }
      };
      const ownerBuffer = new runtime.CommandBuffer(ownerContext, null, null, null);

      const instance = await runtime.createComponentInstance({
        templateOrPromise: {
          compile() {},
          rootRenderFunc(envArg, contextArg, runtimeArg, cbArg) {
            void envArg;
            void contextArg;
            void runtimeArg;
            setTimeout(() => {
              cbArg(new runtime.RuntimeFatalError(
                'async startup failed',
                1,
                1,
                null,
                'Component.script'
              ));
            }, 10);
          },
          path: 'Component.script'
        },
        payload: {},
        ownerContext,
        env: {},
        runtime,
        cb: (error) => {
          if (error) {
            seenErrors.push(error);
          }
        },
        ownerBuffer,
        errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(seenErrors).to.have.length(1);
      expect(() => {
        instance.callMethod(
          'build',
          [],
          runtime,
          () => {},
          { lineno: 1, colno: 1, path: 'Main.script' }
        );
      }).to.throwException((error) => {
        expect(error).to.be.a(runtime.RuntimeFatalError);
        expect(error.message).to.contain('async startup failed');
      });
    });
  });
});
