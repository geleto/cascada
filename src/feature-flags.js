'use strict';

// Optional dynamic-mode switch:
// When enabled, value symbol lookup can lazily link the current read buffer into a handler lane.
// Keep this permanently (even after transition) so Cascada can, in the future, support more dynamic
// compositions where compile-time/boundary prelinking does not cover every runtime-discovered read path.
const LOOKUP_DYNAMIC_OUTPUT_LINKING = false;

// Debug/probe switch:
// When enabled, AsyncFrame.set throws on reassignment of an existing slot.
const THROW_ON_ASYNC_FRAME_REASSIGN = false;


module.exports = {
  LOOKUP_DYNAMIC_OUTPUT_LINKING,
  THROW_ON_ASYNC_FRAME_REASSIGN
};
