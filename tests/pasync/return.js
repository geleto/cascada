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
      if __return__ == __RETURN_UNSET__
        record("unset")
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
    expect(events).to.eql(['unset']);
  });

  describe('guard waterfall', function () {
    it('skips statements after a top-level return', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'record("before")',
        'return "done"',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql(['before']);
    });

    it('keeps the first visible top-level return value', async function () {
      const result = await env.renderScriptString([
        'return "first"',
        'return "second"'
      ].join('\n'));

      expect(result).to.be('first');
    });

    it('cascades a return out of nested if blocks', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'if true',
        '  if true',
        '    return "done"',
        '  endif',
        '  record("after-inner")',
        'endif',
        'record("after-outer")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('keeps return guards open across nested sibling blocks until the returning block closes', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'if true',
        '  return "done"',
        '  if true',
        '    record("nested-after-return")',
        '  endif',
        'endif',
        'record("outer-after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('keeps middle tags attached to the original block', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'if false',
        '  return "wrong"',
        'else',
        '  record("else")',
        'endif',
        'return "done"'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql(['else']);
    });

    it('balances guards when both if and else branches return', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'if false',
        '  return "wrong"',
        'else',
        '  return "done"',
        'endif',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('handles elif return branches without leaking guards', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'if false',
        '  return "wrong"',
        'elif true',
        '  return "done"',
        'else',
        '  return "also-wrong"',
        'endif',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('handles switch case/default returns without leaking guards', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'switch 2',
        'case 1',
        '  return "one"',
        'case 2',
        '  return "two"',
        'default',
        '  return "default"',
        'endswitch',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('two');
      expect(events).to.eql([]);
    });

    it('handles loop else returns without leaking guards', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'for item in []',
        '  return "wrong"',
        'else',
        '  return "done"',
        'endfor',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('keeps guard/recover branches attached to the original guard block', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'guard',
        '  var failed = fail()',
        'recover err',
        '  return "recover"',
        'endguard',
        'record("after")'
      ].join('\n'), {
        fail() {
          throw new Error('boom');
        },
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('recover');
      expect(events).to.eql([]);
    });

    it('closes guard-branch returns before recover', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'guard',
        '  return "guard"',
        'recover err',
        '  record("recover")',
        'endguard',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('guard');
      expect(events).to.eql([]);
    });

    it('does not let nested function returns guard the outer scope', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'function inner()',
        '  return "inner"',
        '  record("inner-after")',
        'endfunction',
        'record("outer-after-function")',
        'return inner()'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('inner');
      expect(events).to.eql(['outer-after-function']);
    });

    it('cascades returns after loop end tags', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'var i = 0',
        'while i < 1',
        '  i = i + 1',
        '  return "done"',
        'endwhile',
        'record("after-while")',
        'for item in [1]',
        '  record("after-for-start")',
        'endfor',
        'each item in [1]',
        '  record("after-each-start")',
        'endeach'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('keeps caller block returns local to the call body', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'function runner()',
        '  return caller()',
        'endfunction',
        'var callerResult = call runner()',
        '  return 7',
        '  record("caller-after")',
        'endcall',
        'record("outer-after-call")',
        'return callerResult'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be(7);
      expect(events).to.eql(['outer-after-call']);
    });

    it('closes EOF root guards after a final comment-only line', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'return "done"',
        '// final comment'
      ].join('\n'));

      const commentIndex = template.indexOf('{#- final comment -#}');
      const closeIndex = template.lastIndexOf('{%- endif -%}');
      expect(commentIndex).to.be.greaterThan(-1);
      expect(closeIndex).to.be.greaterThan(commentIndex);
    });

    it('preserves physical line count when injecting nested return guards', function () {
      const script = [
        'if true',
        '  return 1',
        'endif',
        'return 2'
      ].join('\n');
      const template = scriptTranspiler.scriptToTemplate(script);

      expect(template.split('\n')).to.have.length(script.split('\n').length);
    });
  });

  describe('loop return semantics', function () {
    it('rewrites while conditions in return-owning scopes', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'var keepGoing = true',
        'while keepGoing',
        '  keepGoing = false',
        'endwhile',
        'return "done"'
      ].join('\n'));

      expect(template).to.contain('while __return__ == __RETURN_UNSET__ and (keepGoing)');
    });

    it('does not rewrite while conditions in scopes that cannot return', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'var keepGoing = true',
        'while keepGoing',
        '  keepGoing = false',
        'endwhile'
      ].join('\n'));

      expect(template).to.not.contain('while __return__ == __RETURN_UNSET__');
    });

    it('does not evaluate another while condition after return', async function () {
      let conditionChecks = 0;
      const result = await env.renderScriptString([
        'while shouldContinue()',
        '  return "done"',
        'endwhile',
        'return "wrong"'
      ].join('\n'), {
        shouldContinue() {
          conditionChecks += 1;
          return conditionChecks < 3;
        }
      });

      expect(result).to.be('done');
      expect(conditionChecks).to.be(1);
    });

    it('preserves multi-line while conditions when adding the return guard', async function () {
      const script = [
        'var i = 0',
        'while (',
        '  i < 3',
        ')',
        '  i = i + 1',
        '  return i',
        'endwhile',
        'return 0'
      ].join('\n');
      const template = scriptTranspiler.scriptToTemplate(script);
      const result = await env.renderScriptString(script);

      expect(template).to.contain('while __return__ == __RETURN_UNSET__ and ((');
      expect(template).to.contain(')) -%}');
      expect(template.split('\n')).to.have.length(script.split('\n').length);
      expect(result).to.be(1);
    });

    it('stops sequential each advancement after return', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'each item in [1, 2, 3]',
        '  record("before-" + item)',
        '  if item == 2',
        '    return item',
        '  endif',
        '  record("after-" + item)',
        'endeach',
        'record("after-loop")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be(2);
      expect(events).to.eql(['before-1', 'after-1', 'before-2']);
    });

    it('stops object each advancement after return', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'each key, val in items',
        '  record(key + ":" + val)',
        '  return key',
        'endeach',
        'return null'
      ].join('\n'), {
        items: { a: 1, b: 2, c: 3 },
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('a');
      expect(events).to.eql(['a:1']);
    });

    it('does not pull the next async iterator item after an each return', async function () {
      const yielded = [];
      async function* items() {
        for (const item of [1, 2, 3]) {
          yielded.push(item);
          yield item;
        }
      }

      const result = await env.renderScriptString([
        'each item in items()',
        '  if item == 2',
        '    return item',
        '  endif',
        'endeach',
        'return null'
      ].join('\n'), {
        items
      });

      expect(result).to.be(2);
      expect(yielded).to.eql([1, 2]);
    });

    it('gates return-capable parallel for bodies with ordered return checks', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'for item in items',
        '  if item.ok',
        '    return item',
        '  endif',
        'endfor',
        'return null'
      ].join('\n'));

      expect(template).to.contain('{%- for item in items -%}{%- if __return__ == __RETURN_UNSET__ -%}');
      expect(template).to.contain('{%- if __return__ == __RETURN_UNSET__ -%}    {%- return item -%}{%- endif -%}');
    });

    it('does not gate parallel for bodies that only contain nested callable returns', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'for item in items',
        '  function inner()',
        '    return item',
        '  endfunction',
        'endfor',
        'return null'
      ].join('\n'));

      expect(template).to.not.contain('{%- for item in items -%}{%- if __return__ == __RETURN_UNSET__ -%}');
    });

    it('keeps the first source-visible parallel for return value', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'for item in [1, 2]',
        '  record("body-" + item)',
        '  if item == 1',
        '    return delay("first", 30)',
        '  endif',
        '  if item == 2',
        '    return delay("second", 0)',
        '  endif',
        'endfor',
        'return "none"'
      ].join('\n'), {
        record(value) {
          events.push(value);
        },
        delay(value, ms) {
          return new Promise((resolve) => setTimeout(() => resolve(value), ms));
        }
      });

      expect(result).to.be('first');
      expect(events).to.eql(['body-1']);
    });
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
