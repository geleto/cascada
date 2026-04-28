import {cpSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const srcDir = path.join(projectRoot, 'src');
const outDir = path.join(projectRoot, 'dist');

cpSync(srcDir, outDir, {recursive: true});

writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify({type: 'module'}, null, 2)}\n`
);
