import fs from 'fs';
import path from 'path';
import {Buffer} from 'buffer';
import {fileURLToPath, pathToFileURL} from 'url';
import expect from 'expect.js';
import {
  precompileScriptString,
  precompileTemplateStringAsync
} from '../src/precompile.js';
import {AsyncEnvironment as FullAsyncEnvironment} from '../src/index.js';
import {
  AsyncEnvironment,
  PrecompiledLoader
} from '../src/precompiled/index.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

async function importGeneratedModule(source) {
  const encoded = Buffer.from(source).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

async function precompileTemplateMap(templates) {
  const precompiled = {};

  for (const template of templates) {
    const source = precompileTemplateStringAsync(template.source, {
      name: template.name,
      format: 'esm',
      asyncEnv: template.asyncEnv
    });
    Object.assign(precompiled, (await importGeneratedModule(source)).default);
  }

  return precompiled;
}

function collectStaticImports(entry, seen = new Set()) {
  const absolute = path.resolve(projectRoot, entry);
  if (seen.has(absolute)) {
    return seen;
  }
  seen.add(absolute);

  const source = fs.readFileSync(absolute, 'utf8');
  const importPattern = /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) {
      continue;
    }
    const next = path.resolve(path.dirname(absolute), specifier);
    collectStaticImports(next, seen);
  }

  return seen;
}

