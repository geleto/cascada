'use strict';

let expect;
let AsyncEnvironment;
let StringLoader;
let runtimeModule;
let NamespaceInstance;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  StringLoader = require('../util').StringLoader;
  runtimeModule = require('../../src/runtime/runtime');
  NamespaceInstance = require('../../src/runtime/namespace').NamespaceInstance;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  StringLoader = window.util.StringLoader;
  runtimeModule = nunjucks.runtime;
  NamespaceInstance = null;
}

describe('Namespace Lifecycle', function () {
  it('should keep constructor work and later method work on the same long-lived namespace root', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared text log',
      'log("ctor|")',
      'method add(item)',
      '  log(item)',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'ns.add("one|")',
      'ns.add("two|")',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('ctor|one|two|');
  });

  it('should keep the namespace shared root open until slow side-channel work finishes', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

    loader.addTemplate('Component.script', [
      'shared text log',
      'method add(item)',
      '  log(waitAndGet(item, 20))',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'ns.add("late|")',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('late|');
  });

  it('should keep async-ancestry namespace instances isolated when they share the same parent chain', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

    loader.addTemplate('A.script', [
      'shared var theme = "parent"',
      'shared text log',
      'log(waitAndGet(theme + "|", 10))',
      'method read()',
      '  return theme',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'shared var theme = "child"',
      'shared text log',
      'extends "A.script"'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'var theme = "left"',
      'import "C.script" as left with theme',
      'theme = "right"',
      'import "C.script" as right with theme',
      'return [left.log.snapshot(), right.log.snapshot(), left.read(), right.read()]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['left|', 'right|', 'left', 'right']);
  });

  it('should keep caller-visible output order deterministic when namespace calls are interleaved with local output', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

    loader.addTemplate('Component.script', [
      'method label(name)',
      '  return waitAndGet(name, 10)',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'text out',
      'import "Component.script" as ns',
      'out("before|")',
      'out(ns.label("one|"))',
      'out("between|")',
      'out(ns.label("two|"))',
      'out("after|")',
      'return out.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('before|one|between|two|after|');
  });

  it('should auto-close a namespace instance when the owner buffer finishes', async function () {
    const makeContext = (path) => ({
      path,
      forkForComposition(nextPath) {
        return makeContext(nextPath);
      }
    });

    const ownerContext = makeContext('Main.script');
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);
    runtimeModule.declareBufferChannel(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const namespaceInstance = await runtimeModule.createNamespaceInstance(
      {
        compile() {},
        methods: {},
        sharedSchema: [],
        path: 'Component.script'
      },
      {},
      ownerContext,
      {},
      runtimeModule,
      () => {},
      ownerBuffer,
      'nsBinding',
      '__namespace_root__nsBinding',
      { lineno: 1, colno: 1, path: 'Main.script' }
    );

    ownerBuffer.add(new runtimeModule.VarCommand({
      channelName: 'nsBinding',
      args: [namespaceInstance],
      pos: { lineno: 1, colno: 1 }
    }), 'nsBinding');

    const bindingSnapshot = ownerBuffer.getChannel('nsBinding').finalSnapshot();
    ownerBuffer.markFinishedAndPatchLinks();
    await bindingSnapshot;
    await ownerBuffer.getFinishCompletePromise();

    expect(() => namespaceInstance.callMethod(
      'build',
      [],
      {},
      runtimeModule,
      () => {},
      { lineno: 1, colno: 1, path: 'Main.script' }
    )).to.throwException((err) => {
      expect(err).to.be.a(runtimeModule.RuntimeFatalError);
      expect(err.message).to.contain('cannot accept new operations');
    });
  });

  it('should reject new namespace operations after the instance is closed', function () {
    if (!NamespaceInstance) {
      this.skip();
      return;
    }

    const namespaceInstance = new NamespaceInstance({
      context: { path: 'Component.script' },
      rootBuffer: { markFinishedAndPatchLinks() {} },
      inheritanceState: {},
      template: null,
      ownerBuffer: null,
      ownerChannelName: null
    });

    namespaceInstance.close();

    expect(() => namespaceInstance.callMethod(
      'build',
      [],
      null,
      runtimeModule,
      () => {},
      { lineno: 1, colno: 1, path: 'Main.script' }
    )).to.throwException((err) => {
      expect(err).to.be.a(runtimeModule.RuntimeFatalError);
      expect(err.message).to.contain('cannot accept new operations');
    });
  });
});
