
import fs from 'fs';
import path from 'path';
import {_prettifyError} from './lib.js';
import {compile} from './compiler/compiler.js';
import {Environment, AsyncEnvironment} from './environment/environment.js';
import {precompileGlobal} from './precompile-global.js';
import {precompileEsm} from './precompile-esm.js';
import {transpiler as scriptTranspiler} from './script/script-transpiler.js';

function match(filename, patterns) {
  if (!Array.isArray(patterns)) {
    return false;
  }
  return patterns.some((pattern) => filename.match(pattern));
}

/** @deprecated Use precompileTemplateString instead */
function precompileString(str, opts) {
  opts = Object.assign({ isAsync: false, isScript: false }, opts, { isString: true });
  opts.isString = true;
  const env = opts.isAsync
    ? opts.asyncEnv || opts.env || new AsyncEnvironment([])
    : opts.env || new Environment([]);
  const wrapper = getPrecompileWrapper(opts);

  if (!opts.name) {
    throw new Error('the "name" option is required when compiling a string');
  }
  return wrapper([_precompile(str, opts.name, env, opts)], opts);
}

function precompileTemplateString(str, opts) {
  opts = Object.assign({}, opts, { isAsync: false, isScript: false });
  return precompileString(str, opts);
}

function precompileTemplateStringAsync(str, opts) {
  opts = Object.assign({}, opts, { isAsync: true, isScript: false });
  return precompileString(str, opts);
}

function precompileScriptString(str, opts) {
  opts = Object.assign({}, opts, { isAsync: true, isScript: true });
  return precompileString(str, opts);
}

/** @deprecated Use precompileTemplate instead */
function precompile(input, opts) {
  // The following options are available:
  //
  // * name: name of the template (auto-generated when compiling a directory)
  // * isString: input is a string, not a file path
  // * asFunction: generate a callable function
  // * force: keep compiling on error
  // * env: the Environment to use (gets extensions and async filters from it)
  // * include: which file/folders to include (folders are auto-included, files are auto-excluded)
  // * exclude: which file/folders to exclude (folders are auto-included, files are auto-excluded)
  // * wrapper: function(templates, opts) {...}
  //       Customize the output format to store the compiled template.
  //       By default, templates are stored in a global variable used by the runtime.
  //       A custom loader will be necessary to load your custom wrapper.

  opts = opts || {};
  const env = opts.isAsync ? opts.asyncEnv || new AsyncEnvironment([]) : opts.env || new Environment([]);
  const wrapper = getPrecompileWrapper(opts);

  if (opts.isString) {
    if (opts.isScript) {
      return precompileScriptString(input, opts);
    } else {
      return opts.isAsync ? precompileTemplateStringAsync(input, opts) : precompileTemplateString(input, opts);
    }
  }

  const pathStats = fs.existsSync(input) && fs.statSync(input);
  const precompiled = [];
  const templates = [];

  function addTemplates(dir) {
    fs.readdirSync(dir).forEach((file) => {
      const filepath = path.join(dir, file);
      let subpath = filepath.substr(path.join(input, '/').length);
      const stat = fs.statSync(filepath);

      if (stat && stat.isDirectory()) {
        subpath += '/';
        if (!match(subpath, opts.exclude)) {
          addTemplates(filepath);
        }
      } else if (match(subpath, opts.include)) {
        templates.push(filepath);
      }
    });
  }

  if (pathStats.isFile()) {
    precompiled.push(_precompile(
      fs.readFileSync(input, 'utf-8'),
      opts.name || input,
      env,
      opts
    ));
  } else if (pathStats.isDirectory()) {
    addTemplates(input);

    for (let i = 0; i < templates.length; i++) {
      const name = templates[i].replace(path.join(input, '/'), '');

      try {
        precompiled.push(_precompile(
          fs.readFileSync(templates[i], 'utf-8'),
          name,
          env,
          opts
        ));
      } catch (e) {
        if (opts.force) {
          // Don't stop generating the output if we're
          // forcing compilation.
          console.error(e);
        } else {
          throw e;
        }
      }
    }
  }

  return wrapper(precompiled, opts);
}

function _precompile(str, name, env, opts) {
  env = env || new Environment([]);

  const asyncFilters = env.asyncFilters;
  const extensions = env.extensionsList;
  let template;

  name = name.replace(/\\/g, '/');

  try {
    const source = opts.isScript ? scriptTranspiler.scriptToTemplate(str) : str;
    template = compile(source,
      asyncFilters,
      extensions,
      name,
      Object.assign({asyncMode: opts.isAsync, scriptMode: opts.isScript}, env.opts)
    );
  } catch (err) {
    throw _prettifyError(name, false, err);
  }

  return {
    name: name,
    template: template
  };
}

function getPrecompileWrapper(opts) {
  if (opts.wrapper) {
    return opts.wrapper;
  }
  if (opts.format === 'esm') {
    return precompileEsm;
  }
  return precompileGlobal;
}

function precompileTemplate(str, opts) {
  return precompile(str, Object.assign({}, opts, { isAsync: false, isScript: false }));
}

function precompileTemplateAsync(str, opts) {
  return precompile(str, Object.assign({}, opts, { isAsync: true, isScript: false }));
}

function precompileScript(str, opts) {
  return precompile(str, Object.assign({}, opts, { isAsync: true, isScript: true }));
}

export {
  /** @deprecated Use precompileTemplate instead */
  precompile,
  /** @deprecated Use precompileTemplateString instead */
  precompileString,
  precompileTemplate,
  precompileTemplateAsync,
  precompileTemplateString,
  precompileTemplateStringAsync,
  precompileScript,
  precompileScriptString,
  precompileEsm
};
