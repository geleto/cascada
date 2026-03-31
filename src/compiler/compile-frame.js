'use strict';

const { Frame } = require('../runtime/frame');

class CompileFrame {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  pushFrame(frame, isolateWrites = false) {
    this.emit.line(`frame = frame.push(${isolateWrites ? 'true' : ''});`);
    return frame.push(isolateWrites);
  }

  popFrame(frame) {
    this.emit.line('frame = frame.pop();');
    return frame.pop();
  }

  declarePushedFrame(frame, isolateWrites = false, declaration = 'var', frameName = 'frame') {
    this.emit.line(`${declaration} ${frameName} = ${frameName}.push(${isolateWrites ? 'true' : ''});`);
    return frame.push(isolateWrites);
  }

  startNewFrame(frame, declaration = null, frameName = 'frame') {
    const prefix = declaration ? `${declaration} ` : '';
    this.emit.line(`${prefix}${frameName} = ${frameName}.new();`);
    return frame.new();
  }

  restoreFrame(frameExpr) {
    this.emit.line(`frame = ${frameExpr};`);
  }

  createRootFrame() {
    return new Frame();
  }

  createChildFrame(frame, isolateWrites = false) {
    return frame.push(isolateWrites);
  }

  createFreshFrame(frame) {
    return frame.new();
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
    return `frame.lookupOrContext(context, "${name}")`;
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

  emitAssignmentPublish(name, valueExpr, exportValue = false) {
    this.emitFrameSet(name, valueExpr, true);
    this.emit.line('if (frame.topLevel) {');
    this.emitTopLevelPublish(name, valueExpr, exportValue);
    this.emit.line('}');
  }

  emitDeclarationPublish(frame, name, valueExpr, exportValue = false) {
    this.setFrameValue(frame, name, valueExpr);
    if (frame.parent) {
      this.emitFrameSet(name, valueExpr);
      return;
    }
    this.emitTopLevelPublish(name, valueExpr, exportValue);
  }
}

module.exports = CompileFrame;
