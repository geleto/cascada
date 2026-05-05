
import expect from 'expect.js';
import {AsyncEnvironment, Script, Context} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';
import * as runtime from '../../src/runtime/runtime.js';
import * as inheritanceCallModule from '../../src/runtime/inheritance-call.js';

describe('Extends Runtime', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Phase 5 - Constructor Model', function () {
    it('should keep script constructors as dedicated method targets instead of aliasing root', function () {
      const script = new Script(
        'shared text trace\nextends "A.script"\nthis.trace("post|")\nreturn this.trace.snapshot()',
        env,
        'constructor-method-target.script'
      );

      script.compile();

      expect(script.inheritanceSpec.methods.__constructor__.fn).to.be.a('function');
      expect(script.inheritanceSpec.methods.__constructor__.fn).not.to.be(script.rootRenderFunc);
    });

    it('should run script constructor chaining in root-buffer source order', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace("A|")\nreturn "A"');
      loader.addTemplate('B.script', 'shared text trace\nextends "A.script"\nthis.trace("post-B|")');
      loader.addTemplate('C.script', 'shared text trace\nextends "B.script"\nthis.trace("post-C|")\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('A|post-B|post-C|');
    });

    it('should run an ancestor constructor once through a constructorless child script', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace("A|")');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('A|');
    });

    it('should run an ancestor constructor once through a constructorless middle script', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace("A|")');
      loader.addTemplate('B.script', 'extends "A.script"');
      loader.addTemplate('C.script', 'shared text trace\nextends "B.script"\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('A|');
    });

    it('should expose descendant shared defaults to ancestor constructors', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared var theme = "light"\nshared text trace\nthis.trace(this.theme)');
      loader.addTemplate('C.script', 'shared var theme = "dark"\nshared text trace\nextends "A.script"\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('dark');
    });

    it('should not treat undeclared parent shared vars as ordinary bare symbols in child scripts', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared var theme = "light"\nthis.theme = "dark"');
      loader.addTemplate('C.script', 'extends "A.script"\nmethod readTheme()\n  return theme\nendmethod\nreturn this.readTheme()');

      try {
        await env.renderScript('C.script', {});
        expect().fail('Expected undeclared shared bare lookup to fail');
      } catch (err) {
        expect(String(err)).to.contain('Can not look up unknown variable/function: theme');
      }
    });

    it('should keep undeclared template block names on the ambient lookup path even when parents declare matching shared vars', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.njk', '{% shared var theme = "light" %}{% block body %}parent{% endblock %}');
      loader.addTemplate('C.njk', '{% extends "A.njk" %}{% block body %}{{ theme }}{% endblock %}');

      const withoutContext = await env.renderTemplate('C.njk', {});
      const withContext = await env.renderTemplate('C.njk', { theme: 'context' });

      expect(withoutContext).to.be('');
      expect(withContext).to.be('context');
    });

    it('should allow template block reads of shared vars with a local declaration', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.njk', '{% shared var theme = "light" %}{% block body %}parent{% endblock %}');
      loader.addTemplate('C.njk', '{% shared var theme = "dark" %}{% extends "A.njk" %}{% block body %}{{ theme }}{% endblock %}');

      const result = await env.renderTemplate('C.njk', {});

      expect(result).to.be('dark');
    });

    it('should preserve parent-before-post order through the child-buffer structure', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace(waitAndGet("A|"))');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nthis.trace("post|")\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {
        waitAndGet: (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10))
      });
      expect(result).to.be('A|post|');
    });

    it('should propagate extends composition payload unchanged across a multi-level chain', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace(theme)');
      loader.addTemplate('B.script', 'extends "A.script"');
      loader.addTemplate('C.script', 'shared text trace\nextends "B.script" with theme\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', { theme: 'dark' });
      expect(result).to.be('dark');
    });

    it('should make extends-with payload visible to the parent constructor before parent work runs', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace(theme)');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script" with theme\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', { theme: 'dark' });
      expect(result).to.be('dark');
    });

    it('should honor without context on script extends payload root', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nif site is error\n  this.trace("missing")\nelse\n  this.trace(site)\nendif');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script" without context\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', { site: 'Example' });
      expect(result).to.be('missing');
    });

    it('should reject multiple top-level script extends declarations', function () {
      expect(() => {
        new Script('extends "A.script"\nextends "B.script"\nreturn 1', env, 'multi-extends.script')._compileSource();
      }).to.throwException(/script roots support at most one top-level extends/);
    });

    it('should reject cyclic script extends chains clearly', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'extends "B.script"\nreturn null');
      loader.addTemplate('B.script', 'extends "A.script"\nreturn null');

      try {
        await env.renderScript('A.script', {});
        expect().fail('Expected cyclic extends chain to fail');
      } catch (err) {
        expect(String(err)).to.contain('Cyclic extends chain detected');
      }
    });

    it('should reject cyclic dynamic script extends chains clearly', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'extends parentName\nreturn null');
      loader.addTemplate('B.script', 'extends "A.script"\nreturn null');

      try {
        await env.renderScript('A.script', { parentName: 'B.script' });
        expect().fail('Expected cyclic dynamic extends chain to fail');
      } catch (err) {
        expect(String(err)).to.contain('Cyclic extends chain detected');
      }
    });

    it('should keep the root constructor empty when there is no executable top-level body', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace("A|")');
      loader.addTemplate('C.script', 'extends "A.script"');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(null);
    });

    it('should let constructor super() resolve against an empty topmost parent body', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'method noop()\n  return null\nendmethod');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nsuper()\nthis.trace("C|")\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('C|');
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
      expect(result).to.be(null);
    });

    it('should ignore all ancestor explicit returns across a 3-level hierarchy', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'return "A"');
      loader.addTemplate('B.script', 'extends "A.script"\nreturn "B"');
      loader.addTemplate('C.script', 'extends "B.script"');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(null);
    });

    it('should not treat script output channels as the direct render result when the entry file has no explicit return', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nthis.trace("A|")');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nthis.trace("C|")');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be(null);
    });

    it('should keep the normal script fallback when the entry file has no explicit return', async function () {
      const result = await env.renderScriptString('var x = 1', {});
      expect(result).to.be(null);
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

      expect(source).to.contain('output.finish();');
      expect(source).to.not.contain('context.asyncExtendsBlocksPromise');
    });
  });

  describe('Script method invocation scope', function () {
    it('should keep plain-script top-level locals out of later method scope', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('Plain.script', 'var secret = "A"\nmethod readSecret()\n  return secret\nendmethod\nreturn this.readSecret()');

      const result = await env.renderScript('Plain.script', {});
      expect(result).to.be(undefined);
    });

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

      loader.addTemplate('A.script', 'shared text trace\nthis.trace(this.build("Ada"))');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nmethod build(name)\n  return "child:" + name\nendmethod\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('child:Ada');
    });

    it('should wait only at the inherited call site after extends, not stall surrounding constructor flow', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nmethod build(name)\n  return waitAndGet("parent:" + name)\nendmethod\nthis.trace("A|")');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nvar label = this.build("Ada")\nthis.trace("post|")\nthis.trace(label)\nreturn this.trace.snapshot()');

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

    it('should compile inherited methods against the composition-context baseline instead of render-context-only fallback', function () {
      const source = new Script(
        'extends "A.script"\nmethod build() with context\n  return siteName\nendmethod\nreturn null',
        env,
        'composition-context-method.script'
      )._compileSource();

      expect(source).to.contain('context.getCompositionContextVariables()');
      expect(source).to.not.contain('context.getMethodCompositionVariables');
    });

    it('should keep shared-channel writes from method bodies ordered at the call site', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nmethod build(name)\n  this.trace("method|" + name + "|")\n  return "done:" + name\nendmethod');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nthis.trace("before|")\nvar result = this.build("Ada")\nthis.trace("after|")\nthis.trace(result)\nreturn this.trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('before|method|Ada|after|done:Ada');
    });

    it('should keep inherited method-in-method shared dependencies ordered before a later local method reads them', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', [
        'shared text trace',
        'shared var theme = "parent"',
        'method applyTheme()',
        '  this.theme = waitAndGet("dark", 10)',
        '  this.trace("apply|")',
        '  return "applied"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'shared text trace',
        'shared var theme = "light"',
        'extends "A.script"',
        'method readTheme()',
        '  this.trace("read:" + this.theme + "|")',
        '  return this.theme',
        'endmethod',
        'method outer()',
        '  var first = this.applyTheme()',
        '  var second = this.readTheme()',
        '  this.trace("result:" + second + "|")',
        '  return this.trace.snapshot()',
        'endmethod',
        'return this.outer()'
      ].join('\n'));

      const result = await env.renderScript('C.script', {
        waitAndGet: (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay))
      });

      expect(result).to.be('apply|read:dark|result:dark|');
    });

    it('should resume multiple unresolved inherited admissions in source order', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'method first()\n  return waitAndGet("first|", 20)\nendmethod\nmethod second()\n  return waitAndGet("second|", 0)\nendmethod');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nthis.trace(this.first())\nthis.trace(this.second())\nreturn this.trace.snapshot()');

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
        expect(error.path).to.be('C.script');
        expect(String(error)).to.contain('Inherited method \'missing\' was not found');
        expect(String(error)).to.contain('doing \'FunCall\'');
      }
    });

    it('should fail cleanly for a deferred missing inherited method inside a shared-channel call site', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\nreturn "A"');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script"\nthis.trace(this.missing(waitAndGet("Ada")))\nreturn this.trace.snapshot()');

      try {
        await env.renderScript('C.script', {
          waitAndGet: (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10))
        });
        expect().fail('Expected deferred missing inherited method failure');
      } catch (error) {
        expect(runtime.isPoisonError(error)).to.be(false);
        expect(error.name).to.be('RuntimeFatalError');
        expect(error.lineno).to.be(3);
        expect(error.path).to.be('C.script');
        expect(String(error)).to.contain('Inherited method \'missing\' was not found');
        expect(String(error)).to.contain('doing \'FunCall\'');
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
        expect(String(error)).to.contain('Inherited method \'build\' received too many arguments');
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

    it('should resolve inherited method metadata with the callable runtime shape', async function () {
      env = new AsyncEnvironment();
      const context = new Context({}, {}, env, 'Main.script', true, {}, {});
      const inheritanceState = runtime.createInheritanceState();
      const rootBuffer = new runtime.CommandBuffer(context);
      runtime.declareBufferChannel(rootBuffer, 'theme', 'var', context, null);
      runtime.declareBufferChannel(rootBuffer, 'trace', 'var', context, null);

      inheritanceState.methods.build = {
        fn() {
          return 'done';
        },
        signature: { argNames: [], withContext: false },
        ownerKey: 'Main.script',
        ownMutatedChannels: ['trace'],
        ownLinkedChannels: ['theme', 'trace'],
        super: null
      };

      const admission = runtime.invokeInheritedMethod(
        inheritanceState,
        'build',
        [],
        context,
        env,
        runtime,
        () => {},
        rootBuffer,
        { lineno: 1, colno: 1, errorContextString: null, path: 'Main.script' }
      );

      const methodMeta = inheritanceCallModule.getMethodData(
        inheritanceState,
        'build',
        { lineno: 1, colno: 1, errorContextString: null, path: 'Main.script' }
      );

      rootBuffer.finish();
      const value = await admission;

      expect(value).to.be('done');
      expect(methodMeta).to.be.ok();
      expect(methodMeta.fn).to.be(inheritanceState.methods.build.fn);
      expect(methodMeta.signature).to.eql({ argNames: [], withContext: false });
      expect(methodMeta.mergedMutatedChannels).to.contain('trace');
      expect(methodMeta.mergedLinkedChannels).to.contain('theme');
      expect(methodMeta.mergedLinkedChannels).to.contain('trace');
    });

    it('should let finishInvocationBuffer own sync invocation-buffer cleanup', async function () {
      if (!inheritanceCallModule) {
        this.skip();
        return;
      }
      const fakeBuffer = {
        finishCount: 0,
        finish() {
          this.finishCount += 1;
        },
        getFinishedPromise() {
          return Promise.resolve();
        }
      };
      const context = {
        getRenderContextVariables() {
          return {};
        }
      };
      const command = inheritanceCallModule.createInheritanceInvocationCommand({
        name: '__constructor__',
        methodData: {
          fn() {
            return 'done';
          },
          signature: { argNames: [], withContext: false },
          ownerKey: 'Parent.script',
          mergedMutatedChannels: [],
          mergedLinkedChannels: [],
          super: null
        },
        args: [],
        context,
        inheritanceState: runtime.createInheritanceState(),
        env: {},
        runtime,
        cb: () => {},
        invocationBuffer: fakeBuffer,
        errorContext: { lineno: 1, colno: 1, errorContextString: null, path: 'Parent.script' }
      });

      const applied = command.apply();
      const value = applied && typeof applied.then === 'function' ? await applied : applied;
      const promised = await command.promise;

      expect(value).to.be('done');
      expect(promised).to.be('done');
      expect(fakeBuffer.finishCount).to.be(1);
    });

    describe('Phase 7 - Late Inherited Linking', function () {
      it('should hold later shared-visible apply behind the unresolved inherited admission barrier in source order', async function () {
        const loader = new StringLoader();
        env = new AsyncEnvironment(loader);

        loader.addTemplate('A.script', [
          'shared text trace',
          'method build()',
          '  this.trace(waitAndGet("method|", 10))',
          '  return "done"',
          'endmethod'
        ].join('\n'));
        loader.addTemplate('C.script', [
          'shared text trace',
          'extends "A.script"',
          'this.trace("before|")',
          'var result = this.build()',
          'this.trace("after|")',
          'this.trace(result)',
          'return this.trace.snapshot()'
        ].join('\n'));

        const result = await env.renderScript('C.script', {
          waitAndGet: (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay))
        });

        expect(result).to.be('before|method|after|done');
      });

    });
  });
});
