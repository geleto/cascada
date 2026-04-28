import {copyFileSync, mkdirSync} from 'fs';
import path from 'path';

const tasks = {
  types: [
    ['src/index.d.ts', 'dist/types/index.d.ts'],
    ['src/precompiled/index.d.ts', 'dist/types/precompiled/index.d.ts']
  ],
  docs: [
    ['docs/cascada/script.md', 'dist/docs/script.md'],
    ['README.md', 'dist/docs/README.md']
  ],
  bin: [
    ['bin/precompile', 'dist/bin/precompile'],
    ['bin/precompile.cmd', 'dist/bin/precompile.cmd']
  ]
};

const taskName = process.argv[2];
const task = tasks[taskName];

if (!task) {
  console.error(`Usage: node scripts/copy-build-assets.js ${Object.keys(tasks).join('|')}`);
  process.exit(1);
}

task.forEach(([from, to]) => {
  mkdirSync(path.dirname(to), {recursive: true});
  copyFileSync(from, to);
});
