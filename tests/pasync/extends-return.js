'use strict';

let expect;
let AsyncEnvironment;
let StringLoader;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  StringLoader = require('../util').StringLoader;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  StringLoader = window.util.StringLoader;
}

describe('Extends Return Rules', function () {
  it('should use the entry file explicit return as the direct render result', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'return "A"');
    loader.addTemplate('C.script', 'extends "A.script"\nreturn "C"');

    const result = await env.renderScript('C.script', {});
    expect(result).to.be('C');
  });

  it('should ignore an ancestor explicit return when the entry file has no explicit return', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'return "A"');
    loader.addTemplate('C.script', 'extends "A.script"');

    const result = await env.renderScript('C.script', {});
    expect(result).to.be(undefined);
  });

  it('should ignore all ancestor explicit returns across a 3-level hierarchy', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'return "A"');
    loader.addTemplate('B.script', 'extends "A.script"\nreturn "B"');
    loader.addTemplate('C.script', 'extends "B.script"');

    const result = await env.renderScript('C.script', {});
    expect(result).to.be(undefined);
  });

  it('should not treat script output channels as the direct render result when the entry file has no explicit return', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'shared text trace\ntrace("A|")');
    loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\ntrace("C|")');

    const result = await env.renderScript('C.script', {});
    expect(result).to.be(undefined);
  });

  it('should keep the normal script fallback when the entry file has no explicit return', async function () {
    const env = new AsyncEnvironment();

    const result = await env.renderScriptString('var x = 1', {});
    expect(result).to.be(undefined);
  });

  it('should discard an ancestor constructor return in composition mode when the entry file returns explicitly', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'return waitAndGet("A")');
    loader.addTemplate('C.script', 'extends "A.script"\nreturn "C"');

    const result = await env.renderScript('C.script', {
      waitAndGet: (value) => Promise.resolve(value)
    });

    expect(result).to.be('C');
  });

  it('should discard all ancestor constructor returns in composition mode across a 3-level chain', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'return "A"');
    loader.addTemplate('B.script', 'extends "A.script"\nreturn Promise.resolve("B")');
    loader.addTemplate('C.script', 'extends "B.script"\nreturn "C"');

    const result = await env.renderScript('C.script', {
      Promise
    });

    expect(result).to.be('C');
  });
});
