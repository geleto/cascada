'use strict';

const lib = require('./src/lib');
const {Environment, PAsyncEnvironment, Template, PAsyncTemplate} = require('./src/environment');
const Loader = require('./src/loader');
const loaders = require('./src/loaders');
const precompile = require('./src/precompile');
const compiler = require('./src/compiler');
const parser = require('./src/parser');
const lexer = require('./src/lexer');
const runtime = require('./src/runtime');
const nodes = require('./src/nodes');
const installJinjaCompat = require('./src/jinja-compat');

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

module.exports = {
  Environment: Environment,
  PAsyncEnvironment: PAsyncEnvironment,
  Template: Template,
  PAsyncTemplate: PAsyncTemplate,
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
  compile(src, env, path, eagerCompile) {
    if (!e) {
      configure();
    }
    return new Template(src, env, path, eagerCompile);
  },
  compilePAsync(src, env, path, eagerCompile) {
    if (!asyncE) {
      configurePAsync();
    }
    return new PAsyncTemplate(src, env, path, eagerCompile);
  },
  render(name, ctx, asyncMode, cb) {
    if (!e) {
      configure();
    }

    return e.render(name, ctx, asyncMode, cb);
  },
  renderPAsync(name, ctx) {
    if (!asyncE) {
      configurePAsync();
    }
    return asyncE.render(name, ctx, true);
  },
  renderString(src, ctx, cb) {
    if (!e) {
      configure();
    }
    return e.renderString(src, ctx, cb);
  },
  renderStringPAsync(src, ctx, cb) {
    if (!asyncE) {
      configurePAsync();
    }
    return asyncE.renderString(src, ctx, cb);
  },
  precompile: (precompile) ? precompile.precompile : undefined,
  precompileString: (precompile) ? precompile.precompileString : undefined,
  precompilePAsync: (precompile) ? precompile.precompilePAsync : undefined,
  precompileStringPAsync: (precompile) ? precompile.precompileStringPAsync : undefined,
};
