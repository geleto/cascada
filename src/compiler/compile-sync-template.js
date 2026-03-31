'use strict';

class CompileSyncTemplate {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  setFrameValue(frame, name, valueExpr, resolveUp = false) {
    frame.set(name, valueExpr, resolveUp);
  }

  emitFrameSet(name, valueExpr, resolveUp = false) {
    this.emit.line(`frame.set("${name}", ${valueExpr}${resolveUp ? ', true' : ''});`);
  }

  emitFrameAssignment(name, emitValueExpr) {
    this.emit(`frame.set("${name}", `);
    emitValueExpr();
    this.emit.line(');');
  }

  emitCompilerFrameLookup(frame, name) {
    const value = frame.lookup(name);
    if (value) {
      this.emit(value);
      return true;
    }
    return false;
  }

  getFrameContextLookupExpr(name) {
    return `runtime.contextOrSyncTemplateFrameLookup(context, frame, "${name}")`;
  }

  getDirectFrameLookupExpr(name) {
    return `frame.lookup("${name}")`;
  }

  emitTopLevelPublish(name, valueExpr, exportValue = false) {
    this.emit.line(`context.setVariable("${name}", ${valueExpr});`);
    if (exportValue && name.charAt(0) !== '_') {
      this.emit.line(`context.addResolvedExport("${name}", ${valueExpr});`);
    }
  }

  getTopLevelCheckExpr() {
    return 'runtime.isSyncTemplateFrameTopLevel(frame)';
  }
}

module.exports = CompileSyncTemplate;
