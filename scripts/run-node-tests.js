#!/usr/bin/env node

import {promises as fs} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import Mocha from 'mocha';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(scriptDir, '..');
const defaultSpecs = [
  {path: 'tests', recursive: false},
  {path: 'tests/pasync', recursive: true},
  {path: 'tests/poison', recursive: true}
];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectJsFiles(dir, recursive) {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...await collectJsFiles(entryPath, true));
      }
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }

  return files;
}

async function collectSpecs(args) {
  if (!args.length) {
    const fileGroups = await Promise.all(defaultSpecs.map(spec =>
      collectJsFiles(path.join(projectRoot, spec.path), spec.recursive)
    ));
    return fileGroups.flat();
  }

  const files = [];
  for (const arg of args) {
    const absolutePath = path.resolve(projectRoot, arg);
    if (!await pathExists(absolutePath)) {
      throw new Error(`Test path does not exist: ${arg}`);
    }

    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      files.push(...await collectJsFiles(absolutePath, true));
    } else if (stat.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function writeStats(stats) {
  const outDir = path.join(projectRoot, 'coverage');
  const outFile = path.join(outDir, 'node-tests-stats.json');
  await fs.mkdir(outDir, {recursive: true});
  await fs.writeFile(outFile, JSON.stringify({
    tests: stats.tests || 0,
    passes: stats.passes || 0,
    failures: stats.failures || 0,
    pending: stats.pending || 0,
    duration: stats.duration || 0
  }));
}

async function run() {
  const mocha = new Mocha({
    checkLeaks: true,
    reporter: 'spec'
  });

  const files = await collectSpecs(process.argv.slice(2));
  for (const file of files.sort()) {
    mocha.addFile(file);
  }

  await mocha.loadFilesAsync();

  const {failures, stats} = await new Promise((resolve) => {
    const runner = mocha.run(failureCount => {
      resolve({failures: failureCount, stats: runner.stats || {}});
    });
  });

  await writeStats(stats);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
