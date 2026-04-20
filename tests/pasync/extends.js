'use strict';

let expect;
let AsyncEnvironment;
let Script;
let Context;
let StringLoader;
let runtime;
let InheritanceState;
let InheritanceMethodRegistry;
let inheritanceStateModule;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  Script = environment.Script;
  Context = require('../../src/environment/context').Context;
  StringLoader = require('../util').StringLoader;
  runtime = require('../../src/runtime/runtime');
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
  Script = nunjucks.Script;
  Context = nunjucks.Context;
  StringLoader = window.util.StringLoader;
  runtime = nunjucks.runtime;
  InheritanceState = null;
  InheritanceMethodRegistry = null;
}

describe('Extends Runtime', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Phase 5 - Constructor Model', function () {
    it('should compile script constructors as dedicated method targets instead of aliasing root', function () {
      const script = new Script(
        'shared text trace\nextends "A.script"\ntrace("post|")\nreturn trace.snapshot()',
        env,
        'constructor-method-target.script'
      );

      script.compile();

      expect(script.methods.__constructor__.fn).to.be.a('function');
      expect(script.methods.__constructor__.fn).not.to.be(script.rootRenderFunc);
      expect(script._compileSource()).to.contain('function b___constructor__(env, context, runtime, cb, output, inheritanceState = null) {');
    });

    it('should lower static script extends through a structural child-buffer boundary', function () {
      const source = new Script(
        'shared text trace\nextends "A.script"\ntrace("post|")\nreturn trace.snapshot()',
        env,
        'static-extends-boundary.script'
      )._compileSource();

      expect(source).to.contain('runtime.runControlFlowBoundary(');
      expect(source).not.to.contain('waitForApplyComplete');
    });

    it('should compile plain script extends payload reads without the legacy composition capture bridge', function () {
      const source = new Script(
        'shared var theme = "dark"\nextends "A.script" with theme\nreturn "done"',
        env,
        'plain-extends-no-capture-bridge.script'
      )._compileSource();

      expect(source).not.to.contain('captureCompositionScriptValue');
      expect(source).to.contain('inheritanceState.compositionPayload');
    });

    it('should run script constructor chaining in root-buffer source order', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\ntrace("A|")\nreturn "A"');
      loader.addTemplate('B.script', 'shared text trace\nextends "A.script"\ntrace("post-B|")');
      loader.addTemplate('C.script', 'shared text trace\nextends "B.script"\ntrace("post-C|")\nreturn trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('A|post-B|post-C|');
    });

    it('should expose descendant shared defaults to ancestor constructors', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared var theme = "light"\nshared text trace\ntrace(theme)');
      loader.addTemplate('C.script', 'shared var theme = "dark"\nshared text trace\nextends "A.script"\nreturn trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('dark');
    });

    it('should preserve parent-before-post order through the child-buffer structure', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\ntrace(waitAndGet("A|"))');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\ntrace("post|")\nreturn trace.snapshot()');

      const result = await env.renderScript('C.script', {
        waitAndGet: (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10))
      });
      expect(result).to.be('A|post|');
    });

    it('should propagate extends composition payload unchanged across a multi-level chain', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\ntrace(theme)');
      loader.addTemplate('B.script', 'extends "A.script"');
      loader.addTemplate('C.script', 'shared text trace\nextends "B.script" with theme\nreturn trace.snapshot()');

      const result = await env.renderScript('C.script', { theme: 'dark' });
      expect(result).to.be('dark');
    });

    it('should reject multiple top-level script extends declarations', function () {
      expect(() => {
        new Script('extends "A.script"\nextends "B.script"\nreturn 1', env, 'multi-extends.script')._compileSource();
      }).to.throwException(/script roots support at most one top-level extends/);
    });

    it('should keep the root constructor empty when there is no executable top-level body', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\ntrace("A|")');
      loader.addTemplate('C.script', 'extends "A.script"');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(undefined);
    });
  });

  describe('Phase 5 - Extends Return Rules', function () {
    it('should use the entry file explicit return as the direct render result', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'return "A"');
      loader.addTemplate('C.script', 'extends "A.script"\nreturn "C"');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('C');
    });

    it('should ignore an ancestor explicit return when the entry file has no explicit return', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'return "A"');
      loader.addTemplate('C.script', 'extends "A.script"');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(undefined);
    });

    it('should ignore all ancestor explicit returns across a 3-level hierarchy', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'return "A"');
      loader.addTemplate('B.script', 'extends "A.script"\nreturn "B"');
      loader.addTemplate('C.script', 'extends "B.script"');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(undefined);
    });

    it('should not treat script output channels as the direct render result when the entry file has no explicit return', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\ntrace("A|")');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\ntrace("C|")');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(undefined);
    });

    it('should keep the normal script fallback when the entry file has no explicit return', async function () {
      const result = await env.renderScriptString('var x = 1', {});
      expect(result).to.be(undefined);
    });

    it('should discard an ancestor constructor return in composition mode when the entry file returns explicitly', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'return waitAndGet("A")');
      loader.addTemplate('C.script', 'extends "A.script"\nreturn "C"');

      const result = await env.renderScript('C.script', {
        waitAndGet: (value) => Promise.resolve(value)
      });

      expect(result).to.be('C');
    });

    it('should discard all ancestor constructor returns in composition mode across a 3-level chain', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'return "A"');
      loader.addTemplate('B.script', 'extends "A.script"\nreturn Promise.resolve("B")');
      loader.addTemplate('C.script', 'extends "B.script"\nreturn "C"');

      const result = await env.renderScript('C.script', {
        Promise
      });

      expect(result).to.be('C');
    });
  });

  describe('Phase 7 - Shared Root and Invocation Scope', function () {
    it('should route shared declarations from the whole hierarchy to the same shared root buffer', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      const originalDeclareInheritanceSharedChannel = runtime.declareInheritanceSharedChannel;
      const themeBuffers = [];

      runtime.declareInheritanceSharedChannel = function(buffer, channelName, channelType, context, initializer) {
        const channel = originalDeclareInheritanceSharedChannel(buffer, channelName, channelType, context, initializer);
        if (channelName === 'theme') {
          themeBuffers.push(channel._buffer);
        }
        return channel;
      };

      try {
        loader.addTemplate('A.script', 'shared var theme = "light"\nreturn "A"');
        loader.addTemplate('C.script', 'shared var theme = "dark"\nextends "A.script"\nreturn "C"');

        const result = await env.renderScript('C.script', {});

        expect(result).to.be('C');
        expect(themeBuffers.length).to.be.greaterThan(1);
        themeBuffers.forEach((buffer) => {
          expect(buffer).to.be(themeBuffers[0]);
        });
      } finally {
        runtime.declareInheritanceSharedChannel = originalDeclareInheritanceSharedChannel;
      }
    });

    it('should keep constructor-local non-shared vars out of later method invocation scope', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'var secret = "A"\nmethod readSecret()\n  return secret\nendmethod');
      loader.addTemplate('C.script', 'extends "A.script"\nreturn this.readSecret()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(undefined);
    });

    it('should finish the constructor-local buffer without legacy static-extends promise gating', function () {
      const script = new Script('extends "A.script"\nreturn "C"', env, 'C.script');
      const source = script._compileSource();

      expect(source).to.contain('output.markFinishedAndPatchLinks();');
      expect(source).to.not.contain('context.asyncExtendsBlocksPromise');
    });
  });

  describe('Script method invocation scope', function () {
    it('should keep constructor-local non-shared vars out of later method invocation scope', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'var secret = "A"\nmethod readSecret()\n  return secret\nendmethod');
      loader.addTemplate('C.script', 'extends "A.script"\nreturn this.readSecret()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(undefined);
    });
  });

  describe('Phase 7 - Inherited Dispatch', function () {
    it('should let an ancestor constructor call a child-defined override before parent methods load', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\ntrace(this.build("Ada"))');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nmethod build(name)\n  return "child:" + name\nendmethod\nreturn trace.snapshot()');

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
      loader.addTemplate('B.script', 'extends "A.script"\nmethod build(name)\n  return "B>" + super(name)\nendmethod');
      loader.addTemplate('C.script', 'extends "B.script"\nmethod build(name)\n  return "C>" + super(name)\nendmethod\nreturn this.build("x")');

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
        expect(runtime.isPoisonError(error)).to.be(false);
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
        expect(runtime.isPoisonError(error)).to.be(false);
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
      loader.addTemplate('B.script', 'extends "A.script"\nmethod build(name)\n  return super(name, "extra")\nendmethod\nreturn this.build("x")');

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
      const inheritanceState = runtime.createInheritanceState();
      const rootBuffer = runtime.createCommandBuffer(context);
      runtime.declareBufferChannel(rootBuffer, 'trace', 'var', context, null);

      let seenCommand = null;
      let applyCount = 0;
      const originalApply = runtime.InheritanceAdmissionCommand.prototype.apply;
      runtime.InheritanceAdmissionCommand.prototype.apply = function(output) {
        seenCommand = this;
        applyCount++;
        return originalApply.call(this, output);
      };

      try {
        const traceSnapshot = rootBuffer.getChannel('trace').finalSnapshot();
        const admission = runtime.admitConstructorEntry(
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
            contract: { argNames: [], withContext: false },
            ownerKey: 'Main.script',
            linkedChannels: ['trace']
          },
          [],
          env,
          runtime,
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
        expect(seenCommand).to.be.a(runtime.InheritanceAdmissionCommand);
        expect(seenCommand.isObservable).to.be(true);
        expect(seenCommand.getError()).to.be(null);
        expect(admission.promise).to.be(seenCommand.promise);
        expect(admission.completion).to.be(seenCommand.completion);
      } finally {
        runtime.InheritanceAdmissionCommand.prototype.apply = originalApply;
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
        getRenderContextVariables() {
          return {};
        }
      };
      const command = new runtime.InheritanceAdmissionCommand({
        name: '__constructor__',
        resolveMethodEntry: () => ({
          fn() {
            return 'done';
          },
          contract: { argNames: [], withContext: false },
          ownerKey: 'Parent.script',
          linkedChannels: []
        }),
        args: [],
        context,
        inheritanceState: runtime.createInheritanceState(),
        env: {},
        runtime,
        cb: () => {},
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

    describe('Phase 7 - Late Inherited Linking', function () {
      it('should defer unresolved inherited invocation-buffer creation until the target method entry is current', async function () {
        if (!InheritanceState) {
          this.skip();
          return;
        }

        const loader = new StringLoader();
        env = new AsyncEnvironment(loader);
        const events = [];
        const originalRegisterCompiledMethods = InheritanceMethodRegistry.prototype.registerCompiled;
        const originalEnsureInvocationBuffer = runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer;
        let buildInvocationCreatedAt = -1;

        runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = function(methodEntry) {
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
          runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
        }
      });

      it('should create unresolved inherited invocation buffers with the resolved method entry linkedChannels', async function () {
        const loader = new StringLoader();
        env = new AsyncEnvironment(loader);
        let seenLinkedChannels = null;
        const originalEnsureInvocationBuffer = runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer;

        runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = function(methodEntry) {
          const invocationBuffer = originalEnsureInvocationBuffer.apply(this, arguments);
          if (this.name === 'build' && methodEntry && methodEntry.ownerKey === 'A.script') {
            seenLinkedChannels = {
              methodLinkedChannels: Array.from(new Set([
                ...(Array.isArray(methodEntry.usedChannels) ? methodEntry.usedChannels : []),
                ...(Array.isArray(methodEntry.mutatedChannels) ? methodEntry.mutatedChannels : [])
              ])),
              rawEntryLinkedChannels: Array.isArray(methodEntry.linkedChannels) ? methodEntry.linkedChannels.slice() : [],
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
          expect(seenLinkedChannels.rawEntryLinkedChannels).to.eql([]);
          expect(seenLinkedChannels.trace).to.be(true);
          expect(seenLinkedChannels.late).to.be(true);
        } finally {
          runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
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

      it('should link late parent-only shared lanes onto the invocation buffer when the method entry resolves', async function () {
        const loader = new StringLoader();
        env = new AsyncEnvironment(loader);
        let seenInvocationLate = null;
        const originalEnsureInvocationBuffer = runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer;

        runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = function(methodEntry) {
          const invocationBuffer = originalEnsureInvocationBuffer.apply(this, arguments);
          if (this.name === 'build' && methodEntry && methodEntry.ownerKey === 'A.script') {
            seenInvocationLate = {
              late: invocationBuffer ? invocationBuffer.isLinkedChannel('late') : null,
              usesOwnInvocationBuffer: this.invocationBuffer === invocationBuffer
            };
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
          expect(seenInvocationLate).to.eql({
            late: true,
            usesOwnInvocationBuffer: true
          });
        } finally {
          runtime.InheritanceAdmissionCommand.prototype._ensureInvocationBuffer = originalEnsureInvocationBuffer;
        }
      });

      it('should resolve shared snapshot observations through the shared helper', async function () {
        const loader = new StringLoader();
        env = new AsyncEnvironment(loader);
        const seenModes = [];
        const originalObserveInheritanceSharedChannel = runtime.observeInheritanceSharedChannel;

        runtime.observeInheritanceSharedChannel = function(channelName, currentBuffer, errorContext, inheritanceState, mode) {
          if (channelName === 'trace') {
            seenModes.push(mode);
          }
          return originalObserveInheritanceSharedChannel.apply(this, arguments);
        };

        try {
          loader.addTemplate('A.script', [
            'shared text trace',
            'trace(waitAndGet("parent|", 10))',
            'return null'
          ].join('\n'));
          loader.addTemplate('C.script', [
            'shared text trace',
            'extends "A.script"',
            'return trace.snapshot()'
          ].join('\n'));

          const result = await env.renderScript('C.script', {
            waitAndGet: (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay))
          });

          expect(result).to.be('parent|');
          expect(seenModes).to.eql(['snapshot']);
        } finally {
          runtime.observeInheritanceSharedChannel = originalObserveInheritanceSharedChannel;
        }
      });
    });
  });
});
