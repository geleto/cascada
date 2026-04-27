'use strict';

const POISON_KEY = Symbol.for('cascada.poison');
const RESOLVE_MARKER = Symbol.for('cascada.resolve');
const RESOLVED_VALUE_MARKER = Symbol.for('cascada.resolved_value');
const RETURN_UNSET = Symbol.for('cascada.returnUnset');

const __defaultExport = {
  POISON_KEY,
  RESOLVE_MARKER,
  RESOLVED_VALUE_MARKER,
  RETURN_UNSET
};
export { POISON_KEY, RESOLVE_MARKER, RESOLVED_VALUE_MARKER, RETURN_UNSET };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
