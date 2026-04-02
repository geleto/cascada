'use strict';

const nodes = require('../nodes');
const {
  validateGuardVariablesDeclared,
  validateChannelDeclarationNode
} = require('./validation');
const CompilerBaseAsync = require('./compiler-base-async');
const CompileBuffer = require('./buffer');

const RETURN_CHANNEL_NAME = '__return__';

class CompilerAsync extends CompilerBaseAsync {
  init(templateName, options) {
    super.init(Object.assign({}, options, { asyncMode: true, templateName }));
  }

  analyzeCallExtension(node) {
    if (this.scriptMode) {
      return {};
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    return textChannel
      ? { uses: [textChannel], mutates: [textChannel] }
      : {};
  }

  compileCallExtension(node) {
    this._compileAsyncCallExtension(node, false);
  }

  _compileAsyncCallExtension(node, async) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var resolveArgs = node.resolveArgs;
    const positionNode = args || node;

    const emitCallArgs = (extId) => {
      if ((args && args.children.length) || contentArgs.length) {
        this.emit(',');
      }

      if (args) {
        if (!(args instanceof nodes.NodeList)) {
          this.fail('compileCallExtension: arguments must be a NodeList, use `parser.parseSignature`', node.lineno, node.colno, node);
        }

        args.children.forEach((arg, i) => {
          if (!resolveArgs) {
            this.emit('runtime.normalizeFinalPromise(');
            this._compileExpression(arg, null);
            this.emit(')');
          } else {
            this._compileExpression(arg, null);
          }

          if (i !== args.children.length - 1 || contentArgs.length) {
            this.emit(',');
          }
        });
      }

      if (contentArgs.length) {
        contentArgs.forEach((arg, i) => {
          if (i > 0) {
            this.emit(',');
          }

          if (arg) {
            if (!resolveArgs) {
              this.emit('runtime.normalizeFinalPromise(');
              this.emit._compileAsyncRenderBoundary(node, function () {
                this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
                this.compile(arg, null);
              }, arg);
              this.emit(')');
            } else {
              this.emit.line('function(cb) {');
              this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

              this.emit.withScopedSyntax(() => {
                this.emit._compileAsyncCallbackRenderBoundary(node, function () {
                  this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
                  this.compile(arg, null);
                }, 'cb', arg);
                this.emit.line(';');
              });

              this.emit.line('}');
            }
          } else {
            this.emit('null');
          }
        });
      }
    };

    const ext = this._tmpid();
    this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
    const returnId = this._tmpid();
    this.emit(`let ${returnId} = `);
    if (!async) {
      if (!resolveArgs) {
        this.emit(`${ext}["${node.prop}"](context`);
      } else {
        this.emit(`runtime.resolveArguments(${ext}["${node.prop}"].bind(${ext}), 1)(context`);
      }
    } else {
      if (!resolveArgs) {
        this.emit(`runtime.promisify(${ext}["${node.prop}"].bind(${ext}))(context`);
      } else {
        this.emit(`runtime.resolveArguments(runtime.promisify(${ext}["${node.prop}"].bind(${ext})), 1)(context`);
      }
    }
    emitCallArgs(ext);
    this.emit(')');
    this.emit.line(';');
    const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, positionNode, true);
    this.emit.line(`${this.buffer.currentBuffer}.add(${textCmdExpr}, "${this.buffer.currentTextChannelName}");`);
  }

  analyzeCallAssign(node, analysisPass) {
    return this.analyzeSet(node, analysisPass);
  }

  analyzeSet(node, analysisPass) {
    const declares = [];
    const mutates = [];
    const isDeclaration = node.varType === 'declaration';
    const targets = node.targets;
    if (this.scriptMode) {
      switch (node.varType) {
        case 'declaration':
        case 'assignment':
          break;
        default:
          this.fail(`Unknown varType '${node.varType}' for set/var statement.`, node.lineno, node.colno, node);
      }
    } else if (node.varType !== 'assignment' && node.varType !== 'declaration') {
      this.fail(`'${node.varType}' is not allowed in template mode. Use 'set' or declaration tags.`, node.lineno, node.colno, node);
    }
    if (node.body) {
      node.body._analysis = { createScope: true };
    }
    targets.forEach((target) => {
      if (target instanceof nodes.Symbol) {
        target._analysis = { declarationTarget: true };
        const name = target.value;
        const shouldDeclareImplicitTemplateVar = !this.scriptMode &&
          !isDeclaration &&
          !analysisPass.findDeclaration(node._analysis, name);
        if (isDeclaration || shouldDeclareImplicitTemplateVar) {
          declares.push({ name, type: 'var', initializer: null, explicit: !!isDeclaration });
        } else {
          mutates.push(name);
        }
      }
    });
    return {
      declares,
      mutates
    };
  }

  analyzeExtern(node) {
    if (!this.analysis.isRootScopeOwner(node._analysis)) {
      this.fail(
        'extern declarations are only allowed at the root scope',
        node.lineno,
        node.colno,
        node
      );
    }

    const declares = [];

    (node.targets || []).forEach((target) => {
      if (target instanceof nodes.Symbol) {
        target._analysis = { declarationTarget: true };
        declares.push({
          name: target.value,
          type: 'var',
          initializer: null,
          explicit: true,
          extern: true,
          hasFallback: !!node.value
        });
      }
    });

    return { declares };
  }

  compileExtern(node) {
    // Root externs are initialized centrally in the async root entry.
    // The declaration node itself does not emit body code.
  }

  compileSet(node) {
    const ids = [];
    const isDeclarationOnly = !!node.declarationOnly;
    const exportFromRootScope = this.analysis.isRootScopeOwner(node._analysis);

    node.targets.forEach((target) => {
      const name = target.value;
      const visibleDeclaration = this.analysis.findDeclaration(node._analysis, name);
      const isOwnDeclaration = !!(visibleDeclaration && visibleDeclaration.declarationOrigin === node._analysis);

      if (isOwnDeclaration) {
        this.emit(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "var", context, null);`);
      } else if (!(visibleDeclaration && visibleDeclaration.type === 'var')) {
        this.fail(
          `Compiler error: analysis did not resolve a visible var declaration for '${name}'.`,
          target.lineno,
          target.colno,
          node,
          target
        );
      }

      const id = this._tmpid();
      this.emit.line(`let ${id};`);
      ids.push(id);
    });

    let hasAssignedValue = false;
    if (node.path) {
      if (ids.length !== 1) {
        this.fail('set_path only supports a single target.', node.lineno, node.colno, node);
      }
      const targetName = node.targets[0].value;
      const pathValueId = this._tmpid();
      this.emit(`let ${pathValueId} = `);
      this.compileExpression(node.value, null, node.value);
      this.emit.line(';');
      this.emit(ids[0] + ' = ');
      this.emit('runtime.setPath(');
      this.buffer.emitAddRawSnapshot(targetName, node);
      this.emit(', ');
      this._compileAggregate(node.path, null, '[', ']', false, false);
      this.emit(', ');
      this.emit(pathValueId);
      this.emit(')');
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.value && !isDeclarationOnly) {
      this.emit(ids.join(' = ') + ' = ');
      this.compileExpression(node.value, null, node.value);
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.body) {
      this.emit(ids.join(' = ') + ' = ');
      this.compile(node.body, null);
      this.emit.line(';');
      hasAssignedValue = true;
    }

    node.targets.forEach((target, i) => {
      const name = target.value;
      const valueId = ids[i];

      if (hasAssignedValue) {
        this.emit.line(`${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${name}', args: [${valueId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${name}');`);
      }

      if (name.charAt(0) !== '_' && hasAssignedValue && exportFromRootScope) {
        this.emit.line(`context.addDeferredExport("${name}", "${name}", ${this.buffer.currentBuffer});`);
      }
    });
  }

  compileCallAssign(node) {
    this.compileSet(node);
  }

  _analyzeLoopNodeDeclarations(node, analysisPass, declarationsInBody = false) {
    if (node.name instanceof nodes.Symbol) {
      node.name._analysis = { declarationTarget: true };
    } else if (node.name instanceof nodes.Array || node.name instanceof nodes.NodeList) {
      node.name.children.forEach((child) => {
        child._analysis = { declarationTarget: true };
      });
    }
    const declares = [];
    const declaredNames = analysisPass._extractSymbols(node.name);
    declaredNames.forEach((name) => {
      declares.push({ name, type: 'var', initializer: null });
    });
    if (!declaredNames.includes('loop')) {
      declares.push({ name: 'loop', type: 'var', initializer: null, internal: true, isLoopMeta: true });
    }
    if (node.concurrentLimit) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        waitedOutputName: node.body._analysis && node.body._analysis.waitedOutputName
          ? node.body._analysis.waitedOutputName
          : `__waited__${this._tmpid()}`
      });
    }
    if (declarationsInBody) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        createScope: true,
        loopOwner: node,
        declares
      });
      if (node.else_) {
        node.else_._analysis = Object.assign({}, node.else_._analysis, {
          createScope: true
        });
      }
      return {};
    }
    return { createScope: true, declares };
  }

  analyzeWhile(node, analysisPass) {
    const result = this._analyzeLoopNodeDeclarations(node, analysisPass);
    if (node.body) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        waitedOutputName: (node.body._analysis && node.body._analysis.waitedOutputName)
          ? node.body._analysis.waitedOutputName
          : `__waited__${this._tmpid()}`
      });
    }
    return result;
  }

  compileWhile(node) {
    this.loop.compileAsyncWhile(node);
  }

  analyzeFor(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass, true);
  }

  compileFor(node) {
    this.loop.compileAsyncFor(node);
  }

  analyzeAsyncEach(node, analysisPass) {
    const result = this._analyzeLoopNodeDeclarations(node, analysisPass, true);
    if (node.body) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        waitedOutputName: (node.body._analysis && node.body._analysis.waitedOutputName)
          ? node.body._analysis.waitedOutputName
          : `__waited__${this._tmpid()}`
      });
    }
    return result;
  }

  compileAsyncEach(node) {
    this.loop.compileAsyncEach(node);
  }

  analyzeAsyncAll(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass, true);
  }

  compileAsyncAll(node) {
    this.loop.compileAsyncAll(node);
  }

  analyzeSwitch(node) {
    if (node.default) {
      node.default._analysis = { createScope: true };
    }
    return {};
  }

  analyzeCase(node) {
    return { createScope: true };
  }

  compileSwitch(node) {
    this.buffer._compileAsyncControlFlowBoundary(node, () => {
      let catchPoisonPos;

      this.emit('try {');
      this.emit('const switchResult = ');
      this._compileAwaitedExpression(node.expr, null);
      this.emit(';');
      this.emit('');
      this.emit('switch (switchResult) {');

      node.cases.forEach((c) => {
        this.emit('case ');
        this._compileAwaitedExpression(c.cond, null);
        this.emit(': ');

        if (c.body.children.length) {
          this.compile(c.body, null);
          this.emit.line('break;');
        }
      });

      if (node.default) {
        this.emit('default: ');
        this.compile(node.default, null);
      }

      this.emit('}');

      const errorCtx = this._createErrorContext(node, node.expr);
      this.emit('} catch (e) {');
      this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorCtx.lineno}, ${errorCtx.colno}, "${errorCtx.errorContextString}", context.path);`);
      catchPoisonPos = this.codebuf.length;
      this.emit('');
      this.emit('}');

      const allChannels = new Set();
      node.cases.forEach((c) => {
        (c.body._analysis.usedChannels || []).forEach(ch => allChannels.add(ch));
      });
      if (node.default) {
        (node.default._analysis.usedChannels || []).forEach(ch => allChannels.add(ch));
      }

      for (const channelName of allChannels) {
        this.emit.insertLine(
          catchPoisonPos,
          `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${channelName}");`
        );
      }
    });
  }

  analyzeGuard(node) {
    node.body._analysis = { createScope: true };
    if (node.recoveryBody) {
      const recoveryAnalysis = { createScope: true };
      if (typeof node.errorVar === 'string' && node.errorVar) {
        recoveryAnalysis.declares = [{ name: node.errorVar, type: 'var', initializer: null }];
      } else if (node.errorVar instanceof nodes.Symbol) {
        node.errorVar._analysis = { declarationTarget: true };
        recoveryAnalysis.declares = [{ name: node.errorVar.value, type: 'var', initializer: null }];
      }
      node.recoveryBody._analysis = recoveryAnalysis;
    }
    return {};
  }

  compileGuard(node) {
    const guardTargets = this._getGuardTargets(node);
    const variableTargetsAll = guardTargets.variableTargetsAll;
    const variableValidationTargets = guardTargets.variableValidationTargets;
    const hasSequenceTargets = !!guardTargets.sequenceTargets;
    const needsGuardState = variableTargetsAll || hasSequenceTargets;
    const guardStateVar = needsGuardState ? this._tmpid() : null;
    validateGuardVariablesDeclared(variableValidationTargets, this, node);

    this.buffer._compileAsyncControlFlowBoundary(node, () => {
      const previousGuardDepth = this.guardDepth;
      this.guardDepth = previousGuardDepth + 1;

      try {
        this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
        let guardRepairLinePos = null;
        const channelGuardInitLinePos = this.codebuf.length;
        let channelGuardStateVar = null;
        this.emit.line('');
        if (guardStateVar) {
          this.emit.line(`const ${guardStateVar} = runtime.guard.init(cb);`);
        }
        guardRepairLinePos = this.codebuf.length;
        this.emit.line('');

        this.compile(node.body, null);

        const resolvedSequenceTargets = new Set();
        const modifiedLocks = new Set();
        const bodyUsedChannels = Array.from(node.body._analysis.usedChannels || []);
        bodyUsedChannels.forEach((channelName) => {
          if (channelName && channelName.startsWith('!')) {
            modifiedLocks.add(channelName);
          }
        });

        const shouldGuardAllSequencesImplicitly =
          variableTargetsAll &&
          (!node.sequenceTargets || node.sequenceTargets.length === 0);

        if (node.sequenceTargets && node.sequenceTargets.length > 0) {
          for (const target of node.sequenceTargets) {
            let matchFound = false;

            if (target === '!') {
              for (const lock of modifiedLocks) {
                resolvedSequenceTargets.add(lock);
                matchFound = true;
              }
            } else {
              const baseKey = '!' + target.slice(0, -1);

              for (const lock of modifiedLocks) {
                if (lock === baseKey || lock.startsWith(baseKey + '!')) {
                  resolvedSequenceTargets.add(lock);
                  matchFound = true;
                }
              }

              if (!matchFound) {
                this.fail(`guard sequence lock "${target}" is not modified inside guard`, node.lineno, node.colno, node);
              }
            }
          }
        } else if (shouldGuardAllSequencesImplicitly) {
          for (const lock of modifiedLocks) {
            resolvedSequenceTargets.add(lock);
          }
        }

        if (resolvedSequenceTargets.size > 0) {
          this.emit.insertLine(
            guardRepairLinePos,
            `runtime.guard.repairSequenceOutputs(${this.buffer.currentBuffer}, ${guardStateVar}, ${JSON.stringify(Array.from(resolvedSequenceTargets))});`
          );
        }

        let guardChannels = this._getGuardedChannelNames(
          bodyUsedChannels,
          guardTargets,
          node.body._analysis
        );
        if (resolvedSequenceTargets.size > 0) {
          const merged = new Set(guardChannels);
          for (const lockName of resolvedSequenceTargets) {
            merged.add(lockName);
          }
          guardChannels = Array.from(merged);
        }
        const bodyDeclaredChannels = Array.from((node.body._analysis.declaredChannels || new Map()).keys());
        if (bodyDeclaredChannels.length > 0) {
          const merged = new Set(guardChannels);
          for (const name of bodyDeclaredChannels) {
            merged.add(name);
          }
          guardChannels = Array.from(merged);
        }
        if (guardChannels.length > 0) {
          channelGuardStateVar = this._tmpid();
          this.emit.insertLine(
            channelGuardInitLinePos,
            `const ${channelGuardStateVar} = runtime.guard.initChannelSnapshots(${JSON.stringify(guardChannels)}, ${this.buffer.currentBuffer}, cb);`
          );
        }

        const guardErrorsVar = this._tmpid();
        this.emit.line(
          `const ${guardErrorsVar} = await runtime.guard.finalizeGuard(${guardStateVar || 'null'}, ${this.buffer.currentBuffer}, ${JSON.stringify(guardChannels)}, ${channelGuardStateVar || 'null'});`
        );
        this.emit.line(`if (${guardErrorsVar}.length > 0) {`);

        if (node.recoveryBody) {
          if (node.errorVar) {
            this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${node.errorVar}", "var", context, null);`);
            this.emit.line(
              `${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${node.errorVar}', args: [new runtime.PoisonError(${guardErrorsVar})], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${node.errorVar}');`
            );
          }
          this.compile(node.recoveryBody, null);
        }

        this.emit.line('} else {');
        this.emit.line('}');
      } finally {
        this.guardDepth = previousGuardDepth;
      }
    });
  }

  _getGuardedChannelNames(usedChannels, guardTargets, analysis) {
    let used = [];
    if (usedChannels instanceof Set) {
      used = Array.from(usedChannels);
    } else if (Array.isArray(usedChannels)) {
      used = usedChannels;
    }

    if (!guardTargets) {
      return [];
    }

    if (guardTargets.channelSelector === '*') {
      return used;
    }

    const hasNamedChannels = Array.isArray(guardTargets.channelSelector) && guardTargets.channelSelector.length > 0;
    const hasTypedChannels = Array.isArray(guardTargets.typeTargets) && guardTargets.typeTargets.length > 0;
    if (hasNamedChannels || hasTypedChannels) {
      const guardedSet = new Set(hasNamedChannels ? guardTargets.channelSelector : []);
      if (!this.scriptMode && guardedSet.has('text')) {
        guardedSet.add(this.buffer.currentTextChannelName);
      }
      const guardedTypes = new Set(hasTypedChannels ? guardTargets.typeTargets : []);
      return used.filter((name) => {
        if (guardedSet.has(name)) {
          return true;
        }
        if (guardedTypes.size === 0) {
          return false;
        }
        const channelDecl = this.analysis.findDeclaration(analysis, name);
        if (channelDecl) {
          return guardedTypes.has(channelDecl.type);
        }
        if (!this.scriptMode && name === this.buffer.currentTextChannelName && guardedTypes.has('text')) {
          return true;
        }
        return guardedTypes.has(name);
      });
    }

    if (guardTargets.variableTargetsAll) {
      return used.filter((name) => {
        if (name && name.charAt(0) === '!') {
          return false;
        }
        const channelDecl = this.analysis.findDeclaration(analysis, name);
        return !!(channelDecl && channelDecl.type === 'var');
      });
    }

    if (!guardTargets.hasAnySelectors) {
      return used;
    }

    return [];
  }

  _getGuardTargets(guardNode) {
    const channelTargetsRaw = Array.isArray(guardNode && guardNode.channelTargets) &&
      guardNode.channelTargets.length > 0
      ? guardNode.channelTargets
      : null;
    let channelSelector = !channelTargetsRaw
      ? null
      : (channelTargetsRaw.includes('@') ? '*' : channelTargetsRaw);
    const typeTargets = Array.isArray(guardNode && guardNode.typeTargets) && guardNode.typeTargets.length > 0
      ? guardNode.typeTargets
      : null;

    const variableTargetsRaw = guardNode && guardNode.variableTargets === '*'
      ? '*'
      : (Array.isArray(guardNode && guardNode.variableTargets) && guardNode.variableTargets.length > 0
        ? guardNode.variableTargets
        : null);
    const variableTargetsAll = variableTargetsRaw === '*';
    const hasVariableTargetsSelector = variableTargetsRaw !== null;
    const variableValidationTargets = [];

    if (Array.isArray(variableTargetsRaw) && variableTargetsRaw.length > 0) {
      const resolvedChannels = new Set(Array.isArray(channelSelector) ? channelSelector : []);

      for (const name of variableTargetsRaw) {
        const channelDecl = this.analysis.findDeclaration(guardNode._analysis, name);
        const isDeclaredVar = !!(channelDecl && channelDecl.type === 'var');

        if (isDeclaredVar) {
          variableValidationTargets.push(name);
        }
        if (channelDecl) {
          resolvedChannels.add(name);
        }
        if (!this.scriptMode && !isDeclaredVar && !channelDecl && name === 'text') {
          resolvedChannels.add(this.buffer.currentTextChannelName);
          continue;
        }
        if (!isDeclaredVar && !channelDecl) {
          variableValidationTargets.push(name);
        }
      }

      if (channelSelector !== '*') {
        channelSelector = resolvedChannels.size > 0 ? Array.from(resolvedChannels) : null;
      }
    }
    const sequenceTargets = Array.isArray(guardNode && guardNode.sequenceTargets) && guardNode.sequenceTargets.length > 0
      ? guardNode.sequenceTargets
      : null;

    const hasAnySelectors = !!channelSelector || !!typeTargets || hasVariableTargetsSelector || !!sequenceTargets;

    return {
      channelSelector,
      typeTargets,
      variableTargetsAll,
      variableValidationTargets: variableValidationTargets.length > 0 ? variableValidationTargets : null,
      sequenceTargets,
      hasAnySelectors
    };
  }

  analyzeIf(node) {
    node.body._analysis = { createScope: true };
    if (node.else_) {
      node.else_._analysis = { createScope: true };
    }
    return {};
  }

  compileIf(node) {
    this.buffer._compileAsyncControlFlowBoundary(node, () => {
      let catchPoisonPos;
      const condResultId = this._tmpid();

      this.emit('try {');
      this.emit(`const ${condResultId} = `);
      this._compileAwaitedExpression(node.cond, null);
      this.emit(';');
      this.emit('');
      this.emit(`if (${condResultId}) {`);
      this.compile(node.body, null);
      this.emit('} else {');
      if (node.else_) {
        this.compile(node.else_, null);
      }
      this.emit('}');

      const errorContext = this._createErrorContext(node, node.cond);
      this.emit('} catch (e) {');
      this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorContext.lineno}, ${errorContext.colno}, "${errorContext.errorContextString}", context.path);`);
      catchPoisonPos = this.codebuf.length;
      this.emit('');
      this.emit('}');

      const trueBranchChannels = new Set(node.body._analysis.usedChannels || []);
      const falseBranchChannels = node.else_
        ? new Set(node.else_._analysis.usedChannels || [])
        : new Set();
      const allBranchChannels = new Set([...trueBranchChannels, ...falseBranchChannels]);

      for (const channelName of allBranchChannels) {
        this.emit.insertLine(
          catchPoisonPos,
          `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${channelName}");`
        );
      }
    });
  }

  analyzeCapture(node) {
    return {
      createScope: true,
      scopeBoundary: false,
      textOutput: `${CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL}${this._tmpid()}`
    };
  }

  compileCapture(node) {
    if (this.scriptMode) {
      this.fail('Capture blocks are only supported in template mode', node.lineno, node.colno, node);
    }

    this.boundaries.compileCaptureBoundary(
      this.buffer,
      node,
      function() {
        this.compile(node.body, null);
      },
      node.body
    );
  }

  analyzeOutput(node) {
    const textChannel = !this.scriptMode
      ? this.analysis.getCurrentTextChannel(node._analysis)
      : null;
    return this.scriptMode ? {}
      : {
        uses: [textChannel],
        mutates: [textChannel]
      };
  }

  compileOutput(node) {
    if (this.scriptMode) {
      this.fail(
        'Script mode does not support template output nodes. Use declared channels and command instead.',
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }
    const textChannelName = this.buffer.currentTextChannelName;
    node.children.forEach((child) => {
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          this.buffer.addToBuffer(node, null, function() {
            this.compileLiteral(child, null);
          }, child, textChannelName, true);
        }
        return;
      }
      if (child._analysis?.mutatedChannels?.size > 0) {
        this.boundaries.compileAsyncTextBoundary(
          this.buffer,
          node,
          child,
          () => {
            this.compileExpression(child, null, child);
          },
          { emitInCurrentBuffer: true }
        );
      } else {
        const returnId = this._tmpid();
        this.emit.line(`let ${returnId};`);
        this.emit(`${returnId} = `);
        this.compileExpression(child, null, child);
        this.emit.line(';');
        const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, child, true);
        this.emit.line(`${this.buffer.currentBuffer}.add(${textCmdExpr}, "${textChannelName}");`);
      }
    });
  }

  compileDo(node) {
    node.children.forEach((child) => {
      this.compileExpression(child, null, child);
      this.emit.line(';');
    });
  }

  compileReturn(node) {
    const resultVar = this._tmpid();
    this.emit(`let ${resultVar} = `);
    if (node.value) {
      this.compileExpression(node.value, null, node);
    } else {
      this.emit('undefined');
    }
    this.emit.line(';');
    this.emit.line(
      `${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${RETURN_CHANNEL_NAME}', args: [${resultVar}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), "${RETURN_CHANNEL_NAME}");`
    );
  }

  analyzeReturn() {
    return {
      mutates: [RETURN_CHANNEL_NAME]
    };
  }

  analyzeMacro(node) {
    return this.macro.analyzeMacro(node);
  }

  compileMacro(node) {
    this.macro.compileAsyncMacro(node);
  }

  analyzeImport(node) {
    node.target._analysis = { declarationTarget: true };
    this.importedBindings.add(node.target.value);
    return {
      declares: [{ name: node.target.value, type: 'var', initializer: null, imported: true }]
    };
  }

  compileImport(node) {
    this.inheritance.compileAsyncImport(node);
  }

  analyzeFromImport(node) {
    const declares = [];
    node.names.children.forEach((nameNode) => {
      if (nameNode instanceof nodes.Pair && nameNode.value instanceof nodes.Symbol) {
        nameNode.value._analysis = { declarationTarget: true };
        this.importedBindings.add(nameNode.value.value);
        declares.push({ name: nameNode.value.value, type: 'var', initializer: null, imported: true });
      } else if (nameNode instanceof nodes.Symbol) {
        nameNode._analysis = { declarationTarget: true };
        this.importedBindings.add(nameNode.value);
        declares.push({ name: nameNode.value, type: 'var', initializer: null, imported: true });
      }
    });
    return { declares };
  }

  compileFromImport(node) {
    this.inheritance.compileAsyncFromImport(node);
  }

  analyzeBlock(node) {
    return { createScope: true, scopeBoundary: false, parentReadOnly: true };
  }

  compileBlock(node) {
    this.inheritance.compileAsyncBlock(node);
  }

  compileSuper(node) {
    this.inheritance.compileAsyncSuper(node);
  }

  analyzeChannelDeclaration(node) {
    node.name._analysis = { declarationTarget: true };
    const name = node.name.value;
    return {
      declares: [{ name, type: node.channelType, initializer: node.initializer || null }],
      uses: [name]
    };
  }

  compileChannelDeclaration(node) {
    const channelType = node.channelType;
    const nameNode = node.name;
    validateChannelDeclarationNode(this, {
      node,
      nameNode,
      channelType,
      hasInitializer: !!node.initializer,
      asyncMode: this.asyncMode,
      scriptMode: this.scriptMode,
      isNameSymbol: nameNode instanceof nodes.Symbol
    });
    const name = nameNode.value;

    this.emit(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "${channelType}", context, `);
    if (channelType === 'sink' || channelType === 'sequence') {
      this.compile(node.initializer, null);
    } else {
      this.emit('null');
    }
    this.emit.line(');');

    if (channelType === 'var' && node.initializer) {
      const initNode = node.initializer;
      const lineno = initNode.lineno !== undefined ? initNode.lineno : node.lineno;
      const colno = initNode.colno !== undefined ? initNode.colno : node.colno;
      const initValueId = this._tmpid();
      this.emit(`let ${initValueId} = `);
      this.compileExpression(initNode, null, initNode);
      this.emit.line(';');
      this.emit.line(`${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${name}', args: [${initValueId}], pos: {lineno: ${lineno}, colno: ${colno}} }), '${name}');`);
    }
  }

  analyzeChannelCommand(node) {
    const callNode = node.call instanceof nodes.FunCall ? node.call : null;
    const path = this.sequential._extractStaticPath(callNode ? callNode.name : node.call);
    if (!path || path.length === 0) {
      return {};
    }
    const channelName = path[0];
    const channelDecl = channelName ? this.analysis.findDeclaration(node._analysis, channelName) : null;
    const isSequenceGet = !callNode && channelDecl && channelDecl.type === 'sequence';
    const isObservation = isSequenceGet ||
      (callNode && path.length === 2 &&
       (path[1] === 'snapshot' || path[1] === 'isError' || path[1] === 'getError'));
    return isObservation ? { uses: [channelName] } : { uses: [channelName], mutates: [channelName] };
  }

  compileChannelCommand(node) {
    this.buffer.compileChannelCommand(node);
  }

  analyzeExtends(node) {
    return {
      uses: ['__parentTemplate'],
      mutates: ['__parentTemplate']
    };
  }

  compileExtends(node) {
    this.inheritance.compileAsyncExtends(node);
  }

  analyzeInclude(node) {
    if (this.scriptMode) {
      return {};
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    return {
      uses: textChannel ? [textChannel] : [],
      mutates: textChannel ? [textChannel] : []
    };
  }

  compileInclude(node) {
    this.inheritance.compileAsyncInclude(node);
  }

  finalizeAnalyzeRoot(node) {
    const externSpec = this._collectRootExternSpec(node);
    this._validateRootExternFallbackOrder(node, externSpec);
    return { externSpec };
  }

  emitDeclareReturnChannel(bufferExpr) {
    this.emit.line(
      `runtime.declareBufferChannel(${bufferExpr}, "${RETURN_CHANNEL_NAME}", "var", context, runtime.RETURN_UNSET);`
    );
  }

  emitReturnChannelSnapshot(bufferExpr, positionNode, resultVar) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    this.emit.line(
      `const ${resultVar}_snapshot = ${bufferExpr}.addSnapshot("${RETURN_CHANNEL_NAME}", {lineno: ${lineno}, colno: ${colno}});`
    );
    this.emit.line(`${bufferExpr}.markFinishedAndPatchLinks();`);
    this.emit.line(`let ${resultVar} = ${resultVar}_snapshot.then((value) => value === runtime.RETURN_UNSET ? undefined : value);`);
  }

  _emitAsyncRootFinalParentLookup() {
    if (this.hasExtends) {
      this.emit.line(`  let finalParent = await runtime.channelLookup("__parentTemplate", ${this.buffer.currentBuffer});`);
    } else {
      this.emit.line('  let finalParent = null;');
    }
  }

  _emitScriptRootLeafResult(node) {
    const returnVar = this._tmpid();
    this.emitReturnChannelSnapshot(this.buffer.currentBuffer, node, returnVar);
    this.emit.line(`    cb(null, runtime.normalizeFinalPromise(await ${returnVar}));`);
  }

  _emitAsyncTemplateRootLeafResult() {
    this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`    cb(null, await ${this.buffer.currentTextChannelVar}.finalSnapshot());`);
  }

  _emitAsyncRootCompletion(node) {
    this.emit.line('if (!compositionMode) {');
    this.emit.line('(async () => {');
    this._emitAsyncRootFinalParentLookup();
    this.emit.line('  if(finalParent) {');
    this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line('    finalParent.rootRenderFunc(env, context.forkForPath(finalParent.path), runtime, cb, compositionMode);');
    this.emit.line('  } else {');

    if (this.scriptMode) {
      this._emitScriptRootLeafResult(node);
    } else {
      this._emitAsyncTemplateRootLeafResult();
    }

    this.emit.line('  }');
    this.emit.line('})().catch(e => {');
    this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this._generateErrorContext(node)}", context.path);`);
    this.emit.line('  cb(err);');
    this.emit.line('});');
    this.emit.line('} else {');
    this.emit.line(`  ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`  return ${this.buffer.currentBuffer};`);
    this.emit.line('}');
  }

  _getRootExternNodes(node) {
    return (node.children || []).filter((child) => child instanceof nodes.Extern);
  }

  _collectRootExternSpec(node) {
    return this._getRootExternNodes(node).map((externNode) => ({
      names: (externNode.targets || []).map((target) => target.value),
      required: !externNode.value,
      hasFallback: !!externNode.value
    }));
  }

  _validateRootExternFallbackOrder(node, externSpec) {
    const orderedExternNames = [];
    externSpec.forEach((entry) => {
      (entry.names || []).forEach((name) => orderedExternNames.push(name));
    });
    const externIndexByName = new Map();
    orderedExternNames.forEach((name, index) => externIndexByName.set(name, index));

    this._getRootExternNodes(node).forEach((externNode) => {
      if (!externNode.value || !externNode.targets || externNode.targets.length !== 1) {
        return;
      }

      const currentName = externNode.targets[0].value;
      const currentIndex = externIndexByName.get(currentName);
      const referencedSymbolNodes = (externNode.value instanceof nodes.Symbol)
        ? [externNode.value]
        : externNode.value.findAll(nodes.Symbol);
      const referencedSymbols = referencedSymbolNodes
        .filter((symbolNode) => !(symbolNode._analysis && symbolNode._analysis.declarationTarget))
        .map((symbolNode) => symbolNode.value);

      referencedSymbols.forEach((name) => {
        if (!externIndexByName.has(name)) {
          return;
        }
        if (externIndexByName.get(name) > currentIndex) {
          this.fail(
            `extern fallback for '${currentName}' cannot reference later extern '${name}'`,
            externNode.lineno,
            externNode.colno,
            externNode,
            externNode.value
          );
        }
      });
    });
  }

  _emitRootExternInitialization(node) {
    const externNodes = this._getRootExternNodes(node);

    externNodes.forEach((externNode) => {
      (externNode.targets || []).forEach((target) => {
        const name = target.value;
        this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "var", context, null);`);
      });
    });

    externNodes.forEach((externNode) => {
      if (!externNode.targets || externNode.targets.length === 0) {
        return;
      }

      externNode.targets.forEach((target) => {
        const name = target.value;
        const valueId = this._tmpid();
        const hasCtxId = this._tmpid();

        this.emit.line(`const ${hasCtxId} = Object.prototype.hasOwnProperty.call(context.ctx, "${name}");`);
        this.emit.line(`let ${valueId};`);
        this.emit.line(`if (${hasCtxId}) {`);
        this.emit.line(`  ${valueId} = context.ctx["${name}"];`);
        this.emit.line('} else {');
        if (externNode.value) {
          this.emit(`  ${valueId} = `);
          this.compileExpression(externNode.value, null, externNode.value);
          this.emit.line(';');
        } else {
          this.emit.line(`  throw new Error('Missing required extern: ${name}');`);
        }
        this.emit.line('}');
        this.emit.line(`context.setVariable("${name}", ${valueId});`);
        this.emit.line(`${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${name}', args: [${valueId}], pos: {lineno: ${externNode.lineno}, colno: ${externNode.colno}} }), '${name}');`);
      });
    });
  }

  _compileAsyncRootBody(node) {
    this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
    this.emit.line(`context.linkDeferredExportsToBuffer(${this.buffer.currentBuffer});`);
    if (this.scriptMode) {
      this.emitDeclareReturnChannel(this.buffer.currentBuffer);
    }
    const sequenceLocks = Array.isArray(node._analysis && node._analysis.sequenceLocks)
      ? node._analysis.sequenceLocks
      : [];
    for (const name of sequenceLocks) {
      this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "sequential_path", context, null);`);
    }
    if (this.hasStaticExtends && !this.hasDynamicExtends) {
      this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "__parentTemplate", "var", context, null);`);
    }
    this._emitRootExternInitialization(node);
    this._compileChildren(node, null);
    this.emit.line('context.resolveExports(output);');
    this._emitAsyncRootCompletion(node);
  }

  _compileAsyncBlockEntry(block) {
    const name = block.name.value;
    const blockLinkedChannels = Array.from(block.body._analysis.usedChannels || [])
      .filter((hname) => hname !== CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL);
    this.emit.beginEntryFunction(block, `b_${name}`, blockLinkedChannels);
    this.emit.line(`context = context.forkForPath(${JSON.stringify(this.templateName)});`);
    this.compile(block.body, null);
    this.emit.line(`${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`return ${this.buffer.currentTextChannelVar}.finalSnapshot();`);
    this.emit.endEntryFunction(block, true);
  }

  _compileAsyncBlockEntries(node) {
    const blockNames = [];
    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block) => {
      const name = block.name.value;

      if (blockNames.indexOf(name) !== -1) {
        this.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.push(name);
      this._compileAsyncBlockEntry(block);
    });

    return blocks;
  }

  _compileAsyncRoot(node) {
    this.emit.beginEntryFunction(node, 'root');
    this._compileAsyncRootBody(node);
    this.emit.endEntryFunction(node, true);
    this.inBlock = true;
    return this._compileAsyncBlockEntries(node);
  }

  analyzeRoot(node) {
    const declares = this._getRootDeclarations(node);
    const sequenceLocks = Array.isArray(node._analysis && node._analysis.sequenceLocks)
      ? node._analysis.sequenceLocks
      : [];
    sequenceLocks.forEach((lockName) => {
      declares.push({ name: lockName, type: 'sequential_path', initializer: null });
    });
    return {
      createScope: true,
      scopeBoundary: true,
      declares,
      textOutput: this._getRootTextOutput()
    };
  }

  compileRoot(node) {
    this.hasStaticExtends = node.children.some(child => child instanceof nodes.Extends);
    this.hasDynamicExtends = node.children.some(child =>
      child instanceof nodes.Set &&
      child.targets[0] &&
      child.targets[0].value === '__parentTemplate'
    );
    this.hasExtends = this.hasStaticExtends || this.hasDynamicExtends;
    const blocks = this._compileAsyncRoot(node);

    this.emit.line('return {');
    blocks.forEach((block) => {
      const blockName = `b_${block.name.value}`;
      this.emit.line(`${blockName}: ${blockName},`);
    });
    this.emit.line(`externSpec: ${JSON.stringify(node._analysis && node._analysis.externSpec ? node._analysis.externSpec : [])},`);
    this.emit.line('root: root\n};');
  }

  _getRootDeclarations(node) {
    const declares = [];
    if (this.scriptMode) {
      declares.push({ name: RETURN_CHANNEL_NAME, type: 'var', initializer: null, internal: true });
    } else {
      declares.push({ name: CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL, type: 'text', initializer: null });
    }

    if (!this.scriptMode) {
      const hasExtendsNode = node.children.some((child) => child instanceof nodes.Extends);
      const hasParentTemplateDeclaration = node.children.some((child) =>
        child instanceof nodes.Set &&
        child.varType === 'declaration' &&
        child.targets &&
        child.targets[0] &&
        child.targets[0].value === '__parentTemplate'
      );
      if (hasExtendsNode && !hasParentTemplateDeclaration) {
        declares.push({ name: '__parentTemplate', type: 'var', initializer: null, internal: true });
      }
    }

    return declares;
  }

  _getRootTextOutput() {
    return this.scriptMode ? null : CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;
  }
}

module.exports = CompilerAsync;
module.exports.CompilerAsync = CompilerAsync;
