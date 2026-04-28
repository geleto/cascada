
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import * as runtime from '../../src/runtime/runtime.js';
import * as scriptTranspiler from '../../src/script/script-transpiler.js';

describe('Cascada Script return', function () {
  let env;

  beforeEach(function () {
    env = new AsyncEnvironment();
  });

  it('supports the internal return-unset guard before and after a return', async function () {
    const events = [];
    const script = `
      if __return_is_unset__()
        record("before")
      endif
      return "done"
      if __return_is_unset__()
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
        if __return_is_unset__()
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
        if __return_is_unset__()
          record("while-before")
        endif
        i = i + 1
      endwhile
      for item in [1]
        return "done"
        if __return_is_unset__()
          record("for-after")
        endif
      endfor
      each item in [1]
        if __return_is_unset__()
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

  it('supports the inverse internal return-state guard', async function () {
    const events = [];
    const script = `
      if __return_is_unset__() == false
        record("before")
      endif
      if __return_is_unset__()
        record("unset")
      endif
      return "done"
      if __return_is_unset__() == false
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

    it('skips structured blocks opened after a top-level return', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'return "done"',
        'if false',
        '  record("if")',
        'else',
        '  record("else")',
        'endif',
        'switch 2',
        'case 1',
        '  record("case-1")',
        'case 2',
        '  record("case-2")',
        'default',
        '  record("default")',
        'endswitch',
        'for item in []',
        '  record("for-body")',
        'else',
        '  record("for-else")',
        'endfor',
        'guard',
        '  var failed = fail()',
        'recover err',
        '  record("recover")',
        'endguard',
        'record("after")'
      ].join('\n'), {
        fail() {
          throw new Error('skipped guard body should not run');
        },
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('closes a return guard before a middle tag after skipped nested blocks', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'if true',
        '  return "done"',
        '  switch 1',
        '  case 1',
        '    record("case")',
        '  default',
        '    record("default")',
        '  endswitch',
        'else',
        '  record("else")',
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

    it('does not let a return in an unselected switch case guard selected non-return cases', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'switch 2',
        'case 1',
        '  return "one"',
        'case 2',
        '  record("two")',
        'default',
        '  return "default"',
        'endswitch',
        'record("after")',
        'return "done"'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql(['two', 'after']);
    });

    it('closes nested switch-case returns before later cases', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'switch 1',
        'case 1',
        '  if true',
        '    return "one"',
        '  endif',
        'case 2',
        '  record("two")',
        'endswitch',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('one');
      expect(events).to.eql([]);
    });

    it('handles same-line switch middle tags around returns', async function () {
      const events = [];
      const result = await env.renderScriptString(
        'switch 2; case 1; return "one"; case 2; return "two"; default; return "default"; endswitch; record("after")',
        {
          record(value) {
            events.push(value);
          }
        }
      );

      expect(result).to.be('two');
      expect(events).to.eql([]);
    });

    it('handles loop else returns without leaking guards', async function () {
      const events = [];
      const script = [
        'for item in []',
        '  record("body")',
        'else',
        '  return "done"',
        'endfor',
        'record("after")'
      ].join('\n');
      const template = scriptTranspiler.scriptToTemplate(script);
      const result = await env.renderScriptString(script, {
        record(value) {
          events.push(value);
        }
      });

      expect(template).to.not.contain('{%- for item in [] -%}{%- if __return_is_unset__() -%}');
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

    it('does not let nested function returns open outer loop body gates', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'for item in [1, 2]',
        '  function inner()',
        '    return item',
        '  endfunction',
        '  record("outer-" + item)',
        'endfor',
        'return "done"'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql(['outer-1', 'outer-2']);
    });

    it('keeps method returns local and skips later method statements', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'method build()',
        '  return "method"',
        '  record("method-after")',
        'endmethod',
        'record("outer-after-method")',
        'return this.build()'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('method');
      expect(events).to.eql(['outer-after-method']);
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

    it('does not emit empty return guards at block or EOF boundaries', function () {
      const cases = [
        'return "done"',
        [
          'return "done"',
          '// final comment'
        ].join('\n'),
        [
          'return "done"',
          '',
          '// final comment',
          '',
          '/* final block comment */'
        ].join('\n'),
        'return "done";',
        'return "done"; // final comment',
        [
          'if true',
          '  return "done"',
          'endif'
        ].join('\n'),
        [
          'if true',
          '  return "done"',
          '',
          '  // final branch comment',
          '',
          'endif'
        ].join('\n'),
        [
          'if true',
          '  return "done"',
          '',
          '  // final branch comment',
          '',
          'else',
          '  return "other"',
          'endif'
        ].join('\n'),
        [
          'function f()',
          '  return "done"',
          'endfunction',
          'return f()'
        ].join('\n'),
        [
          'switch 1',
          'case 1',
          '  return "one"',
          'endswitch'
        ].join('\n'),
        'if true; return 1; endif'
      ];

      cases.forEach((script) => {
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.not.match(/\{%- if __return_is_unset__\(\) -%\}\s*\{%- endif -%\}/);
      });
    });

    it('keeps final comments outside dropped EOF return guards', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'return "done"',
        '// final comment'
      ].join('\n'));

      const commentIndex = template.indexOf('{#- final comment -#}');
      expect(commentIndex).to.be.greaterThan(-1);
      expect(template).to.not.contain('__return_is_unset__()');
    });

    it('keeps comments and blank lines before the guard for later executable statements', async function () {
      const events = [];
      const script = [
        'return "done"',
        '',
        '// still a plain comment',
        '',
        'record("after")'
      ].join('\n');
      const template = scriptTranspiler.scriptToTemplate(script);

      const commentIndex = template.indexOf('{#- still a plain comment -#}');
      const guardIndex = template.indexOf('{%- if __return_is_unset__() -%}');
      const recordIndex = template.indexOf('{%- do record("after") -%}');
      expect(commentIndex).to.be.greaterThan(-1);
      expect(guardIndex).to.be.greaterThan(commentIndex);
      expect(recordIndex).to.be.greaterThan(guardIndex);

      const result = await env.renderScriptString(script, {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('guards structurally empty blocks after return so their conditions do not run', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'return "done"',
        'if shouldNotRun("empty-if")',
        'endif',
        'if shouldNotRun("comment-only-if")',
        '  // body has no executable statements',
        'endif'
      ].join('\n'), {
        shouldNotRun(value) {
          events.push(value);
          return true;
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('does not keep stale active guards nested around later return checks', function () {
      const cascaded = scriptTranspiler.scriptToTemplate([
        'if a',
        '  return 1',
        'endif',
        'if b',
        '  return 2',
        'endif',
        'record("after")'
      ].join('\n'));
      expect(cascaded).to.contain([
        '{%- endif -%}{%- endif -%}',
        '{%- if __return_is_unset__() -%}{%- do record("after") -%}{%- endif -%}'
      ].join('\n'));
      expect(cascaded).to.not.contain('{%- do record("after") -%}{%- endif -%}{%- endif -%}');

      const consecutive = scriptTranspiler.scriptToTemplate([
        'return 1',
        'return 2',
        'record("after")'
      ].join('\n'));
      expect(consecutive).to.contain([
        '{%- if __return_is_unset__() -%}{%- return 2 -%}{%- endif -%}',
        '{%- if __return_is_unset__() -%}{%- do record("after") -%}{%- endif -%}'
      ].join('\n'));
      expect(consecutive).to.not.contain('{%- do record("after") -%}{%- endif -%}{%- endif -%}');
    });

    it('guards same-line statements after a semicolon return', async function () {
      const events = [];
      const result = await env.renderScriptString(
        'return "done"; record("after")',
        {
          record(value) {
            events.push(value);
          }
        }
      );

      expect(result).to.be('done');
      expect(events).to.eql([]);
    });

    it('preserves physical line count when injecting nested return guards', function () {
      const cases = [
        [
          'if true',
          '  return 1',
          'endif',
          'return 2'
        ].join('\n'),
        [
          'return "done"',
          '',
          '// comment before guarded code',
          '',
          'record("after")'
        ].join('\n'),
        [
          'if true',
          '  return "done"',
          '',
          '  // branch comment',
          '',
          'else',
          '  record("else")',
          'endif',
          'record("after")'
        ].join('\n'),
        [
          'switch 1',
          'case 1',
          '  return "one"',
          '',
          '  // case comment',
          'case 2',
          '  record("two")',
          'endswitch',
          'record("after")'
        ].join('\n'),
        [
          'for item in [1]',
          '  return item',
          '',
          '  // loop comment',
          'endfor',
          'record("after")'
        ].join('\n')
      ];

      cases.forEach((script) => {
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template.split('\n')).to.have.length(script.split('\n').length);
      });
    });
  });

  describe('loop return semantics', function () {
    it('rewrites while conditions when the while body can return', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'var keepGoing = true',
        'while keepGoing',
        '  return "done"',
        'endwhile',
        'return "wrong"'
      ].join('\n'));

      expect(template).to.contain('while __return_is_unset__() and (keepGoing)');
    });

    it('does not rewrite while conditions in scopes that cannot return', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'var keepGoing = true',
        'while keepGoing',
        '  keepGoing = false',
        'endwhile'
      ].join('\n'));

      expect(template).to.not.contain('while __return_is_unset__()');
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

      expect(template).to.contain('while __return_is_unset__() and ((');
      expect(template).to.contain(')) -%}');
      expect(template.split('\n')).to.have.length(script.split('\n').length);
      expect(result).to.be(1);
    });

    it('keeps poison in return-aware while conditions observable through loop body channels', async function () {
      const result = await env.renderScriptString([
        'var count = 0',
        'while obj!.method()',
        '  count = count + 1',
        'endwhile',
        'return count is error'
      ].join('\n'), {
        obj: {
          method() {
            throw new Error('Object is poisoned');
          }
        }
      });

      expect(result).to.be(true);
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

    it('rejects for-with-return syntax through script rendering with a clear error', async function () {
      try {
        await env.renderScriptString([
          'for item in [1] with return',
          '  return item',
          'endfor'
        ].join('\n'));
        expect().fail('Should have rejected unsupported for-with-return syntax');
      } catch (err) {
        expect(err.message).to.contain('\'for ... with return\' is not supported');
        expect(err.message).to.contain('use \'each\'');
      }
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

      expect(template).to.contain('{%- for item in items -%}{%- if __return_is_unset__() -%}');
      expect(template).to.contain('{%- if __return_is_unset__() -%}    {%- return item -%}{%- endif -%}');
    });

    it('skips later statements in a parallel for body after a return-containing child block', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'for item in [1]',
        '  if true',
        '    return "done"',
        '  endif',
        '  record("after-if")',
        'endfor',
        'record("after-loop")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql([]);
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

      expect(template).to.not.contain('{%- for item in items -%}{%- if __return_is_unset__() -%}');
    });

    it('does not gate parallel for bodies for return-looking raw content', function () {
      const template = scriptTranspiler.scriptToTemplate([
        'for item in items',
        '  raw',
        '    return item',
        '  endraw',
        'endfor',
        'return null'
      ].join('\n'));

      expect(template).to.not.contain('{%- for item in items -%}{%- if __return_is_unset__() -%}');
      expect(template).to.contain('    return item');
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

    it('handles switch returns inside return-capable parallel for bodies', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'for item in [1, 2]',
        '  switch item',
        '  case 1',
        '    return "one"',
        '  case 2',
        '    record("two")',
        '  endswitch',
        'endfor',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('one');
      expect(events).to.eql([]);
    });
  });

  describe('semantic hardening', function () {
    it('returns null for bare return and skips later statements', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'return',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be(null);
      expect(events).to.eql([]);
    });

    it('returns null when a script completes without return', async function () {
      const result = await env.renderScriptString([
        'var x = 1'
      ].join('\n'));

      expect(result).to.be(null);
    });

    it('returns none as a real null value and skips later statements', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'return none',
        'record("after")'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be(null);
      expect(events).to.eql([]);
    });

    it('returns function-produced undefined as a real value', async function () {
      const result = await env.renderScriptString([
        'return getUndefined()'
      ].join('\n'), {
        getUndefined() {
          return undefined;
        }
      });

      expect(result).to.be(undefined);
    });

    it('resolves promised return values', async function () {
      const result = await env.renderScriptString([
        'return delayed("done")'
      ].join('\n'), {
        delayed(value) {
          return Promise.resolve(value);
        }
      });

      expect(result).to.be('done');
    });

    it('reports rejected promised return values', async function () {
      try {
        await env.renderScriptString([
          'return failLater()'
        ].join('\n'), {
          failLater() {
            return Promise.reject(new Error('rejected return'));
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors.some((nested) => nested.message.indexOf('rejected return') !== -1)).to.be(true);
      }
    });

    it('does not run later guards while a delayed return rejection settles', async function () {
      const events = [];
      try {
        await env.renderScriptString([
          'return failLater()',
          'if __return_is_unset__()',
          '  record("after")',
          'endif'
        ].join('\n'), {
          failLater() {
            return new Promise((resolve, reject) => {
              setTimeout(() => reject(new Error('delayed return rejection')), 0);
            });
          },
          record(value) {
            events.push(value);
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors.some((nested) => nested.message.indexOf('delayed return rejection') !== -1)).to.be(true);
        expect(events).to.eql([]);
      }
    });

    it('reports poison return values while still marking return as happened', async function () {
      const events = [];
      try {
        await env.renderScriptString([
          'return poisonValue()',
          'record("after")'
        ].join('\n'), {
          poisonValue() {
            return runtime.createPoison(new Error('poison return'));
          },
          record(value) {
            events.push(value);
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors.some((nested) => nested.message.indexOf('poison return') !== -1)).to.be(true);
        expect(events).to.eql([]);
      }
    });

    it('reports poison return values from nested guarded blocks', async function () {
      const events = [];
      try {
        await env.renderScriptString([
          'guard',
          '  if true',
          '    return poisonValue()',
          '  endif',
          'recover err',
          '  record("recover")',
          'endguard',
          'record("after")'
        ].join('\n'), {
          poisonValue() {
            return runtime.createPoison(new Error('guarded poison return'));
          },
          record(value) {
            events.push(value);
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors.some((nested) => nested.message.indexOf('guarded poison return') !== -1)).to.be(true);
        expect(events).to.eql([]);
      }
    });

    it('returns null from functions that complete without return', async function () {
      const result = await env.renderScriptString([
        'function noop()',
        '  var x = 1',
        'endfunction',
        'return noop()'
      ].join('\n'));

      expect(result).to.be(null);
    });

    it('does not leak no-return function sentinels into caller expressions', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'function noop()',
        '  var x = 1',
        'endfunction',
        'if noop()',
        '  record("truthy")',
        'else',
        '  record("falsey")',
        'endif',
        'return "done"'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql(['falsey']);
    });

    it('returns null from caller bodies that complete without return', async function () {
      const result = await env.renderScriptString([
        'function runner()',
        '  return caller()',
        'endfunction',
        'var callerResult = call runner()',
        '  var x = 1',
        'endcall',
        'return callerResult'
      ].join('\n'));

      expect(result).to.be(null);
    });

    it('returns null from methods that complete without return', async function () {
      const result = await env.renderScriptString([
        'method noop()',
        '  var x = 1',
        'endmethod',
        'return this.noop()'
      ].join('\n'));

      expect(result).to.be(null);
    });

    it('does not leak no-return caller body sentinels into caller expressions', async function () {
      const events = [];
      const result = await env.renderScriptString([
        'function runner()',
        '  return caller()',
        'endfunction',
        'var callerResult = call runner()',
        '  var x = 1',
        'endcall',
        'if callerResult',
        '  record("truthy")',
        'else',
        '  record("falsey")',
        'endif',
        'return "done"'
      ].join('\n'), {
        record(value) {
          events.push(value);
        }
      });

      expect(result).to.be('done');
      expect(events).to.eql(['falsey']);
    });

    it('returns null from caller body none', async function () {
      const result = await env.renderScriptString([
        'function runner()',
        '  return caller()',
        'endfunction',
        'var callerResult = call runner()',
        '  return none',
        'endcall',
        'return callerResult'
      ].join('\n'));

      expect(result).to.be(null);
    });

    it('does not let parallel for poison returns get overwritten by later ordered returns', async function () {
      try {
        await env.renderScriptString([
          'for item in [1, 2]',
          '  if item == 1',
          '    return poisonValue()',
          '  endif',
          '  if item == 2',
          '    return "wrong"',
          '  endif',
          'endfor',
          'return "none"'
        ].join('\n'), {
          poisonValue() {
            return runtime.createPoison(new Error('parallel poison return'));
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors.some((nested) => nested.message.indexOf('parallel poison return') !== -1)).to.be(true);
      }
    });

    it('does not let each poison returns advance to later ordered returns', async function () {
      const events = [];
      try {
        await env.renderScriptString([
          'each item in [1, 2]',
          '  record("item-" + item)',
          '  if item == 1',
          '    return poisonValue()',
          '  endif',
          '  return "wrong"',
          'endeach',
          'return "none"'
        ].join('\n'), {
          poisonValue() {
            return runtime.createPoison(new Error('each poison return'));
          },
          record(value) {
            events.push(value);
          }
        });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(runtime.isPoisonError(err)).to.be(true);
        expect(err.errors.some((nested) => nested.message.indexOf('each poison return') !== -1)).to.be(true);
        expect(events).to.eql(['item-1']);
      }
    });
  });

  it('keeps function return channels independent from the outer return channel', async function () {
    const events = [];
    const script = `
      function pick()
        return "inner"
        if __return_is_unset__()
          return "wrong"
        endif
      endfunction
      var picked = pick()
      if __return_is_unset__()
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
      if __return_is_unset__()
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
      'var __return_is_unset__ = 1\nreturn null',
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

});
