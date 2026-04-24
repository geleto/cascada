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
let StringLoader;
let inheritanceStateModule;
let inheritanceCallModule;

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
    inheritanceStateModule = require('../../src/runtime/inheritance-state');
  } catch (err) {
    void err;
  }
  try {
    inheritanceCallModule = require('../../src/runtime/inheritance-call');
  } catch (err) {
    void err;
    inheritanceCallModule = null;
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
  inheritanceStateModule = null;
  inheritanceCallModule = null;
  StringLoader = window.util.StringLoader;
}

describe('Extends Foundation', function () {
  let env;

  function getMethodChain(methods, name) {
    const chain = [];
    let entry = methods && methods[name];
    while (entry) {
      chain.push(entry);
      entry = entry.super;
    }
    return chain;
  }

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

      it('should preserve source locations on pre-extends validation failures', function () {
        const ast = parser.parse(
          scriptTranspiler.scriptToTemplate('var theme = "dark"\nextends "A.script"\nreturn null')
        );
        const offendingNode = ast.children[0];

        try {
          new Script(
            'var theme = "dark"\nextends "A.script"\nreturn null',
            env,
            'var-before-extends-location.script'
          )._compileSource();
          expect().fail('Expected pre-extends validation to fail');
        } catch (error) {
          expect(error.lineno).to.be(offendingNode.lineno);
          expect(error.colno).to.be(offendingNode.colno);
          expect(String(error)).to.contain('only shared declarations are allowed before extends');
        }
      });
    });
  });

  describe('Phase 3 - Shared Channel Metadata and Lowering', function () {
    it('should lower shared declarations through the normal script compile path', function () {
      const source = new Script('shared var theme = "dark"\nreturn theme', env, 'shared-lowering.casc')._compileSource();

      expect(source).to.contain('runtime.declareInheritanceSharedChannel(runtime.getInheritanceSharedBuffer(output, inheritanceState), "theme", "var", context, undefined);');
      expect(source).to.contain('initializeIfNotSet: true');
    });

    it('should lower declared shared bare reads through the declared-name path', function () {
      const source = new Script('shared var theme = "dark"\nreturn theme', env, 'shared-declared-read.casc')._compileSource();

      expect(source).to.contain('runtime.observeInheritanceSharedChannel(');
      expect(source).to.not.contain('runtime.contextOrScriptChannelLookup(context, "theme"');
    });

    it('should keep undeclared script bare reads on the ambient lookup path', function () {
      const source = new Script('return theme', env, 'ambient-read.casc')._compileSource();

      expect(source).to.contain('runtime.contextOrScriptChannelLookup(context, "theme"');
      expect(source).to.not.contain('runtime.observeInheritanceSharedChannel(');
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
      expect(script.sharedSchema.theme).to.be('var');
      expect(script.sharedSchema.log).to.be('text');
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

    it('should let script methods read local shared vars as ordinary declared names', async function () {
      const result = await env.renderScriptString(
        'shared var theme = "dark"\nmethod readTheme()\n  return theme\nendmethod\nreturn this.readTheme()',
        {}
      );

      expect(result).to.be('dark');
    });

    it('should let an earlier child-buffer shared default win over a later parent-buffer default', async function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const childBuffer = runtime.createCommandBuffer(null, rootBuffer, ['theme'], rootBuffer);
      runtime.declareInheritanceSharedChannel(childBuffer, 'theme', 'var', null, undefined);

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

      const result = await childBuffer.getOwnChannel('theme').finalSnapshot();
      expect(result).to.be('dark');
    });

    it('should keep shared channel ownership on the child/shared buffer rather than the parent buffer', function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const childBuffer = runtime.createCommandBuffer(null, rootBuffer, ['theme'], rootBuffer);
      const sharedChannel = runtime.declareInheritanceSharedChannel(childBuffer, 'theme', 'var', null, undefined);

      expect(sharedChannel._buffer).to.be(childBuffer);
      expect(rootBuffer.getOwnChannel('theme')).to.be(undefined);
    });

    it('should link newly registered shared lanes from the shared root to the active composition buffer', function () {
      const sharedRootBuffer = runtime.createCommandBuffer(null);
      const compositionBuffer = runtime.createCommandBuffer(null, sharedRootBuffer);
      const state = runtime.createInheritanceState();
      state.sharedRootBuffer = sharedRootBuffer;

      runtime.bootstrapInheritanceMetadata(
        state,
        Object.create(null),
        { theme: 'var', log: 'text' },
        {},
        compositionBuffer,
        null
      );

      expect(sharedRootBuffer.hasLinkedBuffer(compositionBuffer, 'theme')).to.be(true);
      expect(sharedRootBuffer.hasLinkedBuffer(compositionBuffer, 'log')).to.be(true);
    });

    it('should keep shared declarations owned by the shared buffer instead of reusing an unrelated parent channel', function () {
      const rootBuffer = runtime.createCommandBuffer(null);
      const childBuffer = runtime.createCommandBuffer(null, rootBuffer, ['theme'], rootBuffer);
      const parentChannel = runtime.declareBufferChannel(rootBuffer, 'theme', 'var', null, null);
      const sharedChannel = runtime.declareInheritanceSharedChannel(childBuffer, 'theme', 'var', null, undefined);

      expect(sharedChannel).not.to.be(parentChannel);
      expect(childBuffer.getOwnChannel('theme')).to.be(sharedChannel);
      expect(rootBuffer.getOwnChannel('theme')).to.be(parentChannel);
    });

    it('should remove legacy async extends registration helpers from Context', function () {
      if (!Context) {
        this.skip();
        return;
      }

      expect(Context.prototype.beginAsyncExtendsBlockRegistration).to.be(undefined);
      expect(Context.prototype.getAsyncBlock).to.be(undefined);
      expect(Context.prototype.finishAsyncExtendsBlockRegistration).to.be(undefined);
    });

    it('should remove legacy template payload helpers from Context', function () {
      if (!Context) {
        this.skip();
        return;
      }

      expect(Context.prototype.getAsyncSuper).to.be(undefined);
      expect(Context.prototype.setExtendsComposition).to.be(undefined);
      expect(Context.prototype.getExtendsComposition).to.be(undefined);
      expect(Context.prototype.setTemplateLocalCaptures).to.be(undefined);
      expect(Context.prototype.getTemplateLocalCaptures).to.be(undefined);
      expect(Context.prototype.createInheritancePayload).to.be(undefined);
      expect(Context.prototype.createSuperInheritancePayload).to.be(undefined);
      expect(Context.prototype.prepareInheritancePayloadForBlock).to.be(undefined);
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
      expect(script.methods.build.ownUsedChannels).to.be.an(Array);
      expect(script.methods.build.ownMutatedChannels).to.be.an(Array);
      expect(script.methods.build.super).to.be(false);
      expect(script.methods.build.superOrigin).to.be(null);
      expect(script.methods.build.signature).to.eql({ argNames: ['user'], withContext: false });
      expect(script.methods.build.ownerKey).to.be('method-metadata.script');
    });

    it('should record shared-root channel usage in compiled method metadata', function () {
      const script = new Script(
        'shared var theme = "dark"\nshared text trace\nmethod build()\n  trace(theme)\n  return theme\nendmethod\nreturn null',
        env,
        'method-shared-root-metadata.script'
      );
      script.compile();

      expect(script.methods.build.ownUsedChannels).to.contain('theme');
      expect(script.methods.build.ownUsedChannels).to.contain('trace');
      expect(script.methods.build.ownMutatedChannels).to.contain('trace');
      expect(script.methods.build.ownMutatedChannels).not.to.contain('theme');
    });

    it('should expose __constructor__ in the compiled methods map with internal metadata', function () {
      const script = new Script('shared text trace\nextends "A.script"\ntrace("x")\nreturn null', env, 'constructor-metadata.script');
      script.compile();

      expect(script.methods).to.be.ok();
      expect(script.methods.__constructor__).to.be.ok();
      expect(typeof script.methods.__constructor__.fn).to.be('function');
      expect(script.methods.__constructor__.ownUsedChannels).to.be.an(Array);
      expect(script.methods.__constructor__.ownMutatedChannels).to.be.an(Array);
      expect(script.methods.__constructor__.ownUsedChannels).to.contain('trace');
      expect(script.methods.__constructor__.ownMutatedChannels).to.contain('trace');
      expect(script.methods.__constructor__.super).to.be(false);
      expect(script.methods.__constructor__.superOrigin).to.be(null);
      expect(script.methods.__constructor__.signature).to.eql({ argNames: [], withContext: false });
      expect(script.methods.__constructor__.ownerKey).to.be('constructor-metadata.script');
    });

    it('should omit __constructor__ from the compiled methods map when there is no constructor body', function () {
      const script = new Script('extends "A.script"', env, 'no-constructor-metadata.script');
      script.compile();

      expect(script.methods).to.be.ok();
      expect(Object.prototype.hasOwnProperty.call(script.methods, '__constructor__')).to.be(false);
    });

    it('should keep the shared script body helper out of the public compiled surface', function () {
      const script = new Script('var label = "ok"\nreturn label', env, 'plain-body.script');
      script.compile();

      expect(script).not.to.have.property('scriptBodyRenderFunc');
      expect(script.blocks).not.to.have.property('__scriptBody__');
      expect(script.blocks).not.to.have.property('__constructor__');
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
    it('should record inherited method references as invoked-method metadata without placeholders', function () {
      const script = new Script(
        'method build()\n  this.lookup()\nendmethod\nreturn null',
        env,
        'invoked-metadata-method-body.script'
      );
      script.compile();

      expect(script.methods.lookup).to.be(undefined);
      expect(script.invokedMethods.lookup.name).to.be('lookup');
      expect(script.methods.build.invokedMethods.lookup.name).to.be('lookup');
    });

    it('should expose invoked-method metadata without local placeholder methods', function () {
      const script = new Script(
        'extends "A.script" with theme\nmethod build()\n  super()\nendmethod\nreturn this.lookup()',
        env,
        'invoked-metadata-source.script'
      );
      script.compile();

      expect(script.methods.lookup).to.be(undefined);
      expect(script.invokedMethods.lookup.name).to.be('lookup');
    });

    it('should create inheritance state in the root body before bootstrapping metadata', function () {
      const source = new Script(
        'shared var theme = "dark"\nreturn theme',
        env,
        'bootstrap-only.script'
      )._compileSource();

      expect(source).to.contain('if (!inheritanceState) {');
      expect(source).to.contain('inheritanceState = runtime.createInheritanceState();');
      expect(source).to.contain('inheritanceState = runtime.bootstrapInheritanceMetadata(inheritanceState, __compiledMethods, __compiledSharedSchema, ');
      expect(source).to.contain('__compiledMethods, __compiledSharedSchema, ');
      expect(source).to.contain(', context);');
    });

    it('should fail clearly if bootstrapInheritanceMetadata is called without a state object', function () {
      expect(function () {
        runtime.bootstrapInheritanceMetadata(null, {}, {}, null);
      }).to.throwException(/requires an existing inheritance state/);
    });

    it('should preserve the child method entry and wire parent super metadata when parent methods register later', function () {
      const childScript = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'C.script');
      const parentScript = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      expect(childScript.methods.build.super).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, childScript.invokedMethods);
      runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, parentScript.invokedMethods);

      expect(inheritanceState.methods.build).not.to.be(childScript.methods.build);
      expect(inheritanceState.methods.build.fn).to.be(childScript.methods.build.fn);
      expect(inheritanceState.methods.build.ownerKey).to.be('C.script');
      expect(inheritanceState.methods.build.super).not.to.be(childScript.methods.build.super);
      expect(inheritanceState.methods.build.super.fn).to.be(parentScript.methods.build.fn);
      expect(inheritanceState.methods.build.super.ownerKey).to.be('A.script');
    });

    it('should wire multi-level super chains as each ancestor registers later', function () {
      const childScript = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'C.script');
      const parentScript = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'B.script');
      const grandparentScript = new Script('method build(user)\n  user\nendmethod\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();
      grandparentScript.compile();

      expect(childScript.methods.build.super).to.be(true);
      expect(parentScript.methods.build.super).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, childScript.invokedMethods);
      runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, parentScript.invokedMethods);
      runtime.bootstrapInheritanceMetadata(inheritanceState, grandparentScript.methods, grandparentScript.sharedSchema, grandparentScript.invokedMethods);

      expect(inheritanceState.methods.build).not.to.be(childScript.methods.build);
      expect(inheritanceState.methods.build.fn).to.be(childScript.methods.build.fn);
      expect(inheritanceState.methods.build.super.fn).to.be(parentScript.methods.build.fn);
      expect(inheritanceState.methods.build.super.super.fn).to.be(grandparentScript.methods.build.fn);
      expect(getMethodChain(inheritanceState.methods, 'build').map((entry) => entry.ownerKey)).to.eql([
        'C.script',
        'B.script',
        'A.script'
      ]);
    });

    it('should reject missing invoked-method metadata at the topmost root', function () {
      const script = new Script('return this.build("Ada")', env, 'missing-method.script');
      script.compile();

      expect(script.methods.build).to.be(undefined);
      expect(script.invokedMethods.build.name).to.be('build');

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        script.methods,
        script.sharedSchema,
        script.invokedMethods,
        null,
        { path: 'missing-method.script' }
      );

      expect(() => {
        runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'missing-method.script' });
      }).to.throwException(/Inherited method 'build' was not found/);
    });

    it('should resolve file-level and per-callable invoked method metadata during finalization', function () {
      const childScript = new Script(
        'method build(name)\n  this.render(name)\n  this.decorate(name)\nendmethod\nmethod decorate(name)\n  return "C:" + name\nendmethod\nreturn this.build("Ada")',
        env,
        'C.script'
      );
      const parentScript = new Script('method render(name)\n  return "A:" + name\nendmethod\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      expect(childScript.invokedMethods.render.name).to.be('render');
      expect(childScript.invokedMethods.decorate.name).to.be('decorate');
      expect(childScript.invokedMethods.build.name).to.be('build');
      expect(childScript.methods.build.invokedMethods.render.name).to.be('render');
      expect(childScript.methods.build.invokedMethods.decorate.name).to.be('decorate');
      expect(childScript.methods.build.invokedMethods.render.origin.path).to.be('C.script');
      expect(Object.keys(childScript.methods.decorate.invokedMethods)).to.eql([]);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        childScript.methods,
        childScript.sharedSchema,
        childScript.invokedMethods,
        null,
        { path: 'C.script' }
      );
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        parentScript.methods,
        parentScript.sharedSchema,
        parentScript.invokedMethods,
        null,
        { path: 'A.script' }
      );
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'C.script' });

      expect(Object.keys(inheritanceState.invokedMethods)).to.eql([]);

      const buildData = inheritanceCallModule.getMethodData(inheritanceState, 'build');
      expect(buildData.mergedUsedChannels).to.be.an(Array);
      expect(buildData.mergedMutatedChannels).to.be.an(Array);
      expect(buildData.invokedMethods).to.be(undefined);
      expect(inheritanceCallModule.getMethodData(inheritanceState, 'decorate').invokedMethods).to.be(undefined);
    });

    it('should fail finalization when invoked method metadata cannot resolve a target', function () {
      const script = new Script('method build()\n  this.missing()\nendmethod\nreturn null', env, 'missing-invoked.script');
      script.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        script.methods,
        script.sharedSchema,
        script.invokedMethods,
        null,
        { path: 'missing-invoked.script' }
      );

      try {
        runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'missing-invoked.script' });
        expect().fail('Expected missing invoked-method metadata to fail');
      } catch (error) {
        expect(error.path).to.be('missing-invoked.script');
        expect(error.lineno).to.be(2);
        expect(String(error)).to.contain("Inherited method 'missing' was not found");
        expect(String(error)).to.contain("doing 'FunCall'");
      }
    });

    it('should resolve cyclic invoked method metadata without recursive expansion', function () {
      const script = new Script(
        'shared text alphaTrace\nshared text betaTrace\nmethod alpha()\n  alphaTrace("a")\n  this.beta()\nendmethod\nmethod beta()\n  betaTrace("b")\n  this.alpha()\nendmethod\nreturn this.alpha()',
        env,
        'cyclic-invoked.script'
      );
      script.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        script.methods,
        script.sharedSchema,
        script.invokedMethods,
        null,
        { path: 'cyclic-invoked.script' }
      );
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'cyclic-invoked.script' });

      const alphaData = inheritanceCallModule.getMethodData(inheritanceState, 'alpha');
      const betaData = inheritanceCallModule.getMethodData(inheritanceState, 'beta');
      expect(Object.keys(inheritanceState.invokedMethods)).to.eql([]);
      expect(alphaData.invokedMethods).to.be(undefined);
      expect(betaData.invokedMethods).to.be(undefined);
      expect(alphaData.mergedMutatedChannels).to.contain('alphaTrace');
      expect(alphaData.mergedMutatedChannels).to.contain('betaTrace');
      expect(betaData.mergedMutatedChannels).to.contain('alphaTrace');
      expect(betaData.mergedMutatedChannels).to.contain('betaTrace');
    });

    it('should include invoked method footprints in caller-visible merged channels', function () {
      const script = new Script(
        'shared var theme = "light"\nshared text trace\nmethod applyTheme()\n  theme = "dark"\n  trace("apply|")\nendmethod\nmethod readTheme()\n  trace(theme)\n  return theme\nendmethod\nmethod outer()\n  this.applyTheme()\n  return this.readTheme()\nendmethod\nreturn null',
        env,
        'invoked-footprint.script'
      );
      script.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        script.methods,
        script.sharedSchema,
        script.invokedMethods,
        null,
        { path: 'invoked-footprint.script' }
      );
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'invoked-footprint.script' });

      const outerData = inheritanceCallModule.getMethodData(inheritanceState, 'outer');
      expect(outerData.mergedUsedChannels).to.contain('theme');
      expect(outerData.mergedMutatedChannels).to.contain('theme');
      expect(outerData.mergedMutatedChannels).to.contain('trace');
    });

    it('should include invoked method footprints from inherited super methods', function () {
      const childScript = new Script(
        'shared text trace\nmethod build()\n  return super()\nendmethod\nreturn null',
        env,
        'C.script'
      );
      const parentScript = new Script(
        'shared text trace\nmethod decorate()\n  trace("decorated|")\nendmethod\nmethod build()\n  this.decorate()\n  return "done"\nendmethod\nreturn null',
        env,
        'A.script'
      );
      childScript.compile();
      parentScript.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        childScript.methods,
        childScript.sharedSchema,
        childScript.invokedMethods,
        null,
        { path: 'C.script' }
      );
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        parentScript.methods,
        parentScript.sharedSchema,
        parentScript.invokedMethods,
        null,
        { path: 'A.script' }
      );
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'C.script' });

      const buildData = inheritanceCallModule.getMethodData(inheritanceState, 'build');
      expect(buildData.ownerKey).to.be('C.script');
      expect(buildData.super.ownerKey).to.be('A.script');
      expect(buildData.mergedMutatedChannels).to.contain('trace');
      expect(buildData.super.mergedMutatedChannels).to.contain('trace');
    });

    it('should aggregate structural metadata errors discovered during finalization', function () {
      const script = new Script(
        'method needsSuper()\n  super()\nendmethod\nmethod needsMissing()\n  this.missing()\nendmethod\nreturn this.needsMissing()',
        env,
        'metadata-errors.script'
      );
      script.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        script.methods,
        script.sharedSchema,
        script.invokedMethods,
        null,
        { path: 'metadata-errors.script' }
      );

      try {
        runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'metadata-errors.script' });
        expect().fail('Expected finalization to aggregate structural metadata errors');
      } catch (error) {
        expect(error.name).to.be('RuntimeFatalError');
        expect(error.errors).to.be.an(Array);
        expect(error.errors).to.have.length(2);
        expect(error.errors[0].path).to.be('metadata-errors.script');
        expect(error.errors[0].lineno).to.be(2);
        expect(String(error)).to.contain("super() for method 'needsSuper' was not found");
        expect(String(error)).to.contain("Inherited method 'missing' was not found");
      }
    });

    it('should attribute missing super metadata to the method owner path', function () {
      const childScript = new Script('return null', env, 'C.script');
      const parentScript = new Script(
        'method needsSuper()\n  super()\nendmethod\nreturn null',
        env,
        'A.script'
      );
      childScript.compile();
      parentScript.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        childScript.methods,
        childScript.sharedSchema,
        childScript.invokedMethods,
        null,
        { path: 'C.script' }
      );
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        parentScript.methods,
        parentScript.sharedSchema,
        parentScript.invokedMethods,
        null,
        { path: 'A.script' }
      );

      try {
        runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'C.script' });
        expect().fail('Expected missing super metadata to fail');
      } catch (error) {
        expect(error.path).to.be('A.script');
        expect(error.lineno).to.be(2);
        expect(String(error)).to.contain("doing 'Super'");
        expect(String(error)).to.contain("super() for method 'needsSuper' was not found");
      }
    });

    it('should reject invalid invoked method metadata during footprint finalization', function () {
      const inheritanceState = runtime.createInheritanceState();
      inheritanceState.methods.alpha = {
        _resolvedMethodData: {
          fn() {
            return null;
          },
          ownerKey: 'invalid-invoked-footprint.script',
          signature: { argNames: [], withContext: false },
          ownUsedChannels: [],
          ownMutatedChannels: [],
          mergedUsedChannels: [],
          mergedMutatedChannels: [],
          super: null,
          invokedMethods: { beta: 'beta' }
        }
      };

      expect(() => {
        runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'invalid-invoked-footprint.script' });
      }).to.throwException(/Invoked method 'beta'.*has invalid metadata/);
      try {
        runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'invalid-invoked-footprint.script' });
        expect().fail('Expected invalid invoked metadata to fail');
      } catch (error) {
        expect(error.code).to.be('ERR_INVALID_INVOKED_METHOD_METADATA');
      }
    });

    it('should keep per-callable invoked method metadata limited to direct calls', function () {
      const script = new Script(
        'method build()\n  macro inner()\n    this.hidden()\n  endmacro\n  this.visible()\nendmethod\nmethod visible()\n  return "v"\nendmethod\nreturn null',
        env,
        'direct-invoked.script'
      );
      script.compile();

      expect(script.invokedMethods.hidden.name).to.be('hidden');
      expect(script.invokedMethods.visible.name).to.be('visible');
      expect(script.methods.build.invokedMethods.visible.name).to.be('visible');
      expect(script.methods.build.invokedMethods.hidden).to.be(undefined);
    });

    it('should reject unresolved super metadata at the topmost root', function () {
      const script = new Script('method build(user)\n  super(user)\nendmethod\nreturn null', env, 'missing-super.script');
      script.compile();

      expect(script.methods.build.super).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, script.methods, script.sharedSchema, script.invokedMethods);

      expect(() => {
        runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'missing-super.script' });
      }).to.throwException(/super\(\) for method 'build' was not found/);
    });

    it('should resolve unresolved constructor super metadata to a root-only empty constructor at the topmost root', function () {
      const script = new Script(
        'shared text trace\nextends "A.script"\nsuper()\ntrace("done")\nreturn null',
        env,
        'missing-constructor-super.script'
      );
      script.compile();

      expect(script.methods.__constructor__).to.be.ok();
      expect(script.methods.__constructor__.super).to.be(true);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, script.methods, script.sharedSchema, script.invokedMethods);
      runtime.finalizeInheritanceMetadata(inheritanceState, { path: 'missing-constructor-super.script' });

      const resolvedSuper = inheritanceCallModule.getMethodData(inheritanceState, '__constructor__').super;
      expect(resolvedSuper).to.be.ok();
      expect(resolvedSuper.signature).to.eql({ argNames: [], withContext: false });
      expect(resolvedSuper.ownerKey).to.be('missing-constructor-super.script');
    });

    it('should register only real shared channels from parents, not extends input placeholders', function () {
      const childScript = new Script('extends "A.script" with theme\nreturn null', env, 'C.script');
      const parentScript = new Script('shared var theme = "light"\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      expect(childScript.sharedSchema.theme).to.be(undefined);

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, childScript.invokedMethods);
      expect(inheritanceState.sharedSchema.theme).to.be(undefined);

      runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, parentScript.invokedMethods);
      expect(inheritanceState.sharedSchema.theme).to.be.ok();
      expect(inheritanceState.sharedSchema.theme).to.be('var');
    });

    it('should reject conflicting shared channel types across the inheritance chain', function () {
      const childScript = new Script('shared var theme = "dark"\nreturn null', env, 'C.script');
      const parentScript = new Script('shared text theme = "light"\nreturn null', env, 'A.script');
      childScript.compile();
      parentScript.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, childScript.methods, childScript.sharedSchema, childScript.invokedMethods);

      try {
        runtime.bootstrapInheritanceMetadata(inheritanceState, parentScript.methods, parentScript.sharedSchema, parentScript.invokedMethods, null, { path: 'A.script' });
        expect().fail('Expected conflicting shared channel type to throw');
      } catch (error) {
        expect(error.path).to.be('A.script');
        expect(String(error)).to.contain("shared channel 'theme' was declared as 'var' and 'text'");
      }
    });

    it('should fail shared helper lookups for extends inputs that never become shared channels', function () {
      const script = new Script('extends "A.script" with theme\nreturn null', env, 'missing-shared.script');
      script.compile();

      const inheritanceState = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(inheritanceState, script.methods, script.sharedSchema, script.invokedMethods);

      expect(() => {
        inheritanceCallModule.resolveInheritanceSharedChannel(inheritanceState, 'theme', {
          path: 'missing-shared.script'
        });
      }).to.throwException(/Shared channel 'theme' was not found/);
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

    it('should compile script constructor metadata to a dedicated function target', function () {
      const script = new Script('shared text trace\nextends "A.script"\ntrace("x")\nreturn trace.snapshot()', env, 'constructor-metadata.script');
      script.compile();

      expect(script.methods.__constructor__).to.be.ok();
      expect(script.methods.__constructor__.fn).to.be.a('function');
      expect(script.methods.__constructor__.fn).not.to.be(script.rootRenderFunc);
    });

    it('should keep method-local declarations from renaming root declarations', function () {
      const source = new Script(
        'method build()\n  var x = 2\n  return x\nendmethod\nvar x = 1\nreturn x',
        env,
        'method-scope-root-name.script'
      )._compileSource();

      expect(source).to.contain('runtime.declareBufferChannel(output, "x", "var", context, null);');
      expect(source).to.contain('context.addDeferredExport("x", "x", output);');
      expect(source).to.not.contain('context.addDeferredExport("x#');
    });

    it('should not emit template text-channel context wiring inside script methods', function () {
      const source = new Script(
        'method build(name)\n  return name\nendmethod\nreturn null',
        env,
        'script-method-context-wiring.script'
      )._compileSource();

      expect(source).to.contain('function b_build(');
      expect(source).to.not.contain('output_textChannelVar._context = context;');
    });

    it('should allow plain extends composition payload keys that are not shared by the immediate parent', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'return theme');
      loader.addTemplate('C.script', 'extends "A.script" with theme\nreturn "done"');

      const result = await env.renderScript('C.script', { theme: 'dark' });
      expect(result).to.be('done');
    });

    it('should share deferred-export and sync-block state across context forks', function () {
      if (!Context) {
        this.skip();
        return;
      }

      const ctx = new Context({ theme: 'dark' }, {}, env, 'root.script', true);
      ctx.blocks.demo = ['block'];
      ctx.exportResolveFunctions.value = () => 'x';
      ctx.exportChannels.value = { channelName: 'value', buffer: { id: 1 } };

      const forkedPath = ctx.forkForPath('child.script');
      const forkedComposition = ctx.forkForComposition('parent.script', { local: true }, { site: 'Example' }, { extern: true });

      expect(forkedPath._sharedStructuralState).to.be(ctx._sharedStructuralState);
      expect(forkedComposition._sharedStructuralState).to.be(ctx._sharedStructuralState);
      expect(forkedPath.blocks).to.be(ctx.blocks);
      expect(forkedComposition.exportResolveFunctions).to.be(ctx.exportResolveFunctions);
      expect(forkedComposition.exportChannels).to.be(ctx.exportChannels);

      forkedPath.blocks.later = ['new-block'];
      forkedComposition.exportChannels.other = { channelName: 'other', buffer: { id: 2 } };

      expect(ctx.blocks.later).to.eql(['new-block']);
      expect(ctx.exportChannels.other.channelName).to.be('other');
    });
  });

  describe('Phase 7 - Startup-Resolved Inherited Calls', function () {
    it('should make parent methods reachable after the extends load boundary resolves', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);

      loader.addTemplate('A.script', 'method build(name)\n  return "parent:" + name\nendmethod');
      loader.addTemplate('C.script', 'extends "A.script"\nreturn this.build("Ada")');

      const result = await env.renderScript('C.script', {});
      expect(result).to.be('parent:Ada');
    });
  });

  describe('Step 4 - Metadata Readiness Barrier', function () {
    it('should start the root constructor after metadata is ready without waiting for setup startup to finish', async function () {
      env = new AsyncEnvironment();
      const context = new Context({}, {}, env, 'Main.script', true, {}, {});
      const output = runtime.createCommandBuffer(context);
      const inheritanceState = runtime.createInheritanceState();
      const events = [];
      let finishSetup;
      const setupPromise = new Promise((resolve) => {
        finishSetup = () => {
          events.push('setup-finished');
          resolve('setup');
        };
      });
      const compiledMethods = {
        __constructor__: {
          fn() {
            events.push('constructor');
            return null;
          },
          signature: { argNames: [], withContext: false },
          ownerKey: 'Main.script',
          ownUsedChannels: [],
          ownMutatedChannels: [],
          super: false,
          invokedMethods: {}
        }
      };

      runtime.bootstrapInheritanceMetadata(inheritanceState, compiledMethods, {}, {}, output, context);
      const startupPromise = runtime.runCompiledRootStartup(
        () => setupPromise,
        compiledMethods,
        inheritanceState,
        env,
        context,
        runtime,
        () => {},
        output,
        null,
        null
      );

      await Promise.resolve();
      expect(events).to.eql([]);

      runtime.finalizeInheritanceMetadata(inheritanceState, context);
      await Promise.resolve();
      expect(events).to.eql(['constructor']);

      finishSetup();
      await startupPromise;
      expect(events).to.eql(['constructor', 'setup-finished']);
    });

    it('should not invoke inherited methods before metadata finalization resolves', async function () {
      env = new AsyncEnvironment();
      const context = new Context({}, {}, env, 'Main.script', true, {}, {});
      const output = runtime.createCommandBuffer(context);
      const inheritanceState = runtime.createInheritanceState();
      const events = [];
      const compiledMethods = {
        build: {
          fn() {
            events.push('build');
            return 'done';
          },
          signature: { argNames: [], withContext: false },
          ownerKey: 'Main.script',
          ownUsedChannels: [],
          ownMutatedChannels: [],
          super: false,
          invokedMethods: {}
        }
      };

      runtime.bootstrapInheritanceMetadata(inheritanceState, compiledMethods, {}, {}, output, context);
      const invocationPromise = runtime.invokeInheritedMethod(
        inheritanceState,
        'build',
        [],
        context,
        env,
        runtime,
        () => {},
        output,
        { lineno: 1, colno: 1, path: 'Main.script' }
      );

      await Promise.resolve();
      expect(events).to.eql([]);

      runtime.finalizeInheritanceMetadata(inheritanceState, context);
      const result = await invocationPromise;
      expect(result).to.be('done');
      expect(events).to.eql(['build']);
    });

    it('should not rebuild finalized invoked-method metadata on repeated finalization', function () {
      env = new AsyncEnvironment();
      const context = new Context({}, {}, env, 'Main.script', true, {}, {});
      const output = runtime.createCommandBuffer(context);
      const inheritanceState = runtime.createInheritanceState();
      const compiledMethods = {
        build: {
          fn() {
            return 'build';
          },
          signature: { argNames: [], withContext: false },
          ownerKey: 'Main.script',
          ownUsedChannels: [],
          ownMutatedChannels: [],
          super: false,
          invokedMethods: { helper: 'helper' }
        },
        helper: {
          fn() {
            return 'helper';
          },
          signature: { argNames: [], withContext: false },
          ownerKey: 'Main.script',
          ownUsedChannels: [],
          ownMutatedChannels: [],
          super: false,
          invokedMethods: {}
        }
      };

      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        compiledMethods,
        {},
        { helper: 'helper' },
        output,
        context
      );

      runtime.finalizeInheritanceMetadata(inheritanceState, context);
      const resolvedBuildEntry = inheritanceState.methods.build._resolvedMethodData;

      runtime.finalizeInheritanceMetadata(inheritanceState, context);

      expect(Object.keys(inheritanceState.invokedMethods)).to.eql([]);
      expect(inheritanceState.methods.build._resolvedMethodData).to.be(resolvedBuildEntry);
    });
  });

  describe('Phase 6 - Helper and Resolution Lifecycle', function () {
    it('should only bootstrap inheritance state for roots that need inheritance features', function () {
      const plainScript = new Script('var x = 1\nreturn x', env, 'plain.script');
      const methodScript = new Script('method build(name)\n  return name\nendmethod\nreturn this.build("Ada")', env, 'method.script');

      const plainSource = plainScript._compileSource();
      const methodSource = methodScript._compileSource();

      expect(plainSource).to.not.contain('runtime.bootstrapInheritanceMetadata(');
      expect(methodSource).to.contain('runtime.bootstrapInheritanceMetadata(');
    });

    it('should wait for late startup work before finalizing a plain root that uses inheritance startup', async function () {
      if (!inheritanceStateModule) {
        this.skip();
        return;
      }
      const originalRunCompiledRootStartup = runtime.runCompiledRootStartup;

      runtime.runCompiledRootStartup = function(setupRenderFunc, compiledMethods, inheritanceStateArg, envArg, contextArg, runtimeArg, cbArg, outputArg, extendsStateArg, optionsArg) {
        const startupPromise = originalRunCompiledRootStartup(
          setupRenderFunc,
          compiledMethods,
          inheritanceStateArg,
          envArg,
          contextArg,
          runtimeArg,
          cbArg,
          outputArg,
          extendsStateArg,
          optionsArg
        );

        const latePromise = Promise.resolve(startupPromise).then(() => new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              outputArg.add(new runtimeArg.VarCommand({
                channelName: '__return__',
                args: ['late'],
                pos: { lineno: 1, colno: 0 }
              }), '__return__');
              resolve('late');
            } catch (error) {
              reject(error);
            }
          }, 10);
        }));

        return inheritanceStateModule.mergeInheritanceStartupPromise(inheritanceStateArg, latePromise, startupPromise);
      };

      try {
        const result = await env.renderScriptString(
          'method noop()\n  return none\nendmethod\nreturn "early"',
          {}
        );

        expect(result).to.be('late');
      } finally {
        runtime.runCompiledRootStartup = originalRunCompiledRootStartup;
      }
    });

    it('should reuse the existing inheritance state when a parent root renders for composition', function () {
      const childScript = new Script('extends "A.script"\nreturn this.build("Ada")', env, 'C.script');
      const parentScript = new Script('method build(name)\n  return "A:" + name\nendmethod\nreturn null', env, 'A.script');

      childScript.compile();
      parentScript.compile();

      const state = runtime.bootstrapInheritanceMetadata(
        runtime.createInheritanceState(),
        childScript.methods,
        childScript.sharedSchema,
        childScript.invokedMethods
      );
      const reusedState = runtime.bootstrapInheritanceMetadata(
        state,
        parentScript.methods,
        parentScript.sharedSchema,
        parentScript.invokedMethods
      );
      runtime.finalizeInheritanceMetadata(state, { path: 'C.script' });

      const resolvedBuild = inheritanceCallModule.getMethodData(state, 'build');

      expect(reusedState).to.be(state);
      expect(resolvedBuild).to.be.ok();
      expect(resolvedBuild.ownerKey).to.be('A.script');
      expect(resolvedBuild.signature).to.eql({ argNames: ['name'], withContext: false });
    });

    it('should keep repeated bootstrap of the same owner idempotent', function () {
      const script = new Script('method build(name)\n  return name\nendmethod\nreturn null', env, 'A.script');
      script.compile();

      const state = runtime.createInheritanceState();
      runtime.bootstrapInheritanceMetadata(state, script.methods, script.sharedSchema, script.invokedMethods);
      runtime.bootstrapInheritanceMetadata(state, script.methods, script.sharedSchema, script.invokedMethods);

      expect(getMethodChain(state.methods, 'build').map((entry) => entry.ownerKey)).to.eql(['A.script']);
    });

    it('should resolve registered shared-channel metadata through the shared helper', function () {
      const childScript = new Script('extends "A.script" with theme\nreturn null', env, 'C.script');
      const parentScript = new Script('shared var theme = "light"\nreturn null', env, 'A.script');

      childScript.compile();
      parentScript.compile();

      const state = runtime.bootstrapInheritanceMetadata(
        runtime.createInheritanceState(),
        childScript.methods,
        childScript.sharedSchema,
        childScript.invokedMethods
      );
      runtime.bootstrapInheritanceMetadata(
        state,
        parentScript.methods,
        parentScript.sharedSchema,
        parentScript.invokedMethods
      );

      const resolvedTheme = inheritanceCallModule.resolveInheritanceSharedChannel(state, 'theme');

      expect(resolvedTheme).to.be.ok();
      expect(resolvedTheme).to.be('var');
    });

    it('should preserve the root rejection path when inherited method resolution fails during finalization', function () {
      const script = new Script('return this.build("Ada")', env, 'missing-method.script');
      script.compile();

      const state = runtime.bootstrapInheritanceMetadata(
        runtime.createInheritanceState(),
        script.methods,
        script.sharedSchema,
        script.invokedMethods
      );

      try {
        runtime.finalizeInheritanceMetadata(state, { path: 'missing-method.script' });
        expect().fail('Expected metadata finalization to reject missing inherited method');
      } catch (error) {
        expect(error.path).to.be('missing-method.script');
        expect(error.lineno).to.be(1);
        expect(error.colno).to.be(21);
        expect(String(error)).to.contain("Inherited method 'build' was not found");
      }
    });

    it('should use the helper call-site path when a shared-channel lookup fails immediately', function () {
      const script = new Script('extends "A.script" with theme\nreturn null', env, 'missing-shared.script');
      script.compile();

      const state = runtime.bootstrapInheritanceMetadata(
        runtime.createInheritanceState(),
        script.methods,
        script.sharedSchema,
        script.invokedMethods
      );
      try {
        inheritanceCallModule.resolveInheritanceSharedChannel(state, 'theme', {
          lineno: 5,
          colno: 7,
          path: 'dispatch.script',
          errorContextString: 'reading shared theme'
        });
        expect().fail('Expected shared-channel resolution to throw');
      } catch (error) {
        expect(error.path).to.be('dispatch.script');
        expect(error.lineno).to.be(5);
        expect(error.colno).to.be(7);
        expect(String(error)).to.contain("Shared channel 'theme' was not found");
        expect(String(error)).to.contain('dispatch.script');
      }
    });

    it('should share one resolved method metadata object after chain bootstrap', async function () {
      const childScript = new Script(
        'shared text trace\nmethod build(name)\n  trace("C|")\n  return super(name)\nendmethod\nreturn null',
        env,
        'C.script'
      );
      const parentScript = new Script(
        'shared text trace\nmethod build(name)\n  trace("A|")\n  return name\nendmethod\nreturn null',
        env,
        'A.script'
      );

      childScript.compile();
      parentScript.compile();

      const state = runtime.bootstrapInheritanceMetadata(
        runtime.createInheritanceState(),
        childScript.methods,
        childScript.sharedSchema,
        childScript.invokedMethods
      );
      runtime.bootstrapInheritanceMetadata(
        state,
        parentScript.methods,
        parentScript.sharedSchema,
        parentScript.invokedMethods
      );

      const resolvedBuildA = inheritanceCallModule.getMethodData(state, 'build');
      const resolvedBuildB = inheritanceCallModule.getMethodData(state, 'build');

      expect(resolvedBuildA).to.be(resolvedBuildB);
      expect(state.methods.build._resolvedMethodData).to.be(resolvedBuildA);
    });

    it('should memoize merged inherited method metadata on the resolved entry', async function () {
      const childScript = new Script(
        'shared text trace\nmethod build(name)\n  trace("C|")\n  return super(name)\nendmethod\nreturn null',
        env,
        'C.script'
      );
      const parentScript = new Script(
        'shared text trace\nmethod build(name)\n  trace("A|")\n  return name\nendmethod\nreturn null',
        env,
        'A.script'
      );

      childScript.compile();
      parentScript.compile();

      const state = runtime.bootstrapInheritanceMetadata(
        runtime.createInheritanceState(),
        childScript.methods,
        childScript.sharedSchema,
        childScript.invokedMethods
      );
      runtime.bootstrapInheritanceMetadata(
        state,
        parentScript.methods,
        parentScript.sharedSchema,
        parentScript.invokedMethods
      );

      const resolvedBuild = inheritanceCallModule.getMethodData(state, 'build');
      const resolvedAgain = inheritanceCallModule.getMethodData(state, 'build');

      expect(resolvedAgain).to.be(resolvedBuild);
      expect(state.methods.build._resolvedMethodData).to.be(resolvedBuild);
      expect(resolvedBuild.mergedMutatedChannels).to.contain('trace');
      expect(Object.keys(resolvedBuild)).not.to.contain('sharedLookupChannels');
    });

    it('should mark missing inherited-method failures with a structural error code', function () {
      const state = runtime.createInheritanceState();

      try {
        inheritanceCallModule.getMethodData(state, 'missing', {
          lineno: 2,
          colno: 4,
          path: 'dispatch.script',
          errorContextString: 'calling missing()'
        });
        expect().fail('Expected missing inherited method lookup to reject');
      } catch (error) {
        expect(error.code).to.be('ERR_INHERITED_METHOD_NOT_FOUND');
        expect(String(error)).to.contain("Inherited method 'missing' was not found");
      }
    });

    it('should fail clearly when inherited dispatch resolves to an invalid method entry', async function () {
      if (!inheritanceCallModule) {
        this.skip();
        return;
      }
      try {
        inheritanceCallModule.createInheritanceInvocationCommand({
          name: 'build',
          methodData: null,
          normalizeError: (error) => error,
          args: [],
          context: {},
          inheritanceState: runtime.createInheritanceState(),
          env: env,
          runtime: runtime,
          cb: () => {},
          invocationBuffer: null,
          errorContext: null
        });
        expect().fail('Expected invalid inherited method entry to fail');
      } catch (error) {
        expect(String(error)).to.contain('Inherited dispatch resolved to an invalid method entry');
      }
    });

    it('should reject the inherited-call promise once when cleanup fails after resolution', async function () {
      if (!inheritanceCallModule) {
        this.skip();
        return;
      }
      const fakeBuffer = {
        isLinkedChannel() {
          return false;
        },
        isFinished() {
          return false;
        },
        addBuffer() {},
        _registerLinkedChannel() {},
        markFinishedAndPatchLinks() {},
        getFinishedPromise() {
          return Promise.reject(cleanupError);
        }
      };
      const cleanupError = new Error('cleanup failed');
      const command = inheritanceCallModule.createInheritanceInvocationCommand({
        name: '__constructor__',
        methodData: {
          fn() {
            return 'ok';
          },
          signature: { argNames: [], withContext: false },
          ownUsedChannels: [],
          ownMutatedChannels: [],
          mergedUsedChannels: [],
          mergedMutatedChannels: [],
          super: null,
          ownerKey: 'A.script'
        },
        normalizeError: (error) => error,
        args: [],
        context: {},
        inheritanceState: runtime.createInheritanceState(),
        env: env,
        runtime: runtime,
        cb: () => {},
        invocationBuffer: fakeBuffer,
        errorContext: null
      });
      const completionPromise = command.apply();

      try {
        await command.promise;
        expect().fail('Expected inherited-call promise to reject when cleanup fails');
      } catch (error) {
        expect(error).to.be(cleanupError);
      }

      try {
        await completionPromise;
        expect().fail('Expected invocation start to reject when cleanup fails');
      } catch (error) {
        expect(error).to.be(cleanupError);
      }
    });

    it('should pass error context through script fallback lookups after a channel miss', function () {
      const seen = [];
      const errorContext = {
        lineno: 3,
        colno: 5,
        errorContextString: 'reading missingName',
        path: 'lookup.script'
      };
      const context = {
        lookupScript(name, receivedErrorContext) {
          seen.push({ name, errorContext: receivedErrorContext });
          return 'resolved-from-context';
        }
      };
      const currentBuffer = {
        findChannel() {
          return null;
        }
      };

      const result = runtime.contextOrScriptChannelLookup(
        context,
        'missingName',
        currentBuffer,
        errorContext
      );

      expect(result).to.be('resolved-from-context');
      expect(seen).to.have.length(1);
      expect(seen[0].name).to.be('missingName');
      expect(seen[0].errorContext).to.be(errorContext);
    });
  });

  describe('Step 6 - Direct Callable Body Metadata', function () {
    it('should link callable bodies from direct super and invoked-method metadata', function () {
      if (!inheritanceCallModule) {
        this.skip();
        return;
      }

      const helperData = {
        fn() {
          return null;
        },
        ownerKey: 'Helper.script',
        signature: { argNames: [], withContext: false },
        ownUsedChannels: [],
        ownMutatedChannels: [],
        mergedUsedChannels: ['helperRead'],
        mergedMutatedChannels: ['helperWrite'],
        super: null,
        invokedMethods: Object.create(null)
      };
      const methodData = {
        fn() {
          return null;
        },
        ownerKey: 'Main.script',
        signature: { argNames: [], withContext: false },
        ownUsedChannels: ['localRead'],
        ownMutatedChannels: ['localWrite'],
        mergedUsedChannels: ['localRead', 'superRead', 'helperRead'],
        mergedMutatedChannels: ['localWrite', 'superWrite', 'helperWrite'],
        super: {
          fn() {
            return null;
          },
          ownerKey: 'Parent.script',
          signature: { argNames: [], withContext: false },
          ownUsedChannels: [],
          ownMutatedChannels: [],
          mergedUsedChannels: ['superRead'],
          mergedMutatedChannels: ['superWrite'],
          super: null,
          invokedMethods: Object.create(null)
        },
        invokedMethods: {
          helper: helperData
        }
      };

      const linkedChannels = inheritanceCallModule.getCallableBodyLinkedChannels(methodData, {
        path: 'Main.script'
      }).sort();

      expect(linkedChannels).to.eql([
        'helperRead',
        'helperWrite',
        'localRead',
        'localWrite',
        'superRead',
        'superWrite'
      ]);
    });

    it('should use finalized callable-body channels without retained invoked-method metadata', function () {
      if (!inheritanceCallModule) {
        this.skip();
        return;
      }

      const linkedChannels = inheritanceCallModule.getCallableBodyLinkedChannels({
        fn() {
          return null;
        },
        ownerKey: 'Main.script',
        signature: { argNames: [], withContext: false },
        mergedUsedChannels: ['localRead'],
        mergedMutatedChannels: ['localWrite'],
        super: null
      });

      expect(linkedChannels).to.contain('localRead');
      expect(linkedChannels).to.contain('localWrite');
    });

    it('should fail callable-body linking when direct super metadata is malformed', function () {
      if (!inheritanceCallModule) {
        this.skip();
        return;
      }

      try {
        inheritanceCallModule.getCallableBodyLinkedChannels({
          fn() {
            return null;
          },
          ownerKey: 'Main.script',
          signature: { argNames: [], withContext: false },
          ownUsedChannels: ['localRead'],
          ownMutatedChannels: [],
          mergedUsedChannels: [],
          mergedMutatedChannels: [],
          super: {
            ownerKey: 'Parent.script'
          },
          invokedMethods: Object.create(null)
        }, {
          lineno: 5,
          colno: 1,
          path: 'Main.script',
          errorContextString: 'method body linking'
        });
        expect().fail('Expected malformed direct super metadata to fail');
      } catch (error) {
        expect(error.code).to.be('ERR_INVALID_SUPER_METADATA');
        expect(String(error)).to.contain("super() metadata on owner 'Main.script' is invalid");
      }
    });

    it('should use finalized transitive channels during real callable entry linking', async function () {
      const originalGetCallableBodyLinkedChannels = runtime.getCallableBodyLinkedChannels;
      let seenLinkedChannels = null;

      runtime.getCallableBodyLinkedChannels = function(methodData, errorContext) {
        const channels = originalGetCallableBodyLinkedChannels.apply(this, arguments);
        if (
          methodData &&
          channels.indexOf('theme') !== -1
        ) {
          seenLinkedChannels = {
            channels: channels.slice().sort(),
            errorContext
          };
        }
        return channels;
      };

      try {
        const result = await env.renderScriptString(
          'shared var theme = "dark"\nmethod readTheme()\n  return theme\nendmethod\nmethod build()\n  return this.readTheme()\nendmethod\nreturn this.build()',
          {}
        );

        expect(result).to.be('dark');
        expect(seenLinkedChannels).to.be.ok();
        expect(seenLinkedChannels.channels).to.contain('theme');
      } finally {
        runtime.getCallableBodyLinkedChannels = originalGetCallableBodyLinkedChannels;
      }
    });

    it('should use direct super metadata during real callable entry linking', async function () {
      const loader = new StringLoader();
      env = new AsyncEnvironment(loader);
      const originalGetCallableBodyLinkedChannels = runtime.getCallableBodyLinkedChannels;
      let seenLinkedChannels = null;

      runtime.getCallableBodyLinkedChannels = function(methodData, errorContext) {
        const channels = originalGetCallableBodyLinkedChannels.apply(this, arguments);
        if (
          methodData &&
          methodData.ownerKey === 'C.script' &&
          methodData.super
        ) {
          seenLinkedChannels = {
            channels: channels.slice().sort(),
            errorContext
          };
        }
        return channels;
      };

      loader.addTemplate('A.script', [
        'shared text trace',
        'shared var late = "parent-default"',
        'method build()',
        '  trace("parent|")',
        '  late = "from-parent"',
        '  return "done"',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('C.script', [
        'extends "A.script"',
        'method build()',
        '  return super()',
        'endmethod',
        'return this.build()'
      ].join('\n'));

      try {
        const result = await env.renderScript('C.script', {});

        expect(result).to.be('done');
        expect(seenLinkedChannels).to.be.ok();
        expect(seenLinkedChannels.channels).to.contain('late');
        expect(seenLinkedChannels.channels).to.contain('trace');
      } finally {
        runtime.getCallableBodyLinkedChannels = originalGetCallableBodyLinkedChannels;
      }
    });

    it('should compile callable entries to use direct callable-body metadata linking', function () {
      const script = new Script(
        'shared var theme = "dark"\nmethod build()\n  return this.readTheme()\nendmethod\nmethod readTheme()\n  return theme\nendmethod\nreturn null',
        env,
        'direct-body-linking.casc'
      );

      const source = script._compileSource();

      expect(source).to.contain('runtime.getCallableBodyLinkedChannels(methodData,');
      // The callable entry must ask for the body-local transitive footprint,
      // not the invocation-only channel list used for parent dispatch.
      expect(source).to.not.contain('runtime.getMethodLinkedChannels(methodData)');
    });
  });

  describe('Phase 12 - Dynamic Extends Startup Plumbing', function () {
    it('should stop rewriting nested dynamic extends into asyncStoreIn staging nodes', function () {
      if (!transformer) {
        this.skip();
        return;
      }

      const ast = transformer.transform(
        parser.parse('{% if useParent %}{% extends parent %}{% endif %}{% block body %}x{% endblock %}'),
        [],
        'dynamic-nested.njk',
        {
          asyncMode: true,
          scriptMode: false,
          idPool: {
            value: 0,
            next() {
              this.value += 1;
              return this.value;
            }
          }
        }
      );
      const extendsNodes = ast.findAll(nodes.Extends);
      expect(extendsNodes).to.have.length(1);
      expect(Object.prototype.hasOwnProperty.call(extendsNodes[0], 'asyncStoreIn')).to.be(false);
    });

    it('should compile nested dynamic extends without the old top-level staging temp path', function () {
      const source = new AsyncTemplate(
        '{% if useParent %}{% extends parent %}{% endif %}{% block body %}x{% endblock %}',
        env,
        'dynamic-nested.njk'
      )._compileSource();

      expect(source).to.contain('extendsState.parentSelection');
      expect(source).to.not.contain('asyncStoreIn');
      expect(source).to.not.contain('hole_');
    });

    it('should keep top-level dynamic extends on the immediate parent-render boundary path', function () {
      const source = new AsyncTemplate(
        '{% extends parent if useParent else none %}{% block body %}x{% endblock %}',
        env,
        'dynamic-top-level.njk'
      )._compileSource();

      expect(source).to.contain('runtime.runControlFlowBoundary(');
      expect(source).to.contain('extendsState.parentSelection');
      expect(source).to.not.contain('asyncStoreIn');
    });
  });

  describe('Phase 12 - Dynamic Extends Resolution Lifecycle', function () {
    it('should keep inheritance state lean while methods use a plain helper-backed table', function () {
      const inheritanceState = runtime.createInheritanceState();

      expect(Object.getPrototypeOf(inheritanceState.methods)).to.be(null);
      expect(inheritanceState.resolution).to.be(undefined);
      expect(typeof inheritanceState.methods.registerCompiled).to.be('undefined');
      expect(typeof inheritanceState.methods.getChain).to.be('undefined');
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

    it('should compile dynamic extends without the old lifecycle bridge helpers', function () {
      const source = new AsyncTemplate(
        '{% extends parent if useParent else none %}{% block body %}x{% endblock %}',
        env,
        'dynamic-child.njk'
      )._compileSource();

      expect(source).to.contain('extendsState.parentSelection');
      expect(source).to.not.contain('runtime.beginInheritanceResolution(');
      expect(source).to.not.contain('runtime.finishInheritanceResolution(');
      expect(source).to.not.contain('runtime.bridgeDynamicParentTemplate(');
    });
  });

  describe('Phase 12 - Composition Payload Shape', function () {
    it('should compile script and template extends-with startup around one explicit payload object shape', function () {
      const scriptSource = new Script(
        'shared var theme = "dark"\nextends "A.script" with theme\nreturn null',
        env,
        'payload-shape.script'
      )._compileSource();
      const dynamicTemplateSource = new AsyncTemplate(
        '{% set theme = "dark" %}{% extends (parent if useParent else none) with theme %}{% block body %}x{% endblock %}',
        env,
        'payload-shape.njk'
      )._compileSource();

      expect(scriptSource).to.contain('rootContext');
      expect(scriptSource).to.contain('externContext');
      expect(scriptSource).to.not.contain('explicitInputValues');
      expect(scriptSource).to.not.contain('explicitInputNames');
      expect(scriptSource).to.not.contain('runtime.startParentConstructor(');

      expect(dynamicTemplateSource).to.contain('rootContext');
      expect(dynamicTemplateSource).to.contain('externContext');
      expect(dynamicTemplateSource).to.not.contain('explicitInputValues');
      expect(dynamicTemplateSource).to.not.contain('explicitInputNames');
      expect(dynamicTemplateSource).to.not.contain('runtime.setExtendsComposition(');
    });

    it('should capture template extends-with inputs through ordered visibility instead of the latest-assigned bridge', function () {
      const dynamicTemplateSource = new AsyncTemplate(
        '{% set theme = "dark" %}{% extends (parent if useParent else none) with theme %}{% block body %}x{% endblock %}',
        env,
        'payload-observation.njk'
      )._compileSource();

      expect(dynamicTemplateSource).to.contain('runtime.captureCompositionValue(');
      expect(dynamicTemplateSource).to.not.contain('captureCompositionScriptValue');
      expect(dynamicTemplateSource).to.not.contain('recordTemporaryCompositionAssignedValue');
    });
  });
});
