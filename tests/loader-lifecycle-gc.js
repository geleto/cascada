import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const entryURL = new URL('../src/index.js', import.meta.url).href;

describe('loader garbage collection', function() {
  it('collects environments and race groups while their shared loader stays alive', async function() {
    this.timeout(15000);
    const probe = `
      import assert from 'node:assert/strict';
      import {AsyncEnvironment, Loader, raceLoaders} from ${JSON.stringify(entryURL)};
      const loader = new Loader();
      const warnings = [];
      process.on('warning', warning => warnings.push(warning.name));
      const references = Array.from({length: 100}, () => [
        new WeakRef(new AsyncEnvironment(loader)),
        new WeakRef(raceLoaders([loader, () => null]))
      ]).flat();
      assert.equal(loader.listenerCount('update'), 1);
      assert.equal(loader.listenerCount('load'), 1);
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        globalThis.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (references.every(reference => reference.deref() === undefined)
            && loader.listenerCount('update') === 0 && loader.listenerCount('load') === 0) break;
      }
      assert.equal(references.filter(reference => reference.deref() !== undefined).length, 0);
      assert.equal(loader.listenerCount('update'), 0);
      assert.equal(loader.listenerCount('load'), 0);
      assert.deepEqual(warnings, []);
      process.stdout.write('collected');
    `;
    const {stdout, stderr} = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      timeout: 12000
    });
    assert.equal(stdout, 'collected');
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/);
  });

  it('releases path aliases when cacheable sources are no longer reachable', async function() {
    this.timeout(15000);
    const probe = `
      import assert from 'node:assert/strict';
      import {raceLoaders} from ${JSON.stringify(entryURL)};
      const group = raceLoaders([{
        load: name => ({src: name, path: 'store/' + name}),
        isRelative: name => name.startsWith('./'),
        resolve: (from, to) => from + ':' + to
      }]);
      for (let i = 0; i < 1000; i++) await group.load('name-' + i);
      const retained = await group.load('retained');
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        globalThis.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (group.pathLoaders.size <= 2) break;
      }
      assert.equal(group.pathLoaders.size, 2);
      assert.equal(group.resolve(retained.path, './part'), 'store/retained:./part');
      process.stdout.write('released');
    `;
    const {stdout} = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      timeout: 12000
    });
    assert.equal(stdout, 'released');
  });

  it('collects compiled source and scoped environment cycles around race groups', async function() {
    this.timeout(15000);
    const probe = `
      import assert from 'node:assert/strict';
      import {AsyncEnvironment, Loader, raceLoaders} from ${JSON.stringify(entryURL)};
      class Sources extends Loader {
        resolve(from, to) {
          return new URL(to, new URL(from, 'https://loader.test/')).pathname.slice(1);
        }
        load(name) {
          const key = name.startsWith('store/') ? name.slice(6) : name;
          const src = key === 'dir/main.njk' ? '{% include "./part.njk" %}' : 'part';
          return {src, path: 'store/' + key};
        }
      }
      const loader = new Sources();
      async function renderOnce() {
        const group = raceLoaders([loader]);
        const environment = new AsyncEnvironment(group);
        assert.equal(await environment.renderTemplate('dir/main.njk'), 'part');
        return [new WeakRef(environment), new WeakRef(group)];
      }
      const references = [];
      for (let i = 0; i < 10; i++) references.push(...await renderOnce());
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        globalThis.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (references.every(reference => reference.deref() === undefined)
            && loader.listenerCount('update') === 0) break;
      }
      assert.equal(references.filter(reference => reference.deref() !== undefined).length, 0);
      assert.equal(loader.listenerCount('update'), 0);
      process.stdout.write('collected cycles');
    `;
    const {stdout, stderr} = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      timeout: 12000
    });
    assert.equal(stdout, 'collected cycles');
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/);
  });

  it('releases a noCache parent source while its cached child remains live', async function() {
    this.timeout(15000);
    const probe = `
      import assert from 'node:assert/strict';
      import {AsyncEnvironment, Loader, raceLoaders} from ${JSON.stringify(entryURL)};
      let parentReference;
      class Sources extends Loader {
        resolve(from, to) {
          return new URL(to, new URL(from, 'https://loader.test/')).pathname.slice(1);
        }
        load(name) {
          if (name === 'parent') {
            const source = {src: '{% include "./child" %}', path: 'store/parent', noCache: true};
            parentReference = new WeakRef(source);
            return source;
          }
          return name === 'store/child' ? {src: 'child', path: name} : null;
        }
      }
      const environment = new AsyncEnvironment(raceLoaders([new Sources()]));
      assert.equal(await environment.renderTemplate('parent'), 'child');
      const child = await environment.getTemplate('store/child');
      assert.equal(await child.render(), 'child');
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        globalThis.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (parentReference.deref() === undefined) break;
      }
      assert.equal(parentReference.deref(), undefined);
      assert.equal(child.env, environment);
      assert.equal(await child.render(), 'child');
      process.stdout.write('released parent');
    `;
    const {stdout} = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      timeout: 12000
    });
    assert.equal(stdout, 'released parent');
  });

  it('collects per-race finalizers while a member keeps their source alive', async function() {
    this.timeout(15000);
    const probe = `
      import assert from 'node:assert/strict';
      import {Loader, raceLoaders} from ${JSON.stringify(entryURL)};
      const cachedSource = {src: 'cached', path: 'store/cached'};
      class CachedLoader extends Loader {
        load() { return cachedSource; }
        resolve(from, to) { return from + ':' + to; }
      }
      const loader = new CachedLoader();
      async function loadOnce() {
        const group = raceLoaders([loader]);
        assert.equal(await group.load('cached'), cachedSource);
        return [new WeakRef(group), new WeakRef(group.pathFinalizer)];
      }
      const references = [];
      for (let i = 0; i < 100; i++) references.push(...await loadOnce());
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        globalThis.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (references.every(reference => reference.deref() === undefined)
            && loader.listenerCount('update') === 0) break;
      }
      assert.equal(references.filter(reference => reference.deref() !== undefined).length, 0);
      assert.equal(loader.listenerCount('update'), 0);
      assert.equal(loader.load(), cachedSource);
      assert.equal(cachedSource.src, 'cached');
      process.stdout.write('collected finalizers');
    `;
    const {stdout, stderr} = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      timeout: 12000
    });
    assert.equal(stdout, 'collected finalizers');
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/);
  });
});
