import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {AsyncEnvironment, Loader, loadString, raceLoaders} from '../src/index.js';

describe('loader errors from another JavaScript realm', function() {
  for (const mode of ['sync', 'promise', 'callback']) {
    it(`preserves the ${mode} error object through all loader entry points`, async function() {
      const failure = runInNewContext('new TypeError("foreign loader failure", {cause: "origin"})');
      const loader = mode === 'sync' ? () => { throw failure; }
        : mode === 'promise' ? () => Promise.reject(failure)
          : Object.assign(new Loader(), {
            async: true,
            getSource(name, callback) { callback(failure); }
          });
      const reads = [
        () => new AsyncEnvironment(loader).loadString('missing'),
        () => new AsyncEnvironment(loader).getTemplate('missing'),
        () => loadString('missing', loader),
        () => raceLoaders([raceLoaders([loader])]).load('missing')
      ];
      for (const read of reads) {
        await assert.rejects(async () => read(), error => error === failure);
      }
      assert.equal(failure.name, 'TypeError');
      assert.equal(failure.cause, 'origin');
    });
  }
});
