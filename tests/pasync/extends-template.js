'use strict';

let expect;
let AsyncEnvironment;
let AsyncTemplate;
let StringLoader;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  AsyncTemplate = environment.AsyncTemplate;
  StringLoader = require('../util').StringLoader;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  AsyncTemplate = nunjucks.AsyncTemplate;
  StringLoader = window.util.StringLoader;
}

describe('Template Extends', function () {
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

      loader.addTemplate('base.njk', 'Base[{% block body %}{{ theme }}{% endblock %}]');
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

      loader.addTemplate('base.njk', 'Base[{% block body %}{{ theme }}{% endblock %}]');
      loader.addTemplate(
        'child.njk',
        '{% shared var theme = "light" %}{% extends "base.njk" %}{% set theme = "dark" %}{% block body %}{{ theme }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', {});
      expect(result).to.be('Base[dark]');
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

  describe('Phase 9 - Template Inheritance Compiled Shape', function () {
    it('should compile template blocks as inherited callable entries with explicit payload args', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% block content(user) %}{{ user }}{% endblock %}', env, 'block-input-vars.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('function b___constructor__(env, context, runtime, cb, output, inheritanceState = null, extendsState = null) {');
      expect(source).to.contain('function b_content(env, context, runtime, cb, parentBuffer = null, blockPayload = null, blockRenderCtx = undefined, inheritanceState = null) {');
      expect(source).to.contain('runtime.invokeInheritedMethod(inheritanceState, "content"');
      expect(source).to.contain('blockPayload && blockPayload.originalArgs');
      expect(source).to.contain('context.forkForComposition("block-input-vars.njk"');
      expect(source).to.contain('contract: {"argNames":["user"],"withContext":false}');
      expect(source).to.not.contain('context.getBlockContract("content")');
      expect(source).to.not.contain('context.createInheritancePayload(');
      expect(source).to.not.contain('blockPayload.localsByTemplate');
      expect(source).to.not.contain('runtime.prepareBlockEntryContext(');
    });

    it('should treat top-level overriding blocks as definition-only under static extends', function () {
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
      expect(source).to.not.contain('runtime.invokeInheritedMethod(inheritanceState, "content"');
      expect(source).to.not.contain('context.getBlockContract("content")');
      expect(source).to.not.contain('context.getAsyncBlock(');
    });

    it('should compile async super() through invokeSuperMethod', function () {
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
      expect(source).to.not.contain('context.getBlockContract(');
      expect(source).to.not.contain('context.createSuperInheritancePayload(');
      expect(source).to.not.contain('context.getAsyncSuper(');
    });

    it('should compile imported member calls against invokeCallableAsync', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate('{% import "macros.njk" as m %}{{ m.hi("x") }}', env, 'imported-member-boundary.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.memberLookupAsync((runtime.channelLookup("m", currentBuffer)),"hi"');
      expect(source).to.contain('runtime.callWrapAsync(');
    });
  });
});
