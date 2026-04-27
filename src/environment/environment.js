'use strict';

// Import all the separated classes
import {BaseEnvironment} from './base-environment';

import {Environment} from './sync-environment';
import {AsyncEnvironment} from './async-environment';
import {Template, AsyncTemplate} from './template';
import {Script} from './script';
import {Context} from './context';

// Re-export all the classes
const __defaultExport = {
  BaseEnvironment,
  Environment,
  AsyncEnvironment,
  Template,
  AsyncTemplate,
  Script,
  Context
};
export { BaseEnvironment, Environment, AsyncEnvironment, Template, AsyncTemplate, Script, Context };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
