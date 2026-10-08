import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const moduleURL = new URL('../src/loader/loader-events.js', import.meta.url).href;

describe('loader subscription garbage collection', function() {
  it('collects loaders while their subscriber target stays alive', async function() {
    this.timeout(15000);
    const probe = `
      import assert from 'node:assert/strict';
      import {EventEmitter} from 'node:events';
      import {subscribeLoaderEvent} from ${JSON.stringify(moduleURL)};
      const target = {calls: 0};
      function record(subscriber) { subscriber.calls++; }
      function subscribeOnce() {
        const loader = new EventEmitter();
        subscribeLoaderEvent(loader, 'update', target, record);
        loader.emit('update');
        return new WeakRef(loader);
      }
      const reference = subscribeOnce();
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        globalThis.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (reference.deref() === undefined) break;
      }
      assert.equal(reference.deref(), undefined);
      assert.equal(target.calls, 1);
      process.stdout.write('collected loader');
    `;
    const {stdout, stderr} = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      timeout: 12000
    });
    assert.equal(stdout, 'collected loader');
    assert.equal(stderr, '');
  });

  it('can subscribe again after collected targets with and without listener removal', async function() {
    this.timeout(15000);
    const probe = `
      import assert from 'node:assert/strict';
      import {EventEmitter} from 'node:events';
      import {subscribeLoaderEvent} from ${JSON.stringify(moduleURL)};
      class OnOnlyLoader {
        listeners = [];
        on(event, callback) { this.listeners.push(callback); }
        emit() { for (const callback of this.listeners) callback(); }
        listenerCount() { return this.listeners.length; }
      }
      function record(target) { target.calls++; }
      function subscribeOnce(loader) {
        const target = {calls: 0};
        subscribeLoaderEvent(loader, 'update', target, record);
        return new WeakRef(target);
      }
      for (const loader of [new EventEmitter(), new OnOnlyLoader()]) {
        const reference = subscribeOnce(loader);
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise(resolve => setImmediate(resolve));
          globalThis.gc();
          await new Promise(resolve => setImmediate(resolve));
          if (reference.deref() === undefined) break;
        }
        assert.equal(reference.deref(), undefined);
        loader.emit('update');
        const target = {calls: 0};
        subscribeLoaderEvent(loader, 'update', target, record);
        subscribeLoaderEvent(loader, 'update', target, record);
        assert.equal(loader.listenerCount('update'), 1);
        loader.emit('update');
        assert.equal(target.calls, 1);
      }
      process.stdout.write('resubscribed');
    `;
    const {stdout, stderr} = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      timeout: 12000
    });
    assert.equal(stdout, 'resubscribed');
    assert.equal(stderr, '');
  });
});
