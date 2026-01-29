'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');

function flattenBuffer(arr, context = null, focusOutput = null, outputName = null, sharedState = null) {
  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, context, focusOutput, outputName, sharedState, flattenBuffer);
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, flattenBuffer);
  }

  return flattenCommands(arr, context, focusOutput, outputName, sharedState, flattenBuffer);
}

module.exports = {
  flattenBuffer
};
