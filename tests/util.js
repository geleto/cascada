'use strict';

import expectModule from 'expect.js';

const isBrowser = typeof window !== 'undefined';
let nunjucks;
let nunjucksFull;
let isSlim = false;
let Loader;
let templatesPath;
let expect;

if (isBrowser) {
  nunjucks = window.nunjucks;
  if (window.nunjucksFull) {
    isSlim = true;
    nunjucksFull = window.nunjucksFull;
    // These must be the same for instanceof checks to succeed.
    nunjucksFull.runtime.SafeString.prototype = nunjucks.runtime.SafeString.prototype;
  } else {
    nunjucksFull = window.nunjucksFull = nunjucks;
  }
  Loader = nunjucksFull.WebLoader;
  templatesPath = '../templates';
  expect = window.expect;
} else {
  const nunjucksModule = await import('../src/index.js');
  nunjucks = nunjucksFull = nunjucksModule.default || nunjucksModule;
  Loader = nunjucks.FileSystemLoader;
  templatesPath = 'tests/templates';
  expect = expectModule;
}

const precompileString = nunjucksFull.precompileString;
const Environment = nunjucks.Environment;
const Template = nunjucks.Template;

let numAsyncs;
let doneHandler;

beforeEach(function() {
  numAsyncs = 0;
  doneHandler = null;
});

function equal(str, ctx, opts, str2, env) {
  if (typeof ctx === 'string') {
    env = opts;
    str2 = ctx;
    ctx = null;
    opts = {};
  }
  if (typeof opts === 'string') {
    env = str2;
    str2 = opts;
    opts = {};
  }
  opts = opts || {};
  const res = render(str, ctx, opts, env);
  expect(res).to.be(str2);
}

function jinjaEqual(str, ctx, str2, env) {
  const jinjaUninstalls = [nunjucks.installJinjaCompat()];
  if (nunjucksFull !== nunjucks) {
    jinjaUninstalls.push(nunjucksFull.installJinjaCompat());
  }
  try {
    return equal(str, ctx, str2, env);
  } finally {
    for (let i = 0; i < jinjaUninstalls.length; i++) {
      jinjaUninstalls[i]();
    }
  }
}

function finish(done) {
  if (numAsyncs > 0) {
    doneHandler = done;
  } else {
    done();
  }
}

function normEOL(str) {
  if (!str) {
    return str;
  }
  return str.replace(/\r\n|\r/g, '\n');
}

function randomTemplateName() {
  const rand = Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 5);
  return rand + '.njk';
}

function render(str, ctx, opts, env, cb) {
  if (typeof ctx === 'function') {
    cb = ctx;
    ctx = null;
    opts = null;
    env = null;
  } else if (typeof opts === 'function') {
    cb = opts;
    opts = null;
    env = null;
  } else if (typeof env === 'function') {
    cb = env;
    env = null;
  }

  opts = opts || {};
  opts.dev = true;

  let loader;
  let e;

  if (isSlim) {
    e = env || new Environment([], opts);
    loader = e.loaders[0];
  } else {
    loader = new Loader(templatesPath);
    e = env || new Environment(loader, opts);
  }

  let name;
  if (opts.filters) {
    for (name in opts.filters) {
      if (Object.prototype.hasOwnProperty.call(opts.filters, name)) {
        e.addFilter(name, opts.filters[name]);
      }
    }
  }

  if (opts.asyncFilters) {
    for (name in opts.asyncFilters) {
      if (Object.prototype.hasOwnProperty.call(opts.asyncFilters, name)) {
        e.addFilter(name, opts.asyncFilters[name], true);
      }
    }
  }

  if (opts.extensions) {
    for (name in opts.extensions) {
      if (Object.prototype.hasOwnProperty.call(opts.extensions, name)) {
        e.addExtension(name, opts.extensions[name]);
      }
    }
  }

  let tmplName;
  if (isSlim) {
    tmplName = randomTemplateName();
    const precompileJs = precompileString(str, {
      name: tmplName,
      asFunction: true,
      env: e
    });
    eval(precompileJs); // eslint-disable-line no-eval
  }

  ctx = ctx || {};

  let t;

  if (isSlim) {
    const tmplSource = loader.getSource(tmplName);
    t = new Template(tmplSource.src, e, tmplSource.path);
  } else {
    t = new Template(str, e);
  }

  if (!cb) {
    return t.render(ctx);
  }

  numAsyncs++;
  t.render(ctx, function(err, res) {
    if (err && !opts.noThrow) {
      throw err;
    }

    try {
      cb(err, normEOL(res));
    } catch (exc) {
      if (doneHandler) {
        doneHandler(exc);
        numAsyncs = 0;
        doneHandler = null;
      } else {
        throw exc;
      }
    }

    numAsyncs--;

    if (numAsyncs === 0 && doneHandler) {
      doneHandler();
    }
  });
}

async function expectAsyncError(asyncFn, checkFn) {
  let error = null;
  try {
    await asyncFn();
  } catch (e) {
    error = e;
  }

  expect(error).to.be.an(Error);
  if (checkFn) {
    checkFn(error);
  }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class StringLoader {
  constructor() {
    this.templates = new Map();
  }

  getSource(name) {
    if (!this.templates.has(name)) {
      return null;
    }

    return {
      src: this.templates.get(name),
      path: name,
      noCache: false
    };
  }

  addTemplate(name, content) {
    this.templates.set(name, content);
  }
}

const utilApi = {
  render,
  equal,
  jinjaEqual,
  finish,
  normEOL,
  randomTemplateName,
  isSlim,
  Loader,
  expectAsyncError,
  delay,
  StringLoader,
  nunjucks,
  nunjucksFull,
  Environment,
  Template
};

if (isBrowser) {
  window.util = utilApi;
}

export {
  render,
  equal,
  jinjaEqual,
  finish,
  normEOL,
  randomTemplateName,
  isSlim,
  Loader,
  expectAsyncError,
  delay,
  StringLoader,
  nunjucks,
  nunjucksFull,
  Environment,
  Template
};
export default utilApi;
