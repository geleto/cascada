'use strict';

import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';

describe('Template Extends', function () {
  describe('Phase 9 - Generic Template Root Equivalence', function () {
    it('should keep plain-template top-level locals out of plain block scope', async function () {
      const env = new AsyncEnvironment();

      const result = await env.renderTemplateString(
        '{% set suffix = "local" %}{% block content %}{{ suffix }}{% endblock %}',
        {}
      );

      expect(result.trim()).to.be('');
    });

    it('should keep plain-template top-level locals visible to exported macros', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate(
        'lib.njk',
        '{% set label = "plain-label" %}{% macro show() %}{{ label }}{% endmacro %}'
      );
      loader.addTemplate('main.njk', '{% import "lib.njk" as lib %}{{ lib.show() }}');

      const result = await env.renderTemplate('main.njk', {});
      expect(result).to.be('plain-label');
    });
  });

  describe('Phase 9 - Template Extends Pre/Post', function () {
    it('should run child template code before and after static extends', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'Base[{% block body %}base{% endblock %}]');
      loader.addTemplate('child.njk', 'pre|{% extends "base.njk" %}{% block body %}child{% endblock %}|post');

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('pre|Base[child]|post');
    });

    it('should keep block overriding and super() working through the constructor path', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('grand.njk', 'Grand[{% block body %}grand{% endblock %}]');
      loader.addTemplate('parent.njk', '{% extends "grand.njk" %}{% block body %}parent>{{ super() }}{% endblock %}');
      loader.addTemplate('child.njk', 'pre|{% extends "parent.njk" %}{% block body %}child>{{ super() }}{% endblock %}|post');

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('pre|Grand[child>parent>grand]|post');
    });

    it('should preserve pre/post ordering through a multi-level static extends chain', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('grand.njk', 'Grand[{% block body %}grand{% endblock %}]');
      loader.addTemplate('parent.njk', 'parent-pre|{% extends "grand.njk" %}{% block body %}parent>{{ super() }}{% endblock %}|parent-post');
      loader.addTemplate('child.njk', 'child-pre|{% extends "parent.njk" %}{% block body %}child>{{ super() }}{% endblock %}|child-post');

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('child-pre|parent-pre|Grand[child>parent>grand]|parent-post|child-post');
    });

    it('should keep shared state consistent across top-level constructor code and block bodies', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', '{% shared var theme %}Base[{% block body %}{{ theme }}{% endblock %}]');
      loader.addTemplate('child.njk', '{% shared var theme = "light" %}{% set theme = "dark" %}{% extends "base.njk" %}');

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('Base[dark]');
    });

    it('should pass parent block arguments into overriding blocks through inherited dispatch', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'Base[{% block body(user) %}{{ user }}{% endblock %}]');
      loader.addTemplate(
        'child.njk',
        '{% extends "base.njk" %}{% block body %}{{ user }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', { user: 'Ada' });
      expect(result).to.be('Base[Ada]');
    });

    it('should expose render-context bare names through inherited block calls with context', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'Base[{% block body with context %}{{ site }}{% endblock %}]');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}');

      const result = await env.renderTemplate('child.njk', { site: 'Example' });
      expect(result).to.be('Base[Example]');
    });

    it('should let post-extends shared mutations flow into overriding block reads', async function () {
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

    it('should not treat undeclared parent shared vars as ordinary bare symbols in child templates', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate(
        'base.njk',
        '{% shared var theme = "light" %}{% set theme = "dark" %}Base[{% block body %}{{ theme }}{% endblock %}]'
      );
      loader.addTemplate(
        'child.njk',
        '{% extends "base.njk" %}{% block body %}child={{ theme }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('Base[child=]');
    });

    it('should preserve async ordering across pre-extends, parent render, and post-extends code', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

      loader.addTemplate('base.njk', 'Base[{% block body %}{{ waitAndGet("parent|", 10) }}{% endblock %}]');
      loader.addTemplate(
        'child.njk',
        '{{ waitAndGet("pre|", 20) }}{% extends "base.njk" %}{% block body %}child|{{ super() }}{% endblock %}{{ waitAndGet("|post", 5) }}'
      );

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('pre|Base[child|parent|]|post');
    });

    it('should let a static child continue correctly through a dynamically-extending parent', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('grand.njk', 'Grand[{% block body %}grand{% endblock %}]');
      loader.addTemplate('parent.njk', 'parent-pre|{% extends layout %}{% block body %}parent>{{ super() }}{% endblock %}|parent-post');
      loader.addTemplate('child.njk', 'child-pre|{% extends "parent.njk" %}{% block body %}child>{{ super() }}{% endblock %}|child-post');

      const result = await env.renderTemplate('child.njk', { layout: 'grand.njk' });
      expect(result).to.be('child-pre|parent-pre|Grand[child>parent>grand]|parent-post|child-post');
    });

    it('should pass extends-with payload through intermediate template parents unchanged', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', '{% block body %}Base[{{ theme }}]{% endblock %}');
      loader.addTemplate('parent.njk', '{% extends "base.njk" %}{% block body %}{{ super() }}{% endblock %}');
      loader.addTemplate('child.njk', '{% set theme = "dark" %}{% extends "parent.njk" with theme %}{% block body %}{{ super() }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('Base[dark]');
    });

    it('should pass object-style extends-with payload through intermediate template parents unchanged', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', '{% block body %}Base[{{ theme }}:{{ label }}]{% endblock %}');
      loader.addTemplate('parent.njk', '{% extends "base.njk" %}{% block body %}{{ super() }}{% endblock %}');
      loader.addTemplate('child.njk', '{% set childTheme = "dark" %}{% extends "parent.njk" with { theme: childTheme, label: "main" } %}{% block body %}{{ super() }}{% endblock %}');

      const result = await env.renderTemplate('child.njk', { theme: 'render' });
      expect(result).to.be('Base[dark:main]');
    });

    it('should honor without context on template extends payload root', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'Base[{{ site }}]');
      loader.addTemplate('child.njk', '{% extends "base.njk" without context %}');

      const result = await env.renderTemplate('child.njk', { site: 'Example' });
      expect(result).to.be('Base[]');
    });

    it('should render through an ancestor template constructor when the child has no local constructor body', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'base-pre|Base[{% block body %}base{% endblock %}]|base-post');
      loader.addTemplate('child.njk', '{% extends "base.njk" %}');

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('base-pre|Base[base]|base-post');
    });

    it('should skip a constructorless middle template and still render the ancestor constructor body', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('grand.njk', 'grand-pre|Grand[{% block body %}grand{% endblock %}]|grand-post');
      loader.addTemplate('parent.njk', '{% extends "grand.njk" %}');
      loader.addTemplate('child.njk', '{% extends "parent.njk" %}');

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('grand-pre|Grand[grand]|grand-post');
    });

    it('should let dynamic extends without a local constructor body fall through to the selected parent', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'Base[ok]');
      loader.addTemplate('child.njk', '{% extends layout if useParent else none %}');

      const withParent = await env.renderTemplate('child.njk', {
        useParent: true,
        layout: 'base.njk'
      });
      const withoutParent = await env.renderTemplate('child.njk', {
        useParent: false,
        layout: 'base.njk'
      });

      expect(withParent).to.be('Base[ok]');
      expect(withoutParent).to.be('');
    });

    it('should reject cyclic template extends chains clearly', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('a.njk', '{% extends "b.njk" %}');
      loader.addTemplate('b.njk', '{% extends "a.njk" %}');

      try {
        await env.renderTemplate('a.njk', {});
        expect().fail('Expected cyclic template extends chain to fail');
      } catch (err) {
        expect(String(err)).to.contain('Cyclic extends chain detected');
      }
    });

    it('should reject cyclic dynamic template extends chains clearly', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('a.njk', '{% extends layout %}');
      loader.addTemplate('b.njk', '{% extends "a.njk" %}');

      try {
        await env.renderTemplate('a.njk', { layout: 'b.njk' });
        expect().fail('Expected cyclic dynamic template extends chain to fail');
      } catch (err) {
        expect(String(err)).to.contain('Cyclic extends chain detected');
      }
    });

    it('should fail cleanly when a static parent template cannot be loaded', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('child.njk', 'child-pre|{% extends "missing-base.njk" %}|child-post');

      try {
        await env.renderTemplate('child.njk', {});
        expect().fail('Expected render to fail');
      } catch (err) {
        expect(String(err)).to.contain('missing-base.njk');
      }
    });

    it('should keep exported macros from a static-extends template bound to the template composition context', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'Base[{% block body %}base{% endblock %}]');
      loader.addTemplate(
        'child.njk',
        '{% set label = "child-label" %}{% extends "base.njk" %}{% macro show() %}{{ label }}{% endmacro %}{% block body %}child{% endblock %}'
      );
      loader.addTemplate('consumer.njk', '{% import "child.njk" as child %}{{ child.show() }}');

      const result = await env.renderTemplate('consumer.njk', {});
      expect(result).to.be('child-label');
    });
  });

  describe('Phase 9 - Template Lookup And Dispatch Semantics', function () {
    it('should keep undeclared async-template bare names on ordinary ambient lookup', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString('{{ theme }}', { theme: 'ctx-theme' });

      expect(result).to.be('ctx-theme');
    });
  });
});
