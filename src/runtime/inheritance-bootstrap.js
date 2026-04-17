'use strict';

const inheritanceConstants = require('../inheritance-constants');
const output = require('./channel');
const commands = require('./commands');
const lookup = require('./lookup');
const resolve = require('./resolve');
const { DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME } = inheritanceConstants;

function validateSharedInputs(sharedSchema, providedInputNames, operationName = 'extends') {
  const schema = Array.isArray(sharedSchema) ? sharedSchema : [];
  const providedNames = Array.isArray(providedInputNames) ? providedInputNames : [];
  const declaredNames = new Set();

  for (let i = 0; i < schema.length; i++) {
    const entry = schema[i];
    if (entry && entry.name) {
      declaredNames.add(entry.name);
    }
  }

  for (let i = 0; i < providedNames.length; i++) {
    const name = providedNames[i];
    if (!declaredNames.has(name)) {
      throw new Error(`${operationName} passed '${name}' but the target does not declare it as shared`);
    }
  }
}

function preloadSharedInputs(sharedSchema, inputValues, currentBuffer, context, pos = null, operationName = 'extends') {
  const schema = Array.isArray(sharedSchema) ? sharedSchema : [];
  const values = inputValues && typeof inputValues === 'object' ? inputValues : {};
  const providedNames = Object.keys(values);
  const position = pos || { lineno: 0, colno: 0 };
  const schemaByName = new Map();

  validateSharedInputs(schema, providedNames, operationName);
  for (let i = 0; i < schema.length; i++) {
    const entry = schema[i];
    if (entry && entry.name) {
      schemaByName.set(entry.name, entry.type);
    }
  }

  for (let i = 0; i < providedNames.length; i++) {
    const name = providedNames[i];
    const type = schemaByName.get(name);
    const value = values[name];

    if (type === 'sequence') {
      output.declareSharedBufferChannel(currentBuffer, name, type, context, value);
      continue;
    }

    output.declareSharedBufferChannel(currentBuffer, name, type, context, null);
    if (type === 'var') {
      currentBuffer.add(new commands.VarCommand({
        channelName: name,
        args: [value],
        initializeIfNotSet: true,
        pos: position
      }), name);
      continue;
    }

    if (type === 'text') {
      currentBuffer.add(new commands.TextCommand({
        channelName: name,
        command: 'set',
        args: [value],
        normalizeArgs: true,
        pos: position
      }), name);
      continue;
    }

    if (type === 'data') {
      currentBuffer.add(new commands.DataCommand({
        channelName: name,
        command: 'set',
        args: [null, value],
        pos: position
      }), name);
      continue;
    }

    throw new Error(`Unsupported shared preload channel type '${type}' for '${name}'`);
  }
}

function ensureSharedSchemaChannels(sharedSchema, currentBuffer, context) {
  const schema = Array.isArray(sharedSchema) ? sharedSchema : [];
  for (let i = 0; i < schema.length; i++) {
    const entry = schema[i];
    if (!entry || !entry.name || !entry.type) {
      continue;
    }
    output.declareSharedBufferChannel(currentBuffer, entry.name, entry.type, context, null);
  }
}

function bootstrapInheritanceMetadata(inheritanceState, methods, sharedSchema, ownerKey, currentBuffer, context) {
  if (!inheritanceState) {
    return;
  }

  // Compiled output still passes ownerKey directly to this helper; keep the
  // argument for runtime ABI stability even though registration no longer needs
  // it here.
  const compiledMethods = methods && typeof methods === 'object' ? methods : null;
  const schema = Array.isArray(sharedSchema) ? sharedSchema : [];

  if (compiledMethods && Object.keys(compiledMethods).length > 0) {
    inheritanceState.registerCompiledMethods(compiledMethods);
  }

  if (schema.length > 0) {
    inheritanceState.registerSharedSchema(schema);
    ensureSharedSchemaChannels(schema, currentBuffer, context);
  }
}

