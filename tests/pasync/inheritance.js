// Focused integration tests for the new inheritance runtime.
// Add new inheritance coverage here so the runtime grows against one readable
// end-to-end test surface.

import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import * as runtime from '../../src/runtime/runtime.js';
import {StringLoader} from '../util.js';

describe('Inheritance runtime', function () {
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
  });
});
