(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var AsyncTemplate;
  var StringLoader;
  var DEFAULT_TEMPLATE_TEXT_OUTPUT;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    const envModule = require('../../src/environment/environment');
    AsyncEnvironment = envModule.AsyncEnvironment;
    AsyncTemplate = envModule.AsyncTemplate;
    StringLoader = require('../util').StringLoader;
    DEFAULT_TEMPLATE_TEXT_OUTPUT = require('../../src/compiler/compile-buffer').DEFAULT_TEMPLATE_TEXT_OUTPUT;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    AsyncTemplate = nunjucks.AsyncTemplate;
    StringLoader = window.util.StringLoader;
  }

  describe('Async template command buffering parity', function () {
    it('should compile async template output to text commands on text output', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{{ value }}', env);
      const source = tmpl._compileSource();
      expect(source).to.contain(`channelName: "${DEFAULT_TEMPLATE_TEXT_OUTPUT}"`);
      expect(source).to.contain('new runtime.TextCommand');
    });

    it('should not emit caller scheduling machinery for macros without caller()', function () {
      const env = new AsyncEnvironment();
      const tmpl = new AsyncTemplate('{% macro plain(x) %}{{ x }}{% endmacro %}{{ plain("v") }}', env);
      const source = tmpl._compileSource();
      expect(source).to.not.contain('__caller__');
      expect(source).to.not.contain('__callerUsedChannels');
    });

    it('should preserve literal/interpolation parity and source ordering', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString('A{{ one() }}B{{ two() }}C', {
        one: async () => '1',
        two: async () => '2'
      });
      expect(result).to.equal('A1B2C');
    });

    it('should preserve loop/conditional output parity', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString(
        '{% for n in nums %}{% if n % 2 === 0 %}E{{ n }}{% else %}O{{ n }}{% endif %}|{% endfor %}',
        { nums: [1, 2, 3, 4] }
      );
      expect(result).to.equal('O1|E2|O3|E4|');
    });

    it('should preserve macro/call/set-block parity', async function () {
      const env = new AsyncEnvironment();
      const template = `
        {% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}
        {% set captured %}X{{ value }}Y{% endset %}
        {% call wrap("span") %}{{ captured }}{% endcall %}
      `;
      const result = await env.renderTemplateString(template, { value: 'v' });
      expect(result.replace(/\s+/g, '')).to.equal('<span>XvY</span>');
    });

    it('should preserve include/import/extends parity', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'B[{% block body %}{% endblock %}]');
      loader.addTemplate('part.njk', '<i>{{ value }}</i>');
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');
      loader.addTemplate(
        'child.njk',
        '{% extends "base.njk" %}{% import "macros.njk" as m %}{% block body %}{% include "part.njk" %} {{ m.hi(user) }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', { value: 'V', user: 'U' });
      expect(result.replace(/\s+/g, ' ').trim()).to.equal('B[<i>V</i> Hi U]');
    });

    it('should keep observed vs unobserved async errors behavior', async function () {
      const env = new AsyncEnvironment();
      const context = {
        bad: async () => {
          throw new Error('boom');
        }
      };

      const safeResult = await env.renderTemplateString('{% if false %}{{ bad() }}{% endif %}ok', context);
      expect(safeResult).to.equal('ok');

      try {
        await env.renderTemplateString('{{ bad() }}', context);
        expect().fail('Expected observed error');
      } catch (err) {
        expect(err.message).to.contain('boom');
      }
    });

    it('should keep imported member calls on the imported-callable boundary', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate('{% import "macros.njk" as m %}{{ m.hi("x") }}', env, 'imported-member-boundary.njk');
      const source = tmpl._compileSource();

      expect(source).to.contain('runtime.memberLookupAsync((currentBuffer.addSnapshot("m"');
      expect(source).to.contain('runtime.callWrapAsync(');
    });

    it('should not treat a macro parameter shadowing a from-import binding as imported callable', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro foo(name) %}Foo {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% from "macros.njk" import foo %}{% macro use(foo) %}{{ foo("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-from-import-call.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('addSnapshot("foo"');
      expect(source).to.not.contain('currentBuffer.addSnapshot("foo"');
    });

    it('should not treat a macro parameter shadowing an imported namespace as imported callable', function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m %}{% macro use(m) %}{{ m("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-import-namespace-call.njk'
      );
      const source = tmpl._compileSource();

      expect(source).to.contain('addSnapshot("m"');
      expect(source).to.not.contain('currentBuffer.addSnapshot("m"');
    });

  });
}());
