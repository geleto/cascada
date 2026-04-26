'use strict';

let expect;
let AsyncEnvironment;
let Script;
let StringLoader;
let runtimeModule;
let componentRuntimeModule;
let InheritanceState;
let inheritanceStateModule;
let ComponentInstance;
let inheritanceCallModule;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  Script = environment.Script;
  StringLoader = require('../util').StringLoader;
  runtimeModule = require('../../src/runtime/runtime');
  try {
    const componentRuntime = require('../../src/runtime/component');
    componentRuntimeModule = componentRuntime;
    ComponentInstance = componentRuntime.ComponentInstance;
  } catch (err) {
    void err;
    componentRuntimeModule = null;
    ComponentInstance = null;
  }
  try {
    inheritanceStateModule = require('../../src/runtime/inheritance-state');
    InheritanceState = inheritanceStateModule.InheritanceState;
  } catch (err) {
    void err;
    InheritanceState = null;
  }
  try {
    inheritanceCallModule = require('../../src/runtime/inheritance-call');
  } catch (err) {
    void err;
    inheritanceCallModule = null;
  }
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  Script = null;
  StringLoader = window.util.StringLoader;
  runtimeModule = nunjucks.runtime;
  componentRuntimeModule = null;
  InheritanceState = null;
  ComponentInstance = null;
  inheritanceCallModule = null;
}

