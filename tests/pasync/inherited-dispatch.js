'use strict';

let expect;
let AsyncEnvironment;
let Script;
let StringLoader;
let isPoisonError;
let runtimeModule;
let Context;
let InheritanceState;
let InheritanceMethodRegistry;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  Script = environment.Script;
  StringLoader = require('../util').StringLoader;
  runtimeModule = require('../../src/runtime/runtime');
  isPoisonError = runtimeModule.isPoisonError;
  Context = require('../../src/environment/context').Context;
  const inheritanceStateModule = require('../../src/runtime/inheritance-state');
  InheritanceState = inheritanceStateModule.InheritanceState;
  InheritanceMethodRegistry = inheritanceStateModule.InheritanceMethodRegistry;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  Script = nunjucks.Script;
  StringLoader = window.util.StringLoader;
  runtimeModule = nunjucks.runtime;
  isPoisonError = nunjucks.runtime.isPoisonError;
  Context = nunjucks.Context;
  InheritanceState = null;
  InheritanceMethodRegistry = null;
}

describe('Inherited Dispatch', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  it('should let an ancestor constructor call a child-defined override before parent methods load', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'shared text trace\ntrace(this.build("Ada"))');
    loader.addTemplate('C.script', 'shared text trace\nmethod build(name)\n  return "child:" + name\nendmethod\nextends "A.script"\nreturn trace.snapshot()');

    const result = await env.renderScript('C.script', {});
    expect(result).to.be('child:Ada');
  });

  it('should wait only at the inherited call site after extends, not stall surrounding constructor flow', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'shared text trace\nmethod build(name)\n  return waitAndGet("parent:" + name)\nendmethod\ntrace("A|")');
    loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nvar label = this.build("Ada")\ntrace("post|")\ntrace(label)\nreturn trace.snapshot()');

    const result = await env.renderScript('C.script', {
      waitAndGet: (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10))
    });

    expect(result).to.be('A|post|parent:Ada');
  });

  it('should resolve script super() through the next owner in the method chain', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'method build(name)\n  return "A(" + name + ")"\nendmethod');
    loader.addTemplate('B.script', 'method build(name)\n  return "B>" + super(name)\nendmethod\nextends "A.script"');
    loader.addTemplate('C.script', 'method build(name)\n  return "C>" + super(name)\nendmethod\nextends "B.script"\nreturn this.build("x")');

    const result = await env.renderScript('C.script', {});
    expect(result).to.be('C>B>A(x)');
  });

  it('should pass render context into inherited methods declared with context', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'method build(name) with context\n  return name + "|" + siteName\nendmethod');
    loader.addTemplate('C.script', 'extends "A.script"\nreturn this.build("Ada")');

    const result = await env.renderScript('C.script', {
      siteName: 'Example'
    });
    expect(result).to.be('Ada|Example');
  });

  it('should keep shared-channel writes from method bodies ordered at the call site', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'shared text trace\nmethod build(name)\n  trace("method|" + name + "|")\n  return "done:" + name\nendmethod');
    loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\ntrace("before|")\nvar result = this.build("Ada")\ntrace("after|")\ntrace(result)\nreturn trace.snapshot()');

    const result = await env.renderScript('C.script', {});
    expect(result).to.be('before|method|Ada|after|done:Ada');
  });

  it('should resume multiple unresolved inherited admissions in source order', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'method first()\n  return waitAndGet("first|", 20)\nendmethod\nmethod second()\n  return waitAndGet("second|", 0)\nendmethod');
    loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\ntrace(this.first())\ntrace(this.second())\nreturn trace.snapshot()');

    const result = await env.renderScript('C.script', {
      waitAndGet: (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay))
    });

    expect(result).to.be('first|second|');
  });

  it('should fail clearly when an inherited method is still missing after the chain loads', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'return "A"');
    loader.addTemplate('C.script', 'extends "A.script"\nreturn this.missing()');

    try {
      await env.renderScript('C.script', {});
      expect().fail('Expected missing inherited method failure');
    } catch (error) {
      expect(isPoisonError(error)).to.be(false);
      expect(error.name).to.be('RuntimeFatalError');
      expect(error.lineno).to.be(2);
      expect(error.colno).to.be.greaterThan(0);
      expect(String(error)).to.contain("Inherited method 'missing' was not found");
    }
  });

  it('should fail cleanly for a deferred missing inherited method inside a shared-channel call site', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'shared text trace\nreturn "A"');
    loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\ntrace(this.missing(waitAndGet("Ada")))\nreturn trace.snapshot()');

    try {
      await env.renderScript('C.script', {
        waitAndGet: (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10))
      });
      expect().fail('Expected deferred missing inherited method failure');
    } catch (error) {
      expect(isPoisonError(error)).to.be(false);
      expect(error.name).to.be('RuntimeFatalError');
      expect(error.lineno).to.be(3);
      expect(error.colno).to.be.greaterThan(0);
      expect(String(error)).to.contain("Inherited method 'missing' was not found");
    }
  });

  it('should reject inherited method calls with too many arguments', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('C.script', 'method build(name)\n  return name\nendmethod\nreturn this.build("x", "y")');

    try {
      await env.renderScript('C.script', {});
      expect().fail('Expected inherited method arg validation failure');
    } catch (error) {
      expect(String(error)).to.contain("Inherited method 'build' received too many arguments");
    }
  });

  it('should reject script super() calls with too many arguments', async function () {
    const loader = new StringLoader();
    env = new AsyncEnvironment(loader);

    loader.addTemplate('A.script', 'method build(name)\n  return name\nendmethod');
    loader.addTemplate('B.script', 'method build(name)\n  return super(name, "extra")\nendmethod\nextends "A.script"\nreturn this.build("x")');

    try {
      await env.renderScript('B.script', {});
      expect().fail('Expected script super arg validation failure');
    } catch (error) {
      expect(String(error)).to.contain('super(...) for method "build" received too many arguments');
    }
  });

  it('should reject bare this.method references in scripts', function () {
    expect(() => {
      new Script('method build()\n  return "x"\nendmethod\nreturn this.build', env, 'bare-this-method.script')._compileSource();
    }).to.throwException(/bare inherited-method references are not supported/);
  });

  it('should use InheritanceAdmissionCommand as a real observable command barrier', async function () {
    env = new AsyncEnvironment();
    const context = new Context({}, {}, env, 'Main.script', true, {}, {});
    const inheritanceState = runtimeModule.createInheritanceState();
    const rootBuffer = runtimeModule.createCommandBuffer(context);
    runtimeModule.declareBufferChannel(rootBuffer, 'trace', 'var', context, null);

    let seenCommand = null;
    let applyCount = 0;
    const originalApply = runtimeModule.InheritanceAdmissionCommand.prototype.apply;
    runtimeModule.InheritanceAdmissionCommand.prototype.apply = function(output) {
      seenCommand = this;
      applyCount++;
      return originalApply.call(this, output);
    };

    try {
      const traceSnapshot = rootBuffer.getChannel('trace').finalSnapshot();
      const admission = runtimeModule.admitConstructorEntry(
        context,
        inheritanceState,
        {
          fn(envArg, contextArg, runtimeArg, cbArg, output) {
            void envArg;
            void contextArg;
            void cbArg;
            output.add(new runtimeArg.VarCommand({
              channelName: 'trace',
              args: ['done'],
              pos: { lineno: 1, colno: 1 }
            }), 'trace');
            output.markFinishedAndPatchLinks();
            return 'result';
          },
          contract: { inputNames: [], withContext: false },
          ownerKey: 'Main.script',
          linkedChannels: ['trace']
        },
        [],
        env,
        runtimeModule,
        () => {},
        rootBuffer,
        { lineno: 1, colno: 1, errorContextString: null, path: 'Main.script' }
      );

      rootBuffer.markFinishedAndPatchLinks();

      const value = await admission.promise;
      await admission.completion;
      const trace = await traceSnapshot;

      expect(value).to.be('result');
      expect(trace).to.be('done');
      expect(applyCount).to.be(1);
      expect(seenCommand).to.be.a(runtimeModule.InheritanceAdmissionCommand);
      expect(seenCommand.isObservable).to.be(true);
      expect(seenCommand.getError()).to.be(null);
      expect(admission.promise).to.be(seenCommand.promise);
      expect(admission.completion).to.be(seenCommand.completion);
    } finally {
      runtimeModule.InheritanceAdmissionCommand.prototype.apply = originalApply;
    }
  });

  it('should let _finishAdmissionBuffers own sync admission-buffer cleanup', async function () {
    const fakeBuffer = {
      finishCount: 0,
      markFinishedAndPatchLinks() {
        this.finishCount += 1;
      },
      getFinishCompletePromise() {
        return Promise.resolve();
      }
    };
    const context = {
      createInheritancePayload(ownerKey, argMap) {
        return { ownerKey, argMap };
      },
      createSuperInheritancePayload(currentPayload, argMap) {
        return { currentPayload, argMap };
      },
      prepareInheritancePayloadForBlock(fn, payload) {
        void fn;
        return payload;
      },
      getRenderContextVariables() {
        return {};
      }
    };
    const command = new runtimeModule.InheritanceAdmissionCommand({
      name: '__constructor__',
      resolveMethodEntry: () => ({
        fn() {
          return 'done';
        },
        contract: { inputNames: [], withContext: false },
        ownerKey: 'Parent.script',
        linkedChannels: []
      }),
      args: [],
      context,
      inheritanceState: {},
      env: {},
      runtime: runtimeModule,
      cb: () => {},
      barrierBuffer: fakeBuffer,
      invocationBuffer: fakeBuffer,
      currentBuffer: fakeBuffer,
      errorContext: { lineno: 1, colno: 1, errorContextString: null, path: 'Parent.script' }
    });

    const applied = command.apply();
    const value = applied && typeof applied.then === 'function' ? await applied : applied;
    const promised = await command.promise;
    await command.completion;

    expect(value).to.be('done');
    expect(promised).to.be('done');
    expect(fakeBuffer.finishCount).to.be(1);
  });

  describe('Step 14A', function () {
    it('should defer unresolved inherited invocation-buffer creation until the target method entry is current', async function () {
      if (!InheritanceState) {
        this.skip();
        return;
      }

      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
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
        'shared text trace',
        'method build()',
        '  trace("method|")',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'shared text trace',
        'extends "A.script"',
        'trace("before|")',
        'var result = this.build()',
        'trace("after|")',
        'return [result, trace.snapshot()]'
      ].join('\n'));

      try {
        const result = await env.renderScript('C.script', {});
        expect(result).to.eql(['done', 'before|method|after|']);

        const parentRegisteredAt = events.findIndex((event) => event.type === 'parent-build-registered');

        expect(parentRegisteredAt).to.be.greaterThan(-1);
        expect(buildInvocationCreatedAt).to.be.greaterThan(-1);
        expect(buildInvocationCreatedAt).to.be.greaterThan(parentRegisteredAt);
      } finally {
        InheritanceMethodRegistry.prototype.registerCompiled = originalRegisterCompiledMethods;
        runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
      }
    });

    it('should create unresolved inherited invocation buffers with the resolved method entry linkedChannels', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
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
        'extends "A.script"',
        'trace("before|")',
        'var result = this.build()',
        'trace("after|")',
        'return [result, trace.snapshot()]'
      ].join('\n'));

      try {
        const result = await env.renderScript('C.script', {});
        expect(result).to.eql(['done', 'before|method|after|']);
        expect(seenLinkedChannels).to.be.ok();
        expect(seenLinkedChannels.methodLinkedChannels).to.contain('trace');
        expect(seenLinkedChannels.methodLinkedChannels).to.contain('late');
        expect(seenLinkedChannels.trace).to.be(true);
        expect(seenLinkedChannels.late).to.be(true);
      } finally {
        runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
      }
    });

    it('should hold later shared-visible apply behind the unresolved inherited admission barrier in source order', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', [
        'shared text trace',
        'method build()',
        '  trace(waitAndGet("method|", 10))',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'shared text trace',
        'extends "A.script"',
        'trace("before|")',
        'var result = this.build()',
        'trace("after|")',
        'trace(result)',
        'return trace.snapshot()'
      ].join('\n'));

      const result = await env.renderScript('C.script', {
        waitAndGet: (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay))
      });

      expect(result).to.be('before|method|after|done');
    });

    it('should link late parent-only shared lanes onto the inherited admission barrier when the method entry resolves', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      let seenBarrierLate = null;
      const originalEnsureInvocationBuffer = runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer;

      runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = function(methodEntry) {
        const invocationBuffer = originalEnsureInvocationBuffer.apply(this, arguments);
        if (this.name === 'build' && methodEntry && methodEntry.ownerKey === 'A.script') {
          seenBarrierLate = this.barrierBuffer && this.barrierBuffer !== invocationBuffer
            ? this.barrierBuffer.isLinkedChannel('late')
            : null;
        }
        return invocationBuffer;
      };

      loader.addTemplate('A.script', [
        'shared text trace',
        'shared var late = "parent-default"',
        'method build()',
        '  late = "from-parent"',
        '  trace("method|")',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'shared text trace',
        'extends "A.script"',
        'trace("before|")',
        'var result = this.build()',
        'trace("after|")',
        'trace(result)',
        'return trace.snapshot()'
      ].join('\n'));

      try {
        const result = await env.renderScript('C.script', {});
        expect(result).to.be('before|method|after|done');
        expect(seenBarrierLate).to.be(true);
      } finally {
        runtimeModule.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
      }
    });
  });
});
