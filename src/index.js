'use strict';

import lib from './lib';
import {Environment, AsyncEnvironment, Template, AsyncTemplate, Script} from './environment/environment';
import Loader from './loader/loader';
import loaders from './loader/loaders';
import precompileModule from './precompile';
import compiler from './compiler/compiler';
import parser from './parser';
import lexer from './lexer';
import runtime from './runtime/runtime';
import nodes from './nodes';
import installJinjaCompat from './jinja-compat';
import loaderUtils from './loader/loader-utils';

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

const __defaultExport = {
  Environment,
  AsyncEnvironment,
  Template,
  AsyncTemplate,
  Script,
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
    if (!asyncE) {
      configureAsync();
    }
    return new Script(src, env, path, eagerCompile);
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
  renderScriptString(src, ctx) {
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
  precompile: (precompileModule) ? precompileModule.precompile : undefined,
  /** @deprecated Use precompileTemplateString instead */
  precompileString: (precompileModule) ? precompileModule.precompileString : undefined,

  precompileTemplate: (precompileModule) ? precompileModule.precompileTemplate : undefined,
  precompileTemplateString: (precompileModule) ? precompileModule.precompileTemplateString : undefined,

  precompileTemplateAsync: (precompileModule) ? precompileModule.precompileTemplateAsync : undefined,
  precompileTemplateStringAsync: (precompileModule) ? precompileModule.precompileTemplateStringAsync : undefined,
  precompileScript: (precompileModule) ? precompileModule.precompileScript : undefined,
  precompileScriptString: (precompileModule) ? precompileModule.precompileScriptString : undefined,
  loadString: loaderUtils.loadString,
  clearStringCache: loaderUtils.clearStringCache,
  raceLoaders: loaderUtils.raceLoaders,
};
export { Environment, AsyncEnvironment, Template, AsyncTemplate, Script, Loader, compiler, parser, lexer, runtime, lib, nodes, installJinjaCompat, configure };

export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