describe('precompiled runtime entry', function() {
  it('should render async precompiled templates without the full entry', async function() {
    const source = precompileTemplateStringAsync('Hello {{ getName() }}', {
      name: 'hello.njk',
      format: 'esm'
    });
    const templates = (await importGeneratedModule(source)).default;
    const env = new AsyncEnvironment(new PrecompiledLoader(templates));
    env.addGlobal('getName', () => Promise.resolve('Cascada'));

    const result = await env.renderTemplate('hello.njk');

    expect(result).to.be('Hello Cascada');
  });

  it('should reject runtime string compilation', async function() {
    const env = new AsyncEnvironment(new PrecompiledLoader({}));

    try {
      await env.renderTemplateString('Hello');
      expect().fail('Expected precompiled environment to reject string templates');
    } catch (err) {
      expect(err.message).to.contain('Template string rendering is not available');
    }
  });

  it('should render async precompiled scripts without the compiler', async function() {
    const source = precompileScriptString('var result = {name: getName()}\nreturn result', {
      name: 'script.casc',
      format: 'esm'
    });
    const scripts = (await importGeneratedModule(source)).default;
    const env = new AsyncEnvironment(new PrecompiledLoader(scripts));
    env.addGlobal('getName', () => Promise.resolve('Cascada'));

    const result = await env.renderScript('script.casc');

    expect(result).to.eql({name: 'Cascada'});
  });

  it('should render precompiled scripts with data output commands', async function() {
    const source = precompileScriptString(`
data result
result.items.push(getName())
return result.snapshot()
`, {
      name: 'data-script.casc',
      format: 'esm'
    });
    const scripts = (await importGeneratedModule(source)).default;
    const env = new AsyncEnvironment(new PrecompiledLoader(scripts));
    env.addGlobal('getName', () => Promise.resolve('Cascada'));

    const result = await env.renderScript('data-script.casc');

    expect(result).to.eql({items: ['Cascada']});
  });

  it('should render precompiled scripts with custom data methods', async function() {
    const source = precompileScriptString(`
data result
result.count.incrementBy(3)
return result.snapshot()
`, {
      name: 'custom-data-method.casc',
      format: 'esm'
    });
    const scripts = (await importGeneratedModule(source)).default;
    const env = new AsyncEnvironment(new PrecompiledLoader(scripts));
    env.addDataMethods({
      incrementBy(target, amount) {
        return (target || 0) + amount;
      }
    });

    const result = await env.renderScript('custom-data-method.casc');

    expect(result).to.eql({count: 3});
  });

  it('should render precompiled templates with async filters', async function() {
    const compileEnv = new FullAsyncEnvironment([]);
    compileEnv.addFilter('delayed', (value, cb) => {
      setTimeout(() => cb(null, value + '!'), 0);
    }, true);
    const source = precompileTemplateStringAsync('{{ "go" | delayed }}', {
      name: 'async-filter.njk',
      format: 'esm',
      asyncEnv: compileEnv
    });
    const templates = (await importGeneratedModule(source)).default;
    const env = new AsyncEnvironment(new PrecompiledLoader(templates));
    env.addFilter('delayed', (value, cb) => {
      setTimeout(() => cb(null, value + '!'), 0);
    }, true);

    const result = await env.renderTemplate('async-filter.njk');

    expect(result).to.be('go!');
  });

  it('should render precompiled includes, imports, and inheritance from the loader map', async function() {
    const templates = await precompileTemplateMap([
      {
        name: 'base.njk',
        source: 'Base:{% block body %}{% endblock %}'
      },
      {
        name: 'include.njk',
        source: 'Included'
      },
      {
        name: 'macros.njk',
        source: '{% macro label(value) %}[{{ value }}]{% endmacro %}'
      },
      {
        name: 'include-page.njk',
        source: '{% include "include.njk" %}'
      },
      {
        name: 'import-page.njk',
        source: '{% import "macros.njk" as macros %}{{ macros.label(name) }}'
      },
      {
        name: 'child.njk',
        source: '{% extends "base.njk" %}{% block body %}Child {{ name }}{% endblock %}'
      }
    ]);
    const env = new AsyncEnvironment(new PrecompiledLoader(templates));

    const includeResult = await env.renderTemplate('include-page.njk', {name: 'Cascada'});
    const importResult = await env.renderTemplate('import-page.njk', {name: 'Cascada'});
    const inheritanceResult = await env.renderTemplate('child.njk', {name: 'Cascada'});

    expect(includeResult).to.be('Included');
    expect(importResult).to.be('[Cascada]');
    expect(inheritanceResult).to.be('Base:Child Cascada');
  });

  it('should preserve template names in precompiled error reports', async function() {
    const source = precompileTemplateStringAsync('{{ explode() }}', {
      name: 'bad-template.njk',
      format: 'esm'
    });
    const templates = (await importGeneratedModule(source)).default;
    const env = new AsyncEnvironment(new PrecompiledLoader(templates));
    env.addGlobal('explode', () => {
      throw new Error('boom');
    });

    try {
      await env.renderTemplate('bad-template.njk');
      expect().fail('Expected precompiled template render to fail');
    } catch (err) {
      expect(err.message).to.contain('bad-template.njk');
      expect(err.message).to.contain('boom');
    }
  });

  it('should not statically import compiler or loader-heavy modules from the shared entry', function() {
    const importedFiles = [...collectStaticImports('src/precompiled/index.js')]
      .map((file) => path.relative(projectRoot, file).replace(/\\/g, '/'));
    const forbidden = [
      'src/compiler/',
      'src/parser.js',
      'src/lexer.js',
      'src/nodes.js',
      'src/transformer.js',
      'src/precompile.js',
      'src/loader/loaders.js',
      'src/loader/node-loaders.js',
      'src/loader/web-loaders.js'
    ];

    for (const file of importedFiles) {
      expect(forbidden.some((pattern) => file.includes(pattern))).to.be(false);
    }
  });

  it('should not import the full entry from the browser precompiled harness', function() {
    const source = fs.readFileSync(path.join(projectRoot, 'tests/browser/precompiled.js'), 'utf8');

    expect(source).to.not.contain('../../src/index.js');
    expect(source).to.not.contain('nunjucksFull');
    expect(source).to.not.contain('cascadaFull');
  });

  it('should be importable from the built package subpath', async function() {
    if (!fs.existsSync(path.join(projectRoot, 'dist/precompiled/index.js'))) {
      this.skip();
    }
    const moduleUrl = pathToFileURL(path.join(projectRoot, 'dist/precompiled/index.js'));
    const entry = await import(moduleUrl);

    expect(entry.AsyncEnvironment).to.be.a('function');
    expect(entry.PrecompiledLoader).to.be.a('function');
  });

  it('should be importable through the package precompiled export after build', async function() {
    if (!fs.existsSync(path.join(projectRoot, 'dist/precompiled/index.js'))) {
      this.skip();
    }

    const entry = await import('cascada-engine/precompiled');

    expect(entry.AsyncEnvironment).to.be.a('function');
    expect(entry.PrecompiledLoader).to.be.a('function');
    expect(entry.Script).to.be.a('function');
  });
});
