'use strict';

// Temporary migration flags used for side-by-side testing.
const CONVERT_TEMPLATE_VAR_TO_VALUE = true;
const CONVERT_SCRIPT_VAR_TO_VALUE = true;
const LOOP_VARS_USE_VALUE = true;
const SEQUNTIAL_PATHS_USE_VALUE = true;

// Migration toggles for value-only rollout. Keep dual-mode support initially.
const VALUE_IMPORT_BINDINGS = false;
const LOCK_REGISTRY_RUNTIME = false;


module.exports = {
  CONVERT_TEMPLATE_VAR_TO_VALUE,
  CONVERT_SCRIPT_VAR_TO_VALUE,
  LOOP_VARS_USE_VALUE,
  SEQUNTIAL_PATHS_USE_VALUE,
  VALUE_IMPORT_BINDINGS,
  LOCK_REGISTRY_RUNTIME
};
