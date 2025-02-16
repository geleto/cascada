import lib from './src/lib.js';
import {Environment, AsyncEnvironment, Template, AsyncTemplate} from './src/environment.js';
import Loader from './src/loader.js';
import * as loaders from './src/loaders.js';
import * as precompileModule from './src/precompile.js';
import * as compiler from './src/compiler.js';
import * as parser from './src/parser.js';
import * as lexer from './src/lexer.js';
import * as runtime from './src/runtime.js';
import * as nodes from './src/nodes.js';
import installJinjaCompat from './src/jinja-compat.js';

// A single instance of an environment, since this is so commonly used
let e;
// A single instance of an async environment
let asyncE;

function configure(templatesPath, opts, forAsync = false) {
  opts = opts || {};
  if (lib.isObject(templatesPath)) {
    opts = templatesPath;
    templatesPath = null;
  }

  let TemplateLoader;
  if (loaders.FileSystemLoader) {
    TemplateLoader = new loaders.FileSystemLoader(templatesPath, {
      watch: opts.watch,
      noCache: opts.noCache
    });
  } else if (loaders.WebLoader) {
    TemplateLoader = new loaders.WebLoader(templatesPath, {
      useCache: opts.web && opts.web.useCache,
      async: opts.web && opts.web.async
    });
  }

  if (forAsync) {
    asyncE = new AsyncEnvironment(TemplateLoader, opts);
    if (opts && opts.express) {
      asyncE.express(opts.express);
    }
    return asyncE;
  } else {
    e = new Environment(TemplateLoader, opts);
    if (opts && opts.express) {
      e.express(opts.express);
    }
    return e;
  }
}

function configureAsync(templatesPath, opts) {
  return configure(templatesPath, opts, true);
}

// Named exports
export {
  Environment,
  AsyncEnvironment,
  Template,
  AsyncTemplate,
  Loader,
  compiler,
  parser,
  lexer,
  runtime,
  lib,
  nodes,
  installJinjaCompat,
  configure,
};

// Export loaders
export const {
  FileSystemLoader,
  NodeResolveLoader,
  PrecompiledLoader,
  WebLoader
} = loaders;

// Export precompile functions
export const precompile = precompileModule ? precompileModule.precompile : undefined;
export const precompileString = precompileModule ? precompileModule.precompileString : undefined;
export const precompileAsync = precompileModule ? precompileModule.precompileAsync : undefined;
export const precompileStringAsync = precompileModule ? precompileModule.precompileStringAsync : undefined;

export function reset() {
  e = undefined;
  asyncE = undefined;
}

export function compile(src, env, path, eagerCompile) {
  if (!e) {
    configure();
  }
  return new Template(src, env, path, eagerCompile);
}

export function compileAsync(src, env, path, eagerCompile) {
  if (!asyncE) {
    configureAsync();
  }
  return new AsyncTemplate(src, env, path, eagerCompile);
}

export function render(name, ctx, asyncMode, cb) {
  if (!e) {
    configure();
  }
  return e.render(name, ctx, asyncMode, cb);
}

export function renderAsync(name, ctx) {
  if (!asyncE) {
    configureAsync();
  }
  return asyncE.render(name, ctx, true);
}

export function renderString(src, ctx, cb) {
  if (!e) {
    configure();
  }
  return e.renderString(src, ctx, cb);
}

export function renderStringAsync(src, ctx, cb) {
  if (!asyncE) {
    configureAsync();
  }
  return asyncE.renderString(src, ctx, cb);
}

// Default export
export default {
  Environment,
  AsyncEnvironment,
  Template,
  AsyncTemplate,
  Loader,
  FileSystemLoader: loaders.FileSystemLoader,
  NodeResolveLoader: loaders.NodeResolveLoader,
  PrecompiledLoader: loaders.PrecompiledLoader,
  WebLoader: loaders.WebLoader,
  compiler,
  parser,
  lexer,
  runtime,
  lib,
  nodes,
  installJinjaCompat,
  configure,
  reset,
  compile,
  compileAsync,
  render,
  renderAsync,
  renderString,
  renderStringAsync,
  precompile,
  precompileString,
  precompileAsync,
  precompileStringAsync
};