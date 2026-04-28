import fs from 'fs';
import path from 'path';
import {Buffer} from 'buffer';
import {fileURLToPath, pathToFileURL} from 'url';
import expect from 'expect.js';
import {precompileTemplateStringAsync} from '../src/precompile.js';
import {
  AsyncEnvironment,
  PrecompiledLoader
} from '../src/browser/precompiled.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

async function importGeneratedModule(source) {
  const encoded = Buffer.from(source).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
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

  it('should not statically import compiler or loader-heavy modules', function() {
    const importedFiles = [...collectStaticImports('src/browser/precompiled.js')]
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

  it('should be importable from the built package subpath', async function() {
    if (!fs.existsSync(path.join(projectRoot, 'dist/browser/precompiled.js'))) {
      this.skip();
    }
    const moduleUrl = pathToFileURL(path.join(projectRoot, 'dist/browser/precompiled.js'));
    const entry = await import(moduleUrl);

    expect(entry.AsyncEnvironment).to.be.a('function');
    expect(entry.PrecompiledLoader).to.be.a('function');
  });
});
