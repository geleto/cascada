'use strict';

let expect;
let AsyncEnvironment;
let Script;
let parser;
let nodes;
let scriptTranspiler;
let runtime;
let StringLoader;
if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  Script = environment.Script;
  parser = require('../../src/parser');
  nodes = require('../../src/nodes');
  scriptTranspiler = require('../../src/script/script-transpiler');
  runtime = require('../../src/runtime/runtime');
  StringLoader = require('../util').StringLoader;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  Script = nunjucks.Script;
  parser = nunjucks.parser;
  nodes = nunjucks.nodes;
  scriptTranspiler = nunjucks.scriptTranspiler;
  runtime = nunjucks.runtime;
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
      inheritanceState.registerCompiledMethods(childScript.methods);
      inheritanceState.registerCompiledMethods(parentScript.methods);

      const chain = inheritanceState.getRegisteredMethodChain('build');
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
        const originalRegisterSharedSchema = inheritanceState.registerSharedSchema;
        inheritanceState.registerSharedSchema = function(sharedSchema, ownerKey) {
          seen.push(`schema:${ownerKey}:${(sharedSchema || []).map((entry) => entry.name).join(',')}`);
          return originalRegisterSharedSchema.call(this, sharedSchema, ownerKey);
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
        expect(seen[0]).to.be('schema:C.script:trace');
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
});
