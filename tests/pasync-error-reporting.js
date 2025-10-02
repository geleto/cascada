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

    it('should report correct path for error in super block', async () => {
      var parentTemplateName = 'error-super-parent.njk';
      var childTemplateName = 'error-super-child.njk';
      loader.addTemplate(parentTemplateName, '{% block content %}{{ nonExistentFunction() }}{% endblock %}');
      loader.addTemplate(childTemplateName, '{% extends "' + parentTemplateName + '" %}{% block content %}{{ super() }}{% endblock %}');
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in caller block', async () => {
      var templateName = 'error-caller.njk';
      loader.addTemplate(templateName, '{% macro wrapper() %}{{ caller() }}{% endmacro %}{% call wrapper() %}{{ nonExistentFunction() }}{% endcall %}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in capture block', async () => {
      var templateName = 'error-capture.njk';
      loader.addTemplate(templateName, '{% set captured %}{{ nonExistentFunction() }}{% endset %}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(templateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in multi-level extends (grandparent -> parent -> child)', async () => {
      var grandparentName = 'error-extends-grandparent.njk';
      var parentName = 'error-extends-parent-middle.njk';
      var childName = 'error-extends-child-deep.njk';
      loader.addTemplate(grandparentName, '{% block content %}{% endblock %}');
      loader.addTemplate(parentName, '{% extends "' + grandparentName + '" %}{% block content %}{{ super() }}{% endblock %}');
      loader.addTemplate(childName, '{% extends "' + parentName + '" %}{% block content %}{{ nonExistentFunction() }}{% endblock %}');
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);

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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(childTemplateName, {});
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${childTemplateName})`);
      }
    });

    it('should report correct path for error when template loading fails', async () => {
      var mainTemplateName = 'error-template-load-main.njk';
      var missingTemplate = 'missing-template.njk';
      loader.addTemplate(mainTemplateName, '{% include "' + missingTemplate + '" %}');
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader, { throwOnUndefined: true });
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
      let env = new AsyncEnvironment(loader, { throwOnUndefined: true });
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

      loader.addTemplate(mainTemplateName, '{% import "' + libTemplateName + '" as lib %}{{ lib.value }}');
      loader.addTemplate(libTemplateName, '{% set value = asyncFunc() %}');

      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(mainTemplateName, {
          asyncFunc: async () => {
            // Simulate async work then error
            await new Promise(resolve => setTimeout(resolve, 10));
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
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(templateName, { items: [1, 2, 3] });
        expect().fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.contain(`(${templateName})`);
      }
    });

    it('should report correct path for error in nested for loops', async () => {
      var templateName = 'error-nested-for-loops.njk';
      loader.addTemplate(templateName, '{% for outer in items %}{% for inner in outer %}{{ nonExistentFunction() }}{% endfor %}{% endfor %}');
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);
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

    it('should report correct path for error in include expression', async () => {
      var mainTemplateName = 'error-include-expression-main.njk';
      var childTemplateName = 'error-include-expression-child.njk';
      loader.addTemplate(mainTemplateName, '{% include asyncFunc() %}');
      loader.addTemplate(childTemplateName, 'Child content');
      let env = new AsyncEnvironment(loader);
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

    it('should report correct path for error in extends expression', async () => {
      var childTemplateName = 'error-extends-expression-child.njk';
      var parentTemplateName = 'error-extends-expression-parent.njk';
      loader.addTemplate(childTemplateName, '{% extends asyncFunc() %}');
      loader.addTemplate(parentTemplateName, '{% block content %}{% endblock %}');
      let env = new AsyncEnvironment(loader);
      try {
        await env.renderTemplate(childTemplateName, {
          asyncFunc: async () => {
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
      let env = new AsyncEnvironment(loader);
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
      let env = new AsyncEnvironment(loader);

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
        expect(err.message).to.contain(`(${templateName})`);
      }
    });
  });
})();
