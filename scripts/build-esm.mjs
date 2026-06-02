import {cpSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const srcDir = path.join(projectRoot, 'src');
const outDir = path.join(projectRoot, 'dist');

const rootFiles = [
  'chain-types.js',
  // Root modules import this by relative path; copying it does not define a
  // package subpath export.
  'errors.js',
  'index.js',
  'lib.js',
  'object.js',
  'precompile-esm.js',
  'precompile-global.js',
  'precompile.js'
];

const directories = [
  'builtins',
  'compiler',
  'environment',
  'inheritance',
  'language',
  'loader',
  'runtime'
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
