
import {Obj} from './object.js';

function traverseAndCheck(obj, type, results) {
  if (Array.isArray(obj)) {
    obj.forEach((item) => traverseAndCheck(item, type, results));
    return;
  }

  if (obj instanceof type) {
    results.push(obj);
  }

  if (obj instanceof Node) {
    obj.findAll(type, results);
  }
}

class Node extends Obj {
  get fields() { return []; }

  init(lineno, colno, ...args) {
    this.lineno = lineno;
    this.colno = colno;

    this.fields.forEach((field, i) => {
      // Use args[i] since we're using ...args in the signature
      var val = args[i];

      // Fields should never be undefined, but null. It makes
      // testing easier to normalize values.
      if (val === undefined) {
        val = null;
      }

      this[field] = val;
    });
  }

  findAll(type, results) {
    results = results || [];

    this.fields.forEach(field => traverseAndCheck(this[field], type, results));

    return results;
  }

  iterFields(func) {
    this.fields.forEach((field) => {
      func(this[field], field);
    });
  }

}

// Abstract nodes
class Value extends Node {
  get typename() { return 'Value'; }
  get fields() { return ['value']; }
}

// Concrete nodes
class NodeList extends Node {
  get typename() { return 'NodeList'; }
  get fields() { return ['children']; }

  init(lineno, colno, nodes) {
    super.init(lineno, colno, nodes || []);
  }

  addChild(node) {
    this.children.push(node);
  }
}

class Root extends NodeList {
  get typename() { return 'Root'; }
  get fields() {
    // Inheritance metadata is stored as one object, but root traversal follows
    // source semantics: shared declarations, root/extends body, then methods.
    return ['sharedDeclarations', 'children', 'methods'];
  }

  get sharedDeclarations() {
    return this.inheritanceMetadata ? this.inheritanceMetadata.sharedDeclarations : null;
  }

  set sharedDeclarations(value) {
    if (!value && !this.inheritanceMetadata) {
      return;
    }
    this.inheritanceMetadata = this.inheritanceMetadata || new InheritanceMetadata(this.lineno, this.colno);
    this.inheritanceMetadata.sharedDeclarations = value;
  }

  get methods() {
    return this.inheritanceMetadata ? this.inheritanceMetadata.methods : null;
  }

  set methods(value) {
    if (!value && !this.inheritanceMetadata) {
      return;
    }
    this.inheritanceMetadata = this.inheritanceMetadata || new InheritanceMetadata(this.lineno, this.colno);
    this.inheritanceMetadata.methods = value;
  }

  init(lineno, colno, children, inheritanceMetadata) {
    this.lineno = lineno;
    this.colno = colno;
    this.inheritanceMetadata = inheritanceMetadata === undefined ? null : inheritanceMetadata;
    this.children = children || [];
  }
}

class Literal extends Value {
  get typename() { return 'Literal'; }
}

class Symbol extends Value {
  get typename() { return 'Symbol'; }
  get fields() { return ['value', 'sequential', 'isCompilerInternal']; }

}

class Group extends NodeList {
  get typename() { return 'Group'; }
}

class ArrayNode extends NodeList {
  get typename() { return 'Array'; }
}

class Pair extends Node {
  get typename() { return 'Pair'; }
  get fields() { return ['key', 'value']; }
}

class Dict extends NodeList {
  get typename() { return 'Dict'; }
}

class LookupVal extends Node {
  get typename() { return 'LookupVal'; }
  get fields() { return ['target', 'val']; }
}

class If extends Node {
  get typename() { return 'If'; }
  get fields() { return ['cond', 'body', 'else_']; }
}

class IfAsync extends If {
  get typename() { return 'IfAsync'; }
}

class Guard extends Node {
  get fields() {
    return ['body', 'channelTargets', 'typeTargets', 'variableTargets', 'sequenceTargets', 'recoveryBody', 'errorVar'];
  }
}

class Revert extends Node {
  get typename() { return 'Revert'; }
  get fields() { return []; }
}

class Return extends Node {
  get typename() { return 'Return'; }
  get fields() { return ['value']; }
}

class InlineIf extends Node {
  get typename() { return 'InlineIf'; }
  get fields() { return ['cond', 'body', 'else_']; }
}

class For extends Node {
  get typename() { return 'For'; }
  get fields() { return ['arr', 'name', 'body', 'else_', 'concurrentLimit']; }
}

class While extends Node {
  get typename() { return 'While'; }
  get fields() { return ['cond', 'body']; }
}

class AsyncEach extends For {
  get typename() { return 'AsyncEach'; }
}

class AsyncAll extends For {
  get typename() { return 'AsyncAll'; }
}

class Macro extends Node {
  get typename() { return 'Macro'; }
  get fields() { return ['name', 'args', 'body']; }
}

class Caller extends Macro {
  get typename() { return 'Caller'; }
}

class Import extends Node {
  get typename() { return 'Import'; }
  get fields() { return ['template', 'target', 'withContext', 'withVars', 'withValue']; }

  init(lineno, colno, template, target, withContext, withVars, withValue) {
    super.init(lineno, colno, template, target, withContext, withVars || new NodeList(), withValue);
  }
}

