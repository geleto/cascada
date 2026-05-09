// Focused integration tests for the new inheritance runtime.
// Add new inheritance coverage here so the runtime grows against one readable
// end-to-end test surface.

import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import * as runtime from '../../src/runtime/runtime.js';

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

    it('fails clearly when a standalone block uses arguments before arguments are supported', async function () {
      const env = new AsyncEnvironment();

      try {
        await env.renderTemplateString('{% set user = "Ada" %}{% block content(user) %}{{ user }}{% endblock %}');
        expect().fail('Expected block argument failure');
      } catch (err) {
        expect(String(err)).to.contain('arguments are not implemented');
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
  });
});