function ensureCurrentBufferSharedLinks(sharedSchema, currentBuffer) {
  const schema = Array.isArray(sharedSchema) ? sharedSchema : [];
  if (!currentBuffer) {
    return;
  }

  for (let i = 0; i < schema.length; i++) {
    const entry = schema[i];
    if (!entry || !entry.name) {
      continue;
    }
    let cursor = currentBuffer;
    // Shared-link installation follows the same hierarchy boundary as shared
    // declarations: component/shared roots do not leak their lanes upward into
    // the caller buffer tree.
    while (cursor && !cursor._sharedRootBoundary) {
      const nextBuffer = output.getSharedHierarchyParentBuffer(cursor);
      if (!nextBuffer) {
        break;
      }
      if (!(typeof cursor.isLinkedChannel === 'function' && cursor.isLinkedChannel(entry.name))) {
        nextBuffer.addBuffer(cursor, entry.name);
      }
      cursor = nextBuffer;
    }
  }
}

function beginInheritanceResolution(inheritanceState) {
  if (inheritanceState && typeof inheritanceState.beginInheritanceResolution === 'function') {
    inheritanceState.beginInheritanceResolution();
  }
}

function awaitInheritanceResolution(inheritanceState) {
  return inheritanceState && typeof inheritanceState.awaitInheritanceResolution === 'function'
    ? inheritanceState.awaitInheritanceResolution()
    : null;
}

function deferUntilInheritanceResolution(inheritanceState, value) {
  const registrationWait = awaitInheritanceResolution(inheritanceState);
  if (!registrationWait || typeof registrationWait.then !== 'function') {
    return value;
  }
  return registrationWait.then(() => value);
}

function finishInheritanceResolution(inheritanceState) {
  if (inheritanceState && typeof inheritanceState.finishInheritanceResolution === 'function') {
    inheritanceState.finishInheritanceResolution();
  }
}

function getRegisteredAsyncBlock(inheritanceState, context, name) {
  const registrationWait = awaitInheritanceResolution(inheritanceState);
  if (registrationWait && typeof registrationWait.then === 'function') {
    return registrationWait.then(() => context.getBlock(name));
  }
  return Promise.resolve(context.getBlock(name));
}

// Explicit dynamic-extends bridge: the parent template may resolve inside an
// async child boundary, but top-level block/parent startup must only observe it
// after the current inheritance registration wave has settled.
function bridgeDynamicParentTemplate(inheritanceState, parentTemplateValue) {
  return Promise.resolve(parentTemplateValue).then((resolvedParentTemplate) =>
    deferUntilInheritanceResolution(inheritanceState, resolvedParentTemplate)
  );
}

function renderDynamicTopLevelBlock(name, context, currentBuffer, env, runtime, cb, inheritanceState, blockPayload = null, blockRenderCtx = undefined) {
  return resolveDynamicParentTemplate(currentBuffer).then((parentTemplate) => {
    if (parentTemplate) {
      return '';
    }
    return getRegisteredAsyncBlock(inheritanceState, context, name).then((blockFunc) =>
      blockFunc(
        env,
        context,
        runtime,
        cb,
        currentBuffer,
        inheritanceState,
        context.prepareInheritancePayloadForBlock(blockFunc, blockPayload),
        blockRenderCtx
      )
    );
  });
}

function resolveDynamicParentTemplate(currentBuffer) {
  return resolve.resolveSingle(lookup.channelLookup(DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME, currentBuffer));
}

module.exports = {
  validateSharedInputs,
  preloadSharedInputs,
  ensureSharedSchemaChannels,
  bootstrapInheritanceMetadata,
  ensureCurrentBufferSharedLinks,
  beginInheritanceResolution,
  awaitInheritanceResolution,
  deferUntilInheritanceResolution,
  finishInheritanceResolution,
  getRegisteredAsyncBlock,
  bridgeDynamicParentTemplate,
  renderDynamicTopLevelBlock,
  resolveDynamicParentTemplate
};