class Component extends Node {
  get typename() { return 'Component'; }
  get fields() { return ['template', 'target', 'withContext', 'withVars', 'withValue']; }

  init(lineno, colno, template, target, withContext, withVars, withValue) {
    super.init(lineno, colno, template, target, withContext, withVars || new NodeList(), withValue);
  }
}

class FromImport extends Node {
  get typename() { return 'FromImport'; }
  get fields() { return ['template', 'names', 'withContext', 'withVars', 'withValue']; }

  init(lineno, colno, template, names, withContext, withVars, withValue) {
    super.init(lineno, colno, template, names || new NodeList(), withContext, withVars || new NodeList(), withValue);
  }
}

class FunCall extends Node {
  get typename() { return 'FunCall'; }
  get fields() { return ['name', 'args']; }
}

class Filter extends FunCall {
  get typename() { return 'Filter'; }
}

class FilterAsync extends Filter {
  get typename() { return 'FilterAsync'; }
  get fields() { return ['name', 'args', 'symbol']; }
}

class KeywordArgs extends Dict {
  get typename() { return 'KeywordArgs'; }
}

class Block extends Node {
  get typename() { return 'Block'; }
  get fields() { return ['name', 'args', 'body', 'withContext']; }

  init(lineno, colno, name, args, body, withContext) {
    super.init(lineno, colno, name, args || new NodeList(), body, withContext);
  }
}

class MethodDefinition extends Node {
  get typename() { return 'MethodDefinition'; }
  get fields() { return ['name', 'args', 'body', 'withContext']; }

  init(lineno, colno, name, args, body, withContext) {
    super.init(lineno, colno, name, args || new NodeList(), body, withContext);
  }
}

class SharedDeclarations extends NodeList {
  get typename() { return 'SharedDeclarations'; }
}

class InheritanceMetadata extends Node {
  get typename() { return 'InheritanceMetadata'; }
  get fields() { return ['methods', 'sharedDeclarations']; }

  init(lineno, colno, methods, sharedDeclarations) {
    super.init(
      lineno,
      colno,
      methods || new NodeList(lineno, colno, []),
      sharedDeclarations || new SharedDeclarations(lineno, colno, [])
    );
  }
}

class Super extends Node {
  get typename() { return 'Super'; }
  get fields() { return ['blockName', 'symbol', 'args']; }

  init(lineno, colno, blockName, symbol, args) {
    super.init(lineno, colno, blockName, symbol, args || new NodeList());
  }
}

class TemplateRef extends Node {
  get typename() { return 'TemplateRef'; }
  get fields() { return ['template']; }
}

class Extends extends TemplateRef {
  get typename() { return 'Extends'; }
  get fields() { return ['template', 'withContext', 'withVars', 'withValue', 'noParentLiteral']; }

  init(lineno, colno, template, withContext, withVars, withValue, noParentLiteral) {
    super.init(lineno, colno, template, withContext, withVars || new NodeList(), withValue, !!noParentLiteral);
  }
}

class Include extends Node {
  get typename() { return 'Include'; }
  get fields() { return ['template', 'ignoreMissing', 'withContext', 'withVars', 'withValue']; }

  init(lineno, colno, template, ignoreMissing, withContext, withVars, withValue) {
    super.init(lineno, colno, template, ignoreMissing, withContext, withVars || new NodeList(), withValue);
  }
}

class Set extends Node {
  get typename() { return 'Set'; }
  get fields() { return ['targets', 'value', 'body', 'varType', 'path']; }

  init(lineno, colno, targets, value, body, varType, path) {
    super.init(lineno, colno, targets, value, body, varType, path);
  }
}

// Internal node emitted by the ScriptTranspiler via the `call_assign` tag.
// Represents a call block whose result is assigned to a variable (declaration or assignment).
class CallAssign extends Node {
  get typename() { return 'CallAssign'; }
  get fields() { return ['targets', 'value', 'body', 'varType', 'path']; }

  init(lineno, colno, targets, value, body, varType, path) {
    super.init(lineno, colno, targets, value, body, varType, path);
  }
}

class ChannelDeclaration extends Node {
  get typename() { return 'ChannelDeclaration'; }
  get fields() { return ['channelType', 'name', 'initializer', 'isShared']; }
}

class Switch extends Node {
  get typename() { return 'Switch'; }
  get fields() { return ['expr', 'cases', 'default']; }
}

class Case extends Node {
  get typename() { return 'Case'; }
  get fields() { return ['cond', 'body']; }
}

class Output extends NodeList {
  get typename() { return 'Output'; }
}

class Capture extends Node {
  get typename() { return 'Capture'; }
  get fields() { return ['body']; }
}

class TemplateData extends Literal {
  get typename() { return 'TemplateData'; }
}

class UnaryOp extends Node {
  get typename() { return 'UnaryOp'; }
  get fields() { return ['target']; }
}

class BinOp extends Node {
  get typename() { return 'BinOp'; }
  get fields() { return ['left', 'right']; }
}

class In extends BinOp {
  get typename() { return 'In'; }
}

