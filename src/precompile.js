'use strict';

const fs = require('fs');
const path = require('path');
const {_prettifyError} = require('./lib');
const compiler = require('./compiler/compiler');
const {Environment, AsyncEnvironment} = require('./environment/environment');
const precompileGlobal = require('./precompile-global');

function match(filename, patterns) {
  if (!Array.isArray(patterns)) {
    return false;
  }
  return patterns.some((pattern) => filename.match(pattern));
}

/** @deprecated Use precompileTemplateString instead */
function precompileString(str, opts) {
  opts = Object.assign((opts ?? {}), { isAsync: false, isScript: false });
  opts.isString = true;
  const env = opts.env || new Environment([]);
  const wrapper = opts.wrapper || precompileGlobal;

  if (!opts.name) {
    throw new Error('the "name" option is required when compiling a string');
  }
  return wrapper([_precompile(str, opts.name, env, opts)], opts);
}

function precompileTemplateString(str, opts) {
  opts = opts || {};
  opts.isAsync = false;
  opts.isScript = false;
  return precompileString(str, opts);
}

function precompileScriptString(str, opts) {
  opts = opts || {};
  opts.isAsync = false;
  opts.isScript = true;

  return precompileString(str, opts);
}

function precompileTemplateStringAsync(str, opts) {
  opts = opts || {};
  opts.isAsync = true;
  opts.isScript = false;
  return precompileString(str, opts);
}

function precompileScriptStringAsync(str, opts) {
  opts = opts || {};
  opts.isAsync = true;
  opts.isScript = true;
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
  const wrapper = opts.wrapper || precompileGlobal;

  if (opts.isString) {
    if (opts.isScript) {
      return opts.isAsync ? precompileScriptStringAsync(input, opts) : precompileScriptString(input, opts);
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
    template = compiler.compile(str,
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

function precompileTemplate(str, opts) {
  return precompile(str, opts, false/*async*/, false/*script*/);
}

function precompileScript(str, opts) {
  return precompile(str, opts, false/*async*/, true/*script*/);
}

function precompileTemplateAsync(str, opts) {
  return precompile(str, opts, false/*async*/, false/*script*/);
}

function precompileScriptAsync(str, opts) {
  return precompile(str, opts, false/*async*/, true/*script*/);
}

module.exports = {
  /** @deprecated Use precompileTemplate instead */
  precompile,
  /** @deprecated Use precompileTemplateString instead */
  precompileString,

  // Template variants (new names for existing functions)
  precompileTemplate,
  precompileTemplateAsync,
  precompileTemplateString,
  precompileTemplateStringAsync,

  // Script variants (use same underlying functions since script conversion happens at Script class level)
  precompileScript,
  precompileScriptAsync,
  precompileScriptString,
  precompileScriptStringAsync,
};
