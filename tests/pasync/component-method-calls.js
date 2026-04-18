'use strict';

let expect;
let AsyncEnvironment;
let StringLoader;
let runtimeModule;
let InheritanceState;
let InheritanceMethodRegistry;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  StringLoader = require('../util').StringLoader;
  runtimeModule = require('../../src/runtime/runtime');
  const inheritanceStateModule = require('../../src/runtime/inheritance-state');
  InheritanceState = inheritanceStateModule.InheritanceState;
  InheritanceMethodRegistry = inheritanceStateModule.InheritanceMethodRegistry;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  StringLoader = window.util.StringLoader;
  runtimeModule = nunjucks.runtime;
  InheritanceState = null;
  InheritanceMethodRegistry = null;
}

describe('Component Method Calls', function () {
  it('should resolve component method return values correctly', async function () {
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

  it('should route component method calls through inherited dispatch', async function () {
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

  it('should preserve caller-visible ordering when a component call waits for inherited method registration', async function () {
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

  it('should start component method admission before argument resolution completes', async function () {
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

  it('should dispatch shared observations through the same immediate component-side path', async function () {
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

  it('should propagate soft poison through merged component method operations', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('softFail', () => Promise.reject(new Error('soft component failure')));

    loader.addTemplate('Component.script', [
      'method build()',
      '  return softFail()',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'import "Component.script" as ns',
      'return ns.build()'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', {});
      expect().fail('Expected renderScript to reject');
    } catch (err) {
      expect(runtimeModule.isPoisonError(err)).to.be(true);
      expect(err.message).to.contain('soft component failure');
    }
  });

  it('should reject instead of hanging when component method argument resolution fails fatally', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('fatalArg', () => Promise.reject(
      new runtimeModule.RuntimeFatalError('fatal component arg', 1, 1, 'fatalArg()', 'Main.script')
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
    expect(outcome.error.message).to.contain('fatal component arg');
  });

  describe('Step 14B', function () {
    it('should defer unresolved component invocation-buffer creation until the target method entry is current', async function () {
      if (!InheritanceState) {
        this.skip();
        return;
      }

      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      const events = [];
      const originalRegisterCompiledMethods = InheritanceMethodRegistry.prototype.registerCompiled;
      const originalEnsureInvocationBuffer = runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer;
      let buildInvocationCreatedAt = -1;

      runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = function(methodEntry) {
        if (this.name === 'build' && methodEntry && methodEntry.ownerKey === 'A.script') {
          buildInvocationCreatedAt = events.length;
          events.push({ type: 'build-invocation-buffer-created' });
        }
        return originalEnsureInvocationBuffer.apply(this, arguments);
      };

      InheritanceMethodRegistry.prototype.registerCompiled = function(methods) {
        if (methods && methods.build && methods.build.ownerKey === 'A.script') {
          events.push({ type: 'parent-build-registered' });
        }
        return originalRegisterCompiledMethods.apply(this, arguments);
      };

      loader.addTemplate('A.script', [
        'method build()',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'extends "A.script"'
      ].join('\n'));
      loader.addTemplate('Main.script', [
        'import "C.script" as ns',
        'return ns.build()'
      ].join('\n'));

      try {
        const result = await env.renderScript('Main.script', {});

        expect(result).to.be('done');
        const parentRegisteredAt = events.findIndex((event) => event.type === 'parent-build-registered');
        expect(parentRegisteredAt).to.be.greaterThan(-1);
        expect(buildInvocationCreatedAt).to.be.greaterThan(parentRegisteredAt);
      } finally {
        InheritanceMethodRegistry.prototype.registerCompiled = originalRegisterCompiledMethods;
        runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
      }
    });

    it('should create unresolved component invocation buffers with the resolved method entry linkedChannels', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      let seenLinkedChannels = null;
      const originalEnsureInvocationBuffer = runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer;

      runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = function(methodEntry) {
        const invocationBuffer = originalEnsureInvocationBuffer.apply(this, arguments);
        if (this.name === 'build' && methodEntry && methodEntry.ownerKey === 'A.script') {
          seenLinkedChannels = {
            methodLinkedChannels: Array.isArray(methodEntry.linkedChannels) ? methodEntry.linkedChannels.slice() : [],
            late: invocationBuffer.isLinkedChannel('late'),
            trace: invocationBuffer.isLinkedChannel('trace')
          };
        }
        return invocationBuffer;
      };

      loader.addTemplate('A.script', [
        'shared text trace',
        'shared var late = "parent-default"',
        'method build()',
        '  trace("method|")',
        '  late = "from-parent"',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'shared text trace',
        'extends "A.script"'
      ].join('\n'));
      loader.addTemplate('Main.script', [
        'import "C.script" as ns',
        'return ns.build()'
      ].join('\n'));

      try {
        const result = await env.renderScript('Main.script', {});
        expect(result).to.be('done');
        expect(seenLinkedChannels).to.be.ok();
        expect(seenLinkedChannels.methodLinkedChannels).to.contain('trace');
        expect(seenLinkedChannels.methodLinkedChannels).to.contain('late');
        expect(seenLinkedChannels.trace).to.be(true);
        expect(seenLinkedChannels.late).to.be(true);
      } finally {
        runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
      }
    });

  });

  describe('Step 14C', function () {
    it('should link newly discovered component shared lanes before later shared-visible observation continues', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

      loader.addTemplate('A.script', [
        'shared var late = "parent-default"',
        'method build()',
        '  late = waitAndGet("from-parent", 10)',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'extends "A.script"'
      ].join('\n'));
      loader.addTemplate('Main.script', [
        'import "C.script" as ns',
        'var result = ns.build()',
        'var lateValue = ns.late',
        'return [result, lateValue]'
      ].join('\n'));

      const result = await env.renderScript('Main.script', {});
      expect(result).to.eql(['done', 'from-parent']);
    });

    it('should link parent-constructor shared lanes through structural boundaries before exported observation', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', [
        'shared var late = "parent-default"',
        'late = "from-parent-ctor"'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'extends "A.script"'
      ].join('\n'));
      loader.addTemplate('Main.script', [
        'import "C.script" as ns',
        'return ns.late'
      ].join('\n'));

      const result = await env.renderScript('Main.script', {});
      expect(result).to.be('from-parent-ctor');
    });
  });
});
