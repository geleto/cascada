'use strict';

let expect;
let AsyncEnvironment;
let runtime;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  runtime = require('../../src/runtime/runtime');
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  runtime = nunjucks.runtime;
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
});
