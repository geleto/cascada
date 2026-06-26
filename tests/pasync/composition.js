import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate, Environment} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';
import * as runtime from '../../src/runtime/runtime.js';

async function expectRejects(promise) {
  try {
    await promise;
    expect().fail('Expected promise to reject');
  } catch (err) {
    return err;
  }
}

(function () {

  describe('Async mode - dynamic template inheritance', function () {
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

    describe('Dynamic extends with expressions', function () {
      it('should use parent when condition is true', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}default{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if useParent else none %}
			{% block content %}child content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('PARENT[child content]');
      });

      it('should not use parent when condition is false', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}default{% endblock %}]');
        loader.addTemplate('standalone.njk', '{% block content %}{% endblock %}');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if useParent else "standalone.njk" %}
			{% block content %}child content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: false });
        expect(result.trim()).to.equal('child content');
      });

      it('should handle dynamic extends with else branch', async () => {
        loader.addTemplate('parent1.njk', 'PARENT1[{% block content %}{% endblock %}]');
        loader.addTemplate('parent2.njk', 'PARENT2[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent1.njk" if choice == 1 else "parent2.njk" %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { choice: 1 });
        expect(result1.trim()).to.equal('PARENT1[content]');

        const result2 = await env.renderTemplate('child.njk', { choice: 2 });
        expect(result2.trim()).to.equal('PARENT2[content]');
      });
    });

    describe('Multiple blocks with dynamic extends', function () {
      it('should wait for extends before rendering all blocks', async () => {
        loader.addTemplate('parent.njk', `
			PARENT[
			{% block header %}default header{% endblock %}
			{% block content %}default content{% endblock %}
			{% block footer %}default footer{% endblock %}
			]
		  `);
        loader.addTemplate('standalone.njk', `
			{% block header %}{% endblock %}
			{% block content %}{% endblock %}
			{% block footer %}{% endblock %}
		  `);
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if useParent else "standalone.njk" %}
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
			{% extends "parent.njk" if useParent else none %}
			{% block content %}CONTENT{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        const contentCount = (result.match(/CONTENT/g) || []).length;
        expect(contentCount).to.equal(1);
      });
    });

    describe('Nested conditions inside extends expressions', function () {
      it('should handle nested conditions in the parent expression', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}{% endblock %}]');
        loader.addTemplate('standalone.njk', '{% block content %}{% endblock %}');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if outer and inner else "standalone.njk" %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { outer: true, inner: true });
        expect(result1.trim()).to.equal('PARENT[content]');

        const result2 = await env.renderTemplate('child.njk', { outer: true, inner: false });
        expect(result2.trim()).to.equal('content');

        const result3 = await env.renderTemplate('child.njk', { outer: false, inner: true });
        expect(result3.trim()).to.equal('content');
      });

      it('should handle parent selection by switch-like expression', async () => {
        loader.addTemplate('layout1.njk', 'L1[{% block content %}{% endblock %}]');
        loader.addTemplate('layout2.njk', 'L2[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "layout1.njk" if layout == "layout1" else "layout2.njk" %}
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
        loader.addTemplate('standalone.njk', '{% block content %}{% endblock %}');
        loader.addTemplate('child.njk', `
			{% extends parentName if parentName else "standalone.njk" %}
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
			{% extends getParentTemplate() if shouldExtend else null %}
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

    describe('Single dynamic parent selection', function () {
      it('should select between two candidate parents in one extends expression', async () => {
        loader.addTemplate('static-parent.njk', 'STATIC[{% block content %}{% endblock %}]');
        loader.addTemplate('dynamic-parent.njk', 'DYNAMIC[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "dynamic-parent.njk" if useDynamic else "static-parent.njk" %}
			{% block content %}content{% endblock %}
		  `);

        const resultDynamic = await env.renderTemplate('child.njk', { useDynamic: true });
        expect(resultDynamic.trim()).to.equal('DYNAMIC[content]');

        const resultStatic = await env.renderTemplate('child.njk', { useDynamic: false });
        expect(resultStatic.trim()).to.equal('STATIC[content]');
      });

      it('should keep a default parent when the expression selects it', async () => {
        loader.addTemplate('parent.njk', 'PARENT[{% block content %}{% endblock %}]');
        loader.addTemplate('alt-parent.njk', 'ALT[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "alt-parent.njk" if disableExtends else "parent.njk" %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { disableExtends: false });
        expect(result.trim()).to.equal('PARENT[content]');
      });
    });

    describe('Edge cases and error handling', function () {
      it('should handle parent selection from loop-derived outer state', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if items|length > 0 else none %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { items: [1, 2, 3] });
        expect(result.trim()).to.equal('P[content]');
      });

      it('should handle missing parent template gracefully', async () => {
        loader.addTemplate('child.njk', `
			{% extends "nonexistent.njk" if useParent else none %}
			{% block content %}content{% endblock %}
		  `);

        try {
          await env.renderTemplate('child.njk', { useParent: true });
          expect().fail('Should have thrown an error');
        } catch (err) {
          expect(err.message).to.contain('nonexistent.njk');
        }
      });

      it('should work with ignoreMissing on include in dynamic extends', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if useParent else none %}
			{% include "missing.njk" ignore missing %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('P[content]');
      });

      it('should handle super() calls in dynamic extends', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}parent content{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if useParent else none %}
			{% block content %}{{ super() }} + child{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('P[parent content + child]');
      });

      it('should handle include inside dynamic extends when included child emits no local text', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('empty-logic.njk', `

				{% if flag %}
				  {% set local = 1 %}
				{% endif %}
			  `);
        loader.addTemplate('child.njk', `
				{% extends "parent.njk" if useParent else none %}
				{% block content %}
				  {% include "empty-logic.njk" with flag %}
				  content
				{% endblock %}
			  `);

        const result = await env.renderTemplate('child.njk', {
          useParent: true,
          flag: true
        });
        expect(result.replace(/\s+/g, '')).to.equal('P[content]');
      });
    });

    describe('Complex async scenarios', function () {
      it('should handle multiple async operations with dynamic extends', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if asyncCheck() else none %}
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

      it('should maintain correct order with parallel async operations in dynamic extends', async () => {
        loader.addTemplate('parent.njk', 'P[{% block a %}{% endblock %}{% block b %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if shouldExtend else none %}
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

      it('should handle dynamic extends with macros', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('standalone.njk', '{% block content %}{% endblock %}');
        loader.addTemplate('macros.njk', '{% macro test() %}macro content{% endmacro %}');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if useParent else "standalone.njk" %}
			{% block content %}{% import "macros.njk" as m %}{{ m.test() }}{% endblock %}
		  `);

        const resultWithParent = await env.renderTemplate('child.njk', { useParent: true });
        expect(resultWithParent.replace(/\s+/g, ' ').trim()).to.equal('P[macro content]');

        const resultStandalone = await env.renderTemplate('child.njk', { useParent: false });
        expect(resultStandalone.replace(/\s+/g, ' ').trim()).to.equal('macro content');
      });
    });

    describe('Dynamic parent selection precedence', function () {
      it('should handle expression precedence when multiple conditions are true', async () => {
        loader.addTemplate('parent1.njk', 'P1[{% block content %}{% endblock %}]');
        loader.addTemplate('parent2.njk', 'P2[{% block content %}{% endblock %}]');
        loader.addTemplate('child.njk', `
			{% extends "parent2.njk" if cond2 else ("parent1.njk" if cond1 else "parent1.njk") %}
			{% block content %}content{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { cond1: true, cond2: true });
        expect(result.trim()).to.equal('P2[content]');
      });

      it('should handle dynamic extends with filters', async () => {
        loader.addTemplate('parent.njk', 'P[{% block content %}{% endblock %}]');
        loader.addTemplate('standalone.njk', '{% block content %}{% endblock %}');
        loader.addTemplate('child.njk', `
			{% extends templateName if templateName | length > 0 else "standalone.njk" %}
			{% block content %}content{% endblock %}
		  `);

        const result1 = await env.renderTemplate('child.njk', { templateName: 'parent.njk' });
        expect(result1.trim()).to.equal('P[content]');

        const result2 = await env.renderTemplate('child.njk', { templateName: '' });
        expect(result2.trim()).to.equal('content');
      });
    });

    describe('Inheritance chain with dynamic extends', function () {
      it('should work with multi-level inheritance and dynamic extends', async () => {
        loader.addTemplate('grandparent.njk', 'GP[{% block content %}{% endblock %}]');
        loader.addTemplate('parent.njk', `
			{% extends "grandparent.njk" %}
			{% block content %}P-{% block inner %}{% endblock %}{% endblock %}
		  `);
        loader.addTemplate('standalone-parent.njk', '{% block inner %}{% endblock %}');
        loader.addTemplate('child.njk', `
			{% extends "parent.njk" if useParent else "standalone-parent.njk" %}
			{% block inner %}child{% endblock %}
		  `);

        const result = await env.renderTemplate('child.njk', { useParent: true });
        expect(result.trim()).to.equal('GP[P-child]');
      });

      it('should handle dynamic extends in middle of inheritance chain', async () => {
        loader.addTemplate('grandparent.njk', 'GP[{% block content %}{% endblock %}]');
        loader.addTemplate('parent-shell.njk', '{% block content %}{% endblock %}');
        loader.addTemplate('parent.njk', `
			{% extends "grandparent.njk" if extendGrandparent else "parent-shell.njk" %}
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

    it('should compile import bindings as direct storage', () => {
      env = new AsyncEnvironment(loader);
      const namespaceSource = new AsyncTemplate(
        '{% import "lib.njk" as lib %}{{ lib.x }}',
        env,
        'direct-import-namespace.njk'
      ).compileSource();
      const fromImportSource = new AsyncTemplate(
        '{% from "lib.njk" import x %}{{ x }}',
        env,
        'direct-from-import.njk'
      ).compileSource();

      expect(namespaceSource).to.not.contain('declareBufferChain(currentBuffer, "lib", "var"');
      expect(namespaceSource).to.not.contain('chainName: \'lib\'');
      expect(namespaceSource).to.contain('context.addResolvedExport("lib"');
      expect(namespaceSource).to.not.contain('context.addDeferredExport("lib"');

      expect(fromImportSource).to.not.contain('declareBufferChain(currentBuffer, "x", "var"');
      expect(fromImportSource).to.not.contain('chainName: \'x\'');
      expect(fromImportSource).to.contain('context.addResolvedExport("x"');
      expect(fromImportSource).to.not.contain('context.addDeferredExport("x"');
    });

    it('should reject reassignment of import bindings', async () => {
      loader.addTemplate('lib.njk', '{% set x = 1 %}');

      env = new AsyncEnvironment(loader);
      const namespaceError = await expectRejects(
        env.renderTemplateString('{% import "lib.njk" as lib %}{% set lib = 2 %}', {})
      );
      expect(namespaceError.message).to.contain('Cannot assign to import binding');
      expect(namespaceError.message).to.contain('lib');

      const fromImportError = await expectRejects(
        env.renderTemplateString('{% from "lib.njk" import x %}{% set x = 2 %}', {})
      );
      expect(fromImportError.message).to.contain('Cannot assign to import binding');
      expect(fromImportError.message).to.contain('x');
    });

    describe('Load-failure policy', function () {
      it('should validate loadFailFatal at environment construction', () => {
        expect(() => new AsyncEnvironment(loader, { loadFailFatal: 'include' }))
          .to.throwException(/loadFailFatal/);
        expect(() => new AsyncEnvironment(loader, { loadFailFatal: ['root'] }))
          .to.throwException(/Invalid loadFailFatal kind 'root'/);
      });

      it('should not mutate reusable loadFailFatal options', () => {
        const opts = { loadFailFatal: false };

        new AsyncEnvironment(loader, opts);
        new AsyncEnvironment(loader, opts);

        expect(opts.loadFailFatal).to.be(false);
      });

      it('should keep missing imports fatal by default', async () => {
        loader.addTemplate('main.njk', '{% import "missing.njk" as lib %}{{ lib.x }}');

        env = new AsyncEnvironment(loader);
        const err = await expectRejects(env.renderTemplate('main.njk', {}));

        expect(runtime.isRuntimeError(err)).to.be(true);
        expect(err.message).to.match(/missing\.njk/i);
      });

      it('should keep poisoned import targets out of LoadFailed', async () => {
        loader.addTemplate('main.njk', '{% import target as lib %}{{ lib.x }}');
        const poison = runtime.createPoison(runtime.PoisonError.create(
          'target poisoned',
          [1, 1, 'target', 'target-origin.njk', null, null],
          'UserCallThrew'
        ));

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const err = await expectRejects(env.renderTemplate('main.njk', { target: poison }));

        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('UserCallThrew');
        expect(err.kind).not.to.be('LoadFailed');
        expect(err.message).to.contain('target poisoned');
      });

      it('should turn non-fatal missing imports into LoadFailed poison', async () => {
        loader.addTemplate('main.njk', '{% import "missing.njk" as lib %}{{ lib.x }}');

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const err = await expectRejects(env.renderTemplate('main.njk', {}));

        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('LoadFailed');
        expect(err.message).to.match(/missing\.njk/i);
      });

      it('should turn non-fatal import compile failures into LoadFailed poison', async () => {
        loader.addTemplate('broken.njk', '{% if %}');
        loader.addTemplate('main.njk', '{% import "broken.njk" as lib %}{{ lib.x }}');

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const err = await expectRejects(env.renderTemplate('main.njk', {}));

        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('LoadFailed');
      });

      it('should poison from-import bindings with the module load failure', async () => {
        loader.addTemplate('main.njk', '{% from "missing.njk" import a, b %}{{ a is error }}|{{ b is error }}|{{ a#errors[0].kind }}|{{ b#errors[0].kind }}');

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const result = await env.renderTemplate('main.njk', {});

        expect(result).to.be('true|true|LoadFailed|LoadFailed');
      });

      it('should keep missing exports as ImportBindingMissing after a successful load', async () => {
        loader.addTemplate('lib.njk', '{% set present = "ok" %}');
        loader.addTemplate('main.njk', '{% from "lib.njk" import missing %}{{ missing }}');

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const err = await expectRejects(env.renderTemplate('main.njk', {}));

        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('ImportBindingMissing');
      });

      it('should omit non-fatal missing includes', async () => {
        loader.addTemplate('main.njk', 'a{% include "missing.njk" %}b');

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const result = await env.renderTemplate('main.njk', {});

        expect(result).to.be('ab');
      });

      it('should complete limited loop iterations around silenced includes', async () => {
        loader.addTemplate('main.njk', '{% for x in [1,2,3] of 2 %}{{ x }}{% include "missing.njk" %}|{% endfor %}');

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const result = await env.renderTemplate('main.njk', {});

        expect(result).to.be('1|2|3|');
      });

      it('should let ignore missing silence one include under the fatal default', async () => {
        loader.addTemplate('main.njk', 'a{% include "missing.njk" ignore missing %}b');

        env = new AsyncEnvironment(loader);
        const result = await env.renderTemplate('main.njk', {});

        expect(result).to.be('ab');
      });

      it('should not let ignore missing silence invalid included templates', async () => {
        loader.addTemplate('bad.njk', '{% if %}broken{% endif %}');
        loader.addTemplate('main.njk', 'a{% include "bad.njk" ignore missing %}b');

        env = new AsyncEnvironment(loader);
        const err = await expectRejects(env.renderTemplate('main.njk', {}));

        expect(runtime.isRuntimeError(err)).to.be(true);
        expect(err.message).to.contain('bad.njk');
        expect(err.message).to.contain('unexpected token');
      });

      it('should keep target-name expression failures out of LoadFailed', async () => {
        loader.addTemplate('main.njk', '{% include getName() %}');
        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        env.addGlobal('getName', () => Promise.reject(new Error('name exploded')));

        const err = await expectRejects(env.renderTemplate('main.njk', {}));

        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.kind).to.be('UserCallThrew');
        expect(err.kind).not.to.be('LoadFailed');
        expect(err.message).to.contain('name exploded');
      });

      it('should keep public root renders fatal regardless of loadFailFatal', async () => {
        env = new AsyncEnvironment(loader, { loadFailFatal: false });

        const templateErr = await expectRejects(env.renderTemplate('missing.njk', {}));
        const scriptErr = await expectRejects(env.renderScript('missing.casc', {}));

        expect(runtime.isPoisonError(templateErr)).to.be(false);
        expect(runtime.isPoisonError(scriptErr)).to.be(false);
        expect(templateErr.message).to.match(/missing\.njk/i);
        expect(scriptErr.message).to.match(/missing\.casc/i);
      });

      it('should keep extends fatal regardless of loadFailFatal', async () => {
        loader.addTemplate('child.njk', '{% extends "missing-parent.njk" %}{% block content %}x{% endblock %}');

        env = new AsyncEnvironment(loader, { loadFailFatal: false });
        const err = await expectRejects(env.renderTemplate('child.njk', {}));

        expect(runtime.isRuntimeError(err)).to.be(true);
        expect(err.message).to.match(/missing-parent\.njk/i);
      });

      it('should leave sync include ignore-missing behavior untouched', () => {
        loader.addTemplate('main.njk', 'a{% include "missing.njk" ignore missing %}b');
        const syncEnv = new Environment(loader, { loadFailFatal: false });

        const result = syncEnv.renderTemplate('main.njk', {});

        expect(result).to.be('ab');
      });
    });

    it('should resolve async exported values after removing deferred-export visibility linking', async () => {
      loader.addTemplate('lib-async-export.njk', '{% set x = slowValue() %}');
      loader.addTemplate('main.njk', '{% import "lib-async-export.njk" as lib %}{{ lib.x }}');

      env = new AsyncEnvironment(loader);
      env.addGlobal('slowValue', async () => {
        return new Promise((resolve) => setTimeout(() => resolve('async-export'), 10));
      });
      const result = await env.renderTemplate('main.njk', {});

      expect(result).to.equal('async-export');
    });

    it('should re-export read-only root vars through resolved exports', async () => {
      loader.addTemplate('lib-direct-var.njk', '{% set x = slowValue() %}');
      loader.addTemplate('middle-direct-var.njk', '{% from "lib-direct-var.njk" import x %}{% set y = x %}');
      loader.addTemplate('main.njk', '{% from "middle-direct-var.njk" import y %}{{ y }}');

      env = new AsyncEnvironment(loader);
      env.addGlobal('slowValue', () => Promise.resolve('direct-reexport'));

      const middleSource = new AsyncTemplate(
        '{% from "lib-direct-var.njk" import x %}{% set y = x %}',
        env,
        'middle-direct-var.njk'
      ).compileSource();
      expect(middleSource).to.contain('context.addResolvedExport("y"');
      expect(middleSource).to.not.contain('context.addDeferredExport("y"');

      const result = await env.renderTemplate('main.njk', {});
      expect(result).to.equal('direct-reexport');
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
        {% macro fetchData(getData, id) %}
          {{ getData(id).result }}
        {% endmacro %}
        {% macro formatDate(date) %}
          {{ date | date("YYYY-MM-DD") }}
        {% endmacro %}
        {% set apiVersion = "v2" %}
      `);

      loader.addTemplate('main.njk', `
        {% import "api.njk" as api %}
        <div class="api-{{ api.apiVersion }}">
          {{ api.fetchData(getData, userId) }}
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
