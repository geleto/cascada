'use strict';

const lib = require('./lib');
const {Environment, AsyncEnvironment, Template, AsyncTemplate, Script, AsyncScript} = require('./environment');
const Loader = require('./loader');
const loaders = require('./loaders');
const precompile = require('./precompile');
const compiler = require('./compiler');
const parser = require('./parser');
const lexer = require('./lexer');
const runtime = require('./runtime');
const nodes = require('./nodes');
const installJinjaCompat = require('./jinja-compat');

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
  Environment: Environment,
  AsyncEnvironment: AsyncEnvironment,
  Template: Template,
  AsyncTemplate: AsyncTemplate,
  Script: Script,
  AsyncScript: AsyncScript,
  Loader: Loader,
  FileSystemLoader: loaders.FileSystemLoader,
  NodeResolveLoader: loaders.NodeResolveLoader,
  PrecompiledLoader: loaders.PrecompiledLoader,
  WebLoader: loaders.WebLoader,
  compiler: compiler,
  parser: parser,
  lexer: lexer,
  runtime: runtime,
  lib: lib,
  nodes: nodes,
  installJinjaCompat: installJinjaCompat,
  configure: configure,
  reset() {
    e = undefined;
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
  render(name, ctx, asyncMode, cb) {
    if (!e) {
      configure();
    }
    return e.render(name, ctx, asyncMode, cb);
  },
  /** @deprecated Use renderTemplateAsync instead */
  renderAsync(name, ctx) {
    if (!asyncE) {
      configureAsync();
    }
    return asyncE.render(name, ctx, true);
  },
  renderString(src, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderString(src, ctx, cb);
  },
  renderStringAsync(src, ctx, cb) {
    if (!asyncE) {
      configureAsync();
    }
    return asyncE.renderString(src, ctx, cb);
  },
  renderTemplateString(src, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderTemplateString(src, ctx, cb);
  },
  renderTemplateStringAsync(src, ctx, cb) {
    if (!asyncE) {
      configureAsync();
    }
    return asyncE.renderTemplateString(src, ctx, cb);
  },
  renderScriptString(src, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderScriptString(src, ctx, cb);
  },
  renderScriptStringAsync(src, ctx, cb) {
    if (!asyncE) {
      configureAsync();
    }
    return asyncE.renderScriptString(src, ctx, cb);
  },
  /** @deprecated Use precompileTemplate instead */
  precompile: (precompile) ? precompile.precompile : undefined,
  /** @deprecated Use precompileTemplateString instead */
  precompileString: (precompile) ? precompile.precompileString : undefined,
  /** @deprecated Use precompileTemplateAsync instead */
  precompileAsync: (precompile) ? precompile.precompileAsync : undefined,
  /** @deprecated Use precompileTemplateStringAsync instead */
  precompileStringAsync: (precompile) ? precompile.precompileStringAsync : undefined,

  // New template compilation functions
  precompileTemplate: (precompile) ? precompile.precompileTemplate : undefined,
  precompileTemplateString: (precompile) ? precompile.precompileTemplateString : undefined,
  precompileTemplateAsync: (precompile) ? precompile.precompileTemplateAsync : undefined,
  precompileTemplateStringAsync: (precompile) ? precompile.precompileTemplateStringAsync : undefined,

  // New script compilation functions
  precompileScript: (precompile) ? precompile.precompileScript : undefined,
  precompileScriptString: (precompile) ? precompile.precompileScriptString : undefined,
  precompileScriptAsync: (precompile) ? precompile.precompileScriptAsync : undefined,
  precompileScriptStringAsync: (precompile) ? precompile.precompileScriptStringAsync : undefined,
};
