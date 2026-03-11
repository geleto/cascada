'use strict';

// Optional dynamic-mode switch:
// When enabled, value symbol lookup can lazily link the current read buffer into a handler lane.
// Keep this permanently (even after transition) so Cascada can, in the future, support more dynamic
// compositions where compile-time/boundary prelinking does not cover every runtime-discovered read path.
const LOOKUP_DYNAMIC_OUTPUT_LINKING = false;

// Migration-enforcement switch:
// When enabled, AsyncFrame.set throws on any runtime assignment.
const THROW_ON_ASYNC_FRAME_ASSIGN = true;

// Compiler-analysis safety switch:
// When enabled, compile-time analysis facts are validated against direct
// compiler-side detection and mismatches fail compilation.
const VERIFY_ANALYSIS_PARITY = true;


module.exports = {
  LOOKUP_DYNAMIC_OUTPUT_LINKING,
  THROW_ON_ASYNC_FRAME_ASSIGN,
  VERIFY_ANALYSIS_PARITY
};