describe('Phase 8 - Component Method Calls', function () {
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

  it('should route component method calls through the shared inherited admission path', async function () {
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
      '  this.log("build|" + name + "|")',
      '  return "A-" + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'shared text log',
      'extends "A.script"',
      'this.log(waitAndGet("ctor|", 10))'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "C.script" as ns',
      'var result = ns.build("Ada")',
      'return [result, ns.log.snapshot()]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['A-Ada', 'ctor|build|Ada|']);
  });

  it('should keep component method-in-method shared dependencies ordered before a later local method reads them', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', [
      'shared text log',
      'shared var theme = "parent"',
      'method applyTheme()',
      '  this.theme = waitAndGet("dark", 10)',
      '  this.log("apply|")',
      '  return "applied"',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'shared text log',
      'shared var theme = "light"',
      'extends "A.script"',
      'method readTheme()',
      '  this.log("read:" + this.theme + "|")',
      '  return this.theme',
      'endmethod',
      'method outer()',
      '  var first = this.applyTheme()',
      '  var second = this.readTheme()',
      '  this.log("result:" + second + "|")',
      '  return second',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "C.script" as ns',
      'var result = ns.outer()',
      'return [result, ns.log.snapshot()]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {
      waitAndGet: (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay))
    });

    expect(result).to.eql(['dark', 'apply|read:dark|result:dark|']);
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
      '  this.log("start|")',
      '  this.log(name)',
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
      '  this.log("start|")',
      '  this.log(name)',
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

  it('should reject unsupported nested component method property access', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build(name)',
      '  return "hello " + name',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return ns.build.extra()'
    ].join('\n'));

    try {
      await env.getScript('Main.script', true);
      expect().fail('Expected component namespace compile to fail');
    } catch (error) {
      expect(String(error)).to.match(/component binding 'ns' only supports/);
    }
  });

  describe('Phase 8 - Late Component Invocation Linking', function () {
    it('should create component invocation buffers only after direct method metadata is current', async function () {
      if (!InheritanceState || !inheritanceCallModule) {
        this.skip();
        return;
      }

      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      const events = [];
      const originalRegisterInheritanceMethods = inheritanceStateModule.registerInheritanceMethods;
      const originalCreateInheritanceInvocationCommand = inheritanceCallModule.createInheritanceInvocationCommand;
      let buildInvocationCreatedAt = -1;

      inheritanceCallModule.createInheritanceInvocationCommand = function(spec) {
        if (spec.name === 'build' && spec.methodData && spec.methodData.ownerKey === 'A.script') {
          buildInvocationCreatedAt = events.length;
          events.push({ type: 'build-invocation-buffer-created' });
        }
        return originalCreateInheritanceInvocationCommand.apply(this, arguments);
      };

      inheritanceStateModule.registerInheritanceMethods = function(state, methods) {
        if (methods && methods.build && methods.build.ownerKey === 'A.script') {
          events.push({ type: 'parent-build-registered' });
        }
        return originalRegisterInheritanceMethods.apply(this, arguments);
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
        inheritanceStateModule.registerInheritanceMethods = originalRegisterInheritanceMethods;
        inheritanceCallModule.createInheritanceInvocationCommand = originalCreateInheritanceInvocationCommand;
      }
    });

    it('should create component invocation buffers with the direct callable merged channels', async function () {
      if (!inheritanceCallModule) {
        this.skip();
        return;
      }
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      let seenLinkedChannels = null;
      const originalCreateInheritanceInvocationCommand = inheritanceCallModule.createInheritanceInvocationCommand;

      inheritanceCallModule.createInheritanceInvocationCommand = function(spec) {
        if (spec.name === 'build' && spec.methodData && spec.methodData.ownerKey === 'A.script') {
          const invocationBuffer = spec.invocationBuffer;
          seenLinkedChannels = {
            mergedLinkedChannels: Array.from(new Set([
              ...(Array.isArray(spec.methodData.mergedUsedChannels) ? spec.methodData.mergedUsedChannels : []),
              ...(Array.isArray(spec.methodData.mergedMutatedChannels) ? spec.methodData.mergedMutatedChannels : [])
            ])),
            late: invocationBuffer.isLinkedChannel('late'),
            trace: invocationBuffer.isLinkedChannel('trace')
          };
        }
        return originalCreateInheritanceInvocationCommand.apply(this, arguments);
      };

      loader.addTemplate('A.script', [
        'shared text trace',
        'shared var late = "parent-default"',
        'method build()',
        '  this.trace("method|")',
        '  this.late = "from-parent"',
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
        expect(seenLinkedChannels.mergedLinkedChannels).to.contain('trace');
        expect(seenLinkedChannels.mergedLinkedChannels).to.contain('late');
        expect(seenLinkedChannels.trace).to.be(true);
        expect(seenLinkedChannels.late).to.be(true);
      } finally {
        inheritanceCallModule.createInheritanceInvocationCommand = originalCreateInheritanceInvocationCommand;
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
        '  this.late = waitAndGet("from-parent", 10)',
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
        'this.late = "from-parent-ctor"'
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

    it('should resolve parent-only shared error observations through `is error` and `#`', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      env.addGlobal('makePoison', (message) => runtimeModule.createPoison(new Error(message)));

      loader.addTemplate('A.script', [
        'shared var status = "ok"',
        'method breakStatus()',
        '  this.status = makePoison("bad parent status")',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'extends "A.script"'
      ].join('\n'));
      loader.addTemplate('Main.script', [
        'component "C.script" as ns',
        'var result = ns.breakStatus()',
        'var hasError = ns.status is error',
        'var err = ns.status#',
        'return [result, hasError, err.message]'
      ].join('\n'));

      const result = await env.renderScript('Main.script', {});
      expect(result[0]).to.be('done');
      expect(result[1]).to.be(true);
      expect(result[2]).to.contain('bad parent status');
    });
  });
});

describe('Phase 8 - Component Observations', function () {
  it('should leave extern declarations to normal component script initialization', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'extern site',
      'method read()',
      '  return site',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return ns.read()'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', {});
      expect().fail('Expected renderScript to reject');
    } catch (error) {
      expect(String(error)).to.contain('Missing required extern: site');
    }
  });

  it('should combine render context and object payload inputs without extern declarations', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build()',
      '  return site + "|" + locale + "|" + theme + "|" + id',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'var theme = "dark"',
      'component "Component.script" as ns with context, { theme: theme, id: "card-7" }',
      'return ns.build()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', { site: 'Example', locale: 'fr' });
    expect(result).to.be('Example|fr|dark|card-7');
  });

  it('should allow payload keys without matching declarations on the component path', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build()',
      '  return site + "|" + theme + "|" + featureFlag',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns with context, { theme: "dark", featureFlag: "on" }',
      'return ns.build()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', { site: 'Example' });
    expect(result).to.be('Example|dark|on');
  });

  it('should keep plain component payload inputs compatible with shared observations', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared text log',
      'this.log(site + "|")',
      'method build(name)',
      '  this.log(name)',
      '  return none',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns with site',
      'ns.build("Ada")',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', { site: 'Example' });
    expect(result).to.be('Example|Ada');
  });

  it('should create a usable component instance and read shared vars through ns.x', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', 'shared var theme = "dark"');
    loader.addTemplate('Main.script', 'component "Component.script" as ns\nreturn ns.theme');

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('dark');
  });

  it('should let component methods read shared vars through this', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var theme = "dark"',
      'method readTheme()',
      '  return this.theme',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', 'component "Component.script" as ns\nreturn ns.readTheme()');

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('dark');
  });

  it('should read shared vars at the caller current position', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var theme = "dark"',
      'method setTheme(nextTheme)',
      '  this.theme = nextTheme',
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
      'this.log("boot|")',
      'method add(item)',
      '  this.log(item)',
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

  it('should compile component shared observations through explicit observational commands', function () {
    if (!Script) {
      this.skip();
      return;
    }

    const env = new AsyncEnvironment();
    const script = new Script([
      'component "Component.script" as ns',
      'var snap = ns.log.snapshot()',
      'var hasError = ns.status is error',
      'var err = ns.status#',
      'return [snap, hasError, err]'
    ].join('\n'), env, 'Main.script');
    const source = script._compileSource();

    expect(source).to.contain('runtime.observeComponentChannel({ bindingName: "ns", currentBuffer: output, observationCommand: new runtime.SnapshotCommand({ channelName: "log"');
    expect(source).to.contain('runtime.observeComponentChannel({ bindingName: "ns", currentBuffer: output, observationCommand: new runtime.IsErrorCommand({ channelName: "status"');
    expect(source).to.contain('runtime.observeComponentChannel({ bindingName: "ns", currentBuffer: output, observationCommand: new runtime.GetErrorCommand({ channelName: "status"');
  });

  it('should observe shared var poison through component `is error` and `#`', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('makePoison', (message) => runtimeModule.createPoison(new Error(message)));

    loader.addTemplate('Component.script', [
      'shared var status = "ok"',
      'method breakStatus()',
      '  this.status = makePoison("bad status")',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'ns.breakStatus()',
      'var hasError = ns.status is error',
      'var err = ns.status#',
      'return [hasError, err.message]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result[0]).to.be(true);
    expect(result[1]).to.contain('bad status');
  });

  it('should enqueue the exact observation command on the component shared root', async function () {
    if (!ComponentInstance) {
      this.skip();
      return;
    }

    const makeContext = (path) => ({
      path,
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath) {
        return makeContext(nextPath);
      }
    });

    const ownerContext = makeContext('Main.script');
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);
    runtimeModule.declareBufferChannel(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const sharedRootBuffer = runtimeModule.createCommandBuffer(makeContext('Component.script'), null, null, null);
    runtimeModule.declareBufferChannel(sharedRootBuffer, 'status', 'var', ownerContext, null);
    sharedRootBuffer.add(new runtimeModule.VarCommand({
      channelName: 'status',
      args: ['ok'],
      pos: { lineno: 1, colno: 1 }
    }), 'status');

    const inheritanceState = runtimeModule.createInheritanceState();
    inheritanceState.sharedRootBuffer = sharedRootBuffer;
    inheritanceState.sharedSchema.status = 'var';

    const componentInstance = new ComponentInstance({
      context: makeContext('Component.script'),
      rootBuffer: sharedRootBuffer,
      inheritanceState
    });

    ownerBuffer.add(new runtimeModule.VarCommand({
      channelName: 'nsBinding',
      args: [componentInstance],
      pos: { lineno: 1, colno: 1 }
    }), 'nsBinding');

    const seenAdds = [];
    const originalAdd = sharedRootBuffer.add.bind(sharedRootBuffer);
    sharedRootBuffer.add = function(value, channelName) {
      seenAdds.push({ value, channelName });
      return originalAdd(value, channelName);
    };

    const observationPromise = runtimeModule.observeComponentChannel({
      bindingName: 'nsBinding',
      currentBuffer: ownerBuffer,
      observationCommand: new runtimeModule.SnapshotCommand({
        channelName: 'status',
        pos: { lineno: 2, colno: 1 }
      }),
      errorContext: { lineno: 2, colno: 1, path: 'Main.script' },
      implicitVarRead: true
    });

    const bindingSnapshot = ownerBuffer.getChannel('nsBinding').finalSnapshot();
    ownerBuffer.markFinishedAndPatchLinks();
    await bindingSnapshot;
    const observed = await observationPromise;

    sharedRootBuffer.add = originalAdd;

    expect(observed).to.be('ok');
    expect(seenAdds.length).to.be.greaterThan(0);
    expect(seenAdds[0].channelName).to.be('status');
    expect(seenAdds[0].value).to.be.a(runtimeModule.SnapshotCommand);
  });

  it('should reject non-observational component shared commands', async function () {
    if (!ComponentInstance) {
      this.skip();
      return;
    }

    const makeContext = (path) => ({
      path,
      forkForComposition(nextPath) {
        return makeContext(nextPath);
      }
    });

    const ownerContext = makeContext('Main.script');
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);
    runtimeModule.declareBufferChannel(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const sharedRootBuffer = runtimeModule.createCommandBuffer(makeContext('Component.script'), null, null, null);
    runtimeModule.declareBufferChannel(sharedRootBuffer, 'status', 'var', ownerContext, null);

    const inheritanceState = runtimeModule.createInheritanceState();
    inheritanceState.sharedRootBuffer = sharedRootBuffer;
    inheritanceState.sharedSchema.status = 'var';

    ownerBuffer.add(new runtimeModule.VarCommand({
      channelName: 'nsBinding',
      args: [new ComponentInstance({
        context: makeContext('Component.script'),
        rootBuffer: sharedRootBuffer,
        inheritanceState
      })],
      pos: { lineno: 1, colno: 1 }
    }), 'nsBinding');

    const observationPromise = runtimeModule.observeComponentChannel({
      bindingName: 'nsBinding',
      currentBuffer: ownerBuffer,
      observationCommand: new runtimeModule.VarCommand({
        channelName: 'status',
        args: ['bad'],
        pos: { lineno: 2, colno: 1 }
      }),
      errorContext: { lineno: 2, colno: 1, path: 'Main.script' }
    });

    ownerBuffer.markFinishedAndPatchLinks();

    try {
      await observationPromise;
      expect().fail('Expected component observation to reject');
    } catch (error) {
      expect(error).to.be.a(runtimeModule.RuntimeFatalError);
      expect(error.message).to.contain('universal observational channel command');
    }
  });

  it('should keep two component instances isolated', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var theme = "default"',
      'method readIncomingTheme()',
      '  return incomingTheme',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'var theme = "dark"',
      'component "Component.script" as left with { incomingTheme: theme }',
      'theme = "light"',
      'component "Component.script" as right with { incomingTheme: theme }',
      'return [left.theme, right.theme, left.readIncomingTheme(), right.readIncomingTheme()]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['default', 'default', 'dark', 'light']);
  });

  it('should pass object-style payload keys through component composition inputs', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build()',
      '  return site + "|" + theme + "|" + id',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'var theme = "dark"',
      'component "Component.script" as ns with context, { theme: theme, id: "card-7" }',
      'return ns.build()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', { site: 'Example' });
    expect(result).to.be('Example|dark|card-7');
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

  it('should reject instead of hanging when observing a missing shared component channel', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var theme = "dark"'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return ns.missing'
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
    expect(outcome.error.message).to.contain("Shared channel 'missing' was not found");
  });

  it('should read nested properties from component shared vars', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var theme = { value: "dark", nested: { tone: "warm" } }'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return [ns.theme.value, ns.theme.nested.tone]'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.eql(['dark', 'warm']);
  });

  it('should reject nested component shared-property chaining for non-var channels', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared text log',
      'this.log("hello")'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return ns.log.value'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', {});
      expect().fail('Expected non-var shared channel nested read to fail');
    } catch (error) {
      expect(error).to.be.a(runtimeModule.RuntimeError);
      expect(error.message).to.contain("Shared channel 'log' cannot be used as a bare symbol");
    }
  });

  it('should allow explicit snapshot property reads for component non-var shared channels', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared text log',
      'this.log("hello")'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return ns.log.snapshot().length'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be(5);
  });

  it('should reject component-only observation aliases and require `is error` / `#` syntax', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var status = "ok"'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'var bad1 = ns.status.isError()',
      'var bad2 = ns.status.getError()',
      'return [bad1, bad2]'
    ].join('\n'));

    try {
      await env.getScript('Main.script', true);
      expect().fail('Expected component observation alias compile to fail');
    } catch (error) {
      expect(String(error)).to.match(/component binding 'ns' only supports/);
      expect(String(error)).to.contain('ns.x is error');
      expect(String(error)).to.contain('ns.x#');
    }
  });
});

