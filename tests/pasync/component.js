'use strict';

let expect;
let AsyncEnvironment;
let StringLoader;
let runtimeModule;
let InheritanceState;
let InheritanceMethodRegistry;
let inheritanceStateModule;
let ComponentInstance;
let ComponentOperationCommand;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  StringLoader = require('../util').StringLoader;
  runtimeModule = require('../../src/runtime/runtime');
  try {
    const componentRuntime = require('../../src/runtime/component');
    ComponentInstance = componentRuntime.ComponentInstance;
    ComponentOperationCommand = componentRuntime.ComponentOperationCommand;
  } catch (err) {
    void err;
    ComponentInstance = null;
    ComponentOperationCommand = null;
  }
  try {
    inheritanceStateModule = require('../../src/runtime/inheritance-state');
    InheritanceState = inheritanceStateModule.InheritanceState;
    InheritanceMethodRegistry = inheritanceStateModule.InheritanceMethodRegistry;
  } catch (err) {
    void err;
    InheritanceState = null;
    InheritanceMethodRegistry = null;
  }
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  StringLoader = window.util.StringLoader;
  runtimeModule = nunjucks.runtime;
  InheritanceState = null;
  InheritanceMethodRegistry = null;
  ComponentInstance = null;
  ComponentOperationCommand = null;
}

describe.skip('Phase 8 - Component Method Calls', function () {
  it('should resolve component method return values correctly', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build(name)',
      '  return "hello " + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
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
      'component "Component.script" as ns',
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
      'component "C.script" as ns',
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
      'component "C.script" as ns',
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
      'component "Component.script" as ns',
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
      'component "Component.script" as ns',
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
      'component "Component.script" as ns',
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
      'component "Component.script" as ns',
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

  describe('Phase 8 - Late Component Invocation Linking', function () {
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
        'component "C.script" as ns',
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
        'component "C.script" as ns',
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

  describe('Phase 8 - Late Component Shared Linking', function () {
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
        'component "C.script" as ns',
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
        'component "C.script" as ns',
        'return ns.late'
      ].join('\n'));

      const result = await env.renderScript('Main.script', {});
      expect(result).to.be('from-parent-ctor');
    });
  });
});

describe.skip('Phase 8 - Component Observations', function () {
  it('should create a usable component instance and read shared vars through ns.x', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', 'shared var theme = "dark"');
    loader.addTemplate('Main.script', 'component "Component.script" as ns\nreturn ns.theme');

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('dark');
  });

  it('should read shared vars at the caller current position', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var theme = "dark"',
      'method setTheme(nextTheme)',
      '  theme = nextTheme',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'var first = ns.theme',
      'ns.setTheme("light")',
      'var second = ns.theme',
      'return [first, second]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['dark', 'light']);
  });

  it('should observe shared non-var channels through component observation calls', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared text log',
      'log("boot|")',
      'method add(item)',
      '  log(item)',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'ns.add("call|")',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('boot|call|');
  });

  it('should observe shared var poison through component isError() and getError()', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('makePoison', (message) => runtimeModule.createPoison(new Error(message)));

    loader.addTemplate('Component.script', [
      'shared var status = "ok"',
      'method breakStatus()',
      '  status = makePoison("bad status")',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'ns.breakStatus()',
      'var hasError = ns.status.isError()',
      'var err = ns.status.getError()',
      'return [hasError, err.message]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result[0]).to.be(true);
    expect(result[1]).to.contain('bad status');
  });

  it('should keep two component instances isolated', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', 'shared var theme = "default"');
    loader.addTemplate('Main.script', [
      'var theme = "dark"',
      'component "Component.script" as left with theme',
      'theme = "light"',
      'component "Component.script" as right with theme',
      'return [left.theme, right.theme]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['dark', 'light']);
  });

  it('should report invalid component shared-input names with a neutral target message', function () {
    expect(() => runtimeModule.validateSharedInputs(
      [{ name: 'theme', type: 'var' }],
      ['wrong'],
      'component binding'
    )).to.throwException((err) => {
      expect(err.message).to.contain("component binding passed 'wrong' but the target does not declare it as shared");
    });
  });

  it('should reject instead of hanging when a component binding resolves asynchronously to a non-instance', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

    loader.addTemplate('Component.script', [
      'method build(name)',
      '  return "hello " + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'ns = waitAndGet(123, 10)',
      'return ns.build("Ada")'
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
    expect(outcome.error.message).to.contain('Component binding is not a component instance');
  });

  it('should reject instead of hanging when component bootstrap fails to load the target script', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Main.script', [
      'component "Missing.script" as ns',
      'return ns.theme'
    ].join('\n'));

    const outcome = await Promise.race([
      env.renderScript('Main.script', {}).then(
        (value) => ({ type: 'value', value }),
        (error) => ({ type: 'error', error })
      ),
      new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 150))
    ]);

    expect(outcome.type).to.be('error');
    expect(runtimeModule.isPoisonError(outcome.error)).to.be(true);
    expect(outcome.error.message).to.match(/Missing\.script|missing/i);
  });
});

