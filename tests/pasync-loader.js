(function () {
  'use strict';

  var expect;
  var unescape;
  var AsyncEnvironment;
  //var Environment;

  class StringLoader {
    constructor() {
      this.templates = new Map();
    }

    getSource(name) {
      if (!this.templates.has(name)) {
        return null;// return null rather than throw an error so that ignore missing works
      }

      return {
        src: this.templates.get(name),
        path: name,
        noCache: false
      };
    }

    addTemplate(name, content) {
      this.templates.set(name, content);
    }
  }

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../src/environment').AsyncEnvironment;
    //Environment = require('../src/environment').Environment;
    unescape = require('he').unescape;

    if (module.exports) {
      module.exports = StringLoader;
    }
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    //Environment = nunjucks.Environment;
    window.StringLoader = StringLoader;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Async mode with loaded templates', () => {
    let loader;
    let env;
    beforeEach(() => {
      loader = new StringLoader();
      env = new AsyncEnvironment(loader);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<div>
            <label>Enter Username:</label>
            </div>`
          );
        });
      });

      describe('Import with Context', () => {
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

        it('should handle import with async context values', async () => {
          const context = {
            username: Promise.resolve('john_doe'),
            status: Promise.resolve('active')
          };

          const template = `
            {% import "context-forms.njk" as forms with context %}
            {{ forms.userField() }}
            {{ forms.statusLabel() }}
          `;

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            `<input name="user" value="john_doe" />
            <label>Status: active</label>`
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

          const result = await env.renderString(template, context);
          expect(unescape(result.trim())).to.equal(
            '<input name="user" value="" />'
          );
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
          expect(result).to.equal('Hello, Alice (delayed)!');
        });

        it('should handle async variables and functions in imported macros', async () => {
          // Add the template to the loader
          loader.addTemplate('greeting_macros.njk', `
            {%- macro greetWithContext() -%}
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
            {% import "greeting_macros.njk" as gm with context %}
            {{ gm.greetWithContext() }}
          `;

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
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

          const result = await env.renderString(template, context);
          expect(result.trim()).to.equal('Hello, Charlie!');
        });

        it('should handle async function called within imported macro with context', async () => {
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

          const template = `
          {% import "greet_macro_with_context.njk" as macros with context %}
          {{ macros.greet() }}
        `;

          const result = await env.renderString(template, context);
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

        const mainTemplate = '{% include getTemplateName() %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
        expect(result).to.equal('Hello, World!');
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

        const mainTemplate = '{% include "greeting.njk" %} {{ getPlace() }}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
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

        const greetingTemplate = 'Welcome, {% include "user.njk" %}!';
        loader.addTemplate('greeting.njk', greetingTemplate);

        const mainTemplate = 'Hello! {% include "greeting.njk" %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
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

        const mainTemplate = '{% set userId = 1 %}{% include "user.njk" %}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
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

        const mainTemplate = '{%- for userId in [1, 2] -%}{% include "user.njk" %}\n{% endfor -%}';
        loader.addTemplate('main.njk', mainTemplate);

        const result = await env.renderAsync('main.njk', context);
        expect(result).to.equal('User 1 (user)\nUser 2 (admin)\n');
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
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(childTemplate, context);
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
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Async Outer Async Inner');
      });

      it('should handle blocks within loops with async data', async () => {
        const context = {
          async getItems() {
            await delay(3);
            return ['a', 'b', 'c'];
          },
          async processItem(item) {
            await delay(1);
            return `Processed ${item.toUpperCase()}`;
          }
        };
        const template = '{% for item in getItems() %}{% block item %}{{ processItem(item) }}{% endblock %}{% endfor %}';
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Processed AProcessed BProcessed C');
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
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(childTemplate, context);
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
        const result = await env.renderString(childTemplate, context);
        expect(result.trim()).to.equal('Async AModified Async BModified Async C');
      });

      it('should handle blocks inside a for loop with async content', async () => {
        const context = {
          async getItems() {
            await delay(4);
            return ['apple', 'banana', 'cherry'];
          },
          async processItem(item) {
            await delay(5);
            return item.toUpperCase();
          },
          async getPrefix() {
            await delay(3);
            return 'Item:';
          }
        };

        const template = `
            {% for item in getItems() -%}
              {%- block item_block -%}
                {{ getPrefix() }} {{ processItem(item) }}
              {% endblock -%}
            {% endfor %}
          `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal(`Item: APPLE
              Item: BANANA
              Item: CHERRY`);
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
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('Conditional Content');
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

        const template = `
          {%- import "macros.njk" as macros with context -%}
          {{ macros.asyncMacro1() }} {{ macros.asyncMacro2() }}
        `;
        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('[Macro1: Value1] [Macro2: Value2]');
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

        const template = `
          {% from "macros.njk" import asyncMacro1, asyncMacro2 with context %}
          {{ asyncMacro1() }} {{ asyncMacro2() }}
        `;

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('[Macro1: Value1] [Macro2: Value2]');
      });

    });

  });

})();
