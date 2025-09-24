(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var StringLoader;
  var path;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    path = require('path');
    AsyncEnvironment = require('../src/environment').AsyncEnvironment;
    StringLoader = require('./util').StringLoader;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    StringLoader = window.util.StringLoader;
    // eslint-disable-next-line no-unused-vars
    path = {
      join: function () {
        return Array.prototype.join.call(arguments, '/');
      }
    };
  }

  describe('Async mode - error path reporting', function () {
    var loader;
    beforeEach(function () {
      loader = new StringLoader();
    });

    it('should report correct path for basic error', async () => {
      var templateName = 'error-basic.njk';
      loader.addTemplate(templateName, '{{ nonExistentFunction() }}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for included template', async () => {
      var mainTemplateName = 'error-include-main.njk';
      var childTemplateName = 'error-include-child.njk';
      loader.addTemplate(mainTemplateName, '{% include "' + childTemplateName + '" %}');
      loader.addTemplate(childTemplateName, '{{ nonExistentFunction() }}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(mainTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${childTemplateName})`);
      }
    });

    it('should report correct path for error in parent template', async () => {
      var parentTemplateName = 'error-extends-parent.njk';
      var childTemplateName = 'error-extends-child-parent-error.njk';
      loader.addTemplate(parentTemplateName, '{% block content %}{% endblock %} {{ nonExistentFunction() }}');
      loader.addTemplate(childTemplateName, '{% extends "' + parentTemplateName + '" %}{% block content %}Hello{% endblock %}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(childTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${parentTemplateName})`);
      }
    });

    it('should report correct path for error in child template', async () => {
      var parentTemplateName = 'error-extends-parent-child-error.njk';
      var childTemplateName = 'error-extends-child.njk';
      loader.addTemplate(parentTemplateName, '{% block content %}{% endblock %}');
      loader.addTemplate(childTemplateName, '{% extends "' + parentTemplateName + '" %}{% block content %}{{ nonExistentFunction() }}{% endblock %}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(childTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${childTemplateName})`);
      }
    });

    it('should report correct path for imported macro', async () => {
      var mainTemplateName = 'error-macro-main.njk';
      var macroTemplateName = 'error-macro-lib.njk';
      loader.addTemplate(mainTemplateName, '{% import "' + macroTemplateName + '" as lib %}{{ lib.myMacro() }}');
      loader.addTemplate(macroTemplateName, '{% macro myMacro() %}{{ nonExistentFunction() }}{% endmacro %}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(mainTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${macroTemplateName})`);
      }
    });

    it('should report correct path for nested include', async () => {
      var mainTemplateName = 'error-nested-include-main.njk';
      var templateA = 'error-nested-include-a.njk';
      var templateB = 'error-nested-include-b.njk';
      loader.addTemplate(mainTemplateName, '{% include "' + templateA + '" %}');
      loader.addTemplate(templateA, '{% include "' + templateB + '" %}');
      loader.addTemplate(templateB, '{{ nonExistentFunction() }}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(mainTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateB})`);
      }
    });

    it('should report correct path for throwOnUndefined error', async () => {
      var templateName = 'error-throw-on-undefined.njk';
      loader.addTemplate(templateName, '{{ undefinedVar }}');
      let env = new AsyncEnvironment(loader, {
        throwOnUndefined: true
      });
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report (unknown path) for string templates', async () => {
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplateString('{{ nonExistentFunction() }}', {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain('(unknown path)');
      }
    });
  });
})();
