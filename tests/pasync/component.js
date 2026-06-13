
/* eslint mocha/max-top-level-suites: "off" */

import expect from 'expect.js';
import {AsyncEnvironment, Script} from '../../src/environment/environment.js';
import {Context} from '../../src/environment/context.js';
import {StringLoader} from '../util.js';
import * as runtimeModule from '../../src/runtime/runtime.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const TEST_BUFFER_STACK_CONTEXT = runtimeModule.cloneWithAddedContext(TEST_EC, { branch: 'test' });
const createTestPoison = (message) => runtimeModule.createPoison(
  runtimeModule.PoisonError.create(message, TEST_EC, 'UserCallThrew')
);

function createTestRenderState(reportError = null) {
  return runtimeModule.createRenderState(reportError);
}

function createTestOwnerState(templateOrScript, {
  env = {},
  renderState = createTestRenderState(),
  path = templateOrScript?.path ?? null,
  scriptMode = !!templateOrScript?.scriptMode
} = {}) {
  return {
    env,
    runtime: runtimeModule,
    renderState,
    templateOrScript,
    path,
    scriptMode,
    errorContextTable: templateOrScript && typeof templateOrScript.getErrorContexts === 'function'
      ? templateOrScript.getErrorContexts(runtimeModule, path, renderState)
      : []
  };
}

function compiledComponentMethod(name, options = {}) {
  return {
    name,
    fn: options.fn || function noopMethod() {},
    signature: { argNames: options.argNames || [] },
    errorContextIndex: options.errorContextIndex ?? 0,
    isConstructor: !!options.isConstructor,
    super: false,
    superErrorContextIndex: null,
    inheritedMethodDependencies: {},
    ownLinkedChains: [],
    ownMutatedChains: []
  };
}

function componentParticipant(path, options = {}) {
  return {
    path,
    scriptMode: true,
    compile() {},
    inheritanceSpec: {
      methodEntries: options.methodEntries || {},
      sharedSchema: options.sharedSchema || {},
      hasExtends: false
    },
    getErrorContexts(runtimeArg, ownerPath, renderState) {
      void runtimeArg;
      return [[1, 1, 'Test', ownerPath ?? path, null, renderState ?? null]];
    },
    resolveInheritanceParent() {
      return runtimeModule.noInheritanceParent();
    }
  };
}

