(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var StringLoader;
  var path;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    path = require('path');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    StringLoader = require('../util').StringLoader;
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
    var env;
    beforeEach(function () {
      loader = new StringLoader();
      env = new AsyncEnvironment(loader);
    });

    it('should report correct path for basic error', async () => {
      var templateName = 'error-basic.njk';
      loader.addTemplate(templateName, '{{ nonExistentFunction() }}');
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
      env = new AsyncEnvironment(loader, {
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
      try {
        await env.renderTemplateString('{{ nonExistentFunction() }}', {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain('(unknown path)');
      }
    });

    it('should report correct path for error in super block', async () => {
      var parentTemplateName = 'error-super-parent.njk';
      var childTemplateName = 'error-super-child.njk';
      loader.addTemplate(parentTemplateName, '{% block content %}{{ nonExistentFunction() }}{% endblock %}');
      loader.addTemplate(childTemplateName, '{% extends "' + parentTemplateName + '" %}{% block content %}{{ super() }}{% endblock %}');
      try {
        await env.renderTemplate(childTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${parentTemplateName})`);
      }
    });

    it('should report correct path for error in from import', async () => {
      var mainTemplateName = 'error-from-import-main.njk';
      var macroTemplateName = 'error-from-import-lib.njk';
      loader.addTemplate(mainTemplateName, '{% from "' + macroTemplateName + '" import myMacro %}{{ myMacro() }}');
      loader.addTemplate(macroTemplateName, '{% macro myMacro() %}{{ nonExistentFunction() }}{% endmacro %}');
      try {
        await env.renderTemplate(mainTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${macroTemplateName})`);
      }
    });

    it('should report correct path for error in local macro', async () => {
      var templateName = 'error-local-macro.njk';
      loader.addTemplate(templateName, '{% macro myMacro() %}{{ nonExistentFunction() }}{% endmacro %}{{ myMacro() }}');
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in caller block', async () => {
      var templateName = 'error-caller.njk';
      loader.addTemplate(templateName,
        `{% macro wrapper() %}
          {{ caller() }}
         {% endmacro %}
         {% call wrapper() %}
          {{ nonExistentFunction() }}
         {% endcall %}`);
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in capture block', async () => {
      var scriptName = 'error-capture.casc';
      loader.addTemplate(scriptName, 'var captured = capture\n  nonExistentFunction()\nendcapture\n{{ captured }}');
      try {
        await env.renderScript(scriptName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${scriptName})`);
      }
    });

    it('should report correct path for error in multi-level extends (grandparent -> parent -> child)', async () => {
      var grandparentName = 'error-extends-grandparent.njk';
      var parentName = 'error-extends-parent-middle.njk';
      var childName = 'error-extends-child-deep.njk';
      loader.addTemplate(grandparentName, '{% block content %}{% endblock %}');
      loader.addTemplate(parentName, '{% extends "' + grandparentName + '" %}{% block content %}{{ super() }}{% endblock %}');
      loader.addTemplate(childName, '{% extends "' + parentName + '" %}{% block content %}{{ nonExistentFunction() }}{% endblock %}');
      try {
        await env.renderTemplate(childName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${childName})`);
      }
    });

    it('should report correct path for error in for loop body', async () => {
      var templateName = 'error-for-loop.njk';
      loader.addTemplate(templateName, '{% for item in items %}{{ nonExistentFunction() }}{% endfor %}');
      try {
        await env.renderTemplate(templateName, { items: [1, 2, 3] });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in if block', async () => {
      var templateName = 'error-if-block.njk';
      loader.addTemplate(templateName, '{% if true %}{{ nonExistentFunction() }}{% endif %}');
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in else block', async () => {
      var templateName = 'error-else-block.njk';
      loader.addTemplate(templateName, '{% if false %}ok{% else %}{{ nonExistentFunction() }}{% endif %}');
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error with async filter', async () => {
      var templateName = 'error-async-filter.njk';
      loader.addTemplate(templateName, '{{ "test" | asyncFilter }}');
      env.addFilterAsync('asyncFilter', async (val) => {
        throw new Error('Filter error');
      });
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in async extension', async () => {
      var templateName = 'error-async-extension.njk';
      loader.addTemplate(templateName, '{% asyncTag %}');

      class AsyncTagExtension {
        constructor() {
          this.tags = ['asyncTag'];
        }
        parse(parser, nodes) {
          const tok = parser.nextToken();
          const args = parser.parseSignature(null, true);
          parser.advanceAfterBlockEnd(tok.value);
          return new nodes.CallExtensionAsync(this, 'run', args);
        }
        run(context, callback) {
          // Async extensions use callbacks, not async/await directly
          setTimeout(() => {
            callback(new Error('Extension error'));
          }, 10);
        }
      }

      env.addExtension('AsyncTagExtension', new AsyncTagExtension());
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error during async function call', async () => {
      var templateName = 'error-async-function.njk';
      loader.addTemplate(templateName, '{{ asyncFunc() }}');
      try {
        await env.renderTemplate(templateName, {
          asyncFunc: async () => {
            throw new Error('Async function error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in nested blocks (parent block calls child block)', async () => {
      var parentTemplateName = 'error-nested-blocks-parent.njk';
      var childTemplateName = 'error-nested-blocks-child.njk';
      loader.addTemplate(parentTemplateName, '{% block outer %}{% block inner %}{% endblock %}{% endblock %}');
      loader.addTemplate(childTemplateName, '{% extends "' + parentTemplateName + '" %}{% block inner %}{{ nonExistentFunction() }}{% endblock %}');
      try {
        await env.renderTemplate(childTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${childTemplateName})`);
      }
    });

    // include poisoning not yet supported
    it.skip('should report correct path for error when template loading fails', async () => {
      var mainTemplateName = 'error-template-load-main.njk';
      var missingTemplate = 'missing-template.njk';
      loader.addTemplate(mainTemplateName, '{% include "' + missingTemplate + '" %}');
      try {
        await env.renderTemplate(mainTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        // Error should mention the missing template
        expect(err.message).to.match(/missing-template\.njk|not found/i);
      }
    });

    it('should report correct path for error in macro with imported context', async () => {
      var mainTemplateName = 'error-macro-context-main.njk';
      var macroTemplateName = 'error-macro-context-lib.njk';
      loader.addTemplate(mainTemplateName, '{% import "' + macroTemplateName + '" as lib with context %}{{ lib.myMacro() }}');
      loader.addTemplate(macroTemplateName, '{% macro myMacro() %}{{ nonExistentVar }}{% endmacro %}');
      env = new AsyncEnvironment(loader, { throwOnUndefined: true });
      try {
        await env.renderTemplate(mainTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${macroTemplateName})`);
      }
    });

    it('should report correct path for error in include with context', async () => {
      var mainTemplateName = 'error-include-context-main.njk';
      var childTemplateName = 'error-include-context-child.njk';
      loader.addTemplate(mainTemplateName, '{% include "' + childTemplateName + '" %}');
      loader.addTemplate(childTemplateName, '{{ contextVar }}');
      env = new AsyncEnvironment(loader, { throwOnUndefined: true });
      try {
        await env.renderTemplate(mainTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${childTemplateName})`);
      }
    });

    it('should report correct path for error during import with async template-level code', async () => {
      var mainTemplateName = 'error-import-async-main.njk';
      var libTemplateName = 'error-import-async-lib.njk';

      loader.addTemplate(mainTemplateName, `{% import "${libTemplateName}" as lib with context %}{{ lib.value }}`);
      loader.addTemplate(libTemplateName, '{% set value = errorAsyncFunc() %}');//poison starts at lib template

      try {
        await env.renderTemplate(mainTemplateName, {
          errorAsyncFunc: async () => {
            // Simulate async work then error
            await new Promise(resolve => setTimeout(resolve, 3));
            throw new Error('Async error during import');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain('Async error during import');
        expect(err.message).to.contain(`(${libTemplateName})`);
      }
    });

    it('should report correct path for error in second iteration of for loop', async () => {
      var templateName = 'error-for-loop-second-iteration.njk';
      loader.addTemplate(templateName, '{% for item in items %}{% if loop.index > 1 %}{{ nonExistentFunction() }}{% endif %}{% endfor %}');
      try {
        await env.renderTemplate(templateName, { items: [1, 2, 3] });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('shoukld report correct path when accessing unknown variable in script', async () => {
      var scriptName = 'error-script-unknown-variable.scr';
      loader.addTemplate(scriptName, ':data\nvar x = nonExistentVar\n@data.x = x');
      try {
        await env.renderScript(scriptName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${scriptName})`).and.contain('nonExistentVar').and.contain('Can not look up unknown variable');
      }
    });

    it('shoukld report correct path when outputing unknown variable in script', async () => {
      var scriptName = 'error-script-output-unknown-variable.scr';
      loader.addTemplate(scriptName, ':text\n@text( nonExistentVar )');
      try {
        await env.renderScript(scriptName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${scriptName})`).and.contain('nonExistentVar').and.contain('Can not look up unknown variable');
      }
    });

    it('shoukld report correct path when modifying unknown variable in script', async () => {
      var scriptName = 'error-script-modify-unknown-variable.scr';
      loader.addTemplate(scriptName, 'nonExistentVar = 1');
      try {
        await env.renderScript(scriptName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${scriptName})`).and.contain('nonExistentVar').and.contain('Cannot assign to undeclared variable');
      }
    });

    it('shoukld report correct path when using unknown handler in script', async () => {
      var scriptName = 'error-script-unknown-handler.scr';
      loader.addTemplate(scriptName, '@nonExistentHandler("Hi")');
      try {
        await env.renderScript(scriptName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${scriptName})`).and.contain('Unknown command handler').and.contain('nonExistentHandler');
      }
    });

    it('should report correct path for error in nested for loops', async () => {
      var templateName = 'error-nested-for-loops.njk';
      loader.addTemplate(templateName, '{% for outer in items %}{% for inner in outer %}{{ nonExistentFunction() }}{% endfor %}{% endfor %}');
      try {
        await env.renderTemplate(templateName, { items: [[1, 2], [3, 4]] });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in macro called from another macro', async () => {
      var templateName = 'error-macro-calling-macro.njk';
      loader.addTemplate(templateName,
        '{% macro inner() %}{{ nonExistentFunction() }}{% endmacro %}' +
        '{% macro outer() %}{{ inner() }}{% endmacro %}' +
        '{{ outer() }}'
      );
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in filter chain', async () => {
      var templateName = 'error-filter-chain.njk';
      loader.addTemplate(templateName, '{{ value | upper | myFilter }}');
      env.addFilterAsync('myFilter', async (val) => {
        throw new Error('Filter chain error');
      });
      try {
        await env.renderTemplate(templateName, { value: 'test' });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in set with async expression', async () => {
      var templateName = 'error-set-async.njk';
      loader.addTemplate(templateName, '{% set x = asyncFunc() %}{{ x }}');
      try {
        await env.renderTemplate(templateName, {
          asyncFunc: async () => {
            throw new Error('Async set error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in for loop expression', async () => {
      var templateName = 'error-for-expression.njk';
      loader.addTemplate(templateName, '{% for item in asyncFunc() %}{{ item }}{% endfor %}');
      try {
        await env.renderTemplate(templateName, {
          asyncFunc: async () => {
            throw new Error('For expression error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in if condition expression', async () => {
      var templateName = 'error-if-condition.njk';
      loader.addTemplate(templateName, '{% if asyncFunc() %}yes{% endif %}');
      try {
        await env.renderTemplate(templateName, {
          asyncFunc: async () => {
            throw new Error('If condition error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in macro argument', async () => {
      var templateName = 'error-macro-argument.njk';
      loader.addTemplate(templateName,
        '{% macro myMacro(x) %}{{ x }}{% endmacro %}' +
        '{{ myMacro(asyncFunc()) }}'
      );
      try {
        await env.renderTemplate(templateName, {
          asyncFunc: async () => {
            throw new Error('Macro argument error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in filter argument', async () => {
      var templateName = 'error-filter-argument.njk';
      loader.addTemplate(templateName, '{{ "test" | default(asyncFunc()) }}');
      try {
        await env.renderTemplate(templateName, {
          asyncFunc: async () => {
            throw new Error('Filter argument error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    // include poisoning not yet supported
    it.skip('should report correct path for error in include expression', async () => {
      var mainTemplateName = 'error-include-expression-main.njk';
      var childTemplateName = 'error-include-expression-child.njk';
      loader.addTemplate(mainTemplateName, '{% include asyncFunc() %}');
      loader.addTemplate(childTemplateName, 'Child content');
      try {
        await env.renderTemplate(mainTemplateName, {
          asyncFunc: async () => {
            throw new Error('Include expression error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${mainTemplateName})`);
      }
    });

    // extends poisoning not yet supported
    it.skip('should report correct path for error in extends expression', async () => {
      var childTemplateName = 'error-extends-expression-child.njk';
      var parentTemplateName = 'error-extends-expression-parent.njk';
      loader.addTemplate(childTemplateName, '{% extends errorAsyncFunc() %}');
      loader.addTemplate(parentTemplateName, '{% block content %}{% endblock %}');
      try {
        await env.renderTemplate(childTemplateName, {
          errorAsyncFunc: async () => {
            throw new Error('Extends expression error');
          }
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${childTemplateName})`);
      }
    });

    it('should report correct path for error with both extends and include', async () => {
      var childTemplateName = 'error-extends-include-child.njk';
      var parentTemplateName = 'error-extends-include-parent.njk';
      var includedTemplateName = 'error-extends-include-included.njk';
      loader.addTemplate(parentTemplateName, '{% block content %}{% endblock %}');
      loader.addTemplate(childTemplateName, '{% extends "' + parentTemplateName + '" %}{% block content %}{% include "' + includedTemplateName + '" %}{% endblock %}');
      loader.addTemplate(includedTemplateName, '{{ nonExistentFunction() }}');
      try {
        await env.renderTemplate(childTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${includedTemplateName})`);
      }
    });

    it('should report correct path for error in async iterator', async () => {
      var templateName = 'error-async-iterator.njk';
      loader.addTemplate(templateName, '{% for item in asyncIterator %}{{ item }}{% endfor %}');

      async function* failingIterator() {
        yield 1;
        yield 2;
        throw new Error('Async iterator error');
      }

      try {
        await env.renderTemplate(templateName, {
          asyncIterator: failingIterator()
        });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain('Async iterator error');
        expect(err.message).to.contain(`(${templateName})`);
      }
    });
  });

  describe('Async mode - comprehensive loop error handling', () => {
    let loader;
    let env;

    beforeEach(() => {
      loader = new StringLoader();
      env = new AsyncEnvironment(loader);
    });

    describe('For loops with async iterators', () => {
      it('should report error in async iterator body', async () => {
        const templateName = 'error-async-iterator-body.njk';
        loader.addTemplate(templateName, '{% for item in asyncIterator %}{{ item }}{% endfor %}');

        async function* failingIterator() {
          yield 1;
          yield 2;
          throw new Error('Async iterator error in body');
        }

        try {
          await env.renderTemplate(templateName, {
            asyncIterator: failingIterator()
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Async iterator error in body');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in async iterator condition', async () => {
        const templateName = 'error-async-iterator-condition.njk';
        loader.addTemplate(templateName, '{% for item in getIterator() %}{{ item }}{% endfor %}');

        try {
          await env.renderTemplate(templateName, {
            getIterator: async () => {
              throw new Error('Error getting async iterator');
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Error getting async iterator');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error during iteration value processing', async () => {
        const templateName = 'error-async-iterator-processing.njk';
        loader.addTemplate(templateName, '{% for item in asyncIterator %}{{ failFunc(item) }}{% endfor %}');

        async function* yieldingIterator() {
          yield 1;
          yield 2;
          yield 3;
        }

        try {
          await env.renderTemplate(templateName, {
            asyncIterator: yieldingIterator(),
            failFunc: (item) => {
              if (item === 2) throw new Error('Processing failed for item 2');
              return item;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Processing failed for item 2');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });
    });

    describe('For loops with arrays', () => {
      it('should report error in array loop body', async () => {
        const templateName = 'error-array-body.njk';
        loader.addTemplate(templateName, '{% for item in items %}{{ failFunc(item) }}{% endfor %}');

        try {
          await env.renderTemplate(templateName, {
            items: [1, 2, 3],
            failFunc: async (item) => {
              if (item === 2) throw new Error('Array processing error');
              return item;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Array processing error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in array condition', async () => {
        const templateName = 'error-array-condition.njk';
        loader.addTemplate(templateName, '{% for item in getItems() %}{{ item }}{% endfor %}');

        try {
          await env.renderTemplate(templateName, {
            getItems: async () => {
              throw new Error('Error fetching array');
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Error fetching array');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in parallel array loop', async () => {
        const templateName = 'error-array-parallel.njk';
        loader.addTemplate(templateName, '{% for item in items %}{{ asyncFail(item) }}{% endfor %}');

        try {
          await env.renderTemplate(templateName, {
            items: [1, 2, 3, 4, 5],
            asyncFail: async (item) => {
              await new Promise(resolve => setTimeout(resolve, item * 10));
              if (item === 3) throw new Error('Parallel array error');
              return item;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Parallel array error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });
    });

    describe('For loops with objects', () => {
      it('should report error in object loop body', async () => {
        const templateName = 'error-object-body.njk';
        loader.addTemplate(templateName, '{% for key, val in obj %}{{ failFunc(val) }}{% endfor %}');

        try {
          await env.renderTemplate(templateName, {
            obj: { a: 1, b: 2, c: 3 },
            failFunc: async (val) => {
              if (val === 2) throw new Error('Object processing error');
              return val;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Object processing error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in object condition', async () => {
        const templateName = 'error-object-condition.njk';
        loader.addTemplate(templateName, '{% for key, val in getObj() %}{{ val }}{% endfor %}');

        try {
          await env.renderTemplate(templateName, {
            getObj: async () => {
              throw new Error('Error fetching object');
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Error fetching object');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });
    });

    describe('While loops', () => {
      it('should report error in while loop body', async () => {
        const templateName = 'error-while-body.njk';
        loader.addTemplate(templateName, '{% set counter = 0 %}{% while counter < 5 %}{{ failFunc(counter) }}{% set counter = counter + 1 %}{% endwhile %}');

        try {
          await env.renderTemplate(templateName, {
            failFunc: async (val) => {
              if (val === 3) throw new Error('While loop body error');
              return val;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('While loop body error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in while loop condition', async () => {
        const templateName = 'error-while-condition.njk';
        loader.addTemplate(templateName, '{% set counter = 0 %}{% while checkCondition(counter) %}{{ counter }}{% set counter = counter + 1 %}{% endwhile %}');

        try {
          await env.renderTemplate(templateName, {
            checkCondition: async (val) => {
              if (val === 3) throw new Error('While condition error');
              return val < 5;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('While condition error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in while condition on first check', async () => {
        const templateName = 'error-while-first-condition.njk';
        loader.addTemplate(templateName, '{% while getCondition() %}never executed{% endwhile %}');

        try {
          await env.renderTemplate(templateName, {
            getCondition: async () => {
              throw new Error('Initial condition error');
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Initial condition error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });
    });

    describe('Each loops (sequential)', () => {
      it('should report error in each loop body with array', async () => {
        const templateName = 'error-each-array.njk';
        loader.addTemplate(templateName, '{% asyncEach item in items %}{{ failFunc(item) }}{% endeach %}');

        try {
          await env.renderTemplate(templateName, {
            items: [1, 2, 3],
            failFunc: async (item) => {
              if (item === 2) throw new Error('Each array error');
              return item;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Each array error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in each loop body with object', async () => {
        const templateName = 'error-each-object.njk';
        loader.addTemplate(templateName, '{% asyncEach key, val in obj %}{{ failFunc(val) }}{% endeach %}');

        try {
          await env.renderTemplate(templateName, {
            obj: { a: 1, b: 2, c: 3 },
            failFunc: async (val) => {
              if (val === 2) throw new Error('Each object error');
              return val;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Each object error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error in each loop with async iterator', async () => {
        const templateName = 'error-each-async-iterator.njk';
        loader.addTemplate(templateName, '{% asyncEach item in asyncIterator %}{{ failFunc(item) }}{% endeach %}');

        async function* yieldingIterator() {
          yield 1;
          yield 2;
          yield 3;
        }

        try {
          await env.renderTemplate(templateName, {
            asyncIterator: yieldingIterator(),
            failFunc: async (item) => {
              if (item === 2) throw new Error('Each iterator error');
              return item;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Each iterator error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });
    });

    describe('Nested loop errors', () => {
      it('should report error from nested for loops', async () => {
        const templateName = 'error-nested-for.njk';
        loader.addTemplate(templateName, '{% for i in outer %}{% for j in inner %}{{ failFunc(j) }}{% endfor %}{% endfor %}');

        try {
          await env.renderTemplate(templateName, {
            outer: [1, 2],
            inner: [1, 2, 3],
            failFunc: async (val) => {
              if (val === 2) throw new Error('Nested loop error');
              return val;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('Nested loop error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });

      it('should report error from for loop inside while loop', async () => {
        const templateName = 'error-for-in-while.njk';
        loader.addTemplate(templateName, '{% set counter = 0 %}{% while counter < 2 %}{% for item in items %}{{ failFunc(item) }}{% endfor %}{% set counter = counter + 1 %}{% endwhile %}');

        try {
          await env.renderTemplate(templateName, {
            items: [1, 2, 3],
            failFunc: async (val) => {
              if (val === 2) throw new Error('For in while error');
              return val;
            }
          });
          expect().fail('Expected an error to be thrown');
        } catch (err) {
          expect(err.message).to.contain('For in while error');
          expect(err.message).to.contain(`(${templateName})`);
        }
      });
    });
  });
})();
