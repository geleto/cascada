'use strict';

let expect;
let AsyncEnvironment;
let StringLoader;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  StringLoader = require('../util').StringLoader;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  StringLoader = window.util.StringLoader;
}

describe('Template Extends Pre/Post', function () {
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

  it('should carry pre/post set locals into overriding block reads', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('base.njk', 'Base[{% block body %}{{ before }}|{{ after }}{% endblock %}]');
    loader.addTemplate(
      'child.njk',
      '{% set before = "pre" %}{% extends "base.njk" %}{% set after = "post" %}{% block body %}{{ before }}|{{ after }}{% endblock %}'
    );

    const result = await env.renderTemplate('child.njk', {});
    expect(result).to.be('Base[pre|post]');
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
