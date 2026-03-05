'use strict';

// Temporary migration flags used for side-by-side testing.
const CONVERT_TEMPLATE_VAR_TO_VALUE = true;
const CONVERT_SCRIPT_VAR_TO_VALUE = true;
const LOOP_VARS_USE_VALUE = true;
const SEQUNTIAL_PATHS_USE_VALUE = true;
const VALUE_IMPORT_BINDINGS = true;
const INCLUDE_PRELINK_OUTPUTS = true;
const INHERITANCE_CONTEXT_ONLY_LOOKUP = true;
// Optional dynamic-mode switch:
// When enabled, value symbol lookup can lazily link the current read buffer into a handler lane.
// Keep this permanently (even after transition) so Cascada can, in the future, support more dynamic
// compositions where compile-time/boundary prelinking does not cover every runtime-discovered read path.
const LOOKUP_DYNAMIC_OUTPUT_LINKING = false;


module.exports = {
  CONVERT_TEMPLATE_VAR_TO_VALUE,
  CONVERT_SCRIPT_VAR_TO_VALUE,
  LOOP_VARS_USE_VALUE,
  SEQUNTIAL_PATHS_USE_VALUE,
  VALUE_IMPORT_BINDINGS,
  INCLUDE_PRELINK_OUTPUTS,
  INHERITANCE_CONTEXT_ONLY_LOOKUP,
  LOOKUP_DYNAMIC_OUTPUT_LINKING
};
