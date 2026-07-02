import expect from 'expect.js';
import {parse} from '../../src/language/parser.js';
import {transform} from '../../src/language/transformer.js';
import {CompilerAsync} from '../../src/compiler/compiler.js';
import * as nodes from '../../src/language/nodes.js';
import {transpiler as scriptTranspiler} from '../../src/language/script-transpiler.js';
import {
  DECLARATION_IMPORT_KIND,
  isStoredDirectly
} from '../../src/compiler/declarations.js';

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
      'boundaryLinkedObservedChains',
      'boundaryLinkedMutatedChains'
    ];
    const supersetPairs = [
      ['observedChains', 'usedChains'],
      ['mutatedChains', 'usedChains'],
      ['observedChainsFromParent', 'usedChainsFromParent'],
      ['mutatedChainsFromParent', 'usedChainsFromParent'],
      ['boundaryLinkedObservedChains', 'boundaryLinkedChains'],
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
      declarations.forEach((declaration, name) => {
        if (!isStoredDirectly(declaration)) {
          target.add(name);
        }
      });
    }
  }

  function expectBroadUsedChainParity(ast) {
    collectAllNodes(ast).forEach((node) => {
      const analysis = node._analysis;
      const expectedUsed = new Set();
      addChainNames(expectedUsed, analysis.observedChains);
      addChainNames(expectedUsed, analysis.mutatedChains);
      addDeclaredChainNames(expectedUsed, analysis.declarations);

      const expectedUsedFromParent = new Set();
      addChainNames(expectedUsedFromParent, analysis.observedChainsFromParent);
      addChainNames(expectedUsedFromParent, analysis.mutatedChainsFromParent);

      expect(sortedChainNames(analysis.usedChains)).to.eql(sortedChainNames(expectedUsed));
      expect(sortedChainNames(analysis.usedChainsFromParent)).to.eql(sortedChainNames(expectedUsedFromParent));
    });
  }

  describe('Async analysis chain facts', function () {
    it('should infer this.__text__ as the template text chain', function () {
      const ast = analyzeTemplateSource('{% block body %}{{ this.__text__.snapshot() }}{{ this.theme }}{% endblock %}');
      const inferred = ast._analysis.inheritanceSharedDeclarations;
      const rootTextDeclares = ast._analysis.declareOnEnter
        .filter((declaration) => declaration.name === '__text__' && !declaration.shared);
      const blockNode = collectNodesByType(ast, 'Block')[0];

      expect(inferred.map((declaration) => [declaration.name, declaration.type])).to.eql([
        ['$__text__', 'text'],
        ['$theme', 'var']
      ]);
      expect(rootTextDeclares).to.have.length(1);
      expect(rootTextDeclares[0].type).to.be('text');
      expect(rootTextDeclares[0].shared).to.not.be(true);
      expect(blockNode._analysis.boundaryLinkedChains instanceof Set).to.be(true);
      expect(Array.from(blockNode._analysis.boundaryLinkedChains || [])).to.eql(['$__text__', '$theme']);
      expect(Array.from(blockNode._analysis.boundaryLinkedObservedChains || [])).to.eql(['$__text__', '$theme']);
      expect(blockNode._analysis.boundaryLinkedMutatedChains).to.be(null);
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

    it('should reject custom boundary-linked chain facts', function () {
      const opts = {
        asyncMode: true,
        scriptMode: false,
        idPool: createIdPool()
      };
      const compiler = new CompilerAsync('invalid-linked-chain-facts.njk', opts);
      const ast = transform(parse('{% if flag %}{{ x }}{% endif %}', [], opts), [], 'invalid-linked-chain-facts.njk', opts);
      compiler.postAnalyzeIf = () => ({
        boundaryLinkedChains: ['x'],
        boundaryLinkedObservedChains: ['x'],
        boundaryLinkedMutatedChains: ['x']
      });

      expect(() => compiler.analysis.run(ast)).to.throwException((err) => {
        expect(err.message).to.contain('Analysis fact \'boundaryLinkedChains\' is no longer supported');
        expect(err.message).to.contain('\'observes\', \'mutates\', \'declareOnEnter\', or \'declareOnExit\'');
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
        expect(err.message).to.contain('Analysis fact \'linkedChains\' is no longer supported');
        expect(err.message).to.contain('\'boundaryLinkedChains\'');
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
        expect(err.message).to.contain('Analysis fact \'uses\' is no longer supported');
        expect(err.message).to.contain('\'observes\', \'mutates\', \'declareOnEnter\', or \'declareOnExit\'');
      });
    });

    it('should use source-order declarations for lookup', function () {
      const ast = analyzeScriptSource(
        'var before = someVar\n' +
        'var someVar = "local"\n' +
        'return someVar',
        'source-visible-declarations.casc'
      );
      const rootAnalysis = ast._analysis;
      const someVarUses = collectNodesByType(ast, 'Symbol')
        .filter((node) => node.value === 'someVar' && !node._analysis.isSymbolTarget)
        .sort((left, right) => left.lineno - right.lineno || left.colno - right.colno);

      expect(someVarUses).to.have.length(2);
      expect(someVarUses[0]._analysis.visibleDeclarations.has('someVar')).to.be(false);
      expect(someVarUses[1]._analysis.visibleDeclarations.get('someVar').name).to.be('someVar');
      expect(rootAnalysis.visibleDeclarations instanceof Map).to.be(true);
      expect(rootAnalysis.visibleDeclarations.has('someVar')).to.be(false);
      expect(rootAnalysis.declarations.has('someVar')).to.be(true);
    });

    it('should keep callable declarations scope-visible without changing source lookup', function () {
      const ast = analyzeTemplateSource(
        '{{ later() }}{% macro later() %}L{% endmacro %}',
        'scope-visible-callables.njk'
      );
      const call = collectNodesByType(ast, 'FunCall')[0];
      const symbol = call.name;

      expect(symbol._analysis.visibleDeclarations.has('later')).to.be(false);
      expect(symbol._analysis.visibleCallableDeclarations.has('later')).to.be(true);
      expect(call._analysis.staticCallableCall.declaration.name).to.be('later');
      expect(call._analysis.staticCallableCall.localName).to.be('later');
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

      expect(root.declarations.has('declaredOnly')).to.be(true);
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

    it('should classify only command-backed chain declaration initializers as mutations', function () {
      const ast = analyzeScriptSource([
        'var x = 5',
        'data result = { a: 1 }',
        'text body = "hi"',
        'sequence logger = createLogger()',
        'return x'
      ].join('\n'), 'initialized-chain-facts.casc');
      const root = ast._analysis;

      expect(root.declarations.has('x')).to.be(true);
      expect(isStoredDirectly(root.declarations.get('x'))).to.be(true);
      expect(root.usedChains.has('x')).to.be(false);
      expect(root.mutatedChains.has('x')).to.be(false);
      expect(root.mutatedChains.has('result')).to.be(true);
      expect(root.mutatedChains.has('body')).to.be(true);
      expect(root.mutatedChains.has('logger')).to.be(false);
    });

    it('should preserve broad used-chain parent footprints for representative phase consumers', function () {
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
        '{% set value = "v" %}{% set value = value %}' +
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

      expect(Array.from(controlFlowAst._analysis.usedChains || [])).to.eql(['result', '__return__']);
      expect(Array.from(ifNode._analysis.usedChainsFromParent || [])).to.eql(['result']);
      expect(Array.from(ifNode.body._analysis.usedChainsFromParent || [])).to.eql(['result']);
      expect(Array.from(ifNode.else_._analysis.usedChainsFromParent || [])).to.eql([]);
      expect(Array.from(whileNode._analysis.usedChainsFromParent || [])).to.eql([]);
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
        '{% set x = "v" %}{% set x = x %}' +
        '{% set outer %}A{{ x }}{% set inner %}B{{ x }}{% endset %}C{% endset %}',
        'nested-capture-analysis.njk'
      );
      const captures = collectNodesByType(ast, 'Capture');
      const outer = captures[0]._analysis;
      const inner = captures[1]._analysis;

      expect(sortedChainNames(outer.observedChains)).to.eql(sortedChainNames(['x', outer.textOutput]));
      expect(Array.from(outer.usedChains || [])).to.eql([outer.textOutput, 'x']);
      expect(Array.from(outer.mutatedChains || [])).to.eql([outer.textOutput]);
      expect(sortedChainNames(inner.observedChains)).to.eql(sortedChainNames(['x', inner.textOutput]));
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

    it('should record capture snapshots as ordinary owned observations', function () {
      const ast = analyzeTemplateSource(
        '{% set x = "v" %}{% set x = x %}{% set captured %}A{{ x }}B{% endset %}{{ captured }}',
        'capture-owned-observation-analysis.njk'
      );
      const capture = collectNodesByType(ast, 'Capture')[0]._analysis;

      expect(Array.from(capture.observedChains || [])).to.contain(capture.textOutput);
      expect(Array.from(capture.boundaryLinkedChains || [])).to.eql(['x']);
      expect((capture.boundaryLinkedObservedChains || new Set()).has(capture.textOutput)).to.be(false);
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

      expect(sortedChainNames(outer.observedChains)).to.eql(sortedChainNames(['x', outer.textOutput]));
      expect(sortedChainNames(outer.usedChains)).to.eql(sortedChainNames(['x', outer.textOutput]));
      expect(Array.from(outer.mutatedChains || [])).to.eql(['x']);
      expect(sortedChainNames(inner.observedChains)).to.eql(sortedChainNames(['x', inner.textOutput]));
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
        '{% set x = "v" %}{% set x = x %}' +
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

    it('should derive inline-if boundary links for parent-owned observations', function () {
      const ast = analyzeScriptSource([
        'var result = 0',
        'var seen = result if result == 0 else 99',
        'result = 1',
        'return seen'
      ].join('\n'), 'inline-if-observed-linked-analysis.casc');
      const inlineIfNode = collectNodesByType(ast, 'InlineIf')[0];

      expect(inlineIfNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(inlineIfNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(inlineIfNode._analysis.observedChainsFromParent || [])).to.eql(['result']);
      expect(inlineIfNode._analysis.mutatedChainsFromParent).to.be(null);
      expect(Array.from(inlineIfNode._analysis.boundaryLinkedChains || [])).to.eql(['result']);
      expect(Array.from(inlineIfNode._analysis.boundaryLinkedObservedChains || [])).to.eql(['result']);
      expect(inlineIfNode._analysis.boundaryLinkedMutatedChains).to.be(null);
    });

    it('should derive and/or expression boundary links for parent-owned observations', function () {
      const ast = analyzeScriptSource([
        'var result = true',
        'var andSeen = result and result',
        'var orSeen = result or result',
        'result = false',
        'return { andSeen: andSeen, orSeen: orSeen }'
      ].join('\n'), 'short-circuit-observed-linked-analysis.casc');
      const andNode = collectNodesByType(ast, 'And')[0];
      const orNode = collectNodesByType(ast, 'Or')[0];

      [andNode, orNode].forEach((node) => {
        expect(node._analysis.wantsLinkedChildBuffer).to.be(true);
        expect(node._analysis.createsLinkedChildBuffer).to.be(true);
        expect(Array.from(node._analysis.observedChainsFromParent || [])).to.eql(['result']);
        expect(node._analysis.mutatedChainsFromParent).to.be(null);
        expect(Array.from(node._analysis.boundaryLinkedChains || [])).to.eql(['result']);
        expect(Array.from(node._analysis.boundaryLinkedObservedChains || [])).to.eql(['result']);
        expect(node._analysis.boundaryLinkedMutatedChains).to.be(null);
      });
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
      expect(keySymbols.some((node) => node._analysis.visibleDeclarations?.get('key')?.name === 'key')).to.be(true);
      expect((command.observedChains || new Set()).has('key')).to.be(false);
      expect(command.mutatedChains.has('result')).to.be(true);
      expect((command.usedChains || new Set()).has('key')).to.be(false);
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
      expect(methodSymbols.some((node) => node._analysis.visibleDeclarations?.get('method')?.name === 'method')).to.be(true);
      expect(Array.from(inlineIfNode._analysis.observedChainsFromParent || [])).to.eql([]);
      expect(Array.from(inlineIfNode._analysis.mutatedChainsFromParent || [])).to.eql(['ns']);
      expect(sortedChainNames(inlineIfNode._analysis.boundaryLinkedChains)).to.eql(['ns']);
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
        '{% set x = "v" %}{% set x = x %}' +
        '{% call wrap("span") %}X{{ x }}Y{% endcall %}',
        'caller-linked-analysis.njk'
      );
      const macroNode = collectNodesByType(ast, 'Macro')[0];
      const callerNode = collectNodesByType(ast, 'Caller')[0];

      expect(macroNode._analysis.hasCallerSupport).to.be(true);
      expect(callerNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(callerNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(callerNode._analysis.boundaryLinkedChains || [])).to.eql(['x']);
      expect(Array.from(callerNode._analysis.declarations.keys())).to.eql(['caller', '__return__', '__text__']);
    });

    it('should classify only direct caller calls as caller invocations', function () {
      const ast = analyzeTemplateSource(
        '{% macro wrap() %}{{ caller.foo() }}{% endmacro %}' +
        '{% call wrap() %}X{% endcall %}',
        'caller-member-analysis.njk'
      );
      const macroNode = collectNodesByType(ast, 'Macro')[0];
      const memberCall = collectNodesByType(ast, 'FunCall')
        .find((node) => node.name instanceof nodes.LookupVal);

      expect(macroNode._analysis.hasCallerSupport).to.be(false);
      expect(memberCall._analysis.macroCallerInvocation).to.be(false);
    });

    it('should keep precise macro argument variable facts owned by the macro body', function () {
      const ast = analyzeTemplateSource(
        '{% macro adjust(a, b=a) %}{% set b = b ~ "!" %}{{ b }}{% endmacro %}{{ adjust("x") }}',
        'macro-argument-var-chain-facts.njk'
      );
      const macro = collectNodesByType(ast, 'Macro')[0];
      const bodyFacts = macro.body._analysis;

      expect(Array.from(bodyFacts.observedChains || [])).to.not.contain('caller');
      expect(Array.from(bodyFacts.observedChains || [])).to.not.contain('a');
      expect(Array.from(bodyFacts.observedChains || [])).to.contain('b');
      expect(Array.from(bodyFacts.mutatedChains || [])).to.not.contain('caller');
      expect(Array.from(bodyFacts.mutatedChains || [])).to.not.contain('a');
      expect(Array.from(bodyFacts.mutatedChains || [])).to.contain('b');
      expect(Array.from(macro._analysis.boundaryLinkedChains || [])).to.eql([]);
    });

    it('should not observe macro arguments that have no default reads', function () {
      const ast = analyzeTemplateSource(
        '{% macro plain(a, b) %}ok{% endmacro %}{{ plain("x", "y") }}',
        'macro-default-free-argument-facts.njk'
      );
      const macro = collectNodesByType(ast, 'Macro')[0];
      const bodyFacts = macro.body._analysis;

      expect(Array.from(bodyFacts.observedChains || [])).to.not.contain('a');
      expect(Array.from(bodyFacts.observedChains || [])).to.not.contain('b');
      expect(Array.from(bodyFacts.mutatedChains || [])).to.not.contain('a');
      expect(Array.from(bodyFacts.mutatedChains || [])).to.not.contain('b');
    });

    it('should mark guard body and recovery as buffer-backed scopes', function () {
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
      expect(guardNode.body._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(guardNode.body._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Object.prototype.hasOwnProperty.call(guardNode.body._analysis, 'createsScopeBuffer')).to.be(false);
      expect(recoveryNode._analysis.createScope).to.be(true);
      expect(recoveryNode._analysis.wantsLinkedChildBuffer).to.be(true);
      expect(Object.prototype.hasOwnProperty.call(recoveryNode._analysis, 'createsScopeBuffer')).to.be(false);
      expect(recoveryNode._analysis.createsLinkedChildBuffer).to.be(true);
      expect(Array.from(recoveryNode._analysis.boundaryLinkedChains || [])).to.eql(['result']);
      expect(Array.from(recoveryNode._analysis.boundaryLinkedMutatedChains || [])).to.eql(['result']);
    });

    it('should keep guard-local command facts out of parent-linked facts', function () {
      const ast = analyzeScriptSource([
        'data result',
        'guard result',
        '  var local = "guard"',
        '  result.before = local',
        '  var failed = fail()',
        'recover err',
        '  result.error = err.message',
        'endguard',
        'return result.snapshot()'
      ].join('\n'), 'guard-local-command-facts.casc');
      const guardNode = collectNodesByType(ast, 'Guard')[0]._analysis;
      const bodyNode = collectNodesByType(ast, 'Guard')[0].body._analysis;
      const recoveryNode = collectNodesByType(ast, 'Guard.Recover')[0]._analysis;

      expect((bodyNode.observedChains || new Set()).has('local')).to.be(false);
      expect((bodyNode.mutatedChains || new Set()).has('local')).to.be(false);
      expect(isStoredDirectly(bodyNode.declarations.get('local'))).to.be(true);
      expect(isStoredDirectly(bodyNode.declarations.get('failed'))).to.be(true);
      expect((guardNode.observedChains || new Set()).has('local')).to.be(false);
      expect((guardNode.mutatedChains || new Set()).has('local')).to.be(false);
      expect(Object.prototype.hasOwnProperty.call(guardNode.guardFacts, 'bodyErrorChains')).to.be(false);
      expect((guardNode.boundaryLinkedChains || new Set()).has('local')).to.be(false);
      expect((recoveryNode.mutatedChains || new Set()).has('err')).to.be(true);
      expect((recoveryNode.boundaryLinkedChains || new Set()).has('err')).to.be(false);
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

    it('should keep direct macro names out of chain usage facts', function () {
      const ast = analyzeTemplateSource(
        '{% macro greet() %}{{ greet() }}{% endmacro %}{{ greet() }}',
        'direct-macro-chain-facts.njk'
      );
      const macroNode = collectNodesByType(ast, 'Macro')[0];
      const rootDecl = ast._analysis.declarations.get('greet');
      const macroCalls = collectNodesByType(ast, 'FunCall')
        .filter((node) => node.name.value === 'greet');

      expect(isStoredDirectly(rootDecl)).to.be(true);
      expect(rootDecl.type).to.be(undefined);
      expect(macroNode._analysis.declarations.has('greet')).to.be(false);
      expect(macroCalls).to.have.length(2);
      macroCalls.forEach((call) => {
        expect(call._analysis.staticCallableCall.declaration).to.be(rootDecl);
      });
      expect((ast._analysis.usedChains || new Set()).has('greet')).to.be(false);
      expect((ast._analysis.observedChains || new Set()).has('greet')).to.be(false);
      expect((ast._analysis.mutatedChains || new Set()).has('greet')).to.be(false);
      expect((macroNode._analysis.usedChains || new Set()).has('greet')).to.be(false);
      expect((macroNode._analysis.observedChains || new Set()).has('greet')).to.be(false);
      expect((macroNode._analysis.mutatedChains || new Set()).has('greet')).to.be(false);
    });

    it('should not treat var declaration initializers as mutations', function () {
      const ast = analyzeScriptSource([
        'var x = "value"',
        'return x'
      ].join('\n'), 'var-initializer-chain-facts.casc');
      const setNode = collectNodesByType(ast, 'Set')[0];
      const declaration = ast._analysis.declarations.get('x');

      expect(setNode._analysis.mutates).to.eql([]);
      expect(isStoredDirectly(declaration)).to.be(true);
      expect(declaration.jsVar).to.match(/^t_\d+$/);
      expect((ast._analysis.usedChains || new Set()).has('x')).to.be(false);
      expect((ast._analysis.observedChains || new Set()).has('x')).to.be(false);
      expect((ast._analysis.mutatedChains || new Set()).has('x')).to.be(false);
    });

    it('should keep vars chain-backed when nested branches mutate them', function () {
      const ast = analyzeScriptSource([
        'var x = 1',
        'if flag',
        '  x = 2',
        'endif',
        'return x'
      ].join('\n'), 'nested-var-mutation-chain-facts.casc');
      const declaration = ast._analysis.declarations.get('x');

      expect(isStoredDirectly(declaration)).to.be(false);
      expect(declaration.type).to.be('var');
      expect((ast._analysis.usedChains || new Set()).has('x')).to.be(true);
      expect((ast._analysis.mutatedChains || new Set()).has('x')).to.be(true);
    });

    it('should derive read-only macro arguments and loop variables to direct storage', function () {
      const macroAst = analyzeTemplateSource(
        '{% macro show(x, y = "ok") %}{{ x }}{{ y }}{% endmacro %}{{ show("a") }}',
        'direct-argument-chain-facts.njk'
      );
      const macroNode = collectNodesByType(macroAst, 'Macro')[0];
      const xDecl = macroNode._analysis.declarations.get('x');
      const yDecl = macroNode._analysis.declarations.get('y');

      expect(isStoredDirectly(xDecl)).to.be(true);
      expect(xDecl.jsVar).to.be('l_x');
      expect(isStoredDirectly(yDecl)).to.be(true);
      expect(yDecl.jsVar).to.be('l_y');
      expect((macroNode._analysis.usedChains || new Set()).has('x')).to.be(false);
      expect((macroNode._analysis.usedChains || new Set()).has('y')).to.be(false);

      const loopAst = analyzeTemplateSource(
        '{% for item in items %}{{ item }}{% endfor %}',
        'direct-loop-var-chain-facts.njk'
      );
      const forNode = collectNodesByType(loopAst, 'For')[0];
      const itemDecl = forNode.body._analysis.declarations.get('item');

      expect(isStoredDirectly(itemDecl)).to.be(true);
      expect(itemDecl.jsVar).to.be('item');
      expect((forNode.body._analysis.usedChains || new Set()).has('item')).to.be(false);
      expect((forNode.body._analysis.boundaryLinkedChains || new Set()).has('item')).to.be(false);
    });

    it('should skip expression control-flow links when no parent command lanes are present', function () {
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

    it('should mark imported member calls as linked child buffers', function () {
      const ast = analyzeTemplateSource(
        '{% import "macros.njk" as m %}{{ m.hi("x") }}',
        'imported-member-boundary.njk'
      );
      const importedCall = collectNodesByType(ast, 'FunCall')
        .find((node) => node._analysis.staticCallableCall?.kind === DECLARATION_IMPORT_KIND.NAMESPACE);
      const importDecl = ast._analysis.declarations.get('m');

      expect(isStoredDirectly(importDecl)).to.be(true);
      expect(importDecl.type).to.be(undefined);
      expect(importedCall._analysis.staticCallableCall.localPath).to.be('m.hi');
      expect(importedCall._analysis.wantsLinkedChildBuffer).to.be(true);
      expect((ast._analysis.usedChains || new Set()).has('m')).to.be(false);
      expect((ast._analysis.observedChains || new Set()).has('m')).to.be(false);
      expect((ast._analysis.mutatedChains || new Set()).has('m')).to.be(false);
    });

  });
}());
