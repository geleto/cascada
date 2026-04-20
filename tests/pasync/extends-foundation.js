'use strict';

let expect;
let AsyncEnvironment;
let AsyncTemplate;
let Script;
let Context;
let parser;
let nodes;
let transformer;
let scriptTranspiler;
let runtime;
let inheritanceBootstrap;
let inheritanceStartup;
let inheritanceMethodRegistry;
let inheritanceSharedRegistry;
let StringLoader;
let inheritanceStateModule;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  AsyncTemplate = environment.AsyncTemplate;
  Script = environment.Script;
  Context = require('../../src/environment/context').Context;
  parser = require('../../src/parser');
  nodes = require('../../src/nodes');
  transformer = require('../../src/transformer');
  scriptTranspiler = require('../../src/script/script-transpiler');
  runtime = require('../../src/runtime/runtime');
  try {
    inheritanceBootstrap = require('../../src/runtime/inheritance-bootstrap');
  } catch (err) {
    void err;
    inheritanceBootstrap = null;
  }
  try {
    inheritanceStartup = require('../../src/runtime/inheritance-startup');
  } catch (err) {
    void err;
    inheritanceStartup = null;
  }
  try {
    inheritanceStateModule = require('../../src/runtime/inheritance-state');
    inheritanceMethodRegistry = inheritanceStateModule.InheritanceMethodRegistry;
    inheritanceSharedRegistry = inheritanceStateModule.InheritanceSharedRegistry;
  } catch (err) {
    void err;
    inheritanceMethodRegistry = null;
    inheritanceSharedRegistry = null;
  }
  StringLoader = require('../util').StringLoader;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  AsyncTemplate = nunjucks.AsyncTemplate;
  Script = nunjucks.Script;
  Context = null;
  parser = nunjucks.parser;
  nodes = nunjucks.nodes;
  transformer = nunjucks.transformer || null;
  scriptTranspiler = nunjucks.scriptTranspiler;
  runtime = nunjucks.runtime;
  inheritanceBootstrap = null;
  inheritanceStartup = null;
  inheritanceMethodRegistry = null;
  inheritanceSharedRegistry = null;
  StringLoader = window.util.StringLoader;
}

