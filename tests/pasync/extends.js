'use strict';

let expect;
let AsyncEnvironment;
let Script;
let parser;
let nodes;
let scriptTranspiler;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const environment = require('../../src/environment/environment');
  AsyncEnvironment = environment.AsyncEnvironment;
  Script = environment.Script;
  parser = require('../../src/parser');
  nodes = require('../../src/nodes');
  scriptTranspiler = require('../../src/script/script-transpiler');
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  Script = nunjucks.Script;
  parser = nunjucks.parser;
  nodes = nunjucks.nodes;
  scriptTranspiler = nunjucks.scriptTranspiler;
}

describe('Extends Step 1', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

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

    it('should fail clearly on bad endmethod usage', function () {
      expect(() => {
        scriptTranspiler.scriptToTemplate('endmethod');
      }).to.throwException(/Unexpected 'endmethod'/);
    });
  });
});
