'use strict';

const lib = require('./src/lib');
const {Environment, AsyncEnvironment, Template, AsyncTemplate} = require('./src/environment');
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

function configure(templatesPath, opts) {
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

  e = new Environment(TemplateLoader, opts);

  if (opts && opts.express) {
    e.express(opts.express);
  }

  return e;
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
  compile(src, env, path, eagerCompile, asyncMode) {
    if (!e) {
      configure();
    }
    return new Template(src, env, path, eagerCompile, asyncMode);
  },
  render(name, ctx, asyncMode, cb) {
    if (!e) {
      configure();
    }

    return e.render(name, ctx, asyncMode, cb);
  },
  renderString(src, ctx, cb) {
    if (!e) {
      configure();
    }

    return e.renderString(src, ctx, cb);
  },
  precompile: (precompile) ? precompile.precompile : undefined,
  precompileString: (precompile) ? precompile.precompileString : undefined,
};
