import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {AsyncEnvironment, FileSystemLoader} from '../src/index.js';

describe('filesystem cache policy', function() {
  it('observes a configured search directory created after the loader', async function() {
    this.timeout(10000);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cascada-missing-root-'));
    const searchPath = path.join(directory, 'future');
    const loader = new FileSystemLoader(searchPath, {watch: true});
    const env = new AsyncEnvironment([loader, () => 'fallback']);
    try {
      await once(loader.watcher, 'ready', {signal: AbortSignal.timeout(4000)});
      assert.equal(await env.renderTemplate('new.njk'), 'fallback');
      const added = once(loader, 'update', {signal: AbortSignal.timeout(4000)});
      await fs.mkdir(searchPath);
      await fs.writeFile(path.join(searchPath, 'new.njk'), 'created');
      await added;
      assert.equal(await env.renderTemplate('new.njk'), 'created');
    } finally {
      await loader.watcher.close();
      await fs.rm(directory, {recursive: true, force: true});
    }
  });

  it('rejects paths in sibling directories sharing the search path prefix', async function() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cascada-boundary-'));
    const searchPath = path.join(directory, 'views');
    const sibling = path.join(directory, 'views-extra');
    try {
      await fs.mkdir(searchPath);
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(searchPath, 'safe.njk'), 'safe');
      await fs.writeFile(path.join(sibling, 'secret.njk'), 'secret');
      const loader = new FileSystemLoader(searchPath);
      assert.equal(loader.getSource('safe.njk').src, 'safe');
      assert.equal(loader.getSource(path.join(searchPath, 'safe.njk')).src, 'safe');
      assert.equal(loader.getSource('../views-extra/secret.njk'), null);
      assert.equal(loader.getSource(path.join(sibling, 'secret.njk')), null);
    } finally {
      await fs.rm(directory, {recursive: true, force: true});
    }
  });

  it('invalidates cached misses and hits when watched files are added or removed', async function() {
    this.timeout(10000);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cascada-cache-'));
    const loader = new FileSystemLoader(directory, {watch: true});
    const env = new AsyncEnvironment([loader, () => 'fallback']);
    const filename = path.join(directory, 'new.njk');
    try {
      await once(loader.watcher, 'ready');
      assert.equal(await env.renderTemplate('new.njk'), 'fallback');
      assert.equal(await env.renderTemplate('new.njk'), 'fallback');
      const added = once(loader, 'update');
      await fs.writeFile(filename, 'created');
      await added;
      assert.equal(await env.renderTemplate('new.njk'), 'created');
      const removed = once(loader, 'update');
      await fs.unlink(filename);
      await removed;
      assert.equal(await env.renderTemplate('new.njk'), 'fallback');
    } finally {
      await loader.watcher.close();
      await fs.rm(directory, {recursive: true, force: true});
    }
  });
});