describe('Component method calls', function () {
  it('should resolve component method return values correctly', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);
    env.addGlobal('waitAndGet', (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay)));

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

  it('should isolate method-local temporary chains across calls', async function () {
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
    env.addGlobal('waitAndGet', (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay)));

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

    const result = await env.renderScript('Main.script', {});

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
      new runtimeModule.RuntimeError('fatal component arg', [1, 1, 'fatalArg()', 'Main.script', null, null])
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

  it('should reject instead of hanging when component method cleanup follows fatal state', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('never', () => new Promise(() => {}));
    env.addGlobal('fatalMethod', () => {
      throw runtimeModule.RuntimeError.create(
        'component method fatal cleanup',
        [1, 1, 'FunCall', 'Component.script', null, null]
      );
    });

    loader.addTemplate('Component.script', [
      'method build()',
      '  text out',
      '  out(never())',
      '  return fatalMethod()',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return ns.build()'
    ].join('\n'));

    const outcome = await Promise.race([
      env.renderScript('Main.script', {}).then(
        (value) => ({ type: 'value', value }),
        (error) => ({ type: 'error', error })
      ),
      new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 500))
    ]);

    expect(outcome.type).to.be('error');
    expect(outcome.error).to.be.a(runtimeModule.RuntimeError);
    expect(outcome.error.message).to.contain('component method fatal cleanup');
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

  describe('Late component shared linking', function () {
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

      env.addGlobal('makePoison', createTestPoison);

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
describe('Component observations', function () {
  it('should combine render context and object payload inputs with payload values', async function () {
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

  it('should not expose render context to a component without with context', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build()',
      '  return site',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'return ns.build()'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', { site: 'Example' });
      expect().fail('Expected renderScript to reject');
    } catch (err) {
      expect(runtimeModule.isPoisonError(err)).to.be(true);
      expect(err.message).to.contain('Can not look up unknown variable/function: site');
    }
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

  it('should use shared component composition-input grammar with context names and object payloads', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'method build()',
      '  return site + "|" + locale + "|" + theme + "|" + id',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'var theme = "dark"',
      'component "Component.script" as ns with context, locale, { theme: theme, id: "card-7" }',
      'return ns.build()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', { site: 'Example', locale: 'fr' });
    expect(result).to.be('Example|fr|dark|card-7');
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

  it('should keep underscore shared vars private to the component namespace', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    loader.addTemplate('Component.script', [
      'shared var _theme = "dark"',
      'method readTheme()',
      '  return this._theme',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'component "Component.script" as ns',
      'var internal = ns.readTheme()',
      'return ns._theme'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', {});
      expect().fail('Expected private shared var lookup to fail');
    } catch (err) {
      expect(err.message).to.contain('is private and cannot be accessed through a component');
    }
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

  it('should observe shared non-var chains through component observation calls', async function () {
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
    const source = script.compileSource();

    expect(source).to.contain('runtime.observeComponentChain({ bindingName: "ns", currentBuffer: output, observationCommand: new runtime.SnapshotCommand({ chainName: "$log"');
    expect(source).to.contain('runtime.observeComponentChain({ bindingName: "ns", currentBuffer: output, observationCommand: new runtime.IsErrorCommand({ chainName: "$status"');
    expect(source).to.contain('runtime.observeComponentChain({ bindingName: "ns", currentBuffer: output, observationCommand: new runtime.GetErrorCommand({ chainName: "$status"');
  });

  it('should observe shared var poison through component `is error` and `#`', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('makePoison', createTestPoison);

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

  it('should reject non-observational component shared commands', async function () {
    const env = { globals: {} };
    const ownerContext = new Context({}, {}, env, 'Main.script', true);
    const ownerBuffer = new runtimeModule.CommandBuffer(ownerContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);
    runtimeModule.declareBufferChain(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const componentContext = new Context({}, {}, env, 'Component.script', true);
    const sharedRootBuffer = new runtimeModule.CommandBuffer(componentContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);
    runtimeModule.declareBufferChain(sharedRootBuffer, 'status', 'var', ownerContext, null);

    ownerBuffer.addCommand(new runtimeModule.VarCommand({
      chainName: 'nsBinding',
      args: [new runtimeModule.InheritanceInstance({
        entryTemplateOrScript: { path: 'Component.script' },
        runtimeState: {
          sharedSchema: {
            status: { type: 'var' }
          },
          methods: {}
        },
        ownerState: createTestOwnerState({ path: 'Component.script', scriptMode: true }),
        context: componentContext,
        rootBuffer: sharedRootBuffer,
        sharedRootBuffer
      })],
      errorContext: TEST_EC
    }), 'nsBinding');

    const observationPromise = runtimeModule.observeComponentChain({
      bindingName: 'nsBinding',
      currentBuffer: ownerBuffer,
      observationCommand: new runtimeModule.VarCommand({
        chainName: 'status',
        args: ['bad'],
        errorContext: TEST_EC
      }),
      errorContext: [2, 1, null, 'Main.script', null, null]
    });

    ownerBuffer.finish();

    try {
      await observationPromise;
      expect().fail('Expected component observation to reject');
    } catch (error) {
      expect(error).to.be.a(runtimeModule.RuntimeError);
      expect(error.message).to.contain('universal observational chain command');
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

  it('should create independent component instances inside a for loop', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);

    env.addGlobal('waitAndGet', (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms)));

    loader.addTemplate('Component.script', [
      'method build()',
      '  return waitAndGet(incomingName, delay)',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Main.script', [
      'data result',
      'for item in items',
      '  component "Component.script" as card with { incomingName: item.name, delay: item.delay }',
      '  result.items.push(card.build())',
      'endfor',
      'return result.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {
      items: [
        { name: 'A', delay: 15 },
        { name: 'B', delay: 1 },
        { name: 'C', delay: 5 }
      ]
    });
    expect(result).to.eql({ items: ['A', 'B', 'C'] });
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
    expect(outcome.error.message).to.contain('instance.invoke is not a function');
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
    expect(outcome.error.message).to.match(/Missing\.script|missing/i);
  });

  it('should isolate a non-fatal missing component when the binding is unused', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader, { loadFailFatal: ['import'] });

    loader.addTemplate('Main.script', [
      'data result = []',
      'component "Missing.script" as ns',
      'result.push("ok")',
      'return result.snapshot()'
    ].join('\n'));

    const result = await env.renderScript('Main.script', {});

    expect(result).to.eql(['ok']);
  });

  it('should publish non-fatal missing component loads as LoadFailed poison', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader, { loadFailFatal: false });

    loader.addTemplate('Main.script', [
      'component "Missing.script" as ns',
      'return ns.theme'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', {});
      expect().fail('Expected renderScript to reject');
    } catch (err) {
      expect(runtimeModule.isPoisonError(err)).to.be(true);
      expect(err.kind).to.be('LoadFailed');
      expect(err.message).to.match(/Missing\.script|missing/i);
    }
  });

  it('should publish poisoned component targets without relabeling them as LoadFailed', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader, { loadFailFatal: false });

    loader.addTemplate('Main.script', [
      'component target as ns',
      'return ns.theme'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', { target: createTestPoison('component target poisoned') });
      expect().fail('Expected renderScript to reject');
    } catch (err) {
      expect(runtimeModule.isPoisonError(err)).to.be(true);
      expect(err.kind).to.be('UserCallThrew');
      expect(err.kind).not.to.be('LoadFailed');
      expect(err.message).to.contain('component target poisoned');
    }
  });

  it('should publish non-fatal missing component loads inside a for loop as LoadFailed poison', async function () {
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader, { loadFailFatal: false });

    loader.addTemplate('Main.script', [
      'data result',
      'for item in [1]',
      '  component "Missing.script" as card',
      '  result.items.push(card.theme)',
      'endfor',
      'return result.snapshot()'
    ].join('\n'));

    try {
      await env.renderScript('Main.script', {});
      expect().fail('Expected renderScript to reject');
    } catch (err) {
      expect(runtimeModule.isPoisonError(err)).to.be(true);
      expect(err.kind).to.be('LoadFailed');
      expect(err.message).to.match(/Missing\.script|missing/i);
    }
  });

  it('should reject instead of hanging when observing a missing shared component chain', async function () {
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
    expect(outcome.error.message).to.contain('Shared chain \'missing\' was not found');
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

  it('should reject nested component shared-property chaining for non-var chains', async function () {
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
      expect().fail('Expected non-var shared chain nested read to fail');
    } catch (error) {
      expect(error).to.be.a(runtimeModule.RuntimeError);
      expect(error.message).to.contain('Shared chain \'this.log\' cannot be used as a bare symbol');
    }
  });

  it('should allow explicit snapshot property reads for component non-var shared chains', async function () {
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
describe('Component lifecycle', function () {
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

  it('should keep the component shared root open until slow side-chain work finishes', async function () {
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

  it('should initialize the component binding independently of earlier binding-lane waits', async function () {
    const events = [];
    const env = new AsyncEnvironment();
    env.addGlobal('record', (event) => {
      events.push(event);
    });
    const componentScript = new Script([
      'method noop()',
      '  return null',
      'endmethod',
      'record("ctor-start")'
    ].join('\n'), env, 'Component.script');
    const ownerContext = new Context({}, {}, env, 'Main.script', true);
    const ownerBuffer = new runtimeModule.CommandBuffer(ownerContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);
    runtimeModule.declareBufferChain(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const gate = new Promise((resolve) => {
      setTimeout(() => {
        events.push('gate-resolved');
        resolve('open');
      }, 20);
    });

    ownerBuffer.addCommand(new runtimeModule.WaitResolveCommand({
      chainName: 'nsBinding',
      args: [gate],
      errorContext: TEST_EC
    }), 'nsBinding');

    const renderState = createTestRenderState();
    const startupPromise = runtimeModule.startComponentInstance({
      currentBuffer: ownerBuffer,
      bindingName: 'nsBinding',
      componentScriptOrTemplate: componentScript,
      payload: {},
      ownerContext,
      ownerState: createTestOwnerState(componentScript, { env, renderState }),
      errorContext: [2, 1, null, 'Main.script', null, null]
    });

    const sideChainFinished = ownerBuffer.getChain('nsBinding').finalSnapshot();
    ownerBuffer.finish();
    await sideChainFinished;
    await startupPromise;

    expect(events).to.eql(['ctor-start', 'gate-resolved']);
  });

  it('should start component constructor only after metadata finalization resolves', async function () {
    const events = [];
    const loader = new StringLoader();
    const env = new AsyncEnvironment(loader);
    env.addGlobal('selectParent', () => new Promise((resolve) => {
      Promise.resolve().then(() => {
        events.push('finalize-parent');
        resolve('Parent.script');
      });
    }));
    env.addGlobal('record', (event) => {
      events.push(event);
    });
    loader.addTemplate('Parent.script', [
      'method ping()',
      '  return "parent"',
      'endmethod'
    ].join('\n'));
    loader.addTemplate('Component.script', [
      'extends selectParent()',
      'method ping()',
      '  return "child"',
      'endmethod',
      'record("constructor")'
    ].join('\n'));
    const ownerContext = new Context({}, {}, env, 'Main.script', true);
    const ownerBuffer = new runtimeModule.CommandBuffer(ownerContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);
    runtimeModule.declareBufferChain(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const renderState = createTestRenderState();
    const startupPromise = runtimeModule.startComponentInstance({
      currentBuffer: ownerBuffer,
      bindingName: 'nsBinding',
      componentScriptOrTemplate: env.getScript('Component.script', false, null, false),
      payload: {},
      ownerContext,
      ownerState: createTestOwnerState({ path: 'Main.script', scriptMode: true }, { env, renderState }),
      errorContext: [2, 1, null, 'Main.script', null, null]
    });

    const sideChainFinished = ownerBuffer.getChain('nsBinding').finalSnapshot();
    ownerBuffer.finish();
    await sideChainFinished;
    await startupPromise;

    expect(events).to.eql(['finalize-parent', 'constructor']);
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
    const ownerBuffer = new runtimeModule.CommandBuffer(ownerContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);
    runtimeModule.declareBufferChain(ownerBuffer, 'nsBinding', 'var', ownerContext, null);

    const componentInstance = await runtimeModule.createComponentInstance({
      componentScriptOrTemplate: componentParticipant('Component.script', {
        methodEntries: {
          ping: compiledComponentMethod('ping', {
            fn() {
              return 'pong';
            }
          })
        }
      }),
      payload: {},
      ownerContext,
      ownerState: createTestOwnerState({ path: 'Main.script', scriptMode: true }),
      ownerBuffer,
      bindingName: 'nsBinding',
      errorContext: [1, 1, null, 'Main.script', null, null]
    });

    ownerBuffer.addCommand(new runtimeModule.VarCommand({
      chainName: 'nsBinding',
      args: [componentInstance],
      errorContext: TEST_EC
    }), 'nsBinding');

    const sideChainFinished = ownerBuffer.getChain('nsBinding').finalSnapshot();
    ownerBuffer.finish();
    await sideChainFinished;
    await Promise.resolve();

    expect(() => componentInstance.invoke(
      'ping',
      [],
      TEST_EC
    )).to.throwException((err) => {
      expect(err).to.be.a(runtimeModule.RuntimeError);
      expect(err.message).to.contain('cannot accept new operations');
    });
  });

  it('should reject new component operations after the instance is closed', function () {
    const context = { path: 'Component.script' };
    const rootBuffer = new runtimeModule.CommandBuffer(context, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);
    const componentInstance = new runtimeModule.InheritanceInstance({
      entryTemplateOrScript: { path: 'Component.script' },
      runtimeState: {
        methods: {
          build: compiledComponentMethod('build')
        },
        sharedSchema: {}
      },
      ownerState: createTestOwnerState({ path: 'Main.script', scriptMode: true }),
      context: { path: 'Component.script' },
      rootBuffer,
      sharedRootBuffer: rootBuffer
    });

    componentInstance.close();

    expect(() => componentInstance.invoke(
      'build',
      [],
      TEST_EC
    )).to.throwException((err) => {
      expect(err).to.be.a(runtimeModule.RuntimeError);
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
    const ownerBuffer = new runtimeModule.CommandBuffer(ownerContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);

    await runtimeModule.createComponentInstance({
      componentScriptOrTemplate: componentParticipant('Component.script'),
      payload: { theme: 'dark', rootContext: 'user-value' },
      ownerContext,
      ownerState: createTestOwnerState({ path: 'Main.script', scriptMode: true }),
      ownerBuffer,
      errorContext: [1, 1, null, 'Main.script', null, null]
    });

    expect(seen.nextPath).to.be('Component.script');
    expect(seen.rootContext.theme).to.be('dark');
    expect(seen.rootContext.rootContext).to.be('user-value');
    expect(seen.rootContext.rootOnly).to.be('set-during-fork');
  });

  it('should fail clearly when a component target is not an inheritance participant', async function () {
    const ownerContext = {
      path: 'Main.script',
      getRenderContextVariables() {
        return {};
      },
      forkForComposition(nextPath, rootContext, renderCtx) {
        return { path: nextPath, rootContext, renderCtx };
      }
    };
    const ownerBuffer = new runtimeModule.CommandBuffer(ownerContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);

    try {
      await runtimeModule.createComponentInstance({
        componentScriptOrTemplate: {
          compile() {},
          path: 'Component.script'
        },
        payload: {},
        ownerContext,
        ownerState: createTestOwnerState({ path: 'Main.script', scriptMode: true }),
        ownerBuffer,
        errorContext: [1, 1, null, 'Main.script', null, null]
      });
      expect().fail('Expected createComponentInstance to reject');
    } catch (error) {
      expect(error.message).to.contain('expected an inheritance participant');
    }
  });

  it('should report async constructor failure during component creation', async function () {
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
    const ownerBuffer = new runtimeModule.CommandBuffer(ownerContext, null, null, null, null, TEST_BUFFER_STACK_CONTEXT);

    const failure = new runtimeModule.RuntimeError(
      'async constructor failed',
      [1, 1, null, 'Component.script', null, null]
    );

    try {
      await runtimeModule.createComponentInstance({
        componentScriptOrTemplate: componentParticipant('Component.script', {
          methodEntries: {
            __constructor__: compiledComponentMethod('__constructor__', {
              isConstructor: true,
              fn() {
                return Promise.reject(failure);
              }
            })
          }
        }),
        payload: {},
        ownerContext,
        ownerState: createTestOwnerState({ path: 'Main.script', scriptMode: true }, {
          renderState: createTestRenderState((error) => {
            if (error) {
              seenErrors.push(error);
            }
          })
        }),
        ownerBuffer,
        errorContext: [1, 1, null, 'Main.script', null, null]
      });
      expect().fail('Expected createComponentInstance to reject');
    } catch (error) {
      expect(error).to.be(failure);
    }

    expect(seenErrors).to.eql([failure]);
  });
});
