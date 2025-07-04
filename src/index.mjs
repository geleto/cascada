import lib from './lib.js';
import {Environment, AsyncEnvironment, Template, AsyncTemplate, Script, AsyncScript} from './environment.js';
import Loader from './loader.js';
import * as loaders from './loaders.js';
import * as precompileModule from './precompile.js';
import * as compiler from './compiler.js';
import * as parser from './parser.js';
import * as lexer from './lexer.js';
import * as runtime from './runtime.js';
import * as nodes from './nodes.js';
import installJinjaCompat from './jinja-compat.js';

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
  Script,
  AsyncScript,
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
/** @deprecated Use precompileTemplate instead */
export const precompile = precompileModule ? precompileModule.precompile : undefined;
/** @deprecated Use precompileTemplateString instead */
export const precompileString = precompileModule ? precompileModule.precompileString : undefined;

export const precompileTemplate = precompileModule ? precompileModule.precompileTemplate : undefined;
export const precompileTemplateString = precompileModule ? precompileModule.precompileTemplateString : undefined;
export const precompileScript = precompileModule ? precompileModule.precompileScript : undefined;
export const precompileScriptString = precompileModule ? precompileModule.precompileScriptString : undefined;

//@todo - does this realy return a promise?
export const precompileTemplateAsync = precompileModule ? precompileModule.precompileTemplateAsync : undefined;
export const precompileTemplateStringAsync = precompileModule ? precompileModule.precompileTemplateStringAsync : undefined;
export const precompileScriptAsync = precompileModule ? precompileModule.precompileScriptAsync : undefined;
export const precompileScriptStringAsync = precompileModule ? precompileModule.precompileScriptStringAsync : undefined;


export function reset() {
  e = undefined;
  asyncE = undefined;
}

/** @deprecated Use compileTemplate instead */
export function compile(src, env, path, eagerCompile) {
  if (!e) {
    configure();
  }
  return new Template(src, env, path, eagerCompile);
}

/** @deprecated Use compileTemplateAsync instead */
export function compileAsync(src, env, path, eagerCompile) {
  if (!asyncE) {
    configureAsync();
  }
  return new AsyncTemplate(src, env, path, eagerCompile);
}

export function compileTemplate(src, env, path, eagerCompile) {
  if (!e) {
    configure();
  }
  return new Template(src, env, path, eagerCompile);
}

export function compileTemplateAsync(src, env, path, eagerCompile) {
  if (!asyncE) {
    configureAsync();
  }
  return new AsyncTemplate(src, env, path, eagerCompile);
}

export function compileScript(src, env, path, eagerCompile) {
  if (!e) {
    configure();
  }
  return new Script(src, env, path, eagerCompile);
}

export function compileScriptAsync(src, env, path, eagerCompile) {
  if (!asyncE) {
    configureAsync();
  }
  return new AsyncScript(src, env, path, eagerCompile);
}

/** @deprecated Use renderTemplate instead */
export function render(name, ctx, asyncMode, cb) {
  if (!e) {
    configure();
  }
  return e.render(name, ctx, asyncMode, cb);
}

/** @deprecated Use renderTemplateAsync instead */
export function renderAsync(name, ctx) {
  if (!asyncE) {
    configureAsync();
  }
  return asyncE.renderTemplate(name, ctx);
}

export function renderTemplate(name, ctx, cb) {
  if (!e) {
    configure();
  }
  return e.renderTemplate(name, ctx, cb);
}

export function renderTemplateAsync(name, ctx) {
  if (!asyncE) {
    configureAsync();
  }
  return asyncE.renderTemplate(name, ctx);
}

export function renderString(src, ctx, cb) {
  if (!e) {
    configure();
  }
  return e.renderString(src, ctx, cb);
}

export function renderTemplateString(src, ctx, cb) {
  if (!e) {
    configure();
  }
  return e.renderTemplateString(src, ctx, cb);
}

export function renderTemplateStringAsync(src, ctx) {
  if (!asyncE) {
    configureAsync();
  }
  return asyncE.renderTemplateString(src, ctx);
}

export function renderScriptString(src, ctx, cb) {
  if (!e) {
    configure();
  }
  return e.renderScriptString(src, ctx, cb);
}

export function renderScriptStringAsync(src, ctx) {
  if (!asyncE) {
    configureAsync();
  }
  return asyncE.renderScriptString(src, ctx);
}

// Default export
export default {
  Environment,
  AsyncEnvironment,
  Template,
  AsyncTemplate,
  Script,
  AsyncScript,
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
  compileTemplate,
  compileTemplateAsync,
  compileScript,
  compileScriptAsync,
  render,
  renderAsync,
  renderString,
  renderTemplate,
  renderTemplateAsync,
  renderTemplateString,
  renderTemplateStringAsync,
  renderScriptString,
  renderScriptStringAsync,
  precompile,
  precompileString,
  precompileTemplate,
  precompileTemplateString,
  precompileTemplateAsync,
  precompileTemplateStringAsync,
  precompileScript,
  precompileScriptString,
  precompileScriptAsync,
  precompileScriptStringAsync
};