'use strict';

const nodes = require('../nodes');

const RETURN_CHANNEL_NAME = '__return__';
const CALLER_SCHED_CHANNEL_NAME = '__caller__';

class CompileMacro {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentCallerBindingContext = null;
  }

  isDirectCallerCall(node) {
    return !!(
      this.compiler.asyncMode &&
      node._analysis.directCallerCall &&
      this.currentCallerBindingContext
    );
  }

  _emitCallerCallDispatch({ bufferId, node, frame }) {
    const compiler = this.compiler;
    const activeContext = this.currentCallerBindingContext;
    const argsId = compiler._tmpid();
    const errorContextJson = JSON.stringify(compiler._createErrorContext(node));

    // Direct caller() must register its invocation buffer and __caller__
    // waits in the current boundary, not from a later .then.
    compiler.emit('(() => {');
    compiler.emit(`let ${argsId} = `);
    compiler._compileAggregate(node.args, frame, '[', ']', false, false);
    compiler.emit.line(';');
    compiler.emit.line(`if (${activeContext.rawCallerVar} && ${activeContext.rawCallerVar}.isMacro) {`);

    const invocationBufferId = compiler._tmpid();
    const invocationFinishedId = compiler._tmpid();
    const invocationResultId = compiler._tmpid();
    compiler.emit.line(`let ${invocationBufferId} = runtime.createCommandBuffer(context, ${activeContext.allCallersBufferId}, ${activeContext.rawCallerVar}.__callerUsedChannels || null);`);
    compiler.emit.line(`let ${invocationFinishedId} = ${invocationBufferId}.getFinishedPromise();`);
    compiler.emit.line(`${bufferId}.add(new runtime.WaitResolveCommand({ channelName: "${CALLER_SCHED_CHANNEL_NAME}", args: [${invocationFinishedId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), "${CALLER_SCHED_CHANNEL_NAME}");`);
    compiler.emit.line(`let ${invocationResultId} = Promise.resolve(runtime.invokeMacro(${activeContext.rawCallerVar}, context, ${argsId}, ${invocationBufferId})).finally(() => ${invocationBufferId}.markFinishedAndPatchLinks());`);
    compiler.emit.line(`${bufferId}.add(new runtime.WaitResolveCommand({ channelName: "${CALLER_SCHED_CHANNEL_NAME}", args: [${invocationResultId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), "${CALLER_SCHED_CHANNEL_NAME}");`);
    compiler.emit.line(`return ${invocationResultId};`);
    compiler.emit.line('}');
    compiler.emit.line(`return runtime.callWrapAsync(${activeContext.rawCallerVar}, "caller", context, ${argsId}, ${errorContextJson}, ${bufferId});`);
    compiler.emit('})()');
  }

  analyzeCaller(node) {
    const compiledMacroFuncId = `macro_${this.compiler._tmpid()}`;
    const declares = [
      { name: 'caller', type: 'var', initializer: null },
      { name: RETURN_CHANNEL_NAME, type: 'var', initializer: null, internal: true }
    ];
    node.args.children.forEach((arg) => {
      if (arg instanceof nodes.Symbol) {
        arg._analysis = { declarationTarget: true };
        declares.push({ name: arg.value, type: 'var', initializer: null, macroParam: true });
      }
    });
    return {
      createScope: true,
      scopeBoundary: false,
      parentReadOnly: true,
      declares,
      compiledMacroFuncId
    };
  }

  // Return the parent-owned channels that a caller body may observe, so the
  // caller buffer can be linked only on those lanes.
  _getCallerParentVisibleUsedChannels(node) {
    const compiler = this.compiler;
    if (!compiler.asyncMode || !node) {
      return [];
    }
    const textChannelName = compiler.analysis && typeof compiler.analysis.getCurrentTextChannel === 'function'
      ? compiler.analysis.getCurrentTextChannel(node._analysis)
      : null;
    const used = Array.from(node._analysis.usedChannels || []);
    const declared = new Set((node._analysis.declaredChannels || new Map()).keys());
    return used.filter((name) => {
      if (!name || name === textChannelName) {
        return false;
      }
      const decl = compiler.analysis && compiler.analysis.findDeclaration
        ? compiler.analysis.findDeclaration(node._analysis, name)
        : null;
      if (name === RETURN_CHANNEL_NAME || (decl && decl.runtimeName === RETURN_CHANNEL_NAME)) {
        return false;
      }
      return !declared.has(name);
    });
  }

  compileCaller(node, frame) {
    const compiler = this.compiler;
    compiler.emit('(function (){');
    const funcId = this._compileMacro(node, frame, true);
    if (compiler.asyncMode) {
      const callerUsedChannels = this._getCallerParentVisibleUsedChannels(node);
      compiler.emit.line(`${funcId}.__callerUsedChannels = ${JSON.stringify(callerUsedChannels)};`);
    }
    compiler.emit(`return ${funcId};})()`);
  }

  analyzeMacro(node) {
    const declares = [];
    const declaresInParent = [];
    const compiledMacroFuncId = `macro_${this.compiler._tmpid()}`;
    declares.push({ name: RETURN_CHANNEL_NAME, type: 'var', initializer: null, internal: true });
    declares.push({ name: 'caller', type: 'var', initializer: null });
    node.args.children.forEach((arg) => {
      if (arg instanceof nodes.Symbol) {
        arg._analysis = { declarationTarget: true };
        declares.push({ name: arg.value, type: 'var', initializer: null, macroParam: true });
      } else if (arg instanceof nodes.Dict) {
        arg.children.forEach((pair) => {
          declares.push({ name: pair.key.value, type: 'var', initializer: null, macroParam: true });
        });
      }
    }, undefined, node);
    const macroDecl = { name: node.name.value, type: 'var', initializer: null, isMacro: true };
    const parentMacroDecl = { name: node.name.value, type: 'var', initializer: null, parentOwned: true, isMacro: true };
    declares.push(macroDecl);
    declaresInParent.push(parentMacroDecl);
    const hasCallerSupport = this._macroUsesCaller(node.body);
    const declaresExtra = hasCallerSupport
      ? [{ name: CALLER_SCHED_CHANNEL_NAME, type: 'var', initializer: null, internal: true }]
      : [];
    return {
      createScope: true,
      scopeBoundary: true,
      declares: declares.concat(declaresExtra),
      declaresInParent,
      hasCallerSupport,
      compiledMacroFuncId
    };
  }

  _macroUsesCaller(node) {
    if (!node) {
      return false;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (this._macroUsesCaller(node[i])) {
          return true;
        }
      }
      return false;
    }
    if (!(node instanceof nodes.Node)) {
      return false;
    }
    if (node instanceof nodes.FunCall && node.name) {
      const isCallerCall =
        (node.name instanceof nodes.Symbol && node.name.value === 'caller') ||
        this.compiler.sequential._extractStaticPathRoot(node.name) === 'caller';
      if (isCallerCall) {
        return true;
      }
    }
    for (let i = 0; i < node.fields.length; i++) {
      if (this._macroUsesCaller(node[node.fields[i]])) {
        return true;
      }
    }
    return false;
  }

  _parseMacroSignature(node) {
    const compiler = this.compiler;
    const args = [];
    let kwargs = null;

    node.args.children.forEach((arg, i) => {
      if (i === node.args.children.length - 1 && arg instanceof nodes.Dict) {
        kwargs = arg;
      } else {
        compiler.assertType(arg, nodes.Symbol);
        args.push(arg);
      }
    });

    return {
      args,
      kwargs,
      realNames: [...args.map((n) => `l_${n.value}`), 'kwargs'],
      argNames: args.map((n) => `"${n.value}"`),
      kwargNames: ((kwargs && kwargs.children) || []).map((n) => `"${n.key.value}"`)
    };
  }

  _emitCallerBindingValue({ bufferId, rawCallerVar, allCallersBufferId, positionNode }) {
    const compiler = this.compiler;
    const invocationBufferId = compiler._tmpid();
    const invocationArgsId = compiler._tmpid();
    const invocationFinishedId = compiler._tmpid();
    const invocationResultId = compiler._tmpid();
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;

    // See docs/code/caller.md for the full caller-boundary architecture.
    // The macro body can use caller(), but a particular invocation only has a
    // caller boundary when it was invoked through a call block.
    // Each caller() invocation gets its own child buffer under the macro-local
    // all-callers buffer so multiple invocations can schedule independently.
    compiler.emit(`(${rawCallerVar} && ${rawCallerVar}.isMacro ? function() {`);
    compiler.emit(`let ${invocationArgsId} = Array.prototype.slice.call(arguments);`);
    compiler.emit(`let ${invocationBufferId} = runtime.createCommandBuffer(context, ${allCallersBufferId}, ${rawCallerVar}.__callerUsedChannels || null);`);
    compiler.emit(`let ${invocationFinishedId} = ${invocationBufferId}.getFinishedPromise();`);
    compiler.emit(`${bufferId}.add(new runtime.WaitResolveCommand({ channelName: "${CALLER_SCHED_CHANNEL_NAME}", args: [${invocationFinishedId}], pos: {lineno: ${lineno}, colno: ${colno}} }), "${CALLER_SCHED_CHANNEL_NAME}");`);
    // __caller__ timing is owned only by caller invocation code. Track both:
    // 1. when this invocation child buffer stops receiving commands
    // 2. when the invocation's returned value settles
    compiler.emit(`let ${invocationResultId} = Promise.resolve(runtime.invokeMacro(${rawCallerVar}, context, ${invocationArgsId}, ${invocationBufferId})).finally(() => ${invocationBufferId}.markFinishedAndPatchLinks());`);
    compiler.emit(`${bufferId}.add(new runtime.WaitResolveCommand({ channelName: "${CALLER_SCHED_CHANNEL_NAME}", args: [${invocationResultId}], pos: {lineno: ${lineno}, colno: ${colno}} }), "${CALLER_SCHED_CHANNEL_NAME}");`);
    compiler.emit(`return ${invocationResultId};`);
    compiler.emit(`} : ${rawCallerVar})`);
  }

  _emitMacroCallerSetup({ bufferId, rawCallerVar, allCallersBufferId }) {
    const compiler = this.compiler;
    compiler.emit.line(`let ${rawCallerVar} = kwargs.caller;`);
    compiler.emit.line(`let ${allCallersBufferId} = null;`);
    // __caller__ records when each invocation child buffer has finished
    // receiving commands, so the macro can close the shared caller boundary
    // only after all started caller() invocations have been scheduled.
    compiler.emit.line(`runtime.declareBufferChannel(${bufferId}, "${CALLER_SCHED_CHANNEL_NAME}", "var", context, null);`);
    // Caller-capable macros still allow plain invocations with no caller block.
    compiler.emit.line(`if (${rawCallerVar} && ${rawCallerVar}.isMacro) {`);
    // The all-callers buffer is parent-linked because caller() may emit
    // parent-visible observable commands, unlike the isolated macro buffer.
    compiler.emit.line(`  ${allCallersBufferId} = runtime.createCommandBuffer(context, macroParentBuffer || null, ${rawCallerVar}.__callerUsedChannels || null);`);
    compiler.emit.line('}');
  }

  _emitAsyncMacroReturn({ node, bufferId, errVar, allCallersBufferId, hasCallerSupport }) {
    const compiler = this.compiler;
    const errorCheck = `if (${errVar}) throw ${errVar};`;
    const callerReadyVar = hasCallerSupport ? compiler._tmpid() : null;
    const callerSyncPrefix =
      (hasCallerSupport ? `const ${callerReadyVar} = ${bufferId}.addSnapshot("${CALLER_SCHED_CHANNEL_NAME}", {lineno: ${node.lineno}, colno: ${node.colno}});` : '') +
      (hasCallerSupport ? `await ${callerReadyVar};` : '') +
      (hasCallerSupport ? `if (${allCallersBufferId}) {${allCallersBufferId}.markFinishedAndPatchLinks();}` : '');

    if (compiler.scriptMode) {
      const returnVar = compiler._tmpid();
      return `(async () => {` +
        callerSyncPrefix +
        `const ${returnVar}_snapshot = ${bufferId}.addSnapshot("${RETURN_CHANNEL_NAME}", {lineno: ${node.lineno}, colno: ${node.colno}});` +
        `${bufferId}.markFinishedAndPatchLinks();` +
        `${errorCheck}` +
        `return ${returnVar}_snapshot;` +
        `})()`;
    } else {
      const textSnapshotVar = compiler._tmpid();
      return `(async () => {` +
        callerSyncPrefix +
        `const ${textSnapshotVar} = ${bufferId}.addSnapshot("${compiler.buffer.currentTextChannelName}", {lineno: ${node.lineno}, colno: ${node.colno}});` +
        `${bufferId}.markFinishedAndPatchLinks();` +
        `${errorCheck}` +
        `return Promise.resolve(${textSnapshotVar}).then((value) => runtime.markSafe(value));` +
        `})()`;
    }
  }

  _emitMacroBindingInit(bufferId, name, emitValueExpression, positionNode = null) {
    const compiler = this.compiler;
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    compiler.emit(`${bufferId}.add(new runtime.VarCommand({ channelName: '${name}', args: [`);
    emitValueExpression();
    compiler.emit(`], pos: {lineno: ${lineno}, colno: ${colno}} }), "${name}");`);
  }

  _emitAsyncMacroBindings({ node, managedFrame, bufferId, args, kwargs, rawCallerVar, allCallersBufferId }) {
    const compiler = this.compiler;
    const hasCallerSupport = !!(rawCallerVar && allCallersBufferId);

    if (compiler.scriptMode) {
      compiler.emitDeclareReturnChannel(managedFrame, bufferId);
    }

    if (hasCallerSupport) {
      this._emitMacroCallerSetup({
        bufferId,
        rawCallerVar,
        allCallersBufferId
      });
    }

    compiler.emit.line(`runtime.declareBufferChannel(${bufferId}, "caller", "var", context, null);`);
    args.forEach((arg) => {
      compiler.emit.line(`runtime.declareBufferChannel(${bufferId}, "${arg.value}", "var", context, null);`);
    });
    if (kwargs) {
      kwargs.children.forEach((pair) => {
        compiler.emit.line(`runtime.declareBufferChannel(${bufferId}, "${pair.key.value}", "var", context, null);`);
      });
    }

    this._emitMacroBindingInit(
      bufferId,
      'caller',
      () => {
        if (hasCallerSupport) {
          this._emitCallerBindingValue({
            bufferId,
            rawCallerVar,
            allCallersBufferId,
            positionNode: node
          });
        } else {
          compiler.emit('kwargs.caller');
        }
      },
      node
    );

    args.forEach((arg) => {
      this._emitMacroBindingInit(
        bufferId,
        arg.value,
        () => {
          compiler.emit(`l_${arg.value}`);
        },
        arg
      );
    });

    if (kwargs) {
      kwargs.children.forEach((pair) => {
        const name = pair.key.value;
        this._emitMacroBindingInit(
          bufferId,
          name,
          () => {
            compiler.emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}") ? kwargs["${name}"] : `);
            compiler._compileExpression(pair.value, managedFrame);
          },
          pair
        );
      });
    }
  }

  _emitSyncMacroBindings({ managedFrame, args, kwargs }) {
    const compiler = this.compiler;

    compiler.emit.line('frame.set("caller", kwargs.caller);');
    managedFrame.set('caller', 'kwargs.caller');
    args.forEach((arg) => {
      compiler.emit.line(`frame.set("${arg.value}", l_${arg.value});`);
      managedFrame.set(arg.value, `l_${arg.value}`);
    });

    if (kwargs) {
      kwargs.children.forEach((pair) => {
        const name = pair.key.value;
        compiler.emit(`frame.set("${name}", `);
        compiler.emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}")`);
        compiler.emit(` ? kwargs["${name}"] : `);
        compiler._compileExpression(pair.value, managedFrame);
        compiler.emit(');');
      });
    }
  }

  _compileMacro(node, frame, keepFrame) {
    const compiler = this.compiler;
    const funcId = compiler.asyncMode
      ? node._analysis.compiledMacroFuncId
      : `macro_${compiler._tmpid()}`;
    const { args, kwargs, realNames, argNames, kwargNames } = this._parseMacroSignature(node);

    let currFrame;
    if (compiler.asyncMode) {
      currFrame = frame;
    } else if (keepFrame) {
      currFrame = frame.push(true);
    } else {
      currFrame = frame.new();
    }
    const oldIsCompilingMacroBody = compiler.sequential.isCompilingMacroBody;
    compiler.sequential.isCompilingMacroBody = node.typename !== 'Caller';

    const macroNeedsCallerSupport = compiler.asyncMode && !!node._analysis.hasCallerSupport;
    const macroFunctionSignature = compiler.asyncMode
      ? `function (${realNames.join(', ')}, macroParentBuffer) {`
      : `function (${realNames.join(', ')}) {`;

    compiler.emit.lines(
      `let ${funcId} = runtime.makeMacro(`,
      `[${argNames.join(', ')}], `,
      `[${kwargNames.join(', ')}], `,
      macroFunctionSignature
    );

    compiler.emit.line(`return runtime.withPath(this, "${compiler.templateName}", function() {`);
    if (compiler.asyncMode) {
      compiler.emit.line('return (function() {');
      compiler.emit.lines(
        'kwargs = kwargs || {};',
        'if (!Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
        '  kwargs.caller = undefined;',
        '}'
      );
    } else {
      compiler.emit.line('return (function(frame) {');
      compiler.emit.line('let callerFrame = frame;');
      compiler.emit.lines(
        'frame = ' + (keepFrame ? 'frame.push(true);' : 'frame.new();'),
        'kwargs = kwargs || {};',
        'if (!Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
        '  kwargs.caller = undefined;',
        '}'
      );
    }

    let err = compiler._tmpid();
    if (compiler.asyncMode) {
      compiler.emit.lines(
        `let ${err} = null;`,
        'function cb(err) {',
        `if(err) {${err} = err;}`,
        '}');
    }

    let returnStatement;
    const rawCallerVar = macroNeedsCallerSupport ? compiler._tmpid() : null;
    const allCallersBufferId = macroNeedsCallerSupport ? compiler._tmpid() : null;

    const emitAsyncMacroBody = (managedFrame, bufferId) => {
      if (compiler.asyncMode) {
        this._emitAsyncMacroBindings({
          node,
          managedFrame,
          bufferId,
          args,
          kwargs,
          rawCallerVar,
          allCallersBufferId
        });
      } else {
        this._emitSyncMacroBindings({ managedFrame, args, kwargs });
      }

      const prevCallerBindingContext = this.currentCallerBindingContext;
      if (macroNeedsCallerSupport) {
        this.currentCallerBindingContext = { rawCallerVar, allCallersBufferId };
      }
      compiler.emit.withScopedSyntax(() => {
        compiler.compile(node.body, managedFrame);
      });
      this.currentCallerBindingContext = prevCallerBindingContext;

      if (!compiler.asyncMode) {
        compiler.emit.line('frame = ' + (keepFrame ? 'frame.pop();' : 'callerFrame;'));
      }

      if (compiler.asyncMode) {
        returnStatement = this._emitAsyncMacroReturn({
          node,
          bufferId,
          errVar: err,
          allCallersBufferId,
          hasCallerSupport: macroNeedsCallerSupport
        });
      } else {
        returnStatement = compiler.scriptMode
          ? bufferId
          : `new runtime.SafeString(${bufferId})`;
      }
    };

    if (compiler.asyncMode && node.typename === 'Caller') {
      const prevBuffer = compiler.buffer.currentBuffer;
      const prevTextChannelVar = compiler.buffer.currentTextChannelVar;
      const callerTextChannelVar = !compiler.scriptMode ? compiler._tmpid() : null;
      if (!compiler.scriptMode) {
        compiler.emit.line(`let ${callerTextChannelVar} = runtime.declareBufferChannel(macroParentBuffer, "${compiler.buffer.currentTextChannelName}", "text", context, null);`);
      }
      compiler.buffer.currentBuffer = 'macroParentBuffer';
      compiler.buffer.currentTextChannelVar = callerTextChannelVar;
      emitAsyncMacroBody(currFrame, 'macroParentBuffer');
      compiler.buffer.currentBuffer = prevBuffer;
      compiler.buffer.currentTextChannelVar = prevTextChannelVar;
    } else {
      compiler.emit.managedBlock(currFrame, false, true, (managedFrame, bufferId) => {
        emitAsyncMacroBody(managedFrame, bufferId);
      }, keepFrame ? compiler.buffer.currentBuffer : null, node.body);
    }

    compiler.emit.line(`return ${returnStatement};`);
    compiler.emit.line(compiler.asyncMode ? '}).call(this);' : '}).call(this, frame);');
    compiler.emit.line('});');
    if (compiler.asyncMode) {
      compiler.emit.line('}, true);');
    } else {
      compiler.emit.line('});');
    }

    compiler.sequential.isCompilingMacroBody = oldIsCompilingMacroBody;
    return funcId;
  }

  compileMacro(node, frame) {
    const compiler = this.compiler;
    var funcId = this._compileMacro(node, frame, false);

    var name = node.name.value;
    if (compiler.asyncMode) {
      compiler.emit.line(`runtime.declareBufferChannel(${compiler.buffer.currentBuffer}, "${name}", "var", context, null);`);
      compiler.buffer.asyncAddValueToBuffer(node, frame, (resultVar) => {
        compiler.emit(
          `${resultVar} = new runtime.VarCommand({ channelName: '${name}', args: [${funcId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} })`
        );
      }, node, name);
      if (name.charAt(0) !== '_' && compiler.analysis.isParentOwnedDeclarationRootOwned(node._analysis, name)) {
        if (compiler.scriptMode) {
          compiler.emit.line(`context.addResolvedExport("${name}", ${funcId});`);
        } else {
          compiler.emit.line(`context.addDeferredExport("${name}", "${name}", ${compiler.buffer.currentBuffer});`);
        }
      }
      return;
    }

    frame.set(name, funcId);

    if (frame.parent) {
      compiler.emit.line(`frame.set("${name}", ${funcId});`);
    } else {
      const isPublicMacro = node.name.value.charAt(0) !== '_';
      if (isPublicMacro) {
        compiler.emit.line(`context.addResolvedExport("${name}", ${funcId});`);
      }
      compiler.emit.line(`context.setVariable("${name}", ${funcId});`);
    }
  }
}

module.exports = CompileMacro;
