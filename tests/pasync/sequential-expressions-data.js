'use strict';

var expect;
var AsyncEnvironment;
var Template;
var delay;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const index = require('../../src/index');
  AsyncEnvironment = index.AsyncEnvironment;
  Template = index.Template;
  const util = require('../util');
  delay = util.delay;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  delay = window.util.delay;
  Template = nunjucks.Template;
}

describe('Sequential Expressions Data Output Tests', function () {

  it('should handle sequence in condition and output via @data', async function () {
    const src = `
    :data
    @data.value = (account!.op('B') if account!.op('A') else 'no')
    `;
    const env = new AsyncEnvironment(null, { asyncControl: true });

    const ops = [];
    const account = {
      op: async function (name) {
        await delay(10);
        ops.push(name);
        return 'yes';
      }
    };

    // Use renderScriptString which handles transpilation and returns the data object
    const res = await env.renderScriptString(src, { account: account });

    expect(res.value).to.be('yes');
    expect(ops).to.eql(['A', 'B']);
  });

  it('should handle direct sequence expression in @data assignment', async function () {
    const src = `
    :data
    @data.value = (account!.op('B') if account!.op('A') else 'no')
    `;
    const env = new AsyncEnvironment(null, { asyncControl: true });

    const ops = [];
    const account = {
      op: async function (name) {
        await delay(10);
        ops.push(name);
        return 'result';
      }
    };

    const res = await env.renderScriptString(src, { account: account });

    expect(res.value).to.be('result');
    expect(ops).to.eql(['A', 'B']);
  });

});
