'use strict';

const lib = require('./lib');
const {Environment, AsyncEnvironment, Template, AsyncTemplate, Script, AsyncScript} = require('./environment');
const Loader = require('./loader/loader');
const loaders = require('./loader/loaders');
const precompile = require('./precompile');
const compiler = require('./compiler/compiler');
const parser = require('./parser');
const lexer = require('./lexer');
const runtime = require('./runtime/runtime');
const nodes = require('./nodes');
const installJinjaCompat = require('./jinja-compat');
const loaderUtils = require('./loader/loader-utils');

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

module.exports = {
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
  reset() {
    e = undefined;
    asyncE = undefined;
  },
  /** @deprecated Use compileTemplate instead */
  compile(src, env, path, eagerCompile) {
    if (!e) {
      configure();
    }
    return new Template(src, env, path, eagerCompile);
  },
  /** @deprecated Use compileTemplateAsync instead */
  compileAsync(src, env, path, eagerCompile) {
    if (!asyncE) {
      configureAsync();
    }
    return new AsyncTemplate(src, env, path, eagerCompile);
  },
  compileTemplate(src, env, path, eagerCompile) {
    if (!e) {
      configure();
    }
    return new Template(src, env, path, eagerCompile);
  },
  compileTemplateAsync(src, env, path, eagerCompile) {
    if (!asyncE) {
      configureAsync();
    }
    return new AsyncTemplate(src, env, path, eagerCompile);
  },
  compileScript(src, env, path, eagerCompile) {
    if (!e) {
      configure();
    }
    return new Script(src, env, path, eagerCompile);
  },
  compileScriptAsync(src, env, path, eagerCompile) {
    if (!asyncE) {
      configureAsync();
    }
    return new AsyncScript(src, env, path, eagerCompile);
  },
  /** @deprecated Use renderTemplate instead */
  render(name, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.render(name, ctx, cb);
  },
  /** @deprecated Use renderTemplateAsync instead */
  renderAsync(name, ctx) {
    if (!asyncE) {
      configureAsync();
    }
    return asyncE.renderTemplate(name, ctx);
  },
  renderString(src, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderString(src, ctx, cb);
  },
  renderTemplateString(src, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderTemplateString(src, ctx, cb);
  },
  renderScriptString(src, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderScriptString(src, ctx, cb);
  },
  renderScriptStringAsync(src, ctx) {
    if (!asyncE) {
      configureAsync();
    }
    return asyncE.renderScriptString(src, ctx);
  },
  renderTemplate(name, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderTemplate(name, ctx, cb);
  },
  renderTemplateAsync(name, ctx) {
    if (!asyncE) {
      configureAsync();
    }
    return asyncE.renderTemplate(name, ctx);
  },
  /** @deprecated Use precompileTemplate instead */
  precompile: (precompile) ? precompile.precompile : undefined,
  /** @deprecated Use precompileTemplateString instead */
  precompileString: (precompile) ? precompile.precompileString : undefined,

  precompileTemplate: (precompile) ? precompile.precompileTemplate : undefined,
  precompileTemplateString: (precompile) ? precompile.precompileTemplateString : undefined,

  precompileScript: (precompile) ? precompile.precompileScript : undefined,
  precompileScriptString: (precompile) ? precompile.precompileScriptString : undefined,

  precompileTemplateAsync: (precompile) ? precompile.precompileTemplateAsync : undefined,
  precompileTemplateStringAsync: (precompile) ? precompile.precompileTemplateStringAsync : undefined,
  precompileScriptAsync: (precompile) ? precompile.precompileScriptAsync : undefined,
  precompileScriptStringAsync: (precompile) ? precompile.precompileScriptStringAsync : undefined,
  loadString: loaderUtils.loadString,
  clearStringCache: loaderUtils.clearStringCache,
  raceLoaders: loaderUtils.raceLoaders,
};
