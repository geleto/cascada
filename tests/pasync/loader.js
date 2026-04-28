import expect from 'expect.js';
import he from 'he';
import {StringLoader} from '../util.js';

const {AsyncEnvironment} = typeof window !== 'undefined'
  ? window.nunjucks
  : await import('../../src/environment/environment.js');

(function () {

  const {unescape} = he;
  //var Environment;

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Async mode with loaded templates', () => {
    let loader;
    let env;
    beforeEach(() => {
      loader = new StringLoader();
      env = new AsyncEnvironment(loader);
    });

    describe('Precompiled templates', () => {
      it('Should fail to get a non-existent template', async () => {
        try {
          await env.getTemplate('non-existent.njk');
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error instanceof Error).to.equal(true);
          expect(error.message).to.contain('Template not found');
        }
      });
    });


    describe('Async Import Tests', () => {
      describe('Basic Import', () => {
        beforeEach(() => {
          // Add template with macros
          loader.addTemplate('forms.njk', `
            {%- macro field(name, value='', type='text') -%}
            <div class="field">
            <input type="{{ type }}" name="{{ name }}" value="{{ value | escape }}" />
            </div>
            {%- endmacro -%}

            {%- macro label(text) -%}
            <div>
            <label>{{ text }}</label>
            </div>
            {%- endmacro -%}
          `);
        });

        it('should handle import with async values in macro calls', async () => {
          const context = {
            async getFieldName() {
              await delay(5);
              return 'username';
            },
            async getFieldValue() {
              await delay(3);
              return 'john_doe';
            }
          };

          const template = `
            {%- import "forms.njk" as forms -%}
            {{ forms.field(getFieldName(), getFieldValue()) }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<div class="field">
            <input type="text" name="username" value="john_doe" />
            </div>`
          );
        });

        it('should handle from import with async values', async () => {
          const context = {
            async getLabelText() {
              await delay(5);
              return 'Enter Username:';
            }
          };

          const template = `
            {% from "forms.njk" import field, label %}
            {{ label(getLabelText()) }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<div>
            <label>Enter Username:</label>
            </div>`
          );
        });

        it('should not export macros declared inside blocks', async () => {
          loader.addTemplate('block-macro-lib.njk',
            '{% block body %}{% macro hidden() %}H{% endmacro %}{% endblock %}{% macro visible() %}V{% endmacro %}');

          const template = `
            {% import "block-macro-lib.njk" as lib %}
            {{ lib.visible() }}{% if lib.hidden %}|hidden{% endif %}
          `;

          const result = await env.renderTemplateString(template);
          expect(result.trim()).to.equal('V');
        });

        it('should not export macros declared only inside inherited blocks', async () => {
          loader.addTemplate('inherit-macro-base.njk',
            '{% block body %}base body{% endblock %}');
          loader.addTemplate('inherit-macro-child.njk',
            '{% extends "inherit-macro-base.njk" %}{% macro top() %}T{% endmacro %}{% block body %}{{ super() }}{% macro hiddenChild() %}C{% endmacro %}{% endblock %}');

          const template = `
            {% import "inherit-macro-child.njk" as lib %}
            {{ lib.top() }}{% if lib.hiddenChild %}|child{% endif %}
          `;

          const result = await env.renderTemplateString(template);
          expect(result.trim()).to.equal('T');
        });
      });

      describe('Import isolation', () => {
        beforeEach(() => {
          // Add template that uses context variables
          loader.addTemplate('context-forms.njk', `
            {%- macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}

            {%- macro statusLabel() -%}
            <label>Status: {{ status }}</label>
            {%- endmacro -%}
          `);
        });

        it('should allow async import with context to read render-context properties', async () => {
          const context = {
            username: Promise.resolve('john_doe'),
            status: Promise.resolve('active')
          };

          const result = await env.renderTemplateString(`
            {% import "context-forms.njk" as forms with context %}
            {{ forms.userField() }}
            {{ forms.statusLabel() }}
          `, context);
          expect(unescape(result.replace(/\s+/g, ' ').trim())).to.equal(
            '<input name="user" value="john_doe" /> <label>Status: active</label>'
          );
        });

        it('should not have access to context without with context', async () => {
          const context = {
            username: Promise.resolve('john_doe')
          };

          const template = `
            {% import "context-forms.njk" as forms %}
            {{ forms.userField() }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result.trim())).to.equal(
            '<input name="user" value="" />'
          );
        });

        it('should allow async from-import with context to read render-context properties', async () => {
          const context = {
            username: Promise.resolve('john_doe')
          };

          const result = await env.renderTemplateString(`
            {% from "context-forms.njk" import userField with context %}
            {{ userField() }}
          `, context);
          expect(unescape(result.trim())).to.equal('<input name="user" value="john_doe" />');
        });

        it('should allow async import explicit named with inputs for payload-backed imports', async () => {
          loader.addTemplate('payload-import-with-vars.njk', `

            {% macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% import "payload-import-with-vars.njk" as forms with username %}
            {{ forms.userField() }}
          `, {
            username: 'manual_user'
          });
          expect(unescape(result.trim())).to.equal('<input name="user" value="manual_user" />');
        });

        it('should allow async import object-style with inputs for payload-backed imports', async () => {
          loader.addTemplate('payload-import-with-object.njk', `

            {% macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% set suppliedUsername = "manual_user" %}
            {% import "payload-import-with-object.njk" as forms with { username: suppliedUsername } %}
            {{ forms.userField() }}
          `, {});
          expect(unescape(result.trim())).to.equal('<input name="user" value="manual_user" />');
        });

        it('should allow async from-import explicit named with inputs for payload-backed imports', async () => {
          loader.addTemplate('payload-from-import-with-vars.njk', `

            {% macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% from "payload-from-import-with-vars.njk" import userField with username %}
            {{ userField() }}
          `, {
            username: 'manual_user'
          });
          expect(unescape(result.trim())).to.equal('<input name="user" value="manual_user" />');
        });

        it('should allow async import with context to satisfy payload from render context', async () => {
          loader.addTemplate('payload-import-with-context.njk', `

            {% macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% import "payload-import-with-context.njk" as forms with context %}
            {{ forms.userField() }}
          `, {
            username: 'ctx_user'
          });
          expect(unescape(result.trim())).to.equal('<input name="user" value="ctx_user" />');
        });

        it('should not expose parent-local vars through import with context', async () => {
          loader.addTemplate('context-nonleak-import.njk', `
            {% macro show() -%}
            {{ localName }}|{{ renderName }}
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% set localName = "LOCAL" %}
            {% import "context-nonleak-import.njk" as lib with context %}
            {{ lib.show() }}
          `, {
            renderName: 'RENDER'
          });
          expect(result.trim()).to.equal('|RENDER');
        });

        it('should let explicit import inputs shadow render-context properties of the same name', async () => {
          loader.addTemplate('payload-import-shadow.njk', `

            {% macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% set username = "explicit_user" %}
            {% import "payload-import-shadow.njk" as forms with context, username %}
            {{ forms.userField() }}
          `, {
            username: 'render_user'
          });
          expect(unescape(result.trim())).to.equal('<input name="user" value="explicit_user" />');
        });

        it('should let object-style import inputs shadow render-context properties of the same name', async () => {
          loader.addTemplate('payload-import-object-shadow.njk', `

            {% macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% set explicitUsername = "explicit_user" %}
            {% import "payload-import-object-shadow.njk" as forms with context, { username: explicitUsername } %}
            {{ forms.userField() }}
          `, {
            username: 'render_user'
          });
          expect(unescape(result.trim())).to.equal('<input name="user" value="explicit_user" />');
        });

        it('should allow object-style import inputs with context without exposing parent locals', async () => {
          loader.addTemplate('payload-import-object-nonleak.njk', `

            {% macro show() -%}
            {{ username }}|{{ renderName }}|{{ localName | default("missing") }}
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% set localName = "LOCAL" %}
            {% set explicitUsername = "explicit_user" %}
            {% import "payload-import-object-nonleak.njk" as forms with context, { username: explicitUsername } %}
            {{ forms.show() }}
          `, {
            renderName: 'RENDER',
            username: 'render_user'
          });
          expect(result.trim()).to.equal('explicit_user|RENDER|missing');
        });

        it('should let explicit from-import inputs shadow render-context properties of the same name', async () => {
          loader.addTemplate('payload-from-import-shadow.njk', `

            {% macro userField() -%}
            <input name="user" value="{{ username }}" />
            {%- endmacro -%}
          `);

          const result = await env.renderTemplateString(`
            {% set username = "explicit_user" %}
            {% from "payload-from-import-shadow.njk" import userField with context, username %}
            {{ userField() }}
          `, {
            username: 'render_user'
          });
          expect(unescape(result.trim())).to.equal('<input name="user" value="explicit_user" />');
        });

        it('should keep render-context properties hidden for import with explicit without context', async () => {
          const context = {
            username: Promise.resolve('john_doe')
          };

          const result = await env.renderTemplateString(`
            {% import "context-forms.njk" as forms without context %}
            {{ forms.userField() }}
          `, context);
          expect(unescape(result.trim())).to.equal('<input name="user" value="" />');
        });

        it('should keep render-context properties hidden for from-import with explicit without context', async () => {
          const context = {
            username: Promise.resolve('john_doe')
          };

          const result = await env.renderTemplateString(`
            {% from "context-forms.njk" import userField without context %}
            {{ userField() }}
          `, context);
          expect(unescape(result.trim())).to.equal('<input name="user" value="" />');
        });

        it('should resolve dynamic async import targets without composition contracts', async () => {
          loader.addTemplate('plain-import-lib.njk', `
            {% macro label() -%}
            plain
            {%- endmacro %}
          `);

          const plain = await env.renderTemplateString(`
            {% import pickTemplate() as lib %}
            {{ lib.label() }}
          `, {
            pickTemplate() {
              return 'plain-import-lib.njk';
            }
          });
          expect(plain.trim()).to.equal('plain');

        });

        it('should resolve dynamic async from-import targets without composition contracts', async () => {
          loader.addTemplate('plain-from-import-lib.njk', `
            {% macro label() -%}
            plain
            {%- endmacro %}
          `);

          const plain = await env.renderTemplateString(`
            {% from pickTemplate() import label %}
            {{ label() }}
          `, {
            pickTemplate() {
              return 'plain-from-import-lib.njk';
            }
          });
          expect(plain.trim()).to.equal('plain');

        });

        it('should pass canonical names to async imports from duplicated branch-local vars', async () => {
          loader.addTemplate('payload-import-branch-local.njk', `

            {% macro show() -%}[{{ scopedValue }}]{%- endmacro %}
          `);
          loader.addTemplate('main.njk', `
            {% if usePrimary %}
              {% var scopedValue = "primary" %}
              {% import "payload-import-branch-local.njk" as lib with scopedValue %}
              {{ lib.show() }}
            {% else %}
              {% var scopedValue = "fallback" %}
              {% import "payload-import-branch-local.njk" as lib with scopedValue %}
              {{ lib.show() }}
            {% endif %}
          `);

          const primary = await env.renderTemplate('main.njk', { usePrimary: true });
          expect(primary.replace(/\s+/g, '')).to.equal('[primary]');

          const fallback = await env.renderTemplate('main.njk', { usePrimary: false });
          expect(fallback.replace(/\s+/g, '')).to.equal('[fallback]');
        });

        it('should pass canonical names to async from-imports from duplicated branch-local vars', async () => {
          loader.addTemplate('payload-from-import-branch-local.njk', `

            {% macro show() -%}[{{ scopedValue }}]{%- endmacro %}
          `);
          loader.addTemplate('main.njk', `
            {% if usePrimary %}
              {% var scopedValue = "primary" %}
              {% from "payload-from-import-branch-local.njk" import show with scopedValue %}
              {{ show() }}
            {% else %}
              {% var scopedValue = "fallback" %}
              {% from "payload-from-import-branch-local.njk" import show with scopedValue %}
              {{ show() }}
            {% endif %}
          `);

          const primary = await env.renderTemplate('main.njk', { usePrimary: true });
          expect(primary.replace(/\s+/g, '')).to.equal('[primary]');

          const fallback = await env.renderTemplate('main.njk', { usePrimary: false });
          expect(fallback.replace(/\s+/g, '')).to.equal('[fallback]');
        });
      });

      describe('Dynamic Import Names', () => {
        it('should handle async template names in import', async () => {
          const context = {
            async getFormNumber() {
              await delay(5);
              return 1;
            }
          };

          loader.addTemplate('form1.njk', `
            {%- macro field() -%}Form 1 Field{%- endmacro -%}
          `);
          loader.addTemplate('form2.njk', `
            {%- macro field() -%}Form 2 Field{%- endmacro -%}
          `);

          const template = `
            {% import "form" + getFormNumber() + ".njk" as form %}
            {{ form.field() }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(result.trim()).to.equal('Form 1 Field');
        });

        it('should handle from-import with an async template name', async () => {
          // Add the dynamic template to the loader
          loader.addTemplate('async_template.njk', `
            {% macro greet(name) %}
              Hello, {{ name }}!
            {% endmacro %}
          `);

          const context = {
            async getTemplateName() {
              await delay(5); // Simulate async operation
              return 'async_template.njk';
            },
          };

          const template = `
            {% from getTemplateName() import greet %}
            {{ greet("World") }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(result.trim()).to.equal('Hello, World!');
        });

        it('should handle import with an async template name', async () => {
          // Add the dynamic template to the loader
          loader.addTemplate('async_library.njk', `
            {% macro getData() %}
              Async Fetched Data
            {% endmacro %}
          `);

          const context = {
            async getLibraryName() {
              await delay(5); // Simulate async operation
              return 'async_library.njk';
            },
          };

          const template = `
            {% import getLibraryName() as lib %}
            {{ lib.getData() }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(result.trim()).to.equal('Async Fetched Data');
        });
      });

      describe('Complex Import Scenarios', () => {
        beforeEach(() => {
          // Template with async operations using its own local set variables
          loader.addTemplate('async-forms.njk', `
          {%- set greeting = "Hello" -%}

          {%- macro delayedGreeting(name) -%}
            {{- greeting }}, {{ name }} (delayed)!
          {%- endmacro -%}

          {%- macro counter(count) -%}
            {%- for i in range(count) -%}
              Count: {{ i }}
            {%- endfor -%}
          {%- endmacro -%}
        `);

          // Template with nested imports
          loader.addTemplate('layout.njk', `
          {%- macro page(content) -%}
            <main>{{ content }}</main>
          {%- endmacro -%}
        `);

          loader.addTemplate('nested-template.njk', `
          {%- import "layout.njk" as layout -%}
          {%- import "async-forms.njk" as forms -%}

          {%- macro wrapper(name, count) -%}
            {{ layout.page(forms.delayedGreeting(name)) }}
            {{ forms.counter(count) }}
          {%- endmacro -%}
        `);

          // Template with list rendering
          loader.addTemplate('async-loop.njk', `
          {%- macro listItems(items) -%}
            <ul>
              {%- for item in items -%}
              <li>{{ item }}</li>
              {%- endfor -%}
            </ul>
          {%- endmacro -%}
        `);
        });

        it('should handle async values passed to imported macros', async () => {
          const context = {
            async getName() {
              await delay(5);
              return 'Alice';
            }
          };

          const template = `
            {%- import "async-forms.njk" as forms -%}
            {{- forms.delayedGreeting(getName()) -}}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(result).to.equal('Hello, Alice (delayed)!');
        });

        it('should handle async variables and functions passed as macro arguments', async () => {
          // Add the template to the loader
          loader.addTemplate('greeting_macros.njk', `
            {%- macro greet(getName) -%}
            {{ getName() }}
            {%- endmacro -%}
          `);

          const context = {
            async getName() {
              await delay(5);
              return 'Alice';
            }
          };

          const template = `
            {% import "greeting_macros.njk" as gm %}
            {{ gm.greet(getName) }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result.trim())).to.equal('Alice');
        });

        it('should handle nested imports with async values - simplified', async () => {
          const context = {
            nameValue: 'Bob'
          };

          loader.addTemplate('nested.njk', `
            {%- macro greeting(name) -%}
              {{ name }}!
            {%- endmacro -%}

            {%- macro page(content) -%}
              {{ content }}
            {%- endmacro -%}

            {%- macro wrapper(name) -%}
              {{ page(greeting(name)) }}
            {%- endmacro -%}
          `);

          const template = `
            {%- import "nested.njk" as macros -%}
            {{- macros.wrapper(nameValue) -}}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(result).to.equal(`Bob!`);
        });

        it('should handle nested imports with async values', async () => {
          const context = {
            async getName() {
              await delay(5);
              return 'Bob';
            },
            async getCount() {
              await delay(3);
              return 2;
            }
          };

          const template = `
            {%- import "nested-template.njk" as templates -%}{{- templates.wrapper(getName(), getCount()) -}}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<main>Hello, Bob (delayed)!</main>
            Count: 0Count: 1`
          );
        });

        it('should handle async values in imported macro loops', async () => {
          const context = {
            async getItems() {
              await delay(5);
              return ['one', 'two', 'three'];
            }
          };

          const template = `
            {%- import "async-loop.njk" as loop -%}
            {{- loop.listItems(getItems()) -}}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result)).to.equal(
            '<ul><li>one</li><li>two</li><li>three</li></ul>');
        });

        // Set block in imported templates
        it('should handle set block in imported templates with async values', async () => {
          loader.addTemplate('header.njk', `
            {% macro render(title) %}
              {% set header %}
                <header>{{ title }}</header>
              {% endset %}
              {{ header }}
            {% endmacro %}
          `);

          const context = {
            async getTitle() {
              await delay(5);
              return 'Welcome';
            }
          };

          const template = `
            {% import "header.njk" as headers %}
            {{ headers.render(getTitle()) }}
          `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result.trim())).to.equal('<header>Welcome</header>');
        });
      });

      // Let's also fix the Dependencies section
      describe('Import with Dependencies', () => {
        beforeEach(() => {
          // Template with async set variables that receives the functions it needs
          loader.addTemplate('config.njk', `
          {%- macro init(getUrlFunc, getKeyFunc) -%}
          {% set apiUrl = getUrlFunc() %}
          {% set apiKey = getKeyFunc() %}
          {{ apiUrl }}/{{ caller() }}?key={{ apiKey }}
          {%- endmacro -%}
        `);

          // Template that depends on imported values
          loader.addTemplate('api-forms.njk', `
          {% import "config.njk" as config %}

          {%- macro userEndpoint(getUrlFunc, getKeyFunc, userId) -%}
          {%- call config.init(getUrlFunc, getKeyFunc) -%}
            users/{{ userId }}
          {%- endcall -%}
          {%- endmacro -%}
        `);
        });

        it('should handle async dependencies in nested imports', async () => {
          const context = {
            async getApiUrl() {
              await delay(5);
              return 'https://api.example.com';
            },
            async getApiKey() {
              await delay(3);
              return 'secret-key-123';
            }
          };

          const template = `
          {% import "api-forms.njk" as api -%}
          {{ api.userEndpoint(getApiUrl, getApiKey, "123") }}
        `;

          const result = await env.renderTemplateString(template, context);
          expect(result.trim()).to.equal(
            'https://api.example.com/users/123?key=secret-key-123'
          );
        });

      });

      describe('Imported Macros', () => {
        beforeEach(() => {
          // Add async filter
          env.addFilter('uppercase', async (str) => {
            await delay(5);
            return str.toUpperCase();
          });

          // Template using async filter
          loader.addTemplate('filtered-forms.njk', `
          {%- macro formattedField(name, value) -%}
          <input name="{{ name }}" value="{{ value | uppercase }}" />
          {%- endmacro -%}
        `);
        });

        it('should handle async filters in imported macros', async () => {
          const context = {
            async getName() {
              await delay(3);
              return 'username';
            }
          };

          const template = `
          {% import "filtered-forms.njk" as forms %}
          {{ forms.formattedField(getName(), "john_doe") }}
        `;

          const result = await env.renderTemplateString(template, context);
          expect(unescape(result.trim())).to.equal(
            '<input name="username" value="JOHN_DOE" />'
          );
        });

        it('should handle async function in imported macro', async () => {
          loader.addTemplate('greet_macro.njk', `
          {%- macro greet(name) -%}
          Hello, {{ name }}!
          {%- endmacro -%}
        `);

          const context = {
            async getName() {
              await delay(5);
              return 'Charlie';
            }
          };

          const template = `
          {% import "greet_macro.njk" as macros %}
          {{ macros.greet(getName()) }}
        `;

          const result = await env.renderTemplateString(template, context);
          expect(result.trim()).to.equal('Hello, Charlie!');
        });

        it('should allow async import with context when macros depend on render-context locals', async () => {
          loader.addTemplate('greet_macro_with_context.njk', `
          {%- macro greet() -%}
          Hello, {{ getName() }}!
          {%- endmacro -%}
        `);

          const context = {
            async getName() {
              await delay(5);
              return 'Diana';
            }
          };

          const result = await env.renderTemplateString(`
            {% import "greet_macro_with_context.njk" as macros with context %}
            {{ macros.greet() }}
          `, context);
          expect(result.trim()).to.equal('Hello, Diana!');
        });
      });
    });

    describe('Include async tests', () => {
      it('should handle async functions in include statements', async () => {
        const context = {
          async getTemplateName() {
            await delay(5);
            return 'greeting.njk';
          },
          name: 'World'
        };

        const greetingTemplate = 'Hello, {{ name }}!';
        loader.addTemplate('greeting.njk', greetingTemplate);

        const mainTemplate = '{% include getTemplateName() with name %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderTemplate('main.njk', context);
        expect(result).to.equal('Hello, World!');
      });

      it('should allow include with context to read render-context properties as bare names', async () => {
        loader.addTemplate('greeting.njk', 'Hello, {{ name }} from {{ city }}!');
        loader.addTemplate('main.njk', '{% include "greeting.njk" with context %}');

        const result = await env.renderTemplate('main.njk', {
          name: 'World',
          city: 'London'
        });
        expect(result).to.equal('Hello, World from London!');
      });

      it('should allow include with context to satisfy payload from render context', async () => {
        loader.addTemplate('greeting.njk', 'Hello, {{ name }}!');
        loader.addTemplate('main.njk', '{% include "greeting.njk" with context %}');

        const result = await env.renderTemplate('main.njk', {
          name: 'PayloadUser'
        });
        expect(result).to.equal('Hello, PayloadUser!');
      });

      it('should not expose parent-local vars through include with context', async () => {
        loader.addTemplate('greeting.njk', '{{ localName }}|{{ renderName }}');
        loader.addTemplate('main.njk', '{% set localName = "LOCAL" %}{% include "greeting.njk" with context %}');

        const result = await env.renderTemplate('main.njk', {
          renderName: 'RENDER'
        });
        expect(result).to.equal('|RENDER');
      });

      it('should let explicit include inputs shadow render-context properties of the same name', async () => {
        loader.addTemplate('greeting.njk', 'Hello, {{ name }}!');
        loader.addTemplate('main.njk', '{% set name = "ExplicitUser" %}{% include "greeting.njk" with context, name %}');

        const result = await env.renderTemplate('main.njk', {
          name: 'RenderUser'
        });
        expect(result).to.equal('Hello, ExplicitUser!');
      });

      it('should not expose render-context properties to include without with context', async () => {
        loader.addTemplate('greeting.njk', 'Hello, {{ name }}!');
        loader.addTemplate('main.njk', '{% include "greeting.njk" %}');

        const result = await env.renderTemplate('main.njk', {
          name: 'Hidden'
        });
        expect(result).to.equal('Hello, !');
      });

      it('should handle async functions in includeed template', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'World';
          },
          async getPlace() {
            await delay(3);
            return 'London';
          }
        };

        const greetingTemplate = 'Hello, {{ getName() }}, welcome to';
        loader.addTemplate('greeting.njk', greetingTemplate);

        const mainTemplate = '{% include "greeting.njk" with getName %} {{ getPlace() }}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderTemplate('main.njk', context);
        expect(result).to.equal('Hello, World, welcome to London');
      });

      it('should handle nested includes with async functions', async () => {
        const context = {
          async getUser() {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { name: 'John', role: 'admin' };
          }
        };

        const userTemplate = '{{ getUser().name }} ({{ getUser().role }})';
        loader.addTemplate('user.njk', userTemplate);

        const greetingTemplate = 'Welcome, {% include "user.njk" with getUser %}!';
        loader.addTemplate('greeting.njk', greetingTemplate);

        const mainTemplate = 'Hello! {% include "greeting.njk" with getUser %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderTemplate('main.njk', context);
        expect(result).to.equal('Hello! Welcome, John (admin)!');
      });

      it('should handle async functions in included template using frame variables', async () => {
        const context = {
          async getUserInfo(id) {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { name: `User ${id}`, role: id % 2 === 0 ? 'admin' : 'user' };
          }
        };

        const userTemplate = '{% set user = getUserInfo(userId) %}{{ user.name }} ({{ user.role }})';
        loader.addTemplate('user.njk', userTemplate);

        const mainTemplate = '{% set userId = 1 %}{% include "user.njk" with userId, getUserInfo %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderTemplate('main.njk', context);
        expect(result).to.equal('User 1 (user)');
      });

      it('should handle async functions in included template using for loop variables', async () => {
        const context = {
          getUserInfo(id) {
            // await new Promise(resolve => setTimeout(resolve, 50));
            return { name: `User ${id}`, role: id % 2 === 0 ? 'admin' : 'user' };
          }
        };

        const userTemplate = '{% set user = getUserInfo(userId) %}{{ user.name }} ({{ user.role }})';
        loader.addTemplate('user.njk', userTemplate);

        const mainTemplate = '{%- for userId in [1, 2] -%}{% include "user.njk" with userId, getUserInfo %}\n{% endfor -%}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderTemplate('main.njk', context);
        expect(result).to.equal('User 1 (user)\nUser 2 (admin)\n');
      });

      it('should ignore missing includes without validating payload inputs when the target is absent', async () => {
        loader.addTemplate('main.njk', '{% include pickTemplate() ignore missing with userId %}done');

        const result = await env.renderTemplate('main.njk', {
          userId: 7,
          pickTemplate() {
            return 'missing-child.njk';
          }
        });
        expect(result).to.equal('done');
      });

      it('should pass payload inputs to resolved dynamic include targets', async () => {
        loader.addTemplate('plain-child.njk', 'plain');
        loader.addTemplate('payload-child.njk', 'user={{ userId }}');
        loader.addTemplate('main.njk', '{% include pickTemplate() with userId %}');

        const okResult = await env.renderTemplate('main.njk', {
          userId: 7,
          pickTemplate() {
            return 'payload-child.njk';
          }
        });
        expect(okResult).to.equal('user=7');

        const plainResult = await env.renderTemplate('main.njk', {
          userId: 7,
          pickTemplate() {
            return 'plain-child.njk';
          }
        });
        expect(plainResult).to.equal('plain');
      });

      it('should pass canonical names to includes from duplicated branch-local vars', async () => {
        loader.addTemplate('child.njk', '[{{ scopedValue }}]');
        loader.addTemplate('main.njk', `
          {% if usePrimary %}
            {% var scopedValue = "primary" %}
            {% include "child.njk" with scopedValue %}
          {% else %}
            {% var scopedValue = "fallback" %}
            {% include "child.njk" with scopedValue %}
          {% endif %}
        `);

        const primary = await env.renderTemplate('main.njk', { usePrimary: true });
        expect(primary.replace(/\s+/g, '')).to.equal('[primary]');

        const fallback = await env.renderTemplate('main.njk', { usePrimary: false });
        expect(fallback.replace(/\s+/g, '')).to.equal('[fallback]');
      });
    });

    describe('Async Block Tag Tests', () => {
      it('should render a simple block with async content', async () => {
        const context = {
          async getMessage() {
            await delay(1);
            return 'Hello, World!';
          }
        };
        const template = '{% block content %}{{ getMessage() }}{% endblock %}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Hello, World!');
      });

      it('should handle template inheritance with blocks and async content', async () => {
        const context = {
          async getContent() {
            await delay(1);
            return 'Async Child Content';
          }
        };
        loader.addTemplate('base.njk', '<div>{% block content %}Base Content{% endblock %}</div>');
        const childTemplate = '{% extends "base.njk" %}{% block content %}{{ getContent() }}{% endblock %}';
        const result = await env.renderTemplateString(childTemplate, context);
        expect(result.trim()).to.equal('<div>Async Child Content</div>');
      });

      it('should handle nested blocks with async content', async () => {
        const context = {
          async getOuter() {
            await delay(2);
            return 'Async Outer';
          },
          async getInner() {
            await delay(1);
            return 'Async Inner';
          }
        };
        const template = '{% block outer %}{{ getOuter() }} {% block inner %}{{ getInner() }}{% endblock %}{% endblock %}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Async Outer Async Inner');
      });

      it('should handle blocks within loops without exposing loop-local values into block scope', async () => {
        const context = {
          async getItems() {
            await delay(3);
            return ['a', 'b', 'c'];
          },
          async getPrefix() {
            await delay(1);
            return 'Processed';
          },
          async getLabel() {
            await delay(1);
            return 'Block';
          }
        };
        const template = '{% for item in getItems() %}{% block item %}{{ getPrefix() }} {{ getLabel() }}{% endblock %}{% endfor %}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Processed BlockProcessed BlockProcessed Block');
      });

      it('should handle async functions within blocks and as block parameters', async () => {
        const context = {
          async getName() {
            await delay(4);
            return 'John';
          },
          async getGreeting(name) {
            await delay(2);
            return `Hello, ${name}!`;
          }
        };
        const template = '{% block greeting %}{{ getGreeting(getName()) }}{% endblock %}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Hello, John!');
      });

      it('should handle the super function in blocks with async content', async () => {
        const context = {
          async getBaseContent() {
            await delay(3);
            return 'Async Base Content';
          },
          async getChildContent() {
            await delay(1);
            return 'Async Child Content';
          }
        };
        loader.addTemplate('base.njk', '{% block content %}{{ getBaseContent() }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content %}{{ super() }} + {{ getChildContent() }}{% endblock %}';
        const result = await env.renderTemplateString(childTemplate, context);
        expect(result.trim()).to.equal('Async Base Content + Async Child Content');
      });

      it('should handle multiple levels of inheritance with blocks and async content', async () => {
        const context = {
          async getA() {
            await delay(3);
            return 'Async A';
          },
          async getB() {
            await delay(2);
            return 'Async B';
          },
          async getC() {
            await delay(5);
            return 'Async C';
          }
        };
        loader.addTemplate('grand.njk', '{% block a %}{{ getA() }}{% endblock %}{% block b %}{{ getB() }}{% endblock %}{% block c %}{{ getC() }}{% endblock %}');
        loader.addTemplate('parent.njk', '{% extends "grand.njk" %}{% block b %}Modified {{ getB() }}{% endblock %}');
        const childTemplate = '{% extends "parent.njk" %}{% block c %}Modified {{ getC() }}{% endblock %}';
        const result = await env.renderTemplateString(childTemplate, context);
        expect(result.trim()).to.equal('Async AModified Async BModified Async C');
      });

      it('should pass explicit block signature inputs from the base block invocation to the async override', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}Child {{ user }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Child Ada');
      });

      it('should expose render-context bare names through block with context in an async override', async () => {
        loader.addTemplate('base.njk', '{% block content with context %}Base {{ username }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content with context %}Child {{ username }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { username: 'Ada' });
        expect(result.trim()).to.equal('Child Ada');
      });

      it('should resolve promised block argument values in async overrides', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}Child {{ user }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: Promise.resolve('Ada') });
        expect(result.trim()).to.equal('Child Ada');
      });

      it('should pass the same explicit block arguments to super() without seeing child-local rebinding', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}{% set user = "Grace" %}{{ super() }} / {{ user }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Base Ada / Grace');
      });

      it('should allow super(...) to override inherited signature inputs for the parent block call', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}{{ super("Grace") }} / {{ user }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Base Grace / Ada');
      });

      it('should evaluate super(...) arguments at the original call site', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}{% set user = "Grace" %}{{ super(user) }} / {{ user }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Base Grace / Grace');
      });

      it('should evaluate each super(...) call independently at its own call site', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}[{{ user }}]{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}{{ super(user) }}{% set user = "Grace" %}{{ super(user) }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('[Ada][Grace]');
      });

      it('should reject super(...) calls that pass more args than the block signature declares', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}{{ super("Grace", "Extra") }}{% endblock %}';

        try {
          await env.renderTemplateString(childTemplate, { user: 'Ada' });
          expect().fail('Expected super(...) arity validation');
        } catch (err) {
          expect(String(err)).to.contain('super(...) for block "content" received too many arguments');
        }
      });

      it('should reject super(...) keyword arguments in async mode', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}{{ super(user="Grace") }}{% endblock %}';

        try {
          await env.renderTemplateString(childTemplate, { user: 'Ada' });
          expect().fail('Expected super(...) keyword-argument rejection');
        } catch (err) {
          expect(String(err)).to.contain('super(...) does not support keyword arguments');
        }
      });

      it('should allow overriding signature blocks to redeclare with context', async () => {
        loader.addTemplate('base.njk', '{% block content(user) with context %}Base {{ user }} {{ username }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) with context %}Child {{ user }} {{ username }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada', username: 'Grace' });
        expect(result.trim()).to.equal('Child Ada Grace');
      });

      it('should keep render-context visibility disabled by default for signature blocks without with context', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }} / {{ username }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}Child {{ user }} / {{ username }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada', username: 'Grace' });
        expect(result.trim()).to.equal('Child Ada /');
      });

      it('should treat base-block with inputs as local vars for rebinding', async () => {
        const template = '{% block content(user) %}{{ user }}{% set user = "Grace" %}/{{ user }}{% endblock %}';

        const result = await env.renderTemplateString(template, { user: 'Ada' });
        expect(result.trim()).to.equal('Ada/Grace');
      });

      it('should reject conflicting declarations of base-block argument names', async () => {
        const template = '{% block content(user) %}{% var user = "Grace" %}{{ user }}{% endblock %}';

        try {
          await env.renderTemplateString(template, { user: 'Ada' });
          expect().fail('Expected block argument declaration conflict');
        } catch (err) {
          expect(String(err)).to.contain(`Identifier 'user' has already been declared.`);
        }
      });

      it('should reject duplicate base-block argument names', async () => {
        const template = '{% block content(user, user) %}{{ user }}{% endblock %}';

        try {
          await env.renderTemplateString(template, { user: 'Ada' });
          expect().fail('Expected duplicate block argument rejection');
        } catch (err) {
          expect(String(err)).to.contain(`block argument 'user' is declared more than once`);
        }
      });

      it('should reject legacy named block with-input syntax', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content with user %}Child {{ user }}{% endblock %}';

        try {
          await env.renderTemplateString(childTemplate, { user: 'Ada' });
          expect().fail('Expected legacy named block with-input rejection');
        } catch (err) {
          expect(String(err)).to.contain('named block with-inputs are no longer supported');
        }
      });

      it('should reject overriding block signatures that do not match the parent signature', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(username) %}Child {{ username }}{% endblock %}';

        try {
          await env.renderTemplateString(childTemplate, { user: 'Ada', username: 'Grace' });
          expect().fail('Expected overriding block signature mismatch');
        } catch (err) {
          expect(String(err)).to.contain('block "content" signature mismatch');
          expect(String(err)).to.contain('content(username)');
          expect(String(err)).to.contain('content(user)');
        }
      });

      it('should reject overriding block signatures when with-context mode differs from the parent', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) with context %}Child {{ user }} {{ username }}{% endblock %}';

        try {
          await env.renderTemplateString(childTemplate, { user: 'Ada', username: 'Grace' });
          expect().fail('Expected overriding block context-mode mismatch');
        } catch (err) {
          expect(String(err)).to.contain('block "content" signature mismatch');
          expect(String(err)).to.contain('content(user) with context');
          expect(String(err)).to.contain('content(user)');
        }
      });

      it('should surface block signature mismatches during parent registration in a multi-file inheritance chain', async () => {
        loader.addTemplate('grand.njk', '{% block content(user) %}Grand {{ user }}{% endblock %}');
        loader.addTemplate('parent.njk', '{% extends "grand.njk" %}{% block content(user) %}Parent {{ super() }}{% endblock %}');
        const childTemplate = '{% extends "parent.njk" %}{% block content(username) %}Child {{ username }}{% endblock %}';

        try {
          await env.renderTemplateString(childTemplate, { user: 'Ada', username: 'Grace' });
          expect().fail('Expected multi-file signature mismatch');
        } catch (err) {
          expect(String(err)).to.contain('block "content" signature mismatch');
          expect(String(err)).to.contain('content(username)');
          expect(String(err)).to.contain('content(user)');
        }
      });

      it('should not treat render-context visibility from with context as inherited explicit block arguments', async () => {
        loader.addTemplate('base.njk', '{% block content with context %}Base {{ username }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content with context %}{% var username = "Grace" %}{{ username }} / {{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { username: 'Ada' });
        expect(result.trim()).to.equal('Grace / Base Ada');
      });

      it('should keep same-template top-level locals out of explicit block-argument scope', async () => {
        const template = '{% set suffix = "local" %}{% block content(user) %}{{ user }} {{ suffix }}{% endblock %}';

        const result = await env.renderTemplateString(template, { user: 'Ada' });
        expect(result.trim()).to.equal('Ada');
      });

      it('should keep child top-level locals out of inherited explicit block-argument scope', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% set suffix = "child" %}{% block content(user) %}{{ user }} {{ suffix }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Ada');
      });

      it('should keep template-local values out of a multi-level super chain with explicit block arguments', async () => {
        loader.addTemplate('grand.njk', '{% block content(user) %}Grand {{ user }}{% endblock %}');
        loader.addTemplate('parent.njk', '{% extends "grand.njk" %}{% set parentLabel = "parent" %}{% block content(user) %}Parent {{ parentLabel }} {{ super() }}{% endblock %}');
        const childTemplate = '{% extends "parent.njk" %}{% set childLabel = "child" %}{% block content(user) %}Child {{ childLabel }} {{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Child  Parent  Grand Ada');
      });

      it('should keep original block arguments through a three-level super chain when the middle block rebinds them', async () => {
        loader.addTemplate('grand.njk', '{% block content(user) %}Grand {{ user }}{% endblock %}');
        loader.addTemplate('parent.njk', '{% extends "grand.njk" %}{% block content(user) %}{% set user = "Mid" %}Parent {{ user }} {{ super() }}{% endblock %}');
        const childTemplate = '{% extends "parent.njk" %}{% block content(user) %}Child {{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Child Parent Mid Grand Ada');
      });

      it('should preserve plain super() behavior when called multiple times in one block', async () => {
        loader.addTemplate('base.njk', '{% block content %}Base{% endblock %}');
        const childTemplate = '{% extends "base.njk" %}{% block content %}[{{ super() }}][{{ super() }}]{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, {});
        expect(result.trim()).to.equal('[Base][Base]');
      });

      it('should allow include with explicit inputs inside an overriding block', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }}{% endblock %}');
        loader.addTemplate('card.njk', '[{{ user }}]');
        const childTemplate = '{% extends "base.njk" %}{% block content(user) %}{% include "card.njk" with user %}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('[Ada]');
      });

      it('should let explicit block arguments shadow render-context properties of the same name', async () => {
        const template = '{% set user = "ExplicitUser" %}{% block content(user) with context %}{{ user }}{% endblock %}';

        const result = await env.renderTemplateString(template, { user: 'RenderUser' });
        expect(result.trim()).to.equal('ExplicitUser');
      });

      it('should handle blocks inside a for loop without exposing loop-local values into block scope', async () => {
        const context = {
          async getItems() {
            await delay(4);
            return ['apple', 'banana', 'cherry'];
          },
          async getLabel() {
            await delay(5);
            return 'BLOCK';
          },
          async getPrefix() {
            await delay(3);
            return 'Item:';
          }
        };

        const template = `
            {% for item in getItems() -%}
              {%- block item_block -%}
                {{ getPrefix() }} {{ getLabel() }}
              {% endblock -%}
            {% endfor %}
          `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal(`Item: BLOCK
              Item: BLOCK
              Item: BLOCK`);
      });

      it('should handle async conditionals within blocks', async () => {
        const context = {
          async shouldRender() {
            await delay(10);
            return true;
          },
          async getContent() {
            await delay(5);
            return 'Conditional Content';
          }
        };
        const template = '{% block content %}{% if shouldRender() %}{{ getContent() }}{% endif %}{% endblock %}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Conditional Content');
      });

      it('should keep if-local symbols out of block scope', async () => {
        const context = {
          enabled: true,
          async getScopedValue() {
            await delay(2);
            return 'if-local';
          }
        };

        const template = `
          {% if enabled %}
            {% set scoped = getScopedValue() %}
            {% block content %}{{ scoped }}{% endblock %}
          {% endif %}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('');
      });

      it('should configure base payload through extends with explicit named inputs', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }} / {{ theme }}{% endblock %}');
        const childTemplate = '{% set theme = "dark" %}{% extends "base.njk" with theme %}{% block content(user) %}Child {{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada', theme: 'render' });
        expect(result.trim()).to.equal('Child Base Ada / dark');
      });

      it('should keep extends-with capture stable without exposing later constructor-local reassignment to inherited blocks', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }} / {{ theme }}{% endblock %}');
        const childTemplate = '{% set theme = "dark" %}{% extends "base.njk" with theme %}{% set theme = "changed" %}{% block content(user) %}{{ super() }} / {{ theme }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada' });
        expect(result.trim()).to.equal('Base Ada / dark /');
      });

      it('should let extends payload expose render-context values while explicit names still win', async () => {
        loader.addTemplate('base.njk', '{% block content(user) with context %}Base {{ user }} / {{ locale }} / {{ theme }} / {{ siteName }}{% endblock %}');
        const childTemplate = '{% set theme = "dark" %}{% extends "base.njk" with context, theme %}{% block content(user) with context %}{{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada', locale: 'de', siteName: 'Docs', theme: 'render-theme' });
        expect(result.trim()).to.equal('Base Ada / de / dark / Docs');
      });

      it('should preserve explicit payload names when inherited blocks read render context', async () => {
        loader.addTemplate('base.njk', '{% block content(user) with context %}Base {{ user }} / {{ locale }} / {{ theme }} / {{ siteName }}{% endblock %}');
        const childTemplate = '{% set theme = "dark" %}{% extends "base.njk" with theme %}{% block content(user) with context %}{{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada', locale: 'de', siteName: 'Docs' });
        expect(result.trim()).to.equal('Base Ada / de / dark / Docs');
      });

      it('should pass pending promise values transparently through extends with', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }} / {{ theme }}{% endblock %}');
        const childTemplate = '{% set theme = getTheme() %}{% extends "base.njk" with theme %}{% block content(user) %}{{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, {
          user: 'Ada',
          getTheme() {
            return delay(5).then(() => 'async-dark');
          }
        });
        expect(result.trim()).to.equal('Base Ada / async-dark');
      });

      it('should keep child locals out of the base root unless explicitly passed through extends with', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }} / {{ theme }} / {{ siteName }}{% endblock %}');
        const childTemplate = '{% set theme = "dark" %}{% extends "base.njk" %}{% block content(user) %}{{ super() }}{% endblock %}';

        const result = await env.renderTemplateString(childTemplate, { user: 'Ada', siteName: 'Docs' });
        expect(result.trim()).to.equal('Base Ada /  /');
      });

      it('should isolate extends-with root configuration across concurrent renders of the same templates', async () => {
        loader.addTemplate('base.njk', '{% block content(user) %}Base {{ user }} / {{ theme }}{% endblock %}');
        loader.addTemplate('child.njk', '{% set theme = inputTheme %}{% extends "base.njk" with theme %}{% block content(user) %}{{ super() }}{% endblock %}');

        const [first, second] = await Promise.all([
          env.renderTemplate('child.njk', { user: 'Ada', inputTheme: 'dark' }),
          env.renderTemplate('child.njk', { user: 'Grace', inputTheme: 'blue' })
        ]);

        expect(first.trim()).to.equal('Base Ada / dark');
        expect(second.trim()).to.equal('Base Grace / blue');
      });
    });

    describe('Import multiple items', () => {
      it('should "import as" multiple async macros and use them', async () => {
        loader.addTemplate('macros.njk', `
          {% macro asyncMacro1() -%}
            {%- set result1 = getAsyncValue1() -%}
            [Macro1: {{ result1 }}]
          {%- endmacro %}
          {% macro asyncMacro2() -%}
            {%- set result2 = getAsyncValue2() -%}
            [Macro2: {{ result2 }}]
          {%- endmacro %}
        `);

        const context = {
          async getAsyncValue1() {
            await delay(2);
            return 'Value1';
          },
          async getAsyncValue2() {
            await delay(1);
            return 'Value2';
          }
        };

        const result = await env.renderTemplateString(`
          {%- import "macros.njk" as macros with context -%}
          {{ macros.asyncMacro1() }} {{ macros.asyncMacro2() }}
        `, context);
        expect(result.replace(/\s+/g, ' ').trim()).to.equal('[Macro1: Value1] [Macro2: Value2]');
      });

      it('should "from import" multiple async macros and use them', async () => {
        loader.addTemplate('macros.njk', `
          {% macro asyncMacro1() %}
            {%- set result1 = getAsyncValue1() -%}
            [Macro1: {{ result1 }}]
          {%- endmacro -%}

          {%- macro asyncMacro2() -%}
            {%- set result2 = getAsyncValue2() -%}
            [Macro2: {{ result2 }}]
          {% endmacro %}
        `);

        const context = {
          async getAsyncValue1() {
            await delay(2);
            return 'Value1';
          },
          async getAsyncValue2() {
            await delay(1);
            return 'Value2';
          }
        };

        const result = await env.renderTemplateString(`
          {% from "macros.njk" import asyncMacro1, asyncMacro2 with context %}
          {{ asyncMacro1() }} {{ asyncMacro2() }}
        `, context);
        expect(result.replace(/\s+/g, ' ').trim()).to.equal('[Macro1: Value1] [Macro2: Value2]');
      });

    });

  });

})();