describe.skip('Phase 8 - Component Lifecycle', function () {
  it('should keep constructor work and later method work on the same long-lived component root', async function () {
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
      'component "Component.script" as ns',
      'ns.add("one|")',
      'ns.add("two|")',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('ctor|one|two|');
  });

  it('should keep the component shared root open until slow side-channel work finishes', async function () {
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
      'component "Component.script" as ns',
      'ns.add("late|")',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('late|');
  });

  it('should keep async-ancestry component instances isolated when they share the same parent chain', async function () {
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
      'component "C.script" as left with theme',
      'theme = "right"',
      'component "C.script" as right with theme',
      'return [left.log.snapshot(), right.log.snapshot(), left.read(), right.read()]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['left|', 'right|', 'left', 'right']);
  });

  it('should keep caller-visible output order deterministic when component calls are interleaved with local output', async function () {
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
      'component "Component.script" as ns',
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

  it('should auto-close a component instance when the owner buffer finishes', async function () {
    const makeContext = (path) => ({
      path,
      forkForComposition(nextPath) {
        return makeContext(nextPath);
      }
    });

    const ownerContext = makeContext('Main.script');
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);
    runtimeModule.declareBufferChannel(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const componentInstance = await runtimeModule.createComponentInstance(
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
      '__component_root__nsBinding',
      { lineno: 1, colno: 1, path: 'Main.script' }
    );

    ownerBuffer.add(new runtimeModule.VarCommand({
      channelName: 'nsBinding',
      args: [componentInstance],
      pos: { lineno: 1, colno: 1 }
    }), 'nsBinding');

    const bindingSnapshot = ownerBuffer.getChannel('nsBinding').finalSnapshot();
    ownerBuffer.markFinishedAndPatchLinks();
    await bindingSnapshot;
    await ownerBuffer.getFinishCompletePromise();

    expect(() => componentInstance.callMethod(
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

  it('should reject new component operations after the instance is closed', function () {
    if (!ComponentInstance) {
      this.skip();
      return;
    }

    const componentInstance = new ComponentInstance({
      context: { path: 'Component.script' },
      rootBuffer: { markFinishedAndPatchLinks() {} },
      inheritanceState: {},
      template: null,
      ownerBuffer: null,
      ownerChannelName: null
    });

    componentInstance.close();

    expect(() => componentInstance.callMethod(
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

  it('should use Command deferred-result plumbing only for non-close component operations', function () {
    if (!ComponentOperationCommand) {
      this.skip();
      return;
    }

    const closeCommand = new ComponentOperationCommand({
      channelName: 'nsBinding',
      operation: 'close',
      pos: { lineno: 1, colno: 1, path: 'Main.script' }
    });
    const methodCommand = new ComponentOperationCommand({
      channelName: 'nsBinding',
      operation: 'method',
      methodName: 'build',
      env: {},
      runtime: runtimeModule,
      cb: () => {},
      errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
    });

    expect(closeCommand.promise).to.be(null);
    expect(methodCommand.promise && typeof methodCommand.promise.then).to.be('function');
  });
});
