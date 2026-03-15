'use strict';

// Optional dynamic-mode switch:
// When enabled, value symbol lookup can lazily link the current read buffer into a channel lane.
// Keep this permanently (even after transition) so Cascada can, in the future, support more dynamic
// compositions where compile-time/boundary prelinking does not cover every runtime-discovered read path.
const LOOKUP_DYNAMIC_CHANNEL_LINKING = false;

// Migration-enforcement switch:
// When enabled, AsyncFrame.set throws on any runtime assignment.
const THROW_ON_ASYNC_FRAME_ASSIGN = true;


module.exports = {
  LOOKUP_DYNAMIC_CHANNEL_LINKING,
  THROW_ON_ASYNC_FRAME_ASSIGN
};
