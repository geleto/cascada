
import {isObject} from './lib.js';
import {Environment, AsyncEnvironment, Template, AsyncTemplate, Script} from './environment/environment.js';
import {FileSystemLoader, WebLoader} from './loader/loaders.js';

export {Environment, AsyncEnvironment, Template, AsyncTemplate, Script} from './environment/environment.js';
export {default as Loader} from './loader/loader.js';
export {FileSystemLoader, NodeResolveLoader, PrecompiledLoader, WebLoader} from './loader/loaders.js';
export * as compiler from './compiler/compiler.js';
export * as parser from './parser.js';
export * as lexer from './lexer.js';
export * as runtime from './runtime/runtime.js';
export * as lib from './lib.js';
export * as nodes from './nodes.js';
export {default as installJinjaCompat} from './jinja-compat.js';
export {
  precompile,
  precompileString,
  precompileTemplate,
  precompileTemplateAsync,
  precompileTemplateString,
  precompileTemplateStringAsync,
  precompileScript,
  precompileScriptString
} from './precompile.js';
export {loadString, clearStringCache, raceLoaders} from './loader/loader-utils.js';

// A single instance of an environment, since this is so commonly used
let e;
// A single instance of an async environment
let asyncE;

export function configure(templatesPath, opts, forAsync = false) {
  opts = opts || {};
  if (isObject(templatesPath)) {
    opts = templatesPath;
    templatesPath = null;
  }

  let TemplateLoader;
  if (FileSystemLoader) {
    TemplateLoader = new FileSystemLoader(templatesPath, {
      watch: opts.watch,
      noCache: opts.noCache
    });
  } else if (WebLoader) {
    TemplateLoader = new WebLoader(templatesPath, {
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

export function configureAsync(templatesPath, opts) {
  return configure(templatesPath, opts, true);
}

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
  if (!asyncE) {
    configureAsync();
  }
  return new Script(src, env, path, eagerCompile);
}

/** @deprecated Use renderTemplate instead */
export function render(name, ctx, cb) {
  if (!e) {
    configure();
  }
  return e.render(name, ctx, cb);
}

/** @deprecated Use renderTemplateAsync instead */
export function renderAsync(name, ctx) {
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

export function renderScriptString(src, ctx) {
  if (!asyncE) {
    configureAsync();
  }
  return asyncE.renderScriptString(src, ctx);
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
