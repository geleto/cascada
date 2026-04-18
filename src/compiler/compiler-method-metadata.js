'use strict';

const nodes = require('../nodes');

class CompileMethodMetadata {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  emitCompiledMethodEntryValue(method) {
    this.emit(`{ fn: ${method.functionName}, kind: ${JSON.stringify(method.kind || 'method')}, contract: ${JSON.stringify(method.contract)}, ownerKey: ${JSON.stringify(method.ownerKey)}, linkedChannels: ${JSON.stringify(method.linkedChannels || [])} }`);
  }

  emitCompiledMethodsLiteral(compiledMethods, indent = '') {
    this.emit.line(`${indent}{`);
    Object.keys(compiledMethods || {}).forEach((name) => {
      const method = compiledMethods[name];
      this.emit(`${indent}  ${JSON.stringify(name)}: `);
      this.emitCompiledMethodEntryValue(method);
      this.emit.line(',');
    });
    this.emit.line(`${indent}}`);
  }

  collectBlockContracts(node) {
    const contracts = {};
    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block) => {
      const signature = this.compiler._getBlockSignature(block);
      contracts[block.name.value] = {
        inputNames: signature.inputNames,
        withContext: !!block.withContext
      };
    });

    return contracts;
  }

  getCompiledMethodOwnerKey() {
    return this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName);
  }

  collectCompiledMethods(node, rootSharedChannelNames = []) {
    const methods = Object.create(null);
    const blocks = node.findAll(nodes.Block);
    const ownerKey = this.getCompiledMethodOwnerKey();

    methods.__constructor__ = {
      functionName: 'm___constructor__',
      kind: 'constructor',
      contract: {
        inputNames: [],
        withContext: false
      },
      ownerKey,
      linkedChannels: this.compiler.linkedChannels.getLinkedChannels(node, {
        seedChannels: rootSharedChannelNames,
        includeDefaultTemplateTextChannel: true,
        excludeSequentialChannels: true
      })
    };

    blocks.forEach((block) => {
      if (this.compiler.scriptMode && block.name && block.name.value === '__constructor__') {
        this.compiler.fail(
          'Identifier \'__constructor__\' is reserved and cannot be used as a method name',
          block.lineno,
          block.colno,
          block
        );
      }
      const signature = this.compiler._getBlockSignature(block);
      methods[block.name.value] = {
        functionName: `b_${block.name.value}`,
        kind: this.compiler.scriptMode ? 'method' : 'block',
        contract: {
          inputNames: signature.inputNames,
          withContext: !!block.withContext
        },
        ownerKey,
        linkedChannels: this.compiler.linkedChannels.getLinkedChannels(block.body, {
          excludeNames: this.compiler._getBlockInputNames(block),
          sharedOnly: true,
          excludeSequentialChannels: true
        })
      };
    });

    return methods;
  }

  hasUserCompiledMethods(compiledMethods) {
    return !!(compiledMethods && Object.keys(compiledMethods).some((name) => name !== '__constructor__'));
  }

  needsRootInheritanceState(compiledMethods, rootSharedSchema) {
    const hasCompiledMethods = this.hasUserCompiledMethods(compiledMethods);
    const hasSharedSchema = Array.isArray(rootSharedSchema) && rootSharedSchema.length > 0;
    return hasCompiledMethods || hasSharedSchema || this.compiler.hasExtends;
  }
}

module.exports = CompileMethodMetadata;
