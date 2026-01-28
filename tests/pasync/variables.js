(function () {
  'use strict';

  var expect;
  var Compiler;
  var AsyncFrame;
  var nunjucks;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    nunjucks = require('../../src/index');
    Compiler = nunjucks.compiler.Compiler;
    AsyncFrame = nunjucks.runtime.AsyncFrame;
  } else {
    expect = window.expect;
    nunjucks = window.nunjucks;
    Compiler = nunjucks.compiler && nunjucks.compiler.Compiler;
    if (!Compiler && window.nunjucksFull) {
      Compiler = window.nunjucksFull.compiler && window.nunjucksFull.compiler.Compiler;
    }
    AsyncFrame = nunjucks.runtime && nunjucks.runtime.AsyncFrame;
  }

  describe('Async Variables', function () {
    it('should reject declarations on non-scoping frames', function () {
      var compiler;
      var root;
      var nonScope;
      AsyncFrame.inCompilerContext = true;
      try {
        compiler = new Compiler('scope-check.njk', {
          asyncMode: true,
          scriptMode: true
        });
        root = new AsyncFrame(null, false, true);
        nonScope = new AsyncFrame(root, false, false);

        expect(function () {
          compiler._addDeclaredVar(nonScope, 'leakyVar');
        }).to.throwException(/Cannot declare variable 'leakyVar' in a non-scoping frame\./);
      } finally {
        AsyncFrame.inCompilerContext = false;
      }
    });
  });
})();
