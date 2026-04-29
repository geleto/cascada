import {cpSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const srcDir = path.join(projectRoot, 'src');
const outDir = path.join(projectRoot, 'dist');

const rootFiles = [
  'channel-types.js',
  'express-app.js',
  'filters.js',
  'globals.js',
  'index.js',
  'jinja-compat.js',
  'lexer.js',
  'lib.js',
  'nodes.js',
  'object.js',
  'parser.js',
  'precompile-esm.js',
  'precompile-global.js',
  'precompile.js',
  'tests.js',
  'transformer.js'
];

const directories = [
  'browser',
  'compiler',
  'environment',
  'loader',
  'runtime',
  'script'
];

function copyFromSrc(relativePath) {
  cpSync(
    path.join(srcDir, relativePath),
    path.join(outDir, relativePath),
    {recursive: true}
  );
}

mkdirSync(outDir, {recursive: true});

for (const file of rootFiles) {
  copyFromSrc(file);
}

for (const directory of directories) {
  copyFromSrc(directory);
}

mkdirSync(path.join(outDir, 'precompiled'), {recursive: true});
copyFromSrc(path.join('precompiled', 'index.js'));

writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify({type: 'module'}, null, 2)}\n`
);
