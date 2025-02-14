import lib from './src/lib.js';
import {Environment, PAsyncEnvironment, Template, PAsyncTemplate} from './src/environment.js';
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
    asyncE = new PAsyncEnvironment(TemplateLoader, opts);
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

function configurePAsync(templatesPath, opts) {
  return configure(templatesPath, opts, true);
}

// Named exports
export {
  Environment,
  PAsyncEnvironment,
  Template,
  PAsyncTemplate,
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
export const precompilePAsync = precompileModule ? precompileModule.precompilePAsync : undefined;
export const precompileStringPAsync = precompileModule ? precompileModule.precompileStringPAsync : undefined;

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

export function compilePAsync(src, env, path, eagerCompile) {
  if (!asyncE) {
    configurePAsync();
  }
  return new PAsyncTemplate(src, env, path, eagerCompile);
}

export function render(name, ctx, asyncMode, cb) {
  if (!e) {
    configure();
  }
  return e.render(name, ctx, asyncMode, cb);
}

export function renderPAsync(name, ctx) {
  if (!asyncE) {
    configurePAsync();
  }
  return asyncE.render(name, ctx, true);
}

export function renderString(src, ctx, cb) {
  if (!e) {
    configure();
  }
  return e.renderString(src, ctx, cb);
}

export function renderStringPAsync(src, ctx, cb) {
  if (!asyncE) {
    configurePAsync();
  }
  return asyncE.renderString(src, ctx, cb);
}

// Default export
export default {
  Environment,
  PAsyncEnvironment,
  Template,
  PAsyncTemplate,
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
  compilePAsync,
  render,
  renderPAsync,
  renderString,
  renderStringPAsync,
  precompile,
  precompileString,
  precompilePAsync,
  precompileStringPAsync
};