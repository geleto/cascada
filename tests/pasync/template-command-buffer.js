
import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';
import {parse} from '../../src/language/parser.js';
import {transform} from '../../src/language/transformer.js';
import {CompilerAsync} from '../../src/compiler/compiler.js';
import * as nodes from '../../src/language/nodes.js';
import * as runtime from '../../src/runtime/runtime.js';
import {transpiler as scriptTranspiler} from '../../src/language/script-transpiler.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const TEST_DIAGNOSTIC_CONTEXT = runtime.cloneWithAddedContext(TEST_EC, { branch: 'test' });

(function () {
  function createIdPool() {
    return {
      value: 0,
      next() {
        this.value += 1;
        return this.value;
      }
    };
  }

  function analyzeTemplateSource(src, name = 'analysis-test.njk') {
    const opts = {
      asyncMode: true,
      scriptMode: false,
      idPool: createIdPool()
    };
    const compiler = new CompilerAsync(name, opts);
    const ast = transform(parse(src, [], opts), [], name, opts);
    compiler.analysis.run(ast);
    return ast;
  }

  function analyzeScriptSource(src, name = 'analysis-test.casc') {
    const opts = {
      asyncMode: true,
      scriptMode: true,
      idPool: createIdPool()
    };
    const compiler = new CompilerAsync(name, opts);
    const ast = transform(parse(scriptTranspiler.scriptToTemplate(src), [], opts), [], name, opts);
    compiler.analysis.run(ast);
    return ast;
  }

  function collectNodesByType(node, typename, out = []) {
    if (!node) {
      return out;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => collectNodesByType(child, typename, out));
      return out;
    }
    if (!(node instanceof nodes.Node)) {
      return out;
    }
    if (node.typename === typename) {
      out.push(node);
    }
    node.fields.forEach((field) => collectNodesByType(node[field], typename, out));
    return out;
  }

  function collectAllNodes(node, out = []) {
    if (!node) {
      return out;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => collectAllNodes(child, out));
      return out;
    }
    if (!(node instanceof nodes.Node)) {
      return out;
    }
    out.push(node);
    node.fields.forEach((field) => collectAllNodes(node[field], out));
    return out;
  }

  function expectFinalizedChainSetFacts(ast) {
    const fields = [
      'usedChains',
      'observedChains',
      'mutatedChains',
      'usedChainsFromParent',
      'observedChainsFromParent',
      'mutatedChainsFromParent',
      'boundaryLinkedChains',
      'boundaryLinkedMutatedChains'
    ];
    const supersetPairs = [
      ['observedChains', 'usedChains'],
      ['mutatedChains', 'usedChains'],
      ['observedChainsFromParent', 'usedChainsFromParent'],
      ['mutatedChainsFromParent', 'usedChainsFromParent'],
      ['boundaryLinkedMutatedChains', 'boundaryLinkedChains']
    ];
    collectAllNodes(ast).forEach((node) => {
      fields.forEach((field) => {
        const value = node._analysis[field];
        expect(value === null || value instanceof Set).to.be(true);
        if (value) {
          Array.from(value).forEach((name) => {
            expect(typeof name).to.be('string');
            expect(name).to.not.be('');
          });
        }
      });
      supersetPairs.forEach(([subsetField, supersetField]) => {
        const subset = node._analysis[subsetField];
        const superset = node._analysis[supersetField];
        if (subset) {
          expect(superset instanceof Set).to.be(true);
          subset.forEach((name) => {
            expect(superset.has(name)).to.be(true);
          });
        }
      });
    });
  }

  function sortedChainNames(value) {
    return Array.from(value || []).sort();
  }

  function addChainNames(target, chains) {
    if (chains) {
      chains.forEach((name) => target.add(name));
    }
  }

  function addDeclaredChainNames(target, declarations) {
    if (declarations) {
      declarations.forEach((_declaration, name) => target.add(name));
    }
  }

  function expectBroadUsedChainParity(ast) {
    collectAllNodes(ast).forEach((node) => {
      const analysis = node._analysis;
      const expectedUsed = new Set();
      addChainNames(expectedUsed, analysis.observedChains);
      addChainNames(expectedUsed, analysis.mutatedChains);
      addDeclaredChainNames(expectedUsed, analysis.declaredChains);

      const expectedUsedFromParent = new Set();
      addChainNames(expectedUsedFromParent, analysis.observedChainsFromParent);
      addChainNames(expectedUsedFromParent, analysis.mutatedChainsFromParent);

      expect(sortedChainNames(analysis.usedChains)).to.eql(sortedChainNames(expectedUsed));
      expect(sortedChainNames(analysis.usedChainsFromParent)).to.eql(sortedChainNames(expectedUsedFromParent));
    });
  }

  describe('Async template command buffering parity', function () {
    it('should infer this.__text__ as the template text chain', function () {
      const ast = analyzeTemplateSource('{% block body %}{{ this.__text__.snapshot() }}{{ this.theme }}{% endblock %}');
      const inferred = ast._analysis.inheritanceSharedDeclarations;
      const rootTextDeclares = ast._analysis.declares.filter((declaration) => declaration.name === '__text__' && !declaration.shared);
      const blockNode = collectNodesByType(ast, 'Block')[0];

      expect(inferred.map((declaration) => [declaration.name, declaration.type])).to.eql([
        ['__text__', 'text'],
        ['$theme', 'var']
      ]);
      expect(rootTextDeclares).to.have.length(1);
      expect(rootTextDeclares[0].type).to.be('text');
      expect(rootTextDeclares[0].shared).to.not.be(true);
      expect(blockNode._analysis.boundaryLinkedChains instanceof Set).to.be(true);
      expect(blockNode._analysis.boundaryLinkedMutatedChains instanceof Set).to.be(true);
    });

    it('should finalize analysis chain-set facts as Set or null', function () {
      const ast = analyzeTemplateSource(
        '{% extends parentTemplate %}' +
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}' +
        '{% block body %}{{ this.__text__.snapshot() }}{{ this.theme }}{% endblock %}',
        'finalized-chain-set-facts.njk'
      );

      expectFinalizedChainSetFacts(ast);
    });

    it('should reject invalid custom boundary-linked chain fact shapes during finalization', function () {
      const opts = {
        asyncMode: true,
        scriptMode: false,
        idPool: createIdPool()
      };
      const compiler = new CompilerAsync('invalid-linked-chain-facts.njk', opts);
      const ast = transform(parse('{% if flag %}{{ x }}{% endif %}', [], opts), [], 'invalid-linked-chain-facts.njk', opts);
      compiler.postAnalyzeIf = () => ({ boundaryLinkedChains: 'x' });

      expect(() => compiler.analysis.run(ast)).to.throwException((err) => {
        expect(err.message).to.contain('Analysis fact \'boundaryLinkedChains\'');
        expect(err.message).to.contain('must be a Set, array, or iterable collection of chain names');
      });
    });

    it('should reject Map custom boundary-linked chain facts as invalid shapes', function () {
      const opts = {
        asyncMode: true,
        scriptMode: false,
        idPool: createIdPool()
      };
      const compiler = new CompilerAsync('invalid-linked-chain-map-facts.njk', opts);
      const ast = transform(parse('{% if flag %}{{ x }}{% endif %}', [], opts), [], 'invalid-linked-chain-map-facts.njk', opts);
      compiler.postAnalyzeIf = () => ({ boundaryLinkedChains: new Map([['x', { name: 'x' }]]) });

      expect(() => compiler.analysis.run(ast)).to.throwException((err) => {
        expect(err.message).to.contain('Analysis fact \'boundaryLinkedChains\'');
        expect(err.message).to.contain('must be a Set, array, or iterable collection of chain names');
        expect(err.message).to.contain('got Map');
      });
    });

    it('should reject invalid custom boundary-linked chain names during finalization', function () {
      const opts = {
        asyncMode: true,
        scriptMode: false,
        idPool: createIdPool()
      };
      const compiler = new CompilerAsync('invalid-linked-chain-names.njk', opts);
      const ast = transform(parse('{% if flag %}{{ x }}{% endif %}', [], opts), [], 'invalid-linked-chain-names.njk', opts);
      compiler.postAnalyzeIf = () => ({ boundaryLinkedChains: [''] });

      expect(() => compiler.analysis.run(ast)).to.throwException((err) => {
        expect(err.message).to.contain('Analysis fact \'boundaryLinkedChains\'');
        expect(err.message).to.contain('contains an invalid chain name');
      });
    });

    it('should reject legacy custom linked-chain facts', function () {
      const opts = {
        asyncMode: true,
        scriptMode: false,
        idPool: createIdPool()
      };
      const compiler = new CompilerAsync('legacy-linked-chain-facts.njk', opts);
      const ast = transform(parse('{% if flag %}{{ x }}{% endif %}', [], opts), [], 'legacy-linked-chain-facts.njk', opts);
      compiler.postAnalyzeIf = () => ({ linkedChains: ['x'] });

      expect(() => compiler.analysis.run(ast)).to.throwException((err) => {
        expect(err.message).to.contain("Analysis fact 'linkedChains' is no longer supported");
        expect(err.message).to.contain("'boundaryLinkedChains'");
      });
    });

    it('should reject legacy custom uses facts', function () {
      const opts = {
        asyncMode: true,
        scriptMode: false,
        idPool: createIdPool()
      };
      const compiler = new CompilerAsync('legacy-uses-facts.njk', opts);
      const ast = transform(parse('{% if true %}x{% endif %}', [], opts), [], 'legacy-uses-facts.njk', opts);
      compiler.postAnalyzeIf = () => ({ uses: ['x'] });

      expect(() => compiler.analysis.run(ast)).to.throwException((err) => {
        expect(err.message).to.contain("Analysis fact 'uses' is no longer supported");
        expect(err.message).to.contain("'observes', 'mutates', or 'declares'");
      });
    });

    it('should keep source-order declarations separate from finalized declarations', function () {
      const ast = analyzeScriptSource(
        'var before = someVar\n' +
        'var someVar = "local"\n' +
        'return someVar',
        'source-visible-declarations.casc'
      );
      const rootAnalysis = ast._analysis;
      const someVarUses = collectNodesByType(ast, 'Symbol')
        .filter((node) => node.value === 'someVar' && !node._analysis.declarationTarget)
        .sort((left, right) => left.lineno - right.lineno || left.colno - right.colno);

      expect(someVarUses).to.have.length(2);
      expect(someVarUses[0]._analysis.lookupDeclaration).to.be(null);
      expect(someVarUses[1]._analysis.lookupDeclaration.name).to.be('someVar');
      expect(rootAnalysis.sourceVisibleDeclarations).to.not.be(rootAnalysis.declaredChains);
      expect(rootAnalysis.sourceVisibleDeclarations.has('someVar')).to.be(true);
      expect(rootAnalysis.declaredChains.has('someVar')).to.be(true);
    });

    it('should separate declared, observed, mutated, and broad used chain facts', function () {
      const ast = analyzeScriptSource([
        'data declaredOnly',
        'data mutatedOnly',
        'data observedOnly',
        'data both',
        'mutatedOnly.push("m")',
        'var snapshot = observedOnly.snapshot()',
        'both.push("b")',
        'var bothSnapshot = both.snapshot()',
        'return snapshot'
      ].join('\n'), 'separated-chain-facts.casc');
      const root = ast._analysis;

      expect(root.declaredChains.has('declaredOnly')).to.be(true);
      expect(root.usedChains.has('declaredOnly')).to.be(true);
      expect(root.observedChains.has('declaredOnly')).to.be(false);
      expect(root.mutatedChains.has('declaredOnly')).to.be(false);

      expect(root.usedChains.has('mutatedOnly')).to.be(true);
      expect(root.observedChains.has('mutatedOnly')).to.be(false);
      expect(root.mutatedChains.has('mutatedOnly')).to.be(true);

      expect(root.usedChains.has('observedOnly')).to.be(true);
      expect(root.observedChains.has('observedOnly')).to.be(true);
      expect(root.mutatedChains.has('observedOnly')).to.be(false);

      expect(root.observedChains.has('both')).to.be(true);
      expect(root.mutatedChains.has('both')).to.be(true);
    });

    it('should classify var declarations with initializers as mutations', function () {
      const ast = analyzeScriptSource([
        'var x = 5',
        'return x'
      ].join('\n'), 'initialized-var-chain-facts.casc');
      const root = ast._analysis;

      expect(root.declaredChains.has('x')).to.be(true);
      expect(root.usedChains.has('x')).to.be(true);
      expect(root.mutatedChains.has('x')).to.be(true);
    });

    it('should preserve broad used-chain parent footprints for representative scheduler consumers', function () {
      const controlFlowAst = analyzeScriptSource([
        'data result',
        'var flag = true',
        'if flag',
        '  result.push("yes")',
        'else',
        '  var local = "no"',
        'endif',
        'while flag',
        '  var loopLocal = "tick"',
        'endwhile',
        'return result.snapshot()'
      ].join('\n'), 'broad-used-chain-parity.casc');
      const extendsBoundaryAst = analyzeTemplateSource(
        '{% extends parentTemplate %}' +
        '{% block body %}{{ value }}{% endblock %}',
        'broad-used-template-extends-parity.njk'
      );
      const callerBoundaryAst = analyzeTemplateSource(
        '{% set value = "v" %}' +
        '{% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}' +
        '{% call wrap("span") %}{{ value }}{% endcall %}',
        'broad-used-template-caller-parity.njk'
      );
      const guardAst = analyzeScriptSource([
        'data result',
        'guard result',
        '  result.push("ok")',
        '  var local = fail()',
        'recover err',
        '  result.recovered = err.message',
        'endguard',
        'return result.snapshot()'
      ].join('\n'), 'broad-used-guard-parity.casc');
      const ifNode = collectNodesByType(controlFlowAst, 'If')[0];
      const whileNode = collectNodesByType(controlFlowAst, 'While')[0];
      const callerNode = collectNodesByType(callerBoundaryAst, 'Caller')[0];
      const guardNode = collectNodesByType(guardAst, 'Guard')[0];
      const recoveryNode = collectNodesByType(guardAst, 'Guard.Recover')[0];

      [controlFlowAst, extendsBoundaryAst, callerBoundaryAst, guardAst].forEach(expectBroadUsedChainParity);

      expect(Array.from(controlFlowAst._analysis.usedChains || [])).to.eql(['flag', 'result', '__return__']);
      expect(Array.from(ifNode._analysis.usedChainsFromParent || [])).to.eql(['flag', 'result']);
      expect(Array.from(ifNode.body._analysis.usedChainsFromParent || [])).to.eql(['result']);
      expect(Array.from(ifNode.else_._analysis.usedChainsFromParent || [])).to.eql([]);
      expect(Array.from(whileNode._analysis.usedChainsFromParent || [])).to.eql(['flag']);
      expect(Array.from(whileNode.body._analysis.usedChainsFromParent || [])).to.eql([]);
      expect(Array.from(callerNode._analysis.usedChainsFromParent || [])).to.eql(['value']);
      expect(Array.from(guardNode.body._analysis.usedChainsFromParent || [])).to.eql(['result']);
      expect(Array.from(recoveryNode._analysis.usedChainsFromParent || [])).to.eql(['result']);
    });

    it('should keep skipped-region local declarations out of parent-visible mutation facts', function () {
      const ast = analyzeScriptSource([
        'var mode = "a"',
        'switch mode',
        'case "a"',
        '  var caseLocal = "case"',
        'default',
        '  var defaultLocal = "default"',
        'endswitch',
        'while mode == "b"',
        '  var whileLocal = "while"',
        'endwhile',
        'return 1'
      ].join('\n'), 'skipped-region-local-declarations.casc');
      const switchNode = collectNodesByType(ast, 'Switch')[0];
      const caseNode = collectNodesByType(ast, 'Case')[0];
      const whileNode = collectNodesByType(ast, 'While')[0];

      expect(Array.from(caseNode.body._analysis.mutatedChainsFromParent || [])).to.eql([]);
      expect(Array.from(switchNode.default._analysis.mutatedChainsFromParent || [])).to.eql([]);
      expect(Array.from(whileNode.body._analysis.mutatedChainsFromParent || [])).to.eql([]);
    });

    it('should remove local declarations from parent-visible observed and mutated facts', function () {
      const ast = analyzeTemplateSource(
        '{% macro localOnly(x) %}{{ x }}{% set x = "updated" %}{% endmacro %}',
        'macro-local-shadow-analysis.njk'
      );
      const macro = collectNodesByType(ast, 'Macro')[0]._analysis;

      expect(macro.observedChains.has('x')).to.be(true);
      expect(macro.mutatedChains.has('x')).to.be(true);
      expect(macro.usedChains.has('x')).to.be(true);
      expect((macro.observedChainsFromParent || new Set()).has('x')).to.be(false);
      expect((macro.mutatedChainsFromParent || new Set()).has('x')).to.be(false);
      expect((macro.usedChainsFromParent || new Set()).has('x')).to.be(false);
      expect(Array.from(macro.boundaryLinkedChains || [])).to.eql([]);
    });

    it('should keep nested capture text outputs out of outer stored chain facts', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}',
        'nested-capture-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');
      const outer = captures[0]._analysis;
      const inner = captures[1]._analysis;

      expect(Array.from(outer.observedChains || [])).to.eql(['x']);
      expect(Array.from(outer.usedChains || [])).to.eql([outer.textOutput, 'x', 'inner']);
      expect(Array.from(outer.mutatedChains || [])).to.eql([outer.textOutput, 'inner']);
      expect(Array.from(inner.observedChains || [])).to.eql(['x']);
      expect(Array.from(inner.usedChains || [])).to.eql([inner.textOutput, 'x']);
      expect(Array.from(inner.mutatedChains || [])).to.eql([inner.textOutput]);
      expect(Array.from(outer.observedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(outer.usedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(outer.mutatedChainsFromParent || [])).to.eql([]);
      expect(Array.from(inner.observedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(inner.usedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(inner.mutatedChainsFromParent || [])).to.eql([]);
      expect(outer.usedChains.has(inner.textOutput)).to.be(false);
      expect(outer.mutatedChains.has(inner.textOutput)).to.be(false);
    });

    it('should preserve parent-owned mutations in stored capture chain facts', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}{% set x = "outer" %}{% set inner %}{{ x }}{% set x = "inner" %}{% endset %}{% endset %}',
        'nested-capture-mutation-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');
      const outer = captures[0]._analysis;
      const inner = captures[1]._analysis;

      expect(Array.from(outer.observedChains || [])).to.eql(['x']);
      expect(Array.from(outer.usedChains || [])).to.eql(['x', 'inner', outer.textOutput]);
      expect(Array.from(outer.mutatedChains || [])).to.eql(['x', 'inner']);
      expect(Array.from(inner.observedChains || [])).to.eql(['x']);
      expect(Array.from(inner.usedChains || [])).to.eql([inner.textOutput, 'x']);
      expect(Array.from(inner.mutatedChains || [])).to.eql([inner.textOutput, 'x']);
      expect(Array.from(outer.observedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(outer.usedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(outer.mutatedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(inner.observedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(inner.usedChainsFromParent || [])).to.eql(['x']);
      expect(Array.from(inner.mutatedChainsFromParent || [])).to.eql(['x']);
      expect(outer.usedChains.has(inner.textOutput)).to.be(false);
      expect(outer.mutatedChains.has(inner.textOutput)).to.be(false);
    });

    it('should derive boundary-linked chains from stored facts minus declarations', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}',
        'nested-capture-linked-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');

      expect(Array.from(captures[0]._analysis.boundaryLinkedChains || [])).to.eql(['x']);
      expect(Array.from(captures[0]._analysis.boundaryLinkedMutatedChains || [])).to.eql([]);
      expect(Array.from(captures[1]._analysis.boundaryLinkedChains || [])).to.eql(['x']);
      expect(Array.from(captures[1]._analysis.boundaryLinkedMutatedChains || [])).to.eql([]);
    });

    it('should include parent-owned mutations in derived boundary-linked chains', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}' +
        '{% if flag %}{{ x }}{% set x = "updated" %}{% var local = "local" %}{{ local }}{% endif %}',
        'if-linked-mutation-analysis.njk'
      );
      const ifNode = collectNodesByType(ast, 'If')[0];

      expect(Array.from(ifNode._analysis.boundaryLinkedChains || [])).to.eql(['__text__', 'x']);
      expect(Array.from(ifNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['__text__', 'x']);
    });

    it('should mark include, extends, and block nodes as linked child buffers', function () {
      const ast = analyzeTemplateSource(
        '{% extends parentTemplate %}' +
        '{% include includeTemplate %}' +
        '{% block body %}{{ value }}{% endblock %}',
        'linked-child-buffer-surfaces.njk'
      );

      const includeNode = collectNodesByType(ast, 'Include')[0];
      const extendsNode = collectNodesByType(ast, 'Extends')[0];
      const blockNode = collectNodesByType(ast, 'Block')[0];

      expect(includeNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(includeNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(extendsNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(extendsNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(blockNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(blockNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(includeNode._analysis.boundaryLinkedChains || [])).to.eql(['__text__']);
      expect(Array.from(extendsNode._analysis.boundaryLinkedChains || [])).to.eql(['__text__']);
      expect(Array.from(blockNode._analysis.boundaryLinkedChains || [])).to.eql([]);
      expect(Array.from(blockNode._analysis.mutatedChains || [])).to.eql(['__text__']);
    });

    it('should derive inline-if boundary links for parent-owned command effects', function () {
      const ast = analyzeScriptSource([
        'data result',
        'var item = result.push("a") if flag else ""',
        'return result.snapshot()'
      ].join('\n'), 'inline-if-linked-analysis.casc');
      const inlineIfNode = collectNodesByType(ast, 'InlineIf')[0];

      expect(inlineIfNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(inlineIfNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(inlineIfNode._analysis.boundaryLinkedChains || [])).to.eql(['result']);
      expect(Array.from(inlineIfNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['result']);
    });

    it('should classify component binding side-lane work as parent-visible mutation facts', function () {
      const ast = analyzeScriptSource([
        'component "Component.script" as ns',
        'var selected = ns.theme if true else "fallback"',
        'return selected'
      ].join('\n'), 'component-binding-chain-facts.casc');
      const inlineIfNode = collectNodesByType(ast, 'InlineIf')[0];

      expect(Array.from(inlineIfNode._analysis.observedChainsFromParent || [])).to.eql([]);
      expect(Array.from(inlineIfNode._analysis.mutatedChainsFromParent || [])).to.eql(['ns']);
      expect(Array.from(inlineIfNode._analysis.boundaryLinkedChains || [])).to.eql(['ns']);
      expect(Array.from(inlineIfNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['ns']);
    });

    it('should keep dynamic keys visible inside operation-owned chain paths', function () {
      const ast = analyzeScriptSource([
        'data result',
        'var key = "items"',
        'result[key].push("a")',
        'return result.snapshot()'
      ].join('\n'), 'dynamic-key-chain-command-facts.casc');
      const keySymbols = collectNodesByType(ast, 'Symbol').filter((node) => node.value === 'key');
      const command = collectNodesByType(ast, 'ChainCommand')[0]._analysis;

      expect(keySymbols.some((node) => node._analysis.operationOwnedPath)).to.be(false);
      expect(keySymbols.some((node) => node._analysis.lookupDeclaration?.name === 'key')).to.be(true);
      expect(command.observedChains.has('key')).to.be(true);
      expect(command.mutatedChains.has('result')).to.be(true);
      expect(command.usedChains.has('key')).to.be(true);
      expect(command.usedChains.has('result')).to.be(true);
    });

    it('should keep dynamic keys visible inside operation-owned component paths', function () {
      const ast = analyzeScriptSource([
        'component "Component.script" as ns',
        'var method = "build"',
        'var selected = ns[method]() if true else "fallback"',
        'return selected'
      ].join('\n'), 'dynamic-key-component-call-facts.casc');
      const inlineIfNode = collectNodesByType(ast, 'InlineIf')[0];
      const methodSymbols = collectNodesByType(ast, 'Symbol').filter((node) => node.value === 'method');

      expect(methodSymbols.some((node) => node._analysis.operationOwnedPath)).to.be(false);
      expect(methodSymbols.some((node) => node._analysis.lookupDeclaration?.name === 'method')).to.be(true);
      expect(Array.from(inlineIfNode._analysis.observedChainsFromParent || [])).to.eql(['method']);
      expect(Array.from(inlineIfNode._analysis.mutatedChainsFromParent || [])).to.eql(['ns']);
      expect(sortedChainNames(inlineIfNode._analysis.boundaryLinkedChains)).to.eql(['method', 'ns']);
      expect(Array.from(inlineIfNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['ns']);
    });

    it('should observe nested shared-var sets without observing shared data sets', function () {
      const ast = analyzeScriptSource([
        'shared var theme',
        'shared data state',
        'this.theme.name = "dark"',
        'this.state.count = 1',
        'return null'
      ].join('\n'), 'shared-set-observation-facts.casc');
      const sets = collectNodesByType(ast, 'Set');
      const sharedVarSet = sets[0]._analysis;
      const sharedDataSet = sets[1]._analysis;

      expect(Array.from(sharedVarSet.observedChains || [])).to.eql(['$theme']);
      expect(Array.from(sharedVarSet.mutatedChains || [])).to.eql(['$theme']);
      expect(Array.from(sharedDataSet.observedChains || [])).to.eql([]);
      expect(Array.from(sharedDataSet.mutatedChains || [])).to.eql(['$state']);
    });

    it('should derive caller invocation links from analysis-owned caller facts', function () {
      const ast = analyzeTemplateSource(
        '{% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}' +
        '{% set x = "v" %}' +
        '{% call wrap("span") %}X{{ x }}Y{% endcall %}',
        'caller-linked-analysis.njk'
      );
      const macroNode = collectNodesByType(ast, 'Macro')[0];
      const callerNode = collectNodesByType(ast, 'Caller')[0];

      expect(macroNode._analysis.hasCallerSupport).to.be(true);
      expect(callerNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(callerNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(callerNode._analysis.boundaryLinkedChains || [])).to.eql(['x']);
      expect(Array.from(callerNode._analysis.declaredChains.keys())).to.eql(['caller', '__return__', '__text__']);
    });

    it('should mark recovery scopes as scope buffers without marking guard body scopes', function () {
      const ast = analyzeScriptSource([
        'data result',
        'guard result',
        '  var local = fail()',
        'recover err',
        '  result.recovered = err.message',
        'endguard',
        'return result.snapshot()'
      ].join('\n'), 'guard-recovery-scope-buffer-analysis.casc');
      const guardNode = collectNodesByType(ast, 'Guard')[0];
      const recoveryNode = collectNodesByType(ast, 'Guard.Recover')[0];

      expect(guardNode.body._analysis.createScope).to.be(true);
      expect(guardNode.body._analysis.createsScopeBuffer).to.be(false);
      expect(recoveryNode._analysis.createScope).to.be(true);
      expect(recoveryNode._analysis.wantsLinkedChildBuffer).to.be(false);
      expect(recoveryNode._analysis.createsScopeBuffer).to.be(true);
      expect(recoveryNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(Array.from(recoveryNode._analysis.boundaryLinkedChains || [])).to.eql(['result']);
      expect(Array.from(recoveryNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['result']);
    });

    it('should keep loop and include-owned facts local inside captures', function () {
      const ast = analyzeTemplateSource(
        '{% set outer %}' +
        '{% for item in items %}{{ loop.index }}{{ item }}{% endfor %}' +
        '{% include includeTemplate %}' +
        '{% var local = "local" %}{{ local }}' +
        '{% endset %}',
        'capture-loop-include-linked-analysis.njk'
      );
      const captureNode = collectNodesByType(ast, 'Capture')[0];

      expect(Array.from(captureNode._analysis.boundaryLinkedChains || [])).to.eql([]);
      expect(captureNode._analysis.usedChains.has('loop')).to.be(false);
      expect(captureNode._analysis.usedChains.has('item')).to.be(false);
      expect(captureNode._analysis.usedChains.has('includeTemplate')).to.be(false);
    });

    it('should not mark scope-isolated macro or root nodes as linked child buffers', function () {
      const ast = analyzeTemplateSource(
        '{% macro plain(x) %}{{ x }}{% endmacro %}{{ plain("v") }}',
        'scope-boundary-linked-analysis.njk'
      );
      const macroNode = collectNodesByType(ast, 'Macro')[0];

      expect(ast._analysis.wantsLinkedChildBuffer).to.be(false);
      expect(ast._analysis.createsLinkedChildBuffer).to.be(false);
      expect(ast._analysis.boundaryLinkedChains).to.be(null);
      expect(macroNode._analysis.hasCallerSupport).to.be(false);
      expect(macroNode._analysis.wantsLinkedChildBuffer).to.be(false);
      expect(macroNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(macroNode._analysis.boundaryLinkedChains).to.be(null);
    });

    it('should derive short-circuit expression links only when command effects are present', function () {
      const valueOnlyAst = analyzeTemplateSource(
        '{% set x = "a" %}{{ x and "b" }}{{ x or "c" }}{{ "a" if x else "b" }}',
        'value-only-short-circuit-analysis.njk'
      );
      const valueAndNode = collectNodesByType(valueOnlyAst, 'And')[0];
      const valueOrNode = collectNodesByType(valueOnlyAst, 'Or')[0];
      const valueInlineIfNode = collectNodesByType(valueOnlyAst, 'InlineIf')[0];

      expect(valueAndNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(valueAndNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueAndNode._analysis.boundaryLinkedChains).to.be(null);
      expect(valueAndNode._analysis.boundaryLinkedMutatedChains).to.be(null);
      expect(valueOrNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(valueOrNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueOrNode._analysis.boundaryLinkedChains).to.be(null);
      expect(valueOrNode._analysis.boundaryLinkedMutatedChains).to.be(null);
      expect(valueInlineIfNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(valueInlineIfNode._analysis.createsLinkedChildBuffer).to.be(false);
      expect(valueInlineIfNode._analysis.boundaryLinkedChains).to.be(null);
      expect(valueInlineIfNode._analysis.boundaryLinkedMutatedChains).to.be(null);

      const commandEffectAst = analyzeScriptSource([
        'data result',
        'var a = flag and result.push("a")',
        'var b = flag or result.push("b")',
        'return result.snapshot()'
      ].join('\n'), 'effectful-short-circuit-analysis.casc');
      const commandAndNode = collectNodesByType(commandEffectAst, 'And')[0];
      const commandOrNode = collectNodesByType(commandEffectAst, 'Or')[0];

      expect(commandAndNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(commandAndNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(commandAndNode._analysis.boundaryLinkedChains || [])).to.eql(['result']);
      expect(Array.from(commandAndNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['result']);
      expect(commandOrNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(commandOrNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(commandOrNode._analysis.boundaryLinkedChains || [])).to.eql(['result']);
      expect(Array.from(commandOrNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['result']);
    });

    it('should preserve literal/interpolation parity and source ordering', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString('A{{ one() }}B{{ two() }}C', {
        one: async () => '1',
        two: async () => '2'
      });
      expect(result).to.equal('A1B2C');
    });

    it('should preserve loop/conditional output parity', async function () {
      const env = new AsyncEnvironment();
      const result = await env.renderTemplateString(
        '{% for n in nums %}{% if n % 2 === 0 %}E{{ n }}{% else %}O{{ n }}{% endif %}|{% endfor %}',
        { nums: [1, 2, 3, 4] }
      );
      expect(result).to.equal('O1|E2|O3|E4|');
    });

    it('should preserve macro/call/set-block parity', async function () {
      const env = new AsyncEnvironment();
      const template = `
        {% macro wrap(tag) %}<{{ tag }}>{{ caller() }}</{{ tag }}>{% endmacro %}
        {% set captured %}X{{ value }}Y{% endset %}
        {% call wrap("span") %}{{ captured }}{% endcall %}
      `;
      const result = await env.renderTemplateString(template, { value: 'v' });
      expect(result.replace(/\s+/g, '')).to.equal('<span>XvY</span>');
    });

    it('should preserve include/import/extends parity', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);

      loader.addTemplate('base.njk', 'B[{% block body %}{% endblock %}]');
      loader.addTemplate('part.njk', '<i>{{ value }}</i>');
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');
      loader.addTemplate(
        'child.njk',
        '{% extends "base.njk" %}{% block body %}{% import "macros.njk" as m %}{% include "part.njk" with value %} {{ m.hi(user) }}{% endblock %}'
      );

      const result = await env.renderTemplate('child.njk', { value: 'V', user: 'U' });
      expect(result.replace(/\s+/g, ' ').trim()).to.equal('B[<i>V</i> Hi U]');
    });

    it('should keep canonical include input keys for duplicated branch-local vars', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('child.njk', '[{{ scopedValue }}]');

      const tmpl = new AsyncTemplate(`
        {% if flag %}
          {% var scopedValue = "A" %}
          {% include "child.njk" with scopedValue %}
        {% else %}
          {% var scopedValue = "B" %}
          {% include "child.njk" with scopedValue %}
        {% endif %}
      `, env, 'branch-include-shadow.njk');

      expect((await tmpl.render({ flag: true })).trim()).to.be('[A]');
      expect((await tmpl.render({ flag: false })).trim()).to.be('[B]');
    });

    it('should render async import with context and explicit inputs', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi() %}{{ theme }} {{ name }} {{ localName }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% var localName = "hidden" %}{% import "macros.njk" as m with context, theme %}{{ m.hi() }}',
        env,
        'import-with-context-and-vars.njk'
      );

      const result = await tmpl.render({ theme: 'dark', name: 'Ada' });
      expect(result).to.be('dark Ada ');
    });

    it('should keep canonical exported names for from-import bindings renamed in local scopes', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro show() %}Hi{% endmacro %}');

      const tmpl = new AsyncTemplate(`
        {% if usePrimary %}
          {% from "macros.njk" import show %}
          {{ show() }}
        {% else %}
          {% from "macros.njk" import show %}
          {{ show() }}
        {% endif %}
      `, env, 'from-import-canonical-export-name.njk');

      expect((await tmpl.render({ usePrimary: true })).trim()).to.be('Hi');
      expect((await tmpl.render({ usePrimary: false })).trim()).to.be('Hi');
    });

    it('should resolve deferred exports through the normal render path', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const result = await env.renderTemplateString('{% import "macros.njk" as m %}{{ m.hi("x") }}');
      expect(result).to.be('Hi x');
    });

    it('should return the exported namespace before async exported values settle', async function () {
      const env = new AsyncEnvironment();
      let resolveValue;
      const pendingValue = new Promise((resolve) => {
        resolveValue = resolve;
      });
      env.addGlobal('slowValue', () => pendingValue);
      const tmpl = new AsyncTemplate('{% set x = slowValue() %}', env, 'deferred-export-namespace.njk');

      const exported = tmpl.getExported({});
      expect(exported).to.have.key('x');
      expect(typeof exported.then).to.be('undefined');
      expect(exported.x && typeof exported.x.then).to.be('function');

      const first = await Promise.race([
        Promise.resolve().then(() => 'exported'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 0))
      ]);
      expect(first).to.be('exported');

      resolveValue('ready');
      expect(await exported.x).to.be('ready');
    });

    it('should reject an early returned exported value when its chain fails', async function () {
      const env = new AsyncEnvironment();
      env.addGlobal('failValue', () => {
        throw new Error('export failed');
      });
      const tmpl = new AsyncTemplate('{% set x = failValue() %}', env, 'failed-deferred-export.njk');

      const exported = tmpl.getExported({});
      expect(exported).to.have.key('x');

      try {
        await exported.x;
        expect().fail('Expected exported value to reject');
      } catch (err) {
        expect(err.message).to.contain('export failed');
      }
    });

    it('should keep inherited text placement boundaries out of shared invocation lanes', async function () {
      const createRootBuffer = () => {
        const rootBuffer = new runtime.CommandBuffer(null, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
        runtime.declareBufferChain(rootBuffer, '__text__', 'text', null, null);
        runtime.declareBufferChain(rootBuffer, 'theme', 'var', null, null);
        rootBuffer.addCommand(new runtime.VarCommand({
          chainName: 'theme',
          args: ['dark'],
          errorContext: TEST_EC
        }), 'theme');
        return rootBuffer;
      };

      const blockedRoot = createRootBuffer();
      // This sibling buffer represents the incorrect text-placement boundary
      // shape: linking it into the shared lane creates an earlier source-order
      // slot that the invocation snapshot must wait behind.
      const sharedLaneSibling = new runtime.CommandBuffer(null, null, ['theme'], blockedRoot, null, TEST_DIAGNOSTIC_CONTEXT);
      const invocationBuffer = new runtime.CommandBuffer(null, null, ['theme'], blockedRoot, null, TEST_DIAGNOSTIC_CONTEXT);
      const blockedRead = invocationBuffer.addCommand(new runtime.SnapshotCommand({
        chainName: 'theme',
        errorContext: TEST_EC
      }), 'theme');
      let blockedReadSettled = false;
      blockedRead.then(() => {
        blockedReadSettled = true;
      });

      await Promise.resolve();
      expect(blockedReadSettled).to.be(false);
      sharedLaneSibling.finish();
      invocationBuffer.finish();
      blockedRoot.finish();
      expect(await blockedRead).to.be('dark');

      const textRoot = createRootBuffer();
      const textPlacementBoundary = new runtime.CommandBuffer(null, null, ['__text__'], textRoot, null, TEST_DIAGNOSTIC_CONTEXT);
      const admittedInvocation = new runtime.CommandBuffer(null, null, ['theme'], textRoot, null, TEST_DIAGNOSTIC_CONTEXT);
      const admittedRead = admittedInvocation.addCommand(new runtime.SnapshotCommand({
        chainName: 'theme',
        errorContext: TEST_EC
      }), 'theme');

      expect(await admittedRead).to.be('dark');
      textPlacementBoundary.finish();
      admittedInvocation.finish();
      textRoot.finish();
    });

    it('should keep individual exported value failures independent', async function () {
      const env = new AsyncEnvironment();
      env.addGlobal('failA', () => {
        throw new Error('export failed A');
      });
      env.addGlobal('failB', () => {
        throw new Error('export failed B');
      });
      const tmpl = new AsyncTemplate([
        '{% set a = failA() %}',
        '{% set b = failB() %}'
      ].join(''), env, 'multi-failed-deferred-export.njk');

      const exported = tmpl.getExported({});
      const results = await Promise.allSettled([exported.a, exported.b]);

      expect(results[0].status).to.be('rejected');
      expect(results[0].reason.message).to.contain('export failed A');
      expect(results[1].status).to.be('rejected');
      expect(results[1].reason.message).to.contain('export failed B');
    });

    it('should keep individual resolved exports usable while sibling exports fail', async function () {
      const env = new AsyncEnvironment();
      env.addGlobal('failValue', () => {
        throw new Error('root export value failed');
      });
      const tmpl = new AsyncTemplate([
        '{% macro ok() %}OK{% endmacro %}',
        '{% set x = failValue() %}'
      ].join(''), env, 'resolved-export-with-failed-sibling.njk');

      const exported = tmpl.getExported({});
      const ok = await exported.ok;
      expect(typeof ok).to.be('function');

      try {
        await exported.x;
        expect().fail('Expected failed exported value to reject');
      } catch (err) {
        expect(err.message).to.contain('root export value failed');
      }
    });

    it('should export root script chains through final snapshots', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('chains.script', [
        'text log',
        'data result',
        'log("hello")',
        'result.user.name = "Ada"'
      ].join('\n'));

      const rendered = await env.renderScriptString([
        'import "chains.script" as lib',
        'return { log: lib.log, result: lib.result }'
      ].join('\n'));

      expect(rendered).to.eql({
        log: 'hello',
        result: { user: { name: 'Ada' } }
      });
    });

    it('should keep observed vs unobserved async errors behavior', async function () {
      const env = new AsyncEnvironment();
      const context = {
        bad: async () => {
          throw new Error('boom');
        }
      };

      const safeResult = await env.renderTemplateString('{% if false %}{{ bad() }}{% endif %}ok', context);
      expect(safeResult).to.equal('ok');

      try {
        await env.renderTemplateString('{{ bad() }}', context);
        expect().fail('Expected observed error');
      } catch (err) {
        expect(err.message).to.contain('boom');
      }
    });

    it('should keep imported member calls working through imported namespaces', async function () {
      const ast = analyzeTemplateSource(
        '{% import "macros.njk" as m %}{{ m.hi("x") }}',
        'imported-member-boundary.njk'
      );
      const importedCall = collectNodesByType(ast, 'FunCall')
        .find((node) => node._analysis.importedCallable);

      expect(importedCall._analysis.wantsLinkedChildBuffer).to.be(true);

      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m %}{{ m.hi("x") }}',
        env,
        'imported-member-boundary.njk'
      );
      const result = await tmpl.render({});

      expect(result).to.be('Hi x');
    });

    it('should not treat a macro parameter shadowing a from-import binding as imported callable', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro foo(name) %}Foo {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% from "macros.njk" import foo %}{% macro use(foo) %}{{ foo("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-from-import-call.njk'
      );
      const result = await tmpl.render({
        helper(name) {
          return 'Helper ' + name;
        }
      });

      expect(result).to.be('Helper x');
    });

    it('should not treat a macro parameter shadowing an imported namespace as imported callable', async function () {
      const loader = new StringLoader();
      const env = new AsyncEnvironment(loader);
      loader.addTemplate('macros.njk', '{% macro hi(name) %}Hi {{ name }}{% endmacro %}');

      const tmpl = new AsyncTemplate(
        '{% import "macros.njk" as m %}{% macro use(m) %}{{ m("x") }}{% endmacro %}{{ use(helper) }}',
        env,
        'shadowed-import-namespace-call.njk'
      );
      const result = await tmpl.render({
        helper(name) {
          return 'Helper ' + name;
        }
      });

      expect(result).to.be('Helper x');
    });

  });
}());
