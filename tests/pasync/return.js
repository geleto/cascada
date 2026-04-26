'use strict';

let expect;
let AsyncEnvironment;
let runtime;
let scriptTranspiler;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  runtime = require('../../src/runtime/runtime');
  scriptTranspiler = require('../../src/script/script-transpiler');
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  runtime = nunjucks.runtime;
  scriptTranspiler = nunjucks.scriptTranspiler;
}

describe('Cascada Script return', function () {
  let env;

  beforeEach(function () {
    env = new AsyncEnvironment();
  });

  it('supports the internal return-unset guard before and after a return', async function () {
    const events = [];
    const script = `
      if __return__ == __RETURN_UNSET__
        record("before")
      endif
      return "done"
      if __return__ == __RETURN_UNSET__
        record("after")
      endif
    `;

    const result = await env.renderScriptString(script, {
      record(value) {
        events.push(value);
      }
    });

    expect(result).to.be('done');
    expect(events).to.eql(['before']);
  });

  it('lets nested control-flow buffers observe the same return channel', async function () {
    const events = [];
    const script = `
      return "done"
      if true
        if __return__ == __RETURN_UNSET__
          record("after")
        endif
      endif
    `;

    const result = await env.renderScriptString(script, {
      record(value) {
        events.push(value);
      }
    });

    expect(result).to.be('done');
    expect(events).to.eql([]);
  });

  it('lets loop buffers observe the same return channel', async function () {
    const events = [];
    const script = `
      var i = 0
      while i < 1
        if __return__ == __RETURN_UNSET__
          record("while-before")
        endif
        i = i + 1
      endwhile
      for item in [1]
        return "done"
        if __return__ == __RETURN_UNSET__
          record("for-after")
        endif
      endfor
      each item in [1]
        if __return__ == __RETURN_UNSET__
          record("each-after")
        endif
      endeach
    `;

    const result = await env.renderScriptString(script, {
      record(value) {
        events.push(value);
      }
    });

    expect(result).to.be('done');
    expect(events).to.eql(['while-before']);
  });

  it('supports the inverse internal return-state comparison', async function () {
    const events = [];
    const script = `
      if __return__ != __RETURN_UNSET__
        record("before")
      endif
      return "done"
      if __return__ != __RETURN_UNSET__
        record("after")
      endif
    `;

    const result = await env.renderScriptString(script, {
      record(value) {
        events.push(value);
      }
    });

    expect(result).to.be('done');
    expect(events).to.eql(['after']);
  });

  it('keeps function return channels independent from the outer return channel', async function () {
    const events = [];
    const script = `
      function pick()
        return "inner"
        if __return__ == __RETURN_UNSET__
          return "wrong"
        endif
      endfunction
      var picked = pick()
      if __return__ == __RETURN_UNSET__
        record("outer unset")
      endif
      return picked
    `;

    const result = await env.renderScriptString(script, {
      record(value) {
        events.push(value);
      }
    });
    expect(result).to.be('inner');
    expect(events).to.eql(['outer unset']);
  });

  it('does not surface a returned error value through later return-state guards', async function () {
    const events = [];
    const script = `
      return fail()
      if __return__ == __RETURN_UNSET__
        record("after")
      endif
    `;

    try {
      await env.renderScriptString(script, {
        async fail() {
          throw new Error('return failed');
        },
        record(value) {
          events.push(value);
        }
      });
      expect().fail('Should have thrown');
    } catch (err) {
      expect(runtime.isPoisonError(err)).to.be(true);
      expect(err.errors.some((nested) => nested.message.indexOf('return failed') !== -1)).to.be(true);
      expect(events).to.eql([]);
    }
  });

  it('rejects user declarations that shadow internal return names', async function () {
    const scripts = [
      'var __return__ = 1\nreturn null',
      'var __RETURN_UNSET__ = 1\nreturn null'
    ];

    for (const script of scripts) {
      try {
        await env.renderScriptString(script);
        expect().fail('Should have rejected reserved internal return name');
      } catch (err) {
        expect(err.message).to.contain('reserved');
      }
    }
  });

  describe('logical semicolon lines', function () {
    it('renders semicolon-separated statements on one physical line', async function () {
      const result = await env.renderScriptString('var a = 1; var b = 2; return a + b');
      expect(result).to.be(3);
    });

    it('supports same-line block sequences', async function () {
      const result = await env.renderScriptString('if true; return 1; endif');
      expect(result).to.be(1);
    });

    it('keeps semicolon logical lines on the same generated physical line', function () {
      const template = scriptTranspiler.scriptToTemplate('var a = 1; var b = 2; return a + b');
      expect(template.split('\n')).to.have.length(1);
      expect(template).to.contain('{%- var a = 1 -%}');
      expect(template).to.contain('{%- var b = 2 -%}');
      expect(template).to.contain('{%- return a + b -%}');
    });

    it('does not split semicolons inside strings, regexes, or comments', async function () {
      const script = [
        'var label = "a;b"; var pattern = r/a;b/; // comment ; stays comment',
        'return label'
      ].join('\n');

      const result = await env.renderScriptString(script);
      expect(result).to.be('a;b');
    });

    it('preserves comments between semicolon statements in source order', function () {
      const template = scriptTranspiler.scriptToTemplate(
        'var a = 1; /* comment ; still comment */ var b = 2; return b'
      );

      const firstStatement = template.indexOf('{%- var a = 1 -%}');
      const comment = template.indexOf('{#- comment ; still comment -#}');
      const secondStatement = template.indexOf('{%- var b = 2 -%}');
      expect(firstStatement).to.be.lessThan(comment);
      expect(comment).to.be.lessThan(secondStatement);
    });

    it('does not continue from a previous physical line terminated by semicolon', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'var a = 1;',
        '  + 2; return a'
      ].join('\n'));

      expect(template).to.contain('{%- var a = 1 -%}\n');
      expect(template).to.not.contain('var a = 1\n  + 2');
    });

    it('preserves raw block bodies without semicolon splitting or script wrapping', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'raw',
        'a;b;return c',
        'endraw'
      ].join('\n'));

      expect(template).to.contain('\na;b;return c\n');
      expect(template).to.not.contain('{%- do a;b;return c -%}');
    });

    it('reports block errors on the original physical line', function () {
      try {
        scriptTranspiler.scriptToTemplate('if true; endif; endif');
        expect().fail('Should have rejected extra endif');
      } catch (err) {
        expect(err.message).to.contain('Line 1');
        expect(err.message).to.contain('column');
      }
    });
  });

  describe('return analysis pre-pass', function () {
    it('marks loops whose own body contains a runtime return', function () {
      scriptTranspiler.scriptToTemplate([
        'for item in [1]',
        '  return item',
        'endfor'
      ].join('\n'));

      const analysis = scriptTranspiler.returnAnalysis;
      expect(analysis.loops).to.have.length(1);
      expect(analysis.loops[0].tagName).to.be('for');
      expect(analysis.loops[0].isParallelLoop).to.be(true);
      expect(analysis.loops[0].loopBodyContainsReturn).to.be(true);
    });

    it('does not count nested callable returns as outer loop returns', function () {
      scriptTranspiler.scriptToTemplate([
        'for item in [1]',
        '  function inner()',
        '    return item',
        '  endfunction',
        'endfor',
        'return null'
      ].join('\n'));

      const analysis = scriptTranspiler.returnAnalysis;
      expect(analysis.loops).to.have.length(1);
      expect(analysis.loops[0].loopBodyContainsReturn).to.be(false);
      expect(analysis.returnOwningScopes.some((scope) => scope.tagName === 'function' && scope.mayReturn)).to.be(true);
    });

    it('ignores return-looking content inside raw blocks', function () {
      scriptTranspiler.scriptToTemplate([
        'for item in [1]',
        '  raw',
        '    return item',
        '  endraw',
        'endfor',
        'return null'
      ].join('\n'));

      const analysis = scriptTranspiler.returnAnalysis;
      expect(analysis.loops).to.have.length(1);
      expect(analysis.loops[0].loopBodyContainsReturn).to.be(false);
    });

    it('classifies each as a sequential loop', function () {
      scriptTranspiler.scriptToTemplate([
        'each item in items',
        '  return item',
        'endeach'
      ].join('\n'));

      const analysis = scriptTranspiler.returnAnalysis;
      expect(analysis.loops).to.have.length(1);
      expect(analysis.loops[0].tagName).to.be('each');
      expect(analysis.loops[0].isParallelLoop).to.be(false);
      expect(analysis.loops[0].isSequentialLoop).to.be(true);
      expect(analysis.loops[0].loopBodyContainsReturn).to.be(true);
    });
  });
});