class Is extends BinOp {
  get typename() { return 'Is'; }
}

class Or extends BinOp {
  get typename() { return 'Or'; }
}

class And extends BinOp {
  get typename() { return 'And'; }
}

class Not extends UnaryOp {
  get typename() { return 'Not'; }
}

class PeekError extends UnaryOp {
  get typename() { return 'PeekError'; }
}

class Add extends BinOp {
  get typename() { return 'Add'; }
}

class Concat extends BinOp {
  get typename() { return 'Concat'; }
}

class Sub extends BinOp {
  get typename() { return 'Sub'; }
}

class Mul extends BinOp {
  get typename() { return 'Mul'; }
}

class Div extends BinOp {
  get typename() { return 'Div'; }
}

class FloorDiv extends BinOp {
  get typename() { return 'FloorDiv'; }
}

class Mod extends BinOp {
  get typename() { return 'Mod'; }
}

class Pow extends BinOp {
  get typename() { return 'Pow'; }
}

class Neg extends UnaryOp {
  get typename() { return 'Neg'; }
}

class Pos extends UnaryOp {
  get typename() { return 'Pos'; }
}

class Compare extends Node {
  get typename() { return 'Compare'; }
  get fields() { return ['expr', 'ops']; }
}

class CompareOperand extends Node {
  get typename() { return 'CompareOperand'; }
  get fields() { return ['expr', 'type']; }
}

class CallExtension extends Node {
  get typename() { return 'CallExtension'; }
  // autoescape was not in the nunjucks fields, a bug?
  get fields() { return ['extName', 'prop', 'args', 'contentArgs', 'autoescape', 'resolveArgs']; }

  init(ext, prop, args, contentArgs, resolveArgs = true) {
    super.init();
    this.extName = ext.__name || ext;
    this.prop = prop;
    this.args = args || new NodeList();
    this.contentArgs = contentArgs || [];
    this.autoescape = ext.autoescape;
    this.resolveArgs = resolveArgs;
  }
}

class CallExtensionAsync extends CallExtension {
  get typename() { return 'CallExtensionAsync'; }

  init(ext, prop, args, contentArgs, resolveArgs = true) {
    super.init(ext, prop, args, contentArgs, resolveArgs);
  }
}

class Do extends NodeList {
  get typename() { return 'Do'; }
}

class ChannelCommand extends Node {
  get typename() { return 'ChannelCommand'; }
  get fields() { return ['call']; }
}

// This is hacky, but this is just a debugging function anyway
function print(str, indent, inline) {
  var lines = str.split('\n');

  lines.forEach((line, i) => {
    if (line && ((inline && i > 0) || !inline)) {
      process.stdout.write((' ').repeat(indent));
    }
    const nl = (i === lines.length - 1) ? '' : '\n';
    process.stdout.write(`${line}${nl}`);
  });
}

// Print the AST in a nicely formatted tree format for debugging
function printNodes(node, indent) {
  indent = indent || 0;

  print(node.typename + ': ', indent);

  if (node instanceof NodeList) {
    print('\n');
    node.children.forEach((n) => {
      printNodes(n, indent + 2);
    });
  } else if (node instanceof CallExtension) {
    print(`${node.extName}.${node.prop}\n`);

    if (node.args) {
      printNodes(node.args, indent + 2);
    }

    if (node.contentArgs) {
      node.contentArgs.forEach((n) => {
        printNodes(n, indent + 2);
      });
    }
  } else {
    let nodes = [];
    let props = null;

    node.iterFields((val, fieldName) => {
      if (val instanceof Node) {
        nodes.push([fieldName, val]);
      } else {
        props = props || {};
        props[fieldName] = val;
      }
    });

    if (props) {
      print(JSON.stringify(props, null, 2) + '\n', null, true);
    } else {
      print('\n');
    }

    nodes.forEach(([fieldName, n]) => {
      print(`[${fieldName}] =>`, indent + 2);
      printNodes(n, indent + 4);
    });
  }
}

export {
  Node,
  Root,
  NodeList,
  Value,
  Literal,
  Symbol,
  Group,
  ArrayNode as Array,
  Pair,
  Dict,
  Output,
  Capture,
  TemplateData,
  If,
  IfAsync,
  InlineIf,
  For,
  While,
  Guard,
  Revert,
  Return,
  AsyncEach,
  AsyncAll,
  Macro,
  Caller,
  Import,
  Component,
  FromImport,
  FunCall,
  Filter,
  FilterAsync,
  KeywordArgs,
  Block,
  MethodDefinition,
  SharedDeclarations,
  InheritanceMetadata,
  Super,
  Extends,
  Include,
  Set,
  CallAssign,
  ChannelDeclaration,
  Switch,
  Case,
  LookupVal,
  BinOp,
  In,
  Is,
  Or,
  And,
  Not,
  PeekError,
  Add,
  Concat,
  Sub,
  Mul,
  Div,
  FloorDiv,
  Mod,
  Pow,
  Neg,
  Pos,
  Compare,
  CompareOperand,
  CallExtension,
  CallExtensionAsync,
  Do,
  ChannelCommand,
  printNodes
};
