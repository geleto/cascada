'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');

// outputName only (no focusOutput) => {outputName: ...} (wrapped)
// focusOutput only (no outputName) => value (unwrapped)
// both provided => value (unwrapped, focusOutput used)
// neither provided => ERROR (no longer supported)
function flattenBuffer(arr, context = null, focusOutput = null, outputName = null, sharedState = null) {
  let res;

  if (arr instanceof CommandBuffer) {
    res = flattenCommandBuffer(arr, context, focusOutput, outputName, sharedState, flattenBuffer);
    if (res !== undefined) return res;
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, flattenBuffer);
  }

  if (!focusOutput && !outputName) {
    throw new Error('flattenBuffer requires either focusOutput or outputName parameter');
  }
  return flattenCommands(arr, context, focusOutput, outputName, sharedState, flattenBuffer);
}

module.exports = {
  flattenBuffer
};
