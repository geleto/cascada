'use strict';

let expect;
let AsyncEnvironment;
let AsyncTemplate;
let Script;
let Context;
let parser;
let nodes;
let scriptTranspiler;
let runtime;
let inheritanceBootstrap;
let inheritanceStartup;
let inheritanceMethodRegistry;
let inheritanceSharedRegistry;
let StringLoader;
if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  AsyncTemplate = environment.AsyncTemplate;
  Script = environment.Script;
  Context = require('../../src/environment/context').Context;
  parser = require('../../src/parser');
  nodes = require('../../src/nodes');
  scriptTranspiler = require('../../src/script/script-transpiler');
  runtime = require('../../src/runtime/runtime');
  inheritanceBootstrap = require('../../src/runtime/inheritance-bootstrap');
  inheritanceStartup = require('../../src/runtime/inheritance-startup');
  const inheritanceStateModule = require('../../src/runtime/inheritance-state');
  inheritanceMethodRegistry = inheritanceStateModule.InheritanceMethodRegistry;
  inheritanceSharedRegistry = inheritanceStateModule.InheritanceSharedRegistry;
  StringLoader = require('../util').StringLoader;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  AsyncTemplate = nunjucks.AsyncTemplate;
  Script = nunjucks.Script;
  Context = null;
  parser = nunjucks.parser;
  nodes = nunjucks.nodes;
  scriptTranspiler = nunjucks.scriptTranspiler;
  runtime = nunjucks.runtime;
  inheritanceBootstrap = null;
  inheritanceStartup = null;
  inheritanceMethodRegistry = null;
  inheritanceSharedRegistry = null;
  StringLoader = window.util.StringLoader;
}