describe('Phase 8 - Component Lifecycle', function () {
  it('should keep constructor work and later method work on the same long-lived component root', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared text log',
      'this.log("ctor|")',
      'method add(item)',
      '  this.log(item)',
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

  it('should start a component through an ancestor constructor when the child has no local constructor body', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', [
      'shared text log',
      'this.log("A|")'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'extends "A.script"'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "C.script" as ns',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('A|');
  });

  it('should skip a constructorless middle component level and still run the ancestor constructor', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', [
      'shared text log',
      'this.log("A|")'
    ].join('\n'));
    loader.addTemplate('B.script', [
      'extends "A.script"'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'extends "B.script"'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "C.script" as ns',
      'return ns.log.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});
    expect(result).to.be('A|');
  });

  it('should keep the component shared root open until slow side-channel work finishes', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

    loader.addTemplate('Component.script', [
      'shared text log',
      'method add(item)',
      '  this.log(waitAndGet(item, 20))',
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
      'this.log(waitAndGet(incomingTheme + "|", 10))',
      'method read()',
      '  return incomingTheme',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('C.script', [
      'shared var theme = "child"',
      'shared text log',
      'extends "A.script"'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'var theme = "left"',
      'component "C.script" as left with { incomingTheme: theme }',
      'theme = "right"',
      'component "C.script" as right with { incomingTheme: theme }',
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

  it('should start component constructor work behind earlier caller-side binding-lane waits', async function () {
    const events = [];
    const makeContext = (path) => ({
      path,
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath) {
        return makeContext(nextPath);
      }
    });

    const ownerContext = makeContext('Main.script');
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);
    runtimeModule.declareBufferChannel(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const gate = new Promise((resolve) => {
      setTimeout(() => {
        events.push('gate-resolved');
        resolve('open');
      }, 20);
    });

    ownerBuffer.add(new runtimeModule.WaitResolveCommand({
      channelName: 'nsBinding',
      args: [gate],
      pos: { lineno: 1, colno: 1 }
    }), 'nsBinding');

    const startupPromise = runtimeModule.startComponentInstance({
      currentBuffer: ownerBuffer,
      bindingName: 'nsBinding',
      templateOrPromise: {
        compile() {},
        rootRenderFunc() {
          events.push('ctor-start');
        },
        methods: {},
        sharedSchema: [],
        externSpec: [],
        path: 'Component.script'
      },
      payload: {},
      ownerContext,
      env: {},
      runtime: runtimeModule,
      cb: () => {},
      errorContext: { lineno: 2, colno: 1, path: 'Main.script' }
    });

    const bindingSnapshot = ownerBuffer.getChannel('nsBinding').finalSnapshot();
    ownerBuffer.markFinishedAndPatchLinks();
    await bindingSnapshot;
    await startupPromise;

    expect(events).to.eql(['gate-resolved', 'ctor-start']);
  });

  it('should start component constructor only after metadata finalization resolves', async function () {
    const events = [];
    const makeContext = (path) => ({
      path,
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath) {
        return makeContext(nextPath);
      }
    });

    const ownerContext = makeContext('Main.script');
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);
    runtimeModule.declareBufferChannel(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const compiledMethods = {
      __constructor__: {
        fn() {
          events.push('constructor');
          return null;
        },
        signature: { argNames: [], withContext: false },
        ownerKey: 'Component.script',
        ownUsedChannels: [],
        ownMutatedChannels: [],
        super: false,
        invokedMethods: {}
      }
    };

    const startupPromise = runtimeModule.startComponentInstance({
      currentBuffer: ownerBuffer,
      bindingName: 'nsBinding',
      templateOrPromise: {
        compile() {},
        rootRenderFunc(env, componentContext, runtime, cb, compositionMode, componentRootBuffer, inheritanceStateValue) {
          void env;
          void cb;
          void compositionMode;
          events.push('root-render');
          runtime.bootstrapInheritanceMetadata(
            inheritanceStateValue,
            compiledMethods,
            {},
            {},
            componentRootBuffer,
            componentContext
          );
          runtime.runCompiledRootStartup({
            setup: null,
            compiledMethods,
            runtime,
            env: {},
            context: componentContext,
            cb: () => {},
            output: componentRootBuffer,
            inheritanceState: inheritanceStateValue,
            extendsState: null,
            options: null
          });
          events.push('startup-called');
          Promise.resolve().then(() => {
            events.push('finalize');
            runtime.finalizeInheritanceMetadata(inheritanceStateValue, componentContext);
          });
          return componentRootBuffer;
        },
        methods: compiledMethods,
        sharedSchema: {},
        externSpec: [],
        path: 'Component.script'
      },
      payload: {},
      ownerContext,
      env: {},
      runtime: runtimeModule,
      cb: () => {},
      errorContext: { lineno: 2, colno: 1, path: 'Main.script' }
    });

    const bindingSnapshot = ownerBuffer.getChannel('nsBinding').finalSnapshot();
    ownerBuffer.markFinishedAndPatchLinks();
    await bindingSnapshot;
    await startupPromise;

    expect(events).to.eql(['root-render', 'startup-called', 'finalize', 'constructor']);
  });

  it('should auto-close a component instance when the owner buffer finishes', async function () {
    const makeContext = (path) => ({
      path,
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath) {
        return makeContext(nextPath);
      }
    });

    const ownerContext = makeContext('Main.script');
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);
    runtimeModule.declareBufferChannel(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    if (!componentRuntimeModule) {
      this.skip();
      return;
    }

    const componentInstance = await componentRuntimeModule.createComponentInstance({
      templateOrPromise: {
        compile() {},
        rootRenderFunc() {},
        methods: {},
        sharedSchema: [],
        externSpec: [],
        path: 'Component.script'
      },
      payload: {},
      ownerContext,
      env: {},
      runtime: runtimeModule,
      cb: () => {},
      ownerBuffer,
      bindingName: 'nsBinding',
      errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
    });

    ownerBuffer.add(new runtimeModule.VarCommand({
      channelName: 'nsBinding',
      args: [componentInstance],
      pos: { lineno: 1, colno: 1 }
    }), 'nsBinding');

    const bindingSnapshot = ownerBuffer.getChannel('nsBinding').finalSnapshot();
    ownerBuffer.markFinishedAndPatchLinks();
    await bindingSnapshot;

    expect(() => componentInstance.callMethod(
      'build',
      [],
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
    });

    componentInstance.close();

    expect(() => componentInstance.callMethod(
      'build',
      [],
      runtimeModule,
      () => {},
      { lineno: 1, colno: 1, path: 'Main.script' }
    )).to.throwException((err) => {
      expect(err).to.be.a(runtimeModule.RuntimeFatalError);
      expect(err.message).to.contain('cannot accept new operations');
    });
  });

  it('should pass plain payload objects as the component root context without reserving rootContext', async function () {
    const seen = {};
    const ownerContext = {
      path: 'Main.script',
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath, rootContext, renderCtx) {
        void renderCtx;
        seen.nextPath = nextPath;
        seen.rootContext = rootContext;
        rootContext.rootOnly = 'set-during-fork';
        return {
          path: nextPath,
          getRenderContextVariables() {
            return {};
          }
        };
      }
    };
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);

    if (!componentRuntimeModule) {
      this.skip();
      return;
    }

    await componentRuntimeModule.createComponentInstance({
      templateOrPromise: {
        compile() {},
        rootRenderFunc() {},
        methods: {},
        sharedSchema: [],
        externSpec: [],
        path: 'Component.script'
      },
      payload: { theme: 'dark', rootContext: 'user-value' },
      ownerContext,
      env: {},
      runtime: runtimeModule,
      cb: () => {},
      ownerBuffer,
      errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
    });

    expect(seen.nextPath).to.be('Component.script');
    expect(seen.rootContext.theme).to.be('dark');
    expect(seen.rootContext.rootContext).to.be('user-value');
    expect(seen.rootContext.rootOnly).to.be('set-during-fork');
  });

  it('should fail clearly when a component target has no compiled rootRenderFunc', async function () {
    const ownerContext = {
      path: 'Main.script',
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath, rootContext, renderCtx) {
        return { path: nextPath, rootContext, renderCtx };
      }
    };
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);

    if (!componentRuntimeModule) {
      this.skip();
      return;
    }

    try {
      await componentRuntimeModule.createComponentInstance({
        templateOrPromise: {
          compile() {},
          methods: {},
          sharedSchema: [],
          externSpec: [],
          path: 'Component.script'
        },
        payload: {},
        ownerContext,
        env: {},
        runtime: runtimeModule,
        cb: () => {},
        ownerBuffer,
        errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
      });
      expect().fail('Expected createComponentInstance to reject');
    } catch (error) {
      expect(error).to.be.a(runtimeModule.RuntimeFatalError);
      expect(error.message).to.contain('did not expose a compiled rootRenderFunc');
    }
  });

  it('should rethrow an async startup failure on later component operations', async function () {
    const seenErrors = [];
    const ownerContext = {
      path: 'Main.script',
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath, rootContext, renderCtx) {
        return { path: nextPath, rootContext, renderCtx };
      }
    };
    const ownerBuffer = runtimeModule.createCommandBuffer(ownerContext, null, null, null);

    if (!componentRuntimeModule) {
      this.skip();
      return;
    }

    const componentInstance = await componentRuntimeModule.createComponentInstance({
      templateOrPromise: {
        compile() {},
        rootRenderFunc(envArg, contextArg, runtimeArg, cbArg) {
          void envArg;
          void contextArg;
          void runtimeArg;
          setTimeout(() => {
            cbArg(new runtimeModule.RuntimeFatalError(
              'async startup failed',
              1,
              1,
              null,
              'Component.script'
            ));
          }, 10);
        },
        methods: {},
        sharedSchema: [],
        externSpec: [],
        path: 'Component.script'
      },
      payload: {},
      ownerContext,
      env: {},
      runtime: runtimeModule,
      cb: (error) => {
        if (error) {
          seenErrors.push(error);
        }
      },
      ownerBuffer,
      errorContext: { lineno: 1, colno: 1, path: 'Main.script' }
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(seenErrors).to.have.length(1);
    expect(() => componentInstance.callMethod(
      'build',
      [],
      runtimeModule,
      () => {},
      { lineno: 1, colno: 1, path: 'Main.script' }
    )).to.throwException((error) => {
      expect(error).to.be.a(runtimeModule.RuntimeFatalError);
      expect(error.message).to.contain('async startup failed');
    });
  });
});

