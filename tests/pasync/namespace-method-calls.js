'use strict';

let expect;
let AsyncEnvironment;
let StringLoader;
let runtimeModule;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  StringLoader = require('../util').StringLoader;
  runtimeModule = require('../../src/runtime/runtime');
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  StringLoader = window.util.StringLoader;
  runtimeModule = nunjucks.runtime;
}

describe('Namespace Method Calls', function () {
  it('should resolve namespace method return values correctly', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build(name)',
      '  return "hello " + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'return ns.build("Ada")'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('hello Ada');
  });

  it('should isolate method-local temporary channels across calls', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build(name)',
      '  var local = "local-" + name',
      '  return local',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'return [ns.build("A"), ns.build("B")]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['local-A', 'local-B']);
  });

  it('should route namespace method calls through inherited dispatch', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', [
      'method build(name)',
      '  return "A-" + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'extends "A.script"',
      'method build(name)',
      '  return "C-" + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "C.script" as ns',
      'return ns.build("Ada")'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('C-Ada');
  });

  it('should preserve caller-visible ordering when a namespace call waits for inherited method registration', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

    loader.addTemplate('A.script', [
      'shared text log',
      'method build(name)',
      '  log("build|" + name + "|")',
      '  return "A-" + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'shared text log',
      'extends "A.script"',
      'log(waitAndGet("ctor|", 10))'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "C.script" as ns',
      'var result = ns.build("Ada")',
      'return [result, ns.log.snapshot()]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['A-Ada', 'ctor|build|Ada|']);
  });

  it('should start namespace method admission before argument resolution completes', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);
    const events = [];

    env.addGlobal('record', (label) => {
      events.push(label);
      return '';
    });
    env.addGlobal('slowArg', () => new Promise((resolve) => {
      setTimeout(() => {
        events.push('arg-resolved');
        resolve('Ada|');
      }, 20);
    }));

    loader.addTemplate('Component.script', [
      'shared text log',
      'method build(name)',
      '  record("method-start")',
      '  log("start|")',
      '  log(name)',
      '  return "done"',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'var result = ns.build(slowArg())',
      'return [result, ns.log.snapshot()]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['done', 'start|Ada|']);
    expect(events).to.eql(['method-start', 'arg-resolved']);
  });

  it('should dispatch shared observations through the same immediate namespace-side path', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);
    const events = [];

    env.addGlobal('record', (label) => {
      events.push(label);
      return '';
    });
    env.addGlobal('slowArg', () => new Promise((resolve) => {
      setTimeout(() => {
        events.push('arg-resolved');
        resolve('Ada|');
      }, 20);
    }));

    loader.addTemplate('Component.script', [
      'shared text log',
      'method build(name)',
      '  record("method-start")',
      '  log("start|")',
      '  log(name)',
      '  return "done"',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'var result = ns.build(slowArg())',
      'var observed = ns.log.snapshot()',
      'return [result, observed]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['done', 'start|Ada|']);
    expect(events).to.eql(['method-start', 'arg-resolved']);
  });

  it('should reject instead of hanging when namespace method argument resolution fails fatally', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('fatalArg', () => Promise.reject(
      new runtimeModule.RuntimeFatalError('fatal namespace arg', 1, 1, 'fatalArg()', 'Main.script')
    ));

    loader.addTemplate('Component.script', [
      'method build(name)',
      '  return "hello " + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'return ns.build(fatalArg())'
    ].join('\n'));

    const outcome = await Promise.race([
      env.renderScript('Main.script', {}).then(
        (value) => ({ type: 'value', value }),
        (error) => ({ type: 'error', error })
      ),
      new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 150))
    ]);

    expect(outcome.type).to.be('error');
    expect(outcome.error).to.be.a(runtimeModule.RuntimeError);
    expect(outcome.error.message).to.contain('fatal namespace arg');
  });
});
