'use strict';

// Inheritance resolution helpers.
// Owns resolution-lifecycle reads plus dynamic extends/block-resolution helpers
// that must wait for the current inheritance registration wave to settle.

const inheritanceStateRuntime = require('./inheritance-state');
const lookup = require('./lookup');
const resolve = require('./resolve');
const { DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME } = require('../inheritance-constants');

function getRegisteredAsyncBlock(currentInheritanceState, context, name) {
  const registrationWait = inheritanceStateRuntime.awaitInheritanceResolution(currentInheritanceState);
  if (registrationWait && typeof registrationWait.then === 'function') {
    return registrationWait.then(() => context.getBlock(name));
  }
  return Promise.resolve(context.getBlock(name));
}

function deferUntilInheritanceResolution(currentInheritanceState, value) {
  const registrationWait = inheritanceStateRuntime.awaitInheritanceResolution(currentInheritanceState);
  if (!registrationWait || typeof registrationWait.then !== 'function') {
    return value;
  }
  return registrationWait.then(() => value);
}

// Explicit dynamic-extends bridge: the parent template may resolve inside an
// async child boundary, but top-level block/parent startup must only observe it
// after the current inheritance registration wave has settled.
function bridgeDynamicParentTemplate(currentInheritanceState, parentTemplateValue) {
  return Promise.resolve(parentTemplateValue).then((resolvedParentTemplate) =>
    deferUntilInheritanceResolution(currentInheritanceState, resolvedParentTemplate)
  );
}

function resolveDynamicParentTemplate(currentBuffer) {
  return resolve.resolveSingle(lookup.channelLookup(DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME, currentBuffer));
}

function renderDynamicTopLevelBlock(name, context, currentBuffer, env, runtime, cb, currentInheritanceState, blockPayload = null, blockRenderCtx = undefined) {
  return resolveDynamicParentTemplate(currentBuffer).then((parentTemplate) => {
    if (parentTemplate) {
      return '';
    }
    return getRegisteredAsyncBlock(currentInheritanceState, context, name).then((blockFunc) =>
      blockFunc(
        env,
        context,
        runtime,
        cb,
        currentBuffer,
        currentInheritanceState,
        inheritanceStateRuntime.prepareInheritancePayloadForBlock(
          currentInheritanceState,
          blockFunc,
          context && context.path ? context.path : null,
          blockPayload
        ),
        blockRenderCtx
      )
    );
  });
}

module.exports = {
  bridgeDynamicParentTemplate,
  deferUntilInheritanceResolution,
  getRegisteredAsyncBlock,
  renderDynamicTopLevelBlock,
  resolveDynamicParentTemplate
};
