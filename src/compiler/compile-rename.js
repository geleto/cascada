'use strict';

const nodes = require('../nodes');

class CompileRename {
  constructor(compiler) {
    this.compiler = compiler;
    this.loopCounter = 0;
  }

  run(rootNode) {
    if (!rootNode) {
      return;
    }

    this._walk(rootNode, null);

    if (this.compiler.analysis) {
      this.compiler.analysis._finalizeDeclarations(rootNode);
      this.compiler.analysis._finalizeOutputUsage(rootNode);
    }
  }

  _nextLoopRuntimeName() {
    if (this.compiler && this.compiler.idPool && typeof this.compiler.idPool.next === 'function') {
      return `loop#${this.compiler.idPool.next()}`;
    }
    this.loopCounter += 1;
    return `loop#${this.loopCounter}`;
  }

  _renameOutputName(name, binding) {
    if (!name || name !== 'loop' || !binding || binding.kind !== 'loop') {
      return name;
    }
    return binding.runtimeName;
  }

  _renameOutputList(values, binding) {
    if (!Array.isArray(values) || values.length === 0) {
      return values;
    }
    for (let i = 0; i < values.length; i++) {
      values[i] = this._renameOutputName(values[i], binding);
    }
    return values;
  }

  _applyLocalRenames(node, binding) {
    if (!node || !node._analysis) {
      return;
    }
    this._renameOutputList(node._analysis.uses, binding);
    this._renameOutputList(node._analysis.mutates, binding);
    this._renameOutputList(node._analysis.declaresInParent, binding);
  }

  _enterScope(node, parentBinding) {
    const analysis = node && node._analysis ? node._analysis : null;
    if (!analysis || !analysis.createScope) {
      return parentBinding;
    }

    const localDeclares = Array.isArray(analysis.declares) ? analysis.declares : [];
    let nextBinding = parentBinding;
    let hasUserLoopShadow = false;

    for (let i = 0; i < localDeclares.length; i++) {
      const decl = localDeclares[i];
      if (!decl) {
        continue;
      }
      if (decl.isLoopMeta) {
        if (!node.loopRuntimeName) {
          node.loopRuntimeName = this._nextLoopRuntimeName();
        }
        decl.name = node.loopRuntimeName;
        nextBinding = {
          kind: 'loop',
          runtimeName: node.loopRuntimeName
        };
        continue;
      }
      if (decl.name === 'loop') {
        hasUserLoopShadow = true;
      }
    }

    if (hasUserLoopShadow) {
      nextBinding = {
        kind: 'shadow'
      };
    }

    return nextBinding;
  }

  _renameSymbol(node, binding) {
    if (!(node instanceof nodes.Symbol) || node.value !== 'loop') {
      return;
    }
    if (node.isCompilerInternal || (node._analysis && node._analysis.declarationTarget)) {
      return;
    }
    if (!binding || binding.kind !== 'loop') {
      return;
    }
    node.value = binding.runtimeName;
  }

  _walkChildren(node, binding, fieldBindingFn) {
    node.fields.forEach((field) => {
      this._walk(node[field], fieldBindingFn(field, binding));
    });
  }

  _walk(node, binding) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this._walk(node[i], binding);
      }
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }

    this._applyLocalRenames(node, binding);
    this._renameSymbol(node, binding);

    if (node instanceof nodes.For || node instanceof nodes.AsyncEach || node instanceof nodes.AsyncAll) {
      const scopeBinding = this._enterScope(node, binding);
      this._walkChildren(node, binding, (field, parentBinding) => {
        if (field === 'body') {
          return scopeBinding;
        }
        return parentBinding;
      });
      return;
    }

    if (node instanceof nodes.While) {
      const scopeBinding = this._enterScope(node, binding);
      this._walkChildren(node, binding, (field, parentBinding) => {
        if (field === 'cond' || field === 'body') {
          return scopeBinding;
        }
        return parentBinding;
      });
      return;
    }

    const childBinding = this._enterScope(node, binding);
    this._walkChildren(node, childBinding, (_field, scopeBinding) => scopeBinding);
  }
}

module.exports = CompileRename;
