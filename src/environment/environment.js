'use strict';

// Import all the separated classes
import {BaseEnvironment} from './base-environment.js';

import {Environment} from './sync-environment.js';
import {AsyncEnvironment} from './async-environment.js';
import {Template, AsyncTemplate} from './template.js';
import {Script} from './script.js';
import {Context} from './context.js';
import {setDefaultEnvironmentClasses} from './default-environment.js';

setDefaultEnvironmentClasses(Environment, AsyncEnvironment);

// Re-export all the classes
export { BaseEnvironment, Environment, AsyncEnvironment, Template, AsyncTemplate, Script, Context };