describe('Extends', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Step 1', function () {
    describe('shared keyword', function () {
      it('should parse shared var declarations', function () {
        const template = scriptTranspiler.scriptToTemplate('shared var theme = "dark"');
        const ast = parser.parse(template);
        const declaration = ast.findAll(nodes.ChannelDeclaration)[0];

        expect(declaration).to.be.ok();
        expect(declaration.channelType).to.be('var');
        expect(declaration.name.value).to.be('theme');
        expect(declaration.isShared).to.be(true);
      });

      it('should parse shared text declarations', function () {
        const template = scriptTranspiler.scriptToTemplate('shared text log');
        const ast = parser.parse(template);
        const declaration = ast.findAll(nodes.ChannelDeclaration)[0];

        expect(declaration).to.be.ok();
        expect(declaration.channelType).to.be('text');
        expect(declaration.name.value).to.be('log');
        expect(declaration.isShared).to.be(true);
      });

      it('should allow shared sequence declarations without an initializer', function () {
        expect(() => {
          new Script('shared sequence db\nreturn null', env, 'shared-sequence-script.casc')._compileSource();
        }).not.to.throwException();
      });

      it('should reject shared inside a method body', function () {
        try {
          new Script('method build()\n  shared var theme = "dark"\nendmethod', env, 'shared-inside-method.casc')._compileSource();
          expect().fail('Expected nested shared declaration to fail');
        } catch (error) {
          expect(String(error)).to.contain('shared declarations are only allowed at the root scope');
        }
      });

      it('should reject shared text initializers', function () {
        expect(() => {
          new Script('shared text log = "x"', env, 'shared-text-init.casc')._compileSource();
        }).to.throwException(/text channels cannot have initializers/);
      });

      it('should reject shared data initializers', function () {
        expect(() => {
          new Script('shared data state = 1', env, 'shared-data-init.casc')._compileSource();
        }).to.throwException(/data channels cannot have initializers/);
      });
    });

    describe('method syntax', function () {
      it('should compile method syntax by lowering it to a block', function () {
        const template = scriptTranspiler.scriptToTemplate('method foo(user)\n  return user\nendmethod');
        const ast = parser.parse(template);
        const block = ast.findAll(nodes.Block)[0];

        expect(block).to.be.ok();
        expect(block.name.value).to.be('foo');
        expect(block.args.children).to.have.length(1);
        expect(block.args.children[0].value).to.be('user');
      });

      it('should preserve method arguments', function () {
        const template = scriptTranspiler.scriptToTemplate('method foo(user, theme)\n  user + theme\nendmethod');
        const ast = parser.parse(template);
        const block = ast.findAll(nodes.Block)[0];

        expect(block).to.be.ok();
        expect(block.args.children).to.have.length(2);
        expect(block.args.children[0].value).to.be('user');
        expect(block.args.children[1].value).to.be('theme');
      });

      it('should fail clearly on bad endmethod usage in the script transpiler', function () {
        expect(() => {
          scriptTranspiler.scriptToTemplate('endmethod');
        }).to.throwException(/Unexpected 'endmethod'/);
      });
    });
  });

  describe('Step 2', function () {
    it('should lower shared declarations through the normal script compile path', function () {
      const source = new Script('shared var theme = "dark"\nreturn theme', env, 'shared-lowering.casc')._compileSource();

      expect(source).to.contain('runtime.declareSharedBufferChannel(output, "theme", "var", context, null);');
      expect(source).to.contain('initializeIfNotSet: true');
    });

    it('should lower shared sequence declarations through the normal script compile path', function () {
      const declaredOnly = new Script('shared sequence db\nreturn null', env, 'shared-sequence-decl.casc')._compileSource();
      const initialized = new Script('shared sequence db = makeDb()\nreturn null', env, 'shared-sequence-init.casc')._compileSource();

      expect(declaredOnly).to.contain('runtime.declareSharedBufferChannel(output, "db", "sequence", context, null);');
      expect(initialized).to.contain('runtime.declareSharedBufferChannel(output, "db", "sequence", context, ');
      expect(initialized).to.contain('makeDb');
    });

    it('should record shared channel schema on the compiled file', function () {
      const script = new Script('shared var theme = "dark"\nshared text log\nreturn null', env, 'shared-schema.casc');
      script.compile();

      expect(script.sharedSchema).to.eql([
        { name: 'theme', type: 'var' },
        { name: 'log', type: 'text' }
      ]);
    });

    it('should apply a shared var default through normal script rendering', async function () {
      const result = await env.renderScriptString('shared var theme = "dark"\nreturn theme', {});

      expect(result).to.be('dark');
    });

    it('should preserve declaration-only shared vars and allow later plain assignment through normal script rendering', async function () {
      const declarationOnly = await env.renderScriptString('shared var theme\nreturn theme', {});
      const assigned = await env.renderScriptString('shared var theme\ntheme = "light"\nreturn theme', {});

      expect(declarationOnly).to.be(undefined);
      expect(assigned).to.be('light');
    });

    it('should let an earlier child-buffer shared default win over a later parent-buffer default', async function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const childBuffer = runtime.createCommandBuffer(null, rootBuffer, ['theme'], rootBuffer);
      runtime.declareSharedBufferChannel(childBuffer, 'theme', 'var', null, null);

      childBuffer.add(new runtime.VarCommand({
        channelName: 'theme',
        args: ['dark'],
        initializeIfNotSet: true,
        pos: { lineno: 1, colno: 1 }
      }), 'theme');
      rootBuffer.add(new runtime.VarCommand({
        channelName: 'theme',
        args: ['light'],
        initializeIfNotSet: true,
        pos: { lineno: 2, colno: 1 }
      }), 'theme');

      childBuffer.markFinishedAndPatchLinks();
      rootBuffer.markFinishedAndPatchLinks();

      const result = await rootBuffer.getChannel('theme').finalSnapshot();
      expect(result).to.be('dark');
    });

    it('should mark shared channels as explicitly readable across template boundaries', function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const childBuffer = runtime.createCommandBuffer(null, rootBuffer, ['theme'], rootBuffer);
      const sharedChannel = runtime.declareSharedBufferChannel(childBuffer, 'theme', 'var', null, null);

      expect(typeof sharedChannel.allowsCrossTemplateRead).to.be('function');
      expect(sharedChannel.allowsCrossTemplateRead()).to.be(true);
      expect(rootBuffer.getChannel('theme').allowsCrossTemplateRead()).to.be(true);
    });

    it('should preload shared inputs for every declared channel kind through the channel runtime owner', async function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const sharedSchema = [
        { name: 'theme', type: 'var' },
        { name: 'log', type: 'text' },
        { name: 'state', type: 'data' },
        { name: 'logger', type: 'sink' },
        { name: 'db', type: 'sequence' }
      ];
      const loggerSink = {
        snapshot: () => 'logger-ready'
      };
      const sequenceSink = {
        snapshot: () => 'sequence-ready'
      };

      runtime.preloadSharedInputs(sharedSchema, {
        theme: 'dark',
        log: 'boot|',
        state: { ok: true },
        logger: loggerSink,
        db: sequenceSink
      }, rootBuffer, null, { lineno: 1, colno: 1 });
      rootBuffer.markFinishedAndPatchLinks();

      expect(await rootBuffer.getChannel('theme').finalSnapshot()).to.be('dark');
      expect(await rootBuffer.getChannel('log').finalSnapshot()).to.be('boot|');
      expect(await rootBuffer.getChannel('state').finalSnapshot()).to.eql({ ok: true });
      expect(await rootBuffer.getChannel('logger').finalSnapshot()).to.be('logger-ready');
      expect(await rootBuffer.getChannel('db').finalSnapshot()).to.be('sequence-ready');
    });
  });

  describe('Step 3', function () {
    it('should lower static script extends through a structural child-buffer boundary', function () {
      const source = new Script(
        'shared text trace\nextends "A.script"\ntrace("post|")\nreturn trace.snapshot()',
        env,
        'static-extends-boundary.script'
      )._compileSource();

      expect(source).to.contain('runtime.runControlFlowBoundary(');
      expect(source).not.to.contain('waitForApplyComplete');
    });

    it('should run script constructor chaining in root-buffer source order', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared text trace\ntrace("A|")\nreturn "A"');
      loader.addTemplate('B.script', 'shared text trace\ntrace("pre-B|")\nextends "A.script"\ntrace("post-B|")');
      loader.addTemplate('C.script', 'shared text trace\ntrace("pre-C|")\nextends "B.script"\ntrace("post-C|")\nreturn trace.snapshot()');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('pre-C|pre-B|A|post-B|post-C|');
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

    it('should reject multiple top-level script extends declarations', function () {
      expect(() => {
        new Script('extends "A.script"\nextends "B.script"\nreturn 1', env, 'multi-extends.script')._compileSource();
      }).to.throwException(/script roots support at most one top-level extends/);
    });
  });

  describe('Step 4', function () {
    it('should expose compiled methods metadata up front', function () {
      const script = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'method-metadata.script');
      script.compile();

      expect(script.methods).to.be.ok();
      expect(script.methods.build).to.be.ok();
      expect(typeof script.methods.build.fn).to.be('function');
      expect(script.methods.build.contract).to.eql({
        inputNames: ['user'],
        withContext: false
      });
      expect(script.methods.build.ownerKey).to.be('method-metadata.script');
    });

    it('should expose __constructor__ in the compiled methods map with internal metadata', function () {
      const script = new Script('shared text trace\ntrace("x")\nreturn null', env, 'constructor-metadata.script');
      script.compile();

      expect(script.methods).to.be.ok();
      expect(script.methods.__constructor__).to.be.ok();
      expect(typeof script.methods.__constructor__.fn).to.be('function');
      expect(script.methods.__constructor__.contract).to.eql({
        inputNames: [],
        withContext: false
      });
      expect(script.methods.__constructor__.ownerKey).to.be('constructor-metadata.script');
    });

    it('should reject __constructor__ as a user-declared method name', function () {
      expect(() => {
        new Script('method __constructor__()\n  return null\nendmethod\nreturn null', env, 'reserved-constructor.script')._compileSource();
      }).to.throwException(/Identifier '__constructor__' is reserved/);
    });

    it('should preserve child-first method chains when parent methods register later', function () {
      const childScript = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'C.script');
      const parentScript = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      const inheritanceState = runtime.createInheritanceState();
      inheritanceState.methods.registerCompiled(childScript.methods);
      inheritanceState.methods.registerCompiled(parentScript.methods);

      const chain = inheritanceState.methods.getChain('build');
      expect(chain.map((entry) => entry.ownerKey)).to.eql(['C.script', 'A.script']);
      expect(chain[0].contract).to.eql({
        inputNames: ['user'],
        withContext: false
      });
    });

    it('should register shared schema before constructor work begins', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      const seen = [];
      const originalCreateInheritanceState = runtime.createInheritanceState;

      runtime.createInheritanceState = function() {
        const inheritanceState = originalCreateInheritanceState();
        const originalRegisterSharedSchema = inheritanceState.shared.registerSchema;
        inheritanceState.shared.registerSchema = function(sharedSchema) {
          seen.push(`schema:${(sharedSchema || []).map((entry) => entry.name).join(',')}`);
          return originalRegisterSharedSchema.call(this, sharedSchema);
        };
        return inheritanceState;
      };

      try {
        loader.addTemplate('C.script', 'shared text trace\nlog("pre-C|")\nreturn "done"');

        const result = await env.renderScript('C.script', {
          log: (value) => {
            seen.push(value);
            return value;
          }
        });

        expect(result).to.be('done');
        expect(seen[0]).to.be('schema:trace');
        expect(seen[1]).to.be('pre-C|');
      } finally {
        runtime.createInheritanceState = originalCreateInheritanceState;
      }
    });

    it('should make parent methods reachable after the extends load boundary resolves', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'method build(name)\n  return "parent:" + name\nendmethod');
      loader.addTemplate('C.script', 'extends "A.script"\nreturn this.build("Ada")');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('parent:Ada');
    });

    it('should preload shared inputs from extends with before ancestor constructor code runs', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'shared var theme = "light"\nshared text trace\ntrace(theme)');
      loader.addTemplate('C.script', 'shared text trace\nextends "A.script" with theme\nreturn trace.snapshot()');

      const result = await env.renderScript('C.script', { theme: 'dark' });
      expect(result).to.be('dark');
    });

    it('should reject extends with names that are not declared shared by the parent', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'extern theme = "light"\nreturn theme');
      loader.addTemplate('C.script', 'extends "A.script" with theme\nreturn "done"');

      try {
        await env.renderScript('C.script', { theme: 'dark' });
        expect().fail('Expected shared-input validation to fail');
      } catch (error) {
        expect(String(error)).to.contain("does not declare it as shared");
      }
    });
  });

  describe('Step 6', function () {
    it('should only create inheritance state for roots that need inheritance features', function () {
      const plainScript = new Script('var x = 1\nreturn x', env, 'plain.script');
      const methodScript = new Script('method build(name)\n  return name\nendmethod\nreturn this.build("Ada")', env, 'method.script');

      const plainSource = plainScript._compileSource();
      const methodSource = methodScript._compileSource();

      expect(plainSource).to.not.contain('runtime.createInheritanceState()');
      expect(methodSource).to.contain('runtime.createInheritanceState()');
    });

    it('should reuse the existing inheritance state when a parent root renders for composition', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      let createCount = 0;
      const originalCreateInheritanceState = runtime.createInheritanceState;

      runtime.createInheritanceState = function() {
        createCount++;
        return originalCreateInheritanceState();
      };

      try {
        loader.addTemplate('A.script', 'method build(name)\n  return "A:" + name\nendmethod');
        loader.addTemplate('C.script', 'extends "A.script"\nreturn this.build("Ada")');

        const result = await env.renderScript('C.script', {});
        expect(result).to.be('A:Ada');
        expect(createCount).to.be(1);
      } finally {
        runtime.createInheritanceState = originalCreateInheritanceState;
      }
    });
  });

  describe('Step 7', function () {
    it('should route shared declarations from the whole hierarchy to the same shared root buffer', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      const originalDeclareSharedBufferChannel = runtime.declareSharedBufferChannel;
      const themeBuffers = [];

      runtime.declareSharedBufferChannel = function(buffer, channelName, channelType, context, initializer) {
        const channel = originalDeclareSharedBufferChannel(buffer, channelName, channelType, context, initializer);
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
        runtime.declareSharedBufferChannel = originalDeclareSharedBufferChannel;
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

  describe('Step 13A', function () {
    it('should route dynamic parent startup through composition mode only', async function () {
      if (!inheritanceStartup) {
        this.skip();
        return;
      }

      const currentBuffer = runtime.createCommandBuffer({ path: 'Child.script' });
      const inheritanceState = runtime.createInheritanceState();
      const registrationContext = {
        path: 'Child.script',
        getRenderContextVariables() {
          return { siteName: 'Example' };
        },
        forkForComposition(nextPath, ctx, renderCtx, externCtx) {
          return { path: nextPath, ctx, renderCtx, externCtx };
        },
        forkForPath(nextPath) {
          return { path: nextPath };
        }
      };
      const compositionPayload = {
        explicitInputValues: { theme: 'dark' },
        explicitInputNames: ['theme'],
        rootContext: { theme: 'dark', siteName: 'Example' },
        externContext: { theme: 'dark' }
      };
      const calls = [];
      const expectedCompletion = Promise.resolve('dynamic-finished');
      const parentTemplate = {
        path: 'Parent.script',
        hasDynamicExtends: true,
        rootRenderFunc(envArg, contextArg, runtimeArg, cbArg, compositionMode, parentBufferArg, inheritanceStateArg) {
          calls.push({
            envArg,
            contextArg,
            runtimeArg,
            cbArg,
            compositionMode,
            parentBufferArg,
            inheritanceStateArg
          });
          return {
            getFinishedPromise() {
              return expectedCompletion;
            }
          };
        }
      };

      const completion = inheritanceStartup.startParentConstructor(
        parentTemplate,
        registrationContext,
        compositionPayload,
        inheritanceState,
        { envName: 'env' },
        runtime,
        () => {},
        currentBuffer,
        { lineno: 1, colno: 1, path: 'Child.script' },
        true
      );

      expect(calls).to.have.length(1);
      expect(calls[0].compositionMode).to.be(true);
      expect(calls[0].parentBufferArg).to.be(currentBuffer);
      expect(calls[0].inheritanceStateArg).to.be(inheritanceState);
      expect(calls[0].contextArg).to.eql({
        path: 'Parent.script',
        ctx: compositionPayload.rootContext,
        renderCtx: { siteName: 'Example' },
        externCtx: compositionPayload.externContext
      });
      expect(completion).to.be(expectedCompletion);
      expect(await completion).to.be('dynamic-finished');
    });

    it('should route static parent startup through bootstrap and shared-link installation', function () {
      if (!inheritanceStartup || !inheritanceBootstrap) {
        this.skip();
        return;
      }

      const currentBuffer = runtime.createCommandBuffer({ path: 'Child.script' });
      const inheritanceState = runtime.createInheritanceState();
      const registrationContext = {
        path: 'Child.script',
        getRenderContextVariables() {
          return {};
        },
        forkForComposition(nextPath, ctx, renderCtx, externCtx) {
          return { path: nextPath, ctx, renderCtx, externCtx };
        },
        forkForPath(nextPath) {
          return { path: nextPath };
        }
      };
      const parentTemplate = {
        hasDynamicExtends: false,
        path: 'Parent.script',
        methods: {
          __constructor__: {
            fn() {
              return null;
            },
            kind: 'method',
            contract: { inputNames: [], withContext: false },
            ownerKey: 'Parent.script',
            linkedChannels: []
          }
        },
        sharedSchema: [{ name: 'theme', type: 'var' }],
        rootRenderFunc() {
          throw new Error('dynamic parent startup should not run for static parents');
        }
      };
      const originalBootstrap = inheritanceBootstrap.bootstrapInheritanceMetadata;
      const originalEnsureLinks = inheritanceBootstrap.ensureCurrentBufferSharedLinks;
      const seen = [];

      inheritanceBootstrap.bootstrapInheritanceMetadata = function(inheritanceStateArg, methodsArg, sharedSchemaArg, bufferArg, contextArg) {
        seen.push({
          kind: 'bootstrap',
          inheritanceStateArg,
          methodsArg,
          sharedSchemaArg,
          bufferArg,
          contextArg
        });
        return originalBootstrap.apply(this, arguments);
      };
      inheritanceBootstrap.ensureCurrentBufferSharedLinks = function(sharedSchemaArg, bufferArg) {
        seen.push({
          kind: 'links',
          sharedSchemaArg,
          bufferArg
        });
        return originalEnsureLinks.apply(this, arguments);
      };

      try {
        const completion = inheritanceStartup.startParentConstructor(
          parentTemplate,
          registrationContext,
          null,
          inheritanceState,
          { envName: 'env' },
          runtime,
          () => {},
          currentBuffer,
          { lineno: 1, colno: 1, path: 'Child.script' },
          false
        );

        expect(completion).to.be(null);
        expect(seen.map((entry) => entry.kind)).to.eql(['bootstrap', 'links']);
        expect(seen[0].inheritanceStateArg).to.be(inheritanceState);
        expect(seen[0].bufferArg).to.be(currentBuffer);
        expect(seen[0].contextArg).to.be(registrationContext);
        expect(seen[1].bufferArg).to.be(currentBuffer);
      } finally {
        inheritanceBootstrap.bootstrapInheritanceMetadata = originalBootstrap;
        inheritanceBootstrap.ensureCurrentBufferSharedLinks = originalEnsureLinks;
      }
    });

    it('should return static parent constructor completion only after bootstrap, link installation, and admission', async function () {
      if (!inheritanceStartup || !inheritanceBootstrap) {
        this.skip();
        return;
      }

      const inheritanceCall = require('../../src/runtime/inheritance-call');
      const currentBuffer = runtime.createCommandBuffer({ path: 'Child.script' });
      const inheritanceState = runtime.createInheritanceState();
      const registrationContext = {
        path: 'Child.script',
        getRenderContextVariables() {
          return { siteName: 'Example' };
        },
        forkForComposition(nextPath, ctx, renderCtx, externCtx) {
          return { path: nextPath, ctx, renderCtx, externCtx };
        },
        forkForPath(nextPath) {
          return { path: nextPath };
        }
      };
      const compositionPayload = {
        explicitInputValues: { theme: 'dark' },
        explicitInputNames: ['theme'],
        rootContext: { theme: 'dark', siteName: 'Example' },
        externContext: { theme: 'dark' }
      };
      const parentTemplate = {
        hasDynamicExtends: false,
        path: 'Parent.script',
        methods: {
          __constructor__: {
            fn() {
              return null;
            },
            kind: 'method',
            contract: { inputNames: [], withContext: false },
            ownerKey: 'Parent.script',
            linkedChannels: []
          }
        },
        sharedSchema: [{ name: 'theme', type: 'var' }]
      };
      const expectedCompletion = Promise.resolve('static-finished');
      const originalBootstrap = inheritanceBootstrap.bootstrapInheritanceMetadata;
      const originalEnsureLinks = inheritanceBootstrap.ensureCurrentBufferSharedLinks;
      const originalAdmitConstructorEntry = inheritanceCall.admitConstructorEntry;
      const seen = [];

      inheritanceBootstrap.bootstrapInheritanceMetadata = function() {
        seen.push('bootstrap');
        return originalBootstrap.apply(this, arguments);
      };
      inheritanceBootstrap.ensureCurrentBufferSharedLinks = function() {
        seen.push('links');
        return originalEnsureLinks.apply(this, arguments);
      };
      inheritanceCall.admitConstructorEntry = function(parentContext) {
        seen.push('admit');
        expect(parentContext).to.eql({
          path: 'Parent.script',
          ctx: compositionPayload.rootContext,
          renderCtx: { siteName: 'Example' },
          externCtx: compositionPayload.externContext
        });
        return {
          promise: Promise.resolve(null),
          completion: expectedCompletion
        };
      };

      try {
        const completion = inheritanceStartup.startParentConstructor(
          parentTemplate,
          registrationContext,
          compositionPayload,
          inheritanceState,
          { envName: 'env' },
          runtime,
          () => {},
          currentBuffer,
          { lineno: 1, colno: 1, path: 'Child.script' },
          true
        );

        expect(seen).to.eql(['bootstrap', 'links', 'admit']);
        expect(completion).to.be(expectedCompletion);
        expect(await completion).to.be('static-finished');
      } finally {
        inheritanceBootstrap.bootstrapInheritanceMetadata = originalBootstrap;
        inheritanceBootstrap.ensureCurrentBufferSharedLinks = originalEnsureLinks;
        inheritanceCall.admitConstructorEntry = originalAdmitConstructorEntry;
      }
    });
  });

  describe('Step 13B', function () {
    it('should keep inheritance-resolution lifecycle state on InheritanceState', async function () {
      const inheritanceState = runtime.createInheritanceState();

      expect(inheritanceState.methods).to.be.an(inheritanceMethodRegistry);
      expect(inheritanceState.shared).to.be.an(inheritanceSharedRegistry);
      expect(inheritanceState.resolution).to.be.ok();
      expect(inheritanceState.resolution.await()).to.be(null);

      inheritanceState.resolution.begin();
      inheritanceState.resolution.begin();

      const registrationWait = inheritanceState.resolution.await();
      expect(registrationWait && typeof registrationWait.then).to.be('function');

      let settled = false;
      registrationWait.then(() => {
        settled = true;
      });

      inheritanceState.resolution.finish();
      await Promise.resolve();
      expect(settled).to.be(false);

      inheritanceState.resolution.finish();
      await registrationWait;

      expect(settled).to.be(true);
      expect(inheritanceState.resolution.await()).to.be(null);
    });

    it('should remove inheritance-resolution bookkeeping from Context', function () {
      if (!Context) {
        this.skip();
        return;
      }

      expect(Context.prototype.beginInheritanceResolution).to.be(undefined);
      expect(Context.prototype.awaitInheritanceResolution).to.be(undefined);
      expect(Context.prototype.finishInheritanceResolution).to.be(undefined);
    });

    it('should compile dynamic extends against the inheritanceState runtime lifecycle surface', function () {
      const source = new AsyncTemplate(
        '{% if useParent %}{% extends parent %}{% endif %}{% block body %}x{% endblock %}',
        env,
        'dynamic-child.njk'
      )._compileSource();

      expect(source).to.contain('runtime.beginInheritanceResolution(inheritanceState);');
      expect(source).to.contain('runtime.finishInheritanceResolution(inheritanceState);');
      expect(source).to.contain('runtime.bridgeDynamicParentTemplate(inheritanceState,');
      expect(source).to.contain('runtime.renderDynamicTopLevelBlock(');
    });
  });

  describe('Step 15E', function () {
    it('should compile extends-with startup around one explicit composition payload shape', function () {
      const scriptSource = new Script(
        'var theme = "dark"\nextends "A.script" with theme\nreturn null',
        env,
        'payload-shape.script'
      )._compileSource();
      const dynamicTemplateSource = new AsyncTemplate(
        '{% set theme = "dark" %}{% if useParent %}{% extends parent with theme %}{% endif %}{% block body %}x{% endblock %}',
        env,
        'payload-shape.njk'
      )._compileSource();

      expect(scriptSource).to.contain('runtime.createExtendsCompositionPayload(');
      expect(scriptSource).to.contain('.explicitInputValues');
      expect(scriptSource).to.contain('runtime.startParentConstructor(');
      expect(dynamicTemplateSource).to.contain('runtime.createExtendsCompositionPayload(');
      expect(dynamicTemplateSource).to.contain('runtime.setExtendsComposition(inheritanceState,');
      expect(dynamicTemplateSource).to.contain('.explicitInputNames');
    });
  });
});
