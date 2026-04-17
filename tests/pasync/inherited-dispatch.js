'use strict';

let expect;
let AsyncEnvironment;
let Script;
let StringLoader;
let isPoisonError;
let runtimeModule;
let Context;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  Script = environment.Script;
  StringLoader = require('../util').StringLoader;
  runtimeModule = require('../../src/runtime/runtime');
  isPoisonError = runtimeModule.isPoisonError;
  Context = require('../../src/environment/context').Context;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  Script = nunjucks.Script;
  StringLoader = window.util.StringLoader;
  runtimeModule = nunjucks.runtime;
  isPoisonError = nunjucks.runtime.isPoisonError;
  Context = nunjucks.Context;
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
});
