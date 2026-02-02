'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');

// the below comments may not be exactly correct right now
// outputName only (no focusOutput) => {outputName: ...} (wrapped)
// focusOutput only (no outputName) => value (unwrapped)
// both provided => value (unwrapped, focusOutput used)
// neither provided, no context => this is a text flattening => string
// neither provided, context  => ERROR (no longer supported)
function flattenBuffer(arr, context = null, focusOutput = null) {
  if (context && !focusOutput) {
    //throw new Error('flattenBuffer requires either focusOutput or outputName parameter');
  }
  return doFlattenBuffer(arr, context, focusOutput);
}

function doFlattenBuffer(arr, context = null, focusOutput = null, outputName = null, sharedState = null) {

  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, context, focusOutput, outputName, sharedState, doFlattenBuffer);
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, doFlattenBuffer);
  }

  return flattenCommands(arr, context, focusOutput, outputName, sharedState, doFlattenBuffer);
}

module.exports = {
  flattenBuffer
};
