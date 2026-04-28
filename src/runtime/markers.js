'use strict';

const POISON_KEY = Symbol.for('cascada.poison');
const RESOLVE_MARKER = Symbol.for('cascada.resolve');
const RESOLVED_VALUE_MARKER = Symbol.for('cascada.resolved_value');
const RETURN_UNSET = Symbol.for('cascada.returnUnset');

export { POISON_KEY, RESOLVE_MARKER, RESOLVED_VALUE_MARKER, RETURN_UNSET };
