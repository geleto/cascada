'use strict';

const output = require('./channel');
const commands = require('./commands');

function preloadSharedInputs(sharedSchema, providedInputs, rootBuffer, context, pos = null) {
  if (!sharedSchema || typeof sharedSchema !== 'object' || !rootBuffer) {
    return rootBuffer;
  }

  const inputValues = providedInputs && typeof providedInputs === 'object'
    ? providedInputs
    : null;
  const names = Object.keys(sharedSchema);
  const commandPos = pos && typeof pos === 'object'
    ? pos
    : { lineno: 0, colno: 0 };

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = sharedSchema[name] || {};
    const channelType = entry.type;
    if (!channelType) {
      continue;
    }

    if (channelType === 'sink' || channelType === 'sequence') {
      const initializer = inputValues && Object.prototype.hasOwnProperty.call(inputValues, name)
        ? inputValues[name]
        : null;
      output.declareInheritanceSharedChannel(rootBuffer, name, channelType, context, initializer);
      continue;
    }

    output.declareInheritanceSharedChannel(rootBuffer, name, channelType, context, null);
    if (!inputValues || !Object.prototype.hasOwnProperty.call(inputValues, name)) {
      continue;
    }

    if (channelType === 'var') {
      rootBuffer.add(new commands.VarCommand({
        channelName: name,
        args: [inputValues[name]],
        pos: commandPos
      }), name);
      continue;
    }

    if (channelType === 'text') {
      rootBuffer.add(new commands.TextCommand({
        channelName: name,
        command: 'set',
        args: [inputValues[name]],
        normalizeArgs: true,
        pos: commandPos
      }), name);
      continue;
    }

    if (channelType === 'data') {
      rootBuffer.add(new commands.DataCommand({
        channelName: name,
        command: 'set',
        args: [null, inputValues[name]],
        pos: commandPos
      }), name);
    }
  }

  return rootBuffer;
}

function validateInheritanceSharedInputs(sharedSchema, providedInputNames, operationName = 'extends') {
  const schema = sharedSchema && typeof sharedSchema === 'object' ? sharedSchema : {};
  const names = Array.isArray(providedInputNames) ? providedInputNames : [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      throw new Error(`${operationName} passed '${name}' but the parent template does not declare it as shared`);
    }
  }
}

module.exports = {
  preloadSharedInputs,
  validateInheritanceSharedInputs
};
