'use strict';

const lib = require('./lib');
const {Environment, AsyncEnvironment, Template, AsyncTemplate} = require('./environment');
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
  compileAsync(src, env, path, eagerCompile) {
    if (!asyncE) {
      configureAsync();
    }
    return new AsyncTemplate(src, env, path, eagerCompile);
  },
  render(name, ctx, asyncMode, cb) {
    if (!e) {
      configure();
    }

    return e.render(name, ctx, asyncMode, cb);
  },
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
  precompile: (precompile) ? precompile.precompile : undefined,
  precompileString: (precompile) ? precompile.precompileString : undefined,
  precompileAsync: (precompile) ? precompile.precompileAsync : undefined,
  precompileStringAsync: (precompile) ? precompile.precompileStringAsync : undefined,
};
