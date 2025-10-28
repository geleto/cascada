(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var StringLoader;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    StringLoader = require('../util').StringLoader;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    StringLoader = window.util.StringLoader;
  }

  describe('Async mode - conditional template inheritance', function () {
    var loader;
    var env;

    beforeEach(function () {
      loader = new StringLoader();
      env = new AsyncEnvironment(loader);
    });

    describe('Basic static extends (baseline)', function () {
      it('should work with static extends at top level', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}default{% endblock %}]');
        loader.addTemplate('child.njk', '{% extends "parent.njk" %}{% block content %}child content{% endblock %}');

        const result = await env.renderTemplate('child.njk', {});
        expect(result).to.equal('PARENT[child content]');
      });

      it('should render blocks without parent when no extends', async () => {
        loader.addTemplate('standalone.njk', '{% block content %}standalone content{% endblock %}');

        const result = await env.renderTemplate('standalone.njk', {});
        expect(result).to.equal('standalone content');
      });
    });

    describe('Dynamic extends with conditions', function () {
      it('should use parent when condition is true', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}default{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if useParent %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block content %}child content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('PARENT[child content]');
      });

      it('should not use parent when condition is false', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}default{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if useParent %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block content %}child content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: false });
        expect(result.trim()).to.equal('child content');
      });

      it('should handle dynamic extends with else branch', async () => {
        loader.addTemplate('parent1.njk', 'PARENT1[{% block content %}{% endblock %}]');
        loader.addTemplate('parent2.njk', 'PARENT2[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if choice == 1 %}
			  {% extends "parent1.njk" %}
			{% else %}
			  {% extends "parent2.njk" %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { choice: 1 });
        expect(result1.trim()).to.equal('PARENT1[content]');

        const result2 = await env.renderTemplate('child.njk', { choice: 2 });
        expect(result2.trim()).to.equal('PARENT2[content]');
      });
    });

    describe('Multiple blocks with conditional extends', function () {
      it('should wait for extends before rendering all blocks', async () => {
        loader.addTemplate('parent.njk', `
			PARENT[
			{% block header %}default header{% endblock %}
			{% block content %}default content{% endblock %}
			{% block footer %}default footer{% endblock %}
			]
		  `);
        loader.addTemplate('child.njk', `
			{% if useParent %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block header %}child header{% endblock %}
			{% block content %}child content{% endblock %}
			{% block footer %}child footer{% endblock %}
		  `);

        const resultWithParent = await env.renderTemplate('child.njk', { useParent: true });
        expect(resultWithParent).to.contain('PARENT[');
        expect(resultWithParent).to.contain('child header');
        expect(resultWithParent).to.contain('child content');
        expect(resultWithParent).to.contain('child footer');

        const resultWithoutParent = await env.renderTemplate('child.njk', { useParent: false });
        expect(resultWithoutParent).not.to.contain('PARENT[');
        expect(resultWithoutParent).to.contain('child header');
        expect(resultWithoutParent).to.contain('child content');
        expect(resultWithoutParent).to.contain('child footer');
      });

      it('should not duplicate block content', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if useParent %}{% extends "parent.njk" %}{% endif %}
			{% block content %}CONTENT{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        const contentCount = (result.match(/CONTENT/g) || []).length;
        expect(contentCount).to.equal(1);
      });
    });

    describe('Nested conditionals', function () {
      it('should handle extends in nested if statements', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if outer %}
			  {% if inner %}
				{% extends "parent.njk" %}
			  {% endif %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { outer: true, inner: true });
        expect(result1.trim()).to.equal('PARENT[content]');

        const result2 = await env.renderTemplate('child.njk', { outer: true, inner: false });
        expect(result2.trim()).to.equal('content');

        const result3 = await env.renderTemplate('child.njk', { outer: false, inner: true });
        expect(result3.trim()).to.equal('content');
      });

      it('should handle extends in switch statement', async () => {
        loader.addTemplate('layout1.njk', 'L1[{% block content %}{% endblock %}]');
        loader.addTemplate('layout2.njk', 'L2[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% switch layout %}
			  {% case "layout1" %}
				{% extends "layout1.njk" %}
			  {% case "layout2" %}
				{% extends "layout2.njk" %}
			{% endswitch %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { layout: 'layout1' });
        expect(result1.trim()).to.equal('L1[content]');

        const result2 = await env.renderTemplate('child.njk', { layout: 'layout2' });
        expect(result2.trim()).to.equal('L2[content]');
      });
    });

    describe('Dynamic extends with variables', function () {
      it('should resolve template name from variable', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if parentName %}
			  {% extends parentName %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { parentName: 'parent.njk' });
        expect(result1.trim()).to.equal('PARENT[content]');

        const result2 = await env.renderTemplate('child.njk', { parentName: null });
        expect(result2.trim()).to.equal('content');
      });

      it('should work with async function returning template name', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if shouldExtend %}
			  {% extends getParentTemplate() %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const getParentTemplate = async () => {
          return new Promise(resolve => setTimeout(() => resolve('parent.njk'), 10));
        };

        const result = await env.renderTemplate('child.njk', {
          shouldExtend: true,
          getParentTemplate
        });
        expect(result.trim()).to.equal('PARENT[content]');
      });
    });

    describe('Mixed static and dynamic extends', function () {
      it('should handle both static and dynamic extends (dynamic wins)', async () => {
        loader.addTemplate('static-parent.njk', 'STATIC[{% block content %}{% endblock %}]');
        loader.addTemplate('dynamic-parent.njk', 'DYNAMIC[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "static-parent.njk" %}
			{% if useDynamic %}
			  {% extends "dynamic-parent.njk" %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const resultDynamic = await env.renderTemplate('child.njk', { useDynamic: true });
        expect(resultDynamic.trim()).to.equal('DYNAMIC[content]');

        const resultStatic = await env.renderTemplate('child.njk', { useDynamic: false });
        expect(resultStatic.trim()).to.equal('STATIC[content]');
      });

      it('should handle conditional that overrides static extends with null', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" %}
			{% if disableExtends %}
			  {# This case is tricky - we want NO parent #}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { disableExtends: false });
        expect(result.trim()).to.equal('PARENT[content]');
      });
    });

    describe('Edge cases and error handling', function () {
      it('should handle extends in for loop (edge case)', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% for item in items %}
			  {% if loop.first %}
				{% extends "parent.njk" %}
			  {% endif %}
			{% endfor %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { items: [1, 2, 3] });
        expect(result.trim()).to.equal('P[content]');
      });

      it('should handle missing parent template gracefully', async () => {
        loader.addTemplate('child.njk', `
			{% if useParent %}
			  {% extends "nonexistent.njk" %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        try {
          await env.renderTemplate('child.njk', { useParent: true });
          expect().fail('Should have thrown an error');
        } catch (err) {
          expect(err.message).to.contain('nonexistent.njk');
        }
      });

      it('should work with ignoreMissing on include in conditional extends', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if useParent %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% include "missing.njk" ignore missing %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('P[content]');
      });

      it('should handle super() calls in conditional extends', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}parent content{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if useParent %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block content %}{{ super() }} + child{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('P[parent content + child]');
      });
    });

    describe('Complex async scenarios', function () {
      it('should handle multiple async operations with conditional extends', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if asyncCheck() %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block content %}{{ asyncValue() }}{% endblock %}
		  `);

        const asyncCheck = async () => {
          return new Promise(resolve => setTimeout(() => resolve(true), 10));
        };
        const asyncValue = async () => {
          return new Promise(resolve => setTimeout(() => resolve('async content'), 10));
        };

        const result = await env.renderTemplate('child.njk', { asyncCheck, asyncValue });
        expect(result.trim()).to.equal('P[async content]');
      });

      it('should maintain correct order with parallel async operations', async () => {
        loader.addTemplate('parent.njk', 'P[{% block a %}{% endblock %}{% block b %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if shouldExtend %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block a %}{{ slowAsync() }}{% endblock %}
			{% block b %}{{ fastAsync() }}{% endblock %}
		  `);

        const slowAsync = async () => {
          return new Promise(resolve => setTimeout(() => resolve('slow'), 50));
        };
        const fastAsync = async () => {
          return new Promise(resolve => setTimeout(() => resolve('fast'), 10));
        };

        const result = await env.renderTemplate('child.njk', {
          shouldExtend: true,
          slowAsync,
          fastAsync
        });
        expect(result.trim()).to.equal('P[slowfast]');
      });

      it('should handle conditional extends with macros', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('macros.njk', '{% macro test() %}macro content{% endmacro %}');
        loader.addTemplate('child.njk', `
			{% import "macros.njk" as m %}
			{% if useParent %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block content %}{{ m.test() }}{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('P[macro content]');
      });
    });

    describe('Multiple conditional extends scenarios', function () {
      it('should handle last extends wins when multiple conditionals are true', async () => {
        loader.addTemplate('parent1.njk', 'P1[{% block content %}{% endblock %}]');
        loader.addTemplate('parent2.njk', 'P2[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if cond1 %}
			  {% extends "parent1.njk" %}
			{% endif %}
			{% if cond2 %}
			  {% extends "parent2.njk" %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { cond1: true, cond2: true });
        expect(result.trim()).to.equal('P2[content]');
      });

      it('should handle conditional extends with filters', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% if templateName | length > 0 %}
			  {% extends templateName %}
			{% endif %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { templateName: 'parent.njk' });
        expect(result1.trim()).to.equal('P[content]');

        const result2 = await env.renderTemplate('child.njk', { templateName: '' });
        expect(result2.trim()).to.equal('content');
      });
    });

    describe('Inheritance chain with conditional extends', function () {
      it('should work with multi-level inheritance and conditional extends', async () => {
        loader.addTemplate('grandparent.njk', 'GP[{% block content %}{% endblock %}]');
        loader.addTemplate('parent.njk', `
			{% extends "grandparent.njk" %}
			{% block content %}P-{% block inner %}{% endblock %}{% endblock %}
		  `);
        loader.addTemplate('child.njk', `
			{% if useParent %}
			  {% extends "parent.njk" %}
			{% endif %}
			{% block inner %}child{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('GP[P-child]');
      });

      it('should handle conditional extends in middle of inheritance chain', async () => {
        loader.addTemplate('grandparent.njk', 'GP[{% block content %}{% endblock %}]');
        loader.addTemplate('parent.njk', `
			{% if extendGrandparent %}
			  {% extends "grandparent.njk" %}
			{% endif %}
			{% block content %}P[{% block inner %}{% endblock %}]{% endblock %}
		  `);
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" %}
			{% block inner %}child{% endblock %}
		  `);

        const resultWith = await env.renderTemplate('child.njk', { extendGrandparent: true });
        expect(resultWith.trim()).to.equal('GP[P[child]]');

        const resultWithout = await env.renderTemplate('child.njk', { extendGrandparent: false });
        expect(resultWithout.trim()).to.equal('P[child]');
      });
    });

    it('minimal test of import from external template', async () => {
      loader.addTemplate('exports-simple.njk', '{% set myVar = "hello" %}');
      loader.addTemplate('main.njk', '{% from "exports-simple.njk" import myVar %}{{ myVar }}');

      env = new AsyncEnvironment(loader);
      const result = await env.renderTemplate('main.njk', {});
      // Should work, but currently fails
      expect(result).to.equal('hello');
    });

    it('minimal test - import as namespace', async () => {
      loader.addTemplate('lib.njk', '{% set x = 1 %}');
      loader.addTemplate('main.njk', '{% import "lib.njk" as lib %}{{ lib.x }}');

      env = new AsyncEnvironment(loader);
      const result = await env.renderTemplate('main.njk', {});
      expect(result).to.equal('1');
    });

    it('From import with async macro and values', async () => {
      loader.addTemplate('utils.njk', `
        {% macro formatUser(user) %}
          <div class="user">{{ user.name }} ({{ user.email }})</div>
        {% endmacro %}
        {% set defaultTitle = "Welcome" %}
        {% set version = "1.0" %}
      `);

      loader.addTemplate('main.njk', `
        {% from "utils.njk" import formatUser, defaultTitle, version %}
        <h1>{{ defaultTitle }}</h1>
        {{ formatUser(currentUser) }}
        <footer>v{{ version }}</footer>
      `);

      env = new AsyncEnvironment(loader);
      const result = await env.renderTemplate('main.njk', {
        currentUser: Promise.resolve({ name: 'Alice', email: 'alice@example.com' })
      });

      expect(result).to.contain('<h1>Welcome</h1>');
      expect(result).to.contain('Alice (alice@example.com)');
      expect(result).to.contain('<footer>v1.0</footer>');
    });

    it('Import namespace with async operations', async () => {
      loader.addTemplate('api.njk', `
        {% macro fetchData(id) %}
          {{ getData(id).result }}
        {% endmacro %}
        {% macro formatDate(date) %}
          {{ date | date("YYYY-MM-DD") }}
        {% endmacro %}
        {% set apiVersion = "v2" %}
      `);

      loader.addTemplate('main.njk', `
        {% import "api.njk" as api with context %}
        <div class="api-{{ api.apiVersion }}">
          {{ api.fetchData(userId) }}
          {{ api.formatDate(currentDate) }}
        </div>
      `);

      env = new AsyncEnvironment(loader);
      env.addFilter('date', (val, format) => '2024-01-15');

      const result = await env.renderTemplate('main.njk', {
        userId: Promise.resolve(123),
        currentDate: new Date(),
        getData: async (id) => ({ result: `Data for ${id}` })
      });

      expect(result).to.contain('class="api-v2"');
      expect(result).to.contain('Data for 123');
      expect(result).to.contain('2024-01-15');
    });
  });
})();
