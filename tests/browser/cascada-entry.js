import {isObject} from '../../src/lib.js';
import {Environment, AsyncEnvironment, Template, AsyncTemplate, Script} from '../../src/environment/browser-environment.js';
import {WebLoader} from '../../src/loader/web-loaders.js';

export {Environment, AsyncEnvironment, Template, AsyncTemplate, Script} from '../../src/environment/browser-environment.js';
export {Loader} from '../../src/loader/loader.js';
export {WebLoader, PrecompiledLoader} from '../../src/loader/web-loaders.js';
export {SafeString, markSafe} from '../../src/runtime/safe-output.js';
export {TemplateError} from '../../src/lib.js';
export {installCompat as installJinjaCompat} from '../../src/jinja-compat.js';
export {loadString, clearStringCache, raceLoaders} from '../../src/loader/loader-utils.js';

let e;
let asyncE;

export function configure(templatesPath, opts, forAsync = false) {
  opts = opts || {};
  if (isObject(templatesPath)) {
    opts = templatesPath;
    templatesPath = null;
  }

  const templateLoader = new WebLoader(templatesPath, {
    useCache: opts.web && opts.web.useCache,
    async: opts.web && opts.web.async
  });

  if (forAsync) {
    asyncE = new AsyncEnvironment(templateLoader, opts);
    return asyncE;
  }

  e = new Environment(templateLoader, opts);
  return e;
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

/** @deprecated Use renderTemplateString instead */
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
