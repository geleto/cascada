
import {Environment} from './sync-environment.js';
import {AsyncEnvironment} from './async-environment.js';
import {setDefaultEnvironmentClasses} from './default-environment.js';
import {setDefaultLoaderClasses} from './base-environment.js';
import {FileSystemLoader, WebLoader} from '../loader/loaders.js';

setDefaultEnvironmentClasses(Environment, AsyncEnvironment);
setDefaultLoaderClasses(FileSystemLoader, WebLoader);

export {BaseEnvironment} from './base-environment.js';
export {Environment} from './sync-environment.js';
export {AsyncEnvironment} from './async-environment.js';
export {Template, AsyncTemplate} from './template.js';
export {Script} from './script.js';
export {Context} from './context.js';
