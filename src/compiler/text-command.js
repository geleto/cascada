function failInvalidTextSetArity(compiler, methodName, args, node) {
  if (methodName !== 'set') {
    return;
  }
  const argCount = args && args.children ? args.children.length : 0;
  if (argCount !== 1) {
    compiler.fail('text.set() accepts exactly one argument', node.lineno, node.colno, node);
  }
}

export {failInvalidTextSetArity};