describe('Extends Foundation', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Phase 1 - Frontend Syntax', function () {
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

      it('should parse shared sequence declarations with an initializer', function () {
        const template = scriptTranspiler.scriptToTemplate('shared sequence db = makeDb()');
        const ast = parser.parse(template);
        const declaration = ast.findAll(nodes.ChannelDeclaration)[0];

        expect(declaration).to.be.ok();
        expect(declaration.channelType).to.be('sequence');
        expect(declaration.name.value).to.be('db');
        expect(declaration.isShared).to.be(true);
        expect(declaration.initializer).to.be.ok();
      });

      it('should reject shared inside a method body', function () {
        try {
          new Script('method build()\n  shared var theme = "dark"\nendmethod', env, 'shared-inside-method.casc')._compileSource();
          expect().fail('Expected nested shared declaration to fail');
        } catch (error) {
          expect(String(error)).to.contain('shared declarations are only allowed at the root scope');
        }
      });

      it('should allow shared text initializers', function () {
        expect(() => {
          new Script('shared text log = "x"', env, 'shared-text-init.casc')._compileSource();
        }).not.to.throwException();
      });

      it('should allow shared data initializers', function () {
        expect(() => {
          new Script('shared data state = 1', env, 'shared-data-init.casc')._compileSource();
        }).not.to.throwException();
      });

      it('should reject shared sink declarations', function () {
        expect(() => {
          parser.parse(scriptTranspiler.scriptToTemplate('shared sink logger = makeLogger()'));
        }).to.throwException(/unsupported shared channel type 'sink'/);
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

    describe('inherited dispatch syntax', function () {
      it('should allow this.method(...) calls in script methods', function () {
        expect(() => {
          new Script(
            'method build(name)\n  this.render(name)\nendmethod\nreturn null',
            env,
            'this-method-call.script'
          )._compileSource();
        }).not.to.throwException();
      });

      it('should reject bare this.method references in scripts', function () {
        expect(() => {
          new Script(
            'method build(name)\n  this.render\nendmethod\nreturn null',
            env,
            'bare-this-method.script'
          )._compileSource();
        }).to.throwException(/bare this\.render references are not allowed; use this\.render\(\.\.\.\)/);
      });

      it('should keep bare foo() as an ordinary call', function () {
        expect(() => {
          new Script(
            'method build(name)\n  helper(name)\nendmethod\nreturn null',
            env,
            'ordinary-call.script'
          )._compileSource();
        }).not.to.throwException();
      });

      it('should allow super() calls in script methods', function () {
        expect(() => {
          new Script(
            'method build(name)\n  super(name)\nendmethod\nreturn null',
            env,
            'script-super-call.script'
          )._compileSource();
        }).not.to.throwException();
      });
    });

    describe('component syntax', function () {
      it('should parse component bindings without inputs', function () {
        const ast = parser.parse(scriptTranspiler.scriptToTemplate('component "Card.script" as card'));
        const componentNode = ast.findAll(nodes.Component)[0];

        expect(componentNode).to.be.ok();
        expect(componentNode.target.value).to.be('card');
        expect(componentNode.withContext).to.be(null);
        expect(componentNode.withVars.children).to.have.length(0);
        expect(componentNode.withValue).to.be(null);
      });

      it('should parse component bindings with shorthand inputs', function () {
        const ast = parser.parse(scriptTranspiler.scriptToTemplate('component "Card.script" as card with theme, id'));
        const componentNode = ast.findAll(nodes.Component)[0];

        expect(componentNode).to.be.ok();
        expect(componentNode.withContext).to.be(null);
        expect(componentNode.withVars.children).to.have.length(2);
        expect(componentNode.withVars.children[0].value).to.be('theme');
        expect(componentNode.withVars.children[1].value).to.be('id');
        expect(componentNode.withValue).to.be(null);
      });

      it('should parse component bindings with object inputs', function () {
        const ast = parser.parse(scriptTranspiler.scriptToTemplate('component "Card.script" as card with { theme: theme, id: cardId }'));
        const componentNode = ast.findAll(nodes.Component)[0];

        expect(componentNode).to.be.ok();
        expect(componentNode.withContext).to.be(null);
        expect(componentNode.withVars.children).to.have.length(0);
        expect(componentNode.withValue).to.be.a(nodes.Dict);
      });

      it('should parse component bindings with context only', function () {
        const ast = parser.parse(scriptTranspiler.scriptToTemplate('component "Card.script" as card with context'));
        const componentNode = ast.findAll(nodes.Component)[0];

        expect(componentNode).to.be.ok();
        expect(componentNode.withContext).to.be(true);
        expect(componentNode.withVars.children).to.have.length(0);
        expect(componentNode.withValue).to.be(null);
      });

      it('should parse component bindings with context and object inputs', function () {
        const ast = parser.parse(scriptTranspiler.scriptToTemplate('component "Card.script" as card with context, { theme: theme }'));
        const componentNode = ast.findAll(nodes.Component)[0];

        expect(componentNode).to.be.ok();
        expect(componentNode.withContext).to.be(true);
        expect(componentNode.withVars.children).to.have.length(0);
        expect(componentNode.withValue).to.be.a(nodes.Dict);
      });

      it('should reserve component as a declaration name', function () {
        expect(() => {
          scriptTranspiler.scriptToTemplate('var component = 1');
        }).to.throwException(/Identifier 'component' is reserved/);
      });

      it('should reserve this as a declaration name', function () {
        expect(() => {
          scriptTranspiler.scriptToTemplate('var this = 1');
        }).to.throwException(/Identifier 'this' is reserved/);
      });
    });

    describe('extends source order', function () {
      it('should allow only shared declarations before extends', function () {
        expect(() => {
          new Script(
            'shared var theme = "dark"\nshared text trace\nextends "A.script"\nreturn null',
            env,
            'shared-before-extends.script'
          )._compileSource();
        }).not.to.throwException();
      });

      it('should reject plain vars before extends', function () {
        expect(() => {
          new Script(
            'var theme = "dark"\nextends "A.script"\nreturn null',
            env,
            'var-before-extends.script'
          )._compileSource();
        }).to.throwException(/only shared declarations are allowed before extends/);
      });

      it('should reject methods before extends', function () {
        expect(() => {
          new Script(
            'method build(name)\n  helper(name)\nendmethod\nextends "A.script"\nreturn null',
            env,
            'method-before-extends.script'
          )._compileSource();
        }).to.throwException(/only shared declarations are allowed before extends/);
      });
    });
  });

  describe('Phase 3 - Shared Channel Metadata and Lowering', function () {
    it('should lower shared declarations through the normal script compile path', function () {
      const source = new Script('shared var theme = "dark"\nreturn theme', env, 'shared-lowering.casc')._compileSource();

      expect(source).to.contain('runtime.declareInheritanceSharedChannel(runtime.getInheritanceSharedBuffer(output, inheritanceState), "theme", "var", context, undefined);');
      expect(source).to.contain('initializeIfNotSet: true');
    });

    it('should lower shared sequence declarations through the normal script compile path', function () {
      const declaredOnly = new Script('shared sequence db\nreturn null', env, 'shared-sequence-decl.casc')._compileSource();
      const initialized = new Script('shared sequence db = makeDb()\nreturn null', env, 'shared-sequence-init.casc')._compileSource();

      expect(declaredOnly).to.contain('runtime.declareInheritanceSharedChannel(runtime.getInheritanceSharedBuffer(output, inheritanceState), "db", "sequence", context, null);');
      expect(initialized).to.contain('runtime.declareInheritanceSharedChannel(runtime.getInheritanceSharedBuffer(output, inheritanceState), "db", "sequence", context, ');
      expect(initialized).to.contain('makeDb');
    });

    it('should record shared channel schema on the compiled file', function () {
      const script = new Script('shared var theme = "dark"\nshared text log\nreturn null', env, 'shared-schema.casc');
      script.compile();

      expect(Object.keys(script.sharedSchema).sort()).to.eql(['log', 'theme']);
      expect(script.sharedSchema.theme.type).to.be('var');
      expect(typeof script.sharedSchema.theme.defaultValue).to.be('function');
      expect(script.sharedSchema.theme.defaultValue()).to.be('dark');
      expect(script.sharedSchema.log.type).to.be('text');
      expect(script.sharedSchema.log.defaultValue).to.be(null);
    });
  });

  describe('Phase 4 - Shared Channel Runtime Startup', function () {
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
      runtime.declareInheritanceSharedChannel(childBuffer, 'theme', 'var', null, null);

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

    it('should mark shared channels as explicitly readable across inheritance boundaries', function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const childBuffer = runtime.createCommandBuffer(null, rootBuffer, ['theme'], rootBuffer);
      const sharedChannel = runtime.declareInheritanceSharedChannel(childBuffer, 'theme', 'var', null, null);

      expect(sharedChannel._allowsInheritanceBoundaryRead).to.be(true);
      expect(rootBuffer.getChannel('theme')._allowsInheritanceBoundaryRead).to.be(true);
    });

    it('should keep shared declarations owned by the shared buffer instead of reusing an unrelated parent channel', function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const childBuffer = runtime.createCommandBuffer(null, rootBuffer, ['theme'], rootBuffer);
      const parentChannel = runtime.declareBufferChannel(rootBuffer, 'theme', 'var', null, null);
      const sharedChannel = runtime.declareInheritanceSharedChannel(childBuffer, 'theme', 'var', null, null);

      expect(sharedChannel).not.to.be(parentChannel);
      expect(childBuffer.getOwnChannel('theme')).to.be(sharedChannel);
      expect(rootBuffer.getOwnChannel('theme')).to.be(parentChannel);
    });

    it('should preload shared inputs for every declared channel kind through the channel runtime owner', async function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const sharedSchema = {
        theme: { type: 'var', defaultValue: null },
        log: { type: 'text', defaultValue: null },
        state: { type: 'data', defaultValue: null },
        logger: { type: 'sink', defaultValue: null },
        db: { type: 'sequence', defaultValue: null }
      };
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

  describe('Phase 3 - Method Metadata Compilation', function () {
    it('should attach transformed inheritance metadata for methods and shared declarations', function () {
      if (!transformer) {
        this.skip();
        return;
      }

      const template = scriptTranspiler.scriptToTemplate(
        'shared var theme = "dark"\nmethod build(user)\n  return user\nendmethod\nreturn null'
      );
      const ast = transformer.transform(
        parser.parse(template),
        [],
        'transformed-metadata.script',
        {
          asyncMode: true,
          scriptMode: true,
          idPool: {
            value: 0,
            next() {
              this.value += 1;
              return this.value;
            }
          }
        }
      );

      expect(ast.inheritanceMetadata).to.be.ok();
      expect(ast.inheritanceMetadata).to.be.an(nodes.InheritanceMetadata);
      expect(ast.inheritanceMetadata.methods.children[0]).to.be.an(nodes.MethodDefinition);
      expect(ast.inheritanceMetadata.methods.children.map((entry) => entry.name.value)).to.eql(['build']);
      expect(ast.inheritanceMetadata.sharedDeclarations.children.map((entry) => entry.name.value)).to.eql(['theme']);
      expect(ast.findAll(nodes.Block)).to.have.length(0);
      expect(ast.inheritanceMetadata.methods.children[0].body).to.be.ok();
      expect(ast.inheritanceMetadata.sharedDeclarations.children[0]).to.be.an(nodes.ChannelDeclaration);
    });

    it('should keep transformed method bodies reachable through root traversal helpers', function () {
      if (!transformer) {
        this.skip();
        return;
      }

      const template = scriptTranspiler.scriptToTemplate(
        'method build()\n  this.lookup()\nendmethod\nreturn null'
      );
      const ast = transformer.transform(
        parser.parse(template),
        [],
        'transformed-traversal.script',
        {
          asyncMode: true,
          scriptMode: true,
          idPool: {
            value: 0,
            next() {
              this.value += 1;
              return this.value;
            }
          }
        }
      );

      expect(ast.findAll(nodes.FunCall)).to.have.length(1);
    });

    it('should expose compiled methods metadata up front', function () {
      const script = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'method-metadata.script');
      script.compile();

      expect(script.methods).to.be.ok();
      expect(script.methods.build).to.be.ok();
      expect(typeof script.methods.build.fn).to.be('function');
      expect(script.methods.build.usedChannels).to.be.an(Array);
      expect(script.methods.build.mutatedChannels).to.be.an(Array);
      expect(script.methods.build.super).to.be(null);
      expect(script.methods.build.contract).to.be(undefined);
      expect(script.methods.build.ownerKey).to.be('method-metadata.script');
    });

    it('should record shared-root channel usage in compiled method metadata', function () {
      const script = new Script(
        'shared var theme = "dark"\nshared text trace\nmethod build()\n  trace(theme)\n  return theme\nendmethod\nreturn null',
        env,
        'method-shared-root-metadata.script'
      );
      script.compile();

      expect(script.methods.build.usedChannels).to.contain('theme');
      expect(script.methods.build.usedChannels).to.contain('trace');
      expect(script.methods.build.mutatedChannels).to.contain('trace');
      expect(script.methods.build.mutatedChannels).not.to.contain('theme');
    });

    it('should expose __constructor__ in the compiled methods map with internal metadata', function () {
      const script = new Script('shared text trace\ntrace("x")\nreturn null', env, 'constructor-metadata.script');
      script.compile();

      expect(script.methods).to.be.ok();
      expect(script.methods.__constructor__).to.be.ok();
      expect(typeof script.methods.__constructor__.fn).to.be('function');
      expect(script.methods.__constructor__.usedChannels).to.be.an(Array);
      expect(script.methods.__constructor__.mutatedChannels).to.be.an(Array);
      expect(script.methods.__constructor__.usedChannels).to.contain('trace');
      expect(script.methods.__constructor__.mutatedChannels).to.contain('trace');
      expect(script.methods.__constructor__.super).to.be(null);
      expect(script.methods.__constructor__.contract).to.be(undefined);
      expect(script.methods.__constructor__.ownerKey).to.be('constructor-metadata.script');
    });

    it('should reject __constructor__ as a user-declared method name', function () {
      expect(() => {
        new Script('method __constructor__()\n  return null\nendmethod\nreturn null', env, 'reserved-constructor.script')._compileSource();
      }).to.throwException(/Identifier '__constructor__' is reserved/);
    });

    it('should reject __constructor__ as a template block name', function () {
      expect(() => {
        new AsyncTemplate('{% block __constructor__ %}x{% endblock %}', env, 'reserved-constructor-block.njk')._compileSource();
      }).to.throwException(/Identifier '__constructor__' is reserved/);
    });

    it('should reject this as a template block name', function () {
      expect(() => {
        new AsyncTemplate('{% block this %}x{% endblock %}', env, 'reserved-this-block.njk')._compileSource();
      }).to.throwException(/Identifier 'this' is reserved/);
    });
  });

  describe('Phase 4 - Method and Shared Startup Registration', function () {
    it('should build pending inheritance entries through the runtime helper at compile time', function () {
      const originalCreatePendingInheritanceEntry = runtime.createPendingInheritanceEntry;
      let createCount = 0;

      runtime.createPendingInheritanceEntry = function() {
        createCount++;
        return {
          __fromRuntimeHelper: true,
          promise: Promise.resolve(null),
          resolve(value) {
            this.resolvedValue = value;
            return value;
          },
          reject(error) {
            this.rejectedError = error;
            return error;
          }
        };
      };

      try {
        const script = new Script(
          'extends "A.script" with theme\nmethod build()\n  super()\nendmethod\nreturn this.lookup()',
          env,
          'pending-helper.script'
        );
        script.compile();

        expect(createCount).to.be(3);
        expect(script.methods.lookup.__fromRuntimeHelper).to.be(true);
        expect(script.methods.build.super.__fromRuntimeHelper).to.be(true);
        expect(script.sharedSchema.theme.__fromRuntimeHelper).to.be(true);
      } finally {
        runtime.createPendingInheritanceEntry = originalCreatePendingInheritanceEntry;
      }
    });

    it('should create pending inherited method entries discovered from transformed method bodies', function () {
      const script = new Script(
        'method build()\n  this.lookup()\nendmethod\nreturn null',
        env,
        'pending-helper-method-body.script'
      );
      script.compile();

      expect(runtime.isPendingInheritanceEntry(script.methods.lookup)).to.be(true);
    });

    it('should alias the pending-entry helper from runtime instead of inlining a local factory', function () {
      const source = new Script(
        'extends "A.script" with theme\nmethod build()\n  super()\nendmethod\nreturn this.lookup()',
        env,
        'pending-helper-source.script'
      )._compileSource();

      expect(source).to.contain('const __createPendingInheritanceEntry = runtime.createPendingInheritanceEntry;');
      expect(source).to.not.contain('function __createPendingInheritanceEntry()');
    });

    it('should route inheritance-state creation through bootstrap without a pre-bootstrap guard in the root body', function () {
      const source = new Script(
        'shared var theme = "dark"\nreturn theme',
        env,
        'bootstrap-only.script'
      )._compileSource();

      expect(source).to.contain('inheritanceState = runtime.bootstrapInheritanceMetadata(inheritanceState, __compiledMethods, __compiledSharedSchema, ');
      expect(source).to.contain('__compiledMethods, __compiledSharedSchema, ');
      expect(source).to.contain(', context);');
      expect(source).to.not.contain('if (!inheritanceState) {');
      expect(source).to.not.contain('inheritanceState = runtime.createInheritanceState();');
    });

    it('should preserve the child method entry and wire parent super metadata when parent methods register later', function () {
      const childScript = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'C.script');
      const parentScript = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      expect(runtime.isPendingInheritanceEntry(childScript.methods.build.super)).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, null);
      runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, null);

      expect(inheritanceState.methods.build).to.be(childScript.methods.build);
      expect(inheritanceState.methods.build.super).to.be(parentScript.methods.build);
    });

    it('should wire multi-level super chains as each ancestor registers later', function () {
      const childScript = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'C.script');
      const parentScript = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'B.script');
      const grandparentScript = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();
      grandparentScript.compile();

      expect(runtime.isPendingInheritanceEntry(childScript.methods.build.super)).to.be(true);
      expect(runtime.isPendingInheritanceEntry(parentScript.methods.build.super)).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, null);
      runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, null);
      runtime.bootstrapInheritanceMetadata(inheritanceState, grandparentScript.methods, grandparentScript.sharedSchema, null);

      expect(inheritanceState.methods.build).to.be(childScript.methods.build);
      expect(inheritanceState.methods.build.super).to.be(parentScript.methods.build);
      expect(inheritanceState.methods.build.super.super).to.be(grandparentScript.methods.build);
      expect(inheritanceState.methods.getChain('build')).to.eql([
        childScript.methods.build,
        parentScript.methods.build,
        grandparentScript.methods.build
      ]);
    });

    it('should create and reject pending inherited method entries at the topmost root', async function () {
      const script = new Script('return this.build("Ada")', env, 'missing-method.script');
      script.compile();

      expect(runtime.isPendingInheritanceEntry(script.methods.build)).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, script.methods, script.sharedSchema, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'missing-method.script' });

      try {
        await inheritanceState.methods.build.promise;
        expect().fail('Expected unresolved inherited method to reject');
      } catch (error) {
        expect(String(error)).to.contain("inherited method 'build' was not defined by any ancestor");
      }
    });

    it('should reject unresolved super metadata at the topmost root', async function () {
      const script = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'missing-super.script');
      script.compile();

      expect(runtime.isPendingInheritanceEntry(script.methods.build.super)).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, script.methods, script.sharedSchema, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'missing-super.script' });

      try {
        await script.methods.build.super.promise;
        expect().fail('Expected unresolved super entry to reject');
      } catch (error) {
        expect(String(error)).to.contain("super() for method 'build' was not defined by any ancestor");
      }
    });

    it('should create pending shared entries for extends inputs and resolve them when a parent declares the channel', function () {
      const childScript = new Script('extends "A.script" with theme\nreturn null', env, 'C.script');
      const parentScript = new Script('shared var theme = "light"\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      expect(runtime.isPendingInheritanceEntry(childScript.sharedSchema.theme)).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, null);
      expect(inheritanceState.sharedSchema.theme).to.be(childScript.sharedSchema.theme);

      runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, null);
      expect(inheritanceState.sharedSchema.theme).to.be(parentScript.sharedSchema.theme);
    });

    it('should reject conflicting shared channel types across the inheritance chain', function () {
      const childScript = new Script('shared var theme = "dark"\nreturn null', env, 'C.script');
      const parentScript = new Script('shared text theme = "light"\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, null);

      expect(() => {
        runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, { path: 'A.script' });
      }).to.throwException(/shared channel 'theme' was declared as 'var' and 'text'/);
    });

    it('should reject unresolved shared entries at the topmost root', async function () {
      const script = new Script('extends "A.script" with theme\nreturn null', env, 'missing-shared.script');
      script.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, script.methods, script.sharedSchema, null);
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'missing-shared.script' });

      try {
        await inheritanceState.sharedSchema.theme.promise;
        expect().fail('Expected unresolved shared channel to reject');
      } catch (error) {
        expect(String(error)).to.contain("shared channel 'theme' was not defined by any ancestor");
      }
    });

    it('should finalize a missing pending __constructor__ entry to the allowed empty constructor', async function () {
      const inheritanceState = runtime.createInheritanceState();
      const pendingConstructor = runtime.createPendingInheritanceEntry();
      inheritanceState.methods.__constructor__ = pendingConstructor;

      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'root.script' });

      expect(runtime.isPendingInheritanceEntry(inheritanceState.methods.__constructor__)).to.be(false);
      expect(typeof inheritanceState.methods.__constructor__.fn).to.be('function');
      expect(inheritanceState.methods.__constructor__.usedChannels).to.eql([]);
      expect(inheritanceState.methods.__constructor__.mutatedChannels).to.eql([]);
      expect(inheritanceState.methods.__constructor__.ownerKey).to.be('__synthetic__');
      expect(await pendingConstructor.promise).to.be(inheritanceState.methods.__constructor__);
      expect(inheritanceState.methods.__constructor__.fn()).to.be(null);
    });

    it('should register shared schema before constructor work begins', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      const seen = [];

      const originalBootstrapInheritanceMetadata = runtime.bootstrapInheritanceMetadata;
      runtime.bootstrapInheritanceMetadata = function(inheritanceStateArg, methodsArg, sharedSchemaArg) {
        seen.push(`schema:${Object.keys(sharedSchemaArg || {}).join(',')}`);
        return originalBootstrapInheritanceMetadata.apply(this, arguments);
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
        runtime.bootstrapInheritanceMetadata = originalBootstrapInheritanceMetadata;
      }
    });

    it('should preload shared inputs from extends with before ancestor constructor code runs', async function () {
      const source = new Script(
        'extends "A.script" with theme\nreturn "done"',
        env,
        'child-preload.script'
      )._compileSource();

      const preloadIndex = source.indexOf('runtime.preloadSharedInputs(');
      const compositionIndex = source.indexOf('context.setExtendsComposition(');

      expect(preloadIndex).to.be.greaterThan(-1);
      expect(source).to.contain('runtime.validateInheritanceSharedInputs(');
      expect(source).to.contain('runtime.getInheritanceSharedBuffer(currentBuffer, inheritanceState)');
      expect(compositionIndex).to.be.greaterThan(preloadIndex);
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

    it('should share one structural-state object across context forks', function () {
      if (!Context) {
        this.skip();
        return;
      }

      const ctx = new Context({ theme: 'dark' }, {}, env, 'root.script', true);
      ctx.blocks.demo = ['block'];
      ctx.exportResolveFunctions.value = () => 'x';
      ctx.exportChannels.value = { channelName: 'value', buffer: { id: 1 } };
      ctx.inheritanceLocalCapturesByTemplate.root = { theme: 'dark' };

      const forkedPath = ctx.forkForPath('child.script');
      const forkedComposition = ctx.forkForComposition('parent.script', { local: true }, { site: 'Example' }, { extern: true });

      expect(forkedPath._sharedStructuralState).to.be(ctx._sharedStructuralState);
      expect(forkedComposition._sharedStructuralState).to.be(ctx._sharedStructuralState);
      expect(forkedPath.blocks).to.be(ctx.blocks);
      expect(forkedComposition.exportResolveFunctions).to.be(ctx.exportResolveFunctions);
      expect(forkedComposition.inheritanceLocalCapturesByTemplate).to.be(ctx.inheritanceLocalCapturesByTemplate);

      forkedPath.blocks.later = ['new-block'];
      forkedComposition.inheritanceLocalCapturesByTemplate.parent = { user: 'Ada' };

      expect(ctx.blocks.later).to.eql(['new-block']);
      expect(ctx.inheritanceLocalCapturesByTemplate.parent).to.eql({ user: 'Ada' });
    });
  });

  describe.skip('Phase 7 - Startup-Resolved Inherited Calls', function () {
    it('should make parent methods reachable after the extends load boundary resolves', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'method build(name)\n  return "parent:" + name\nendmethod');
      loader.addTemplate('C.script', 'extends "A.script"\nreturn this.build("Ada")');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('parent:Ada');
    });
  });

  describe.skip('Phase 6 - Helper and Resolution Lifecycle', function () {
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

  describe.skip('Phase 10 - Dynamic Extends Startup Plumbing', function () {
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
            contract: { argNames: [], withContext: false },
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
            contract: { argNames: [], withContext: false },
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

  describe.skip('Phase 10 - Dynamic Extends Resolution Lifecycle', function () {
    it('should keep inheritance-resolution lifecycle state on InheritanceState', async function () {
      const inheritanceState = runtime.createInheritanceState();

      expect(inheritanceState.methods).to.be.an(inheritanceMethodRegistry);
      expect(inheritanceState.sharedSchema).to.be.an(inheritanceSharedRegistry);
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

  describe.skip('Phase 10 - Composition Payload Shape', function () {
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
