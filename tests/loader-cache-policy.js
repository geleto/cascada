import expect from 'expect.js';
import {isPoisonError} from '../src/runtime/errors.js';

const isBrowser = typeof window !== 'undefined';
const {Environment, AsyncEnvironment, Loader, loadString, raceLoaders} = isBrowser
  ? window.nunjucks
  : await import('../src/index.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => { resolve = complete; reject = fail; });
  return {promise, resolve, reject};
}

describe('loader cache policy', function() {
  for (const firstMode of ['getScript', 'getTemplate']) {
    it(`keeps script and template compilation separate after ${firstMode}`, async function() {
      let calls = 0;
      const env = new AsyncEnvironment(() => { calls++; return 'return 42'; });
      const first = await env[firstMode]('same', true);
      const script = await env.getScript('same', true);
      const template = await env.getTemplate('same', true);
      expect(script).not.to.be(template);
      expect(first).to.be(firstMode === 'getScript' ? script : template);
      expect(await script.render()).to.be(42);
      expect(await template.render()).to.be('return 42');
      expect(await env.getScript('same')).to.be(script);
      expect(await env.getTemplate('same')).to.be(template);
      expect(calls).to.be(1);
    });
  }

  for (const EnvironmentClass of [Environment, AsyncEnvironment]) {
    it(`caches earlier misses for warm ${EnvironmentClass.name} includes`, async function() {
      let misses = 0;
      const calls = [];
      const env = new EnvironmentClass([
        () => { misses++; return null; },
        name => {
          calls.push(name);
          return name === 'main' ? '{% include "part" %}' : 'part';
        }
      ]);
      for (let i = 0; i < 10; i++) expect(await env.renderTemplate('main')).to.be('part');
      expect(misses).to.be(2);
      expect(calls).to.eql(['main', 'part']);
    });
  }

  it('invalidates cached misses when a loader emits an update', async function() {
    class DynamicLoader extends Loader {
      value = null;
      calls = 0;

      load(name) {
        this.calls++;
        return this.value === null ? null : {src: this.value, path: name};
      }
    }
    const loader = new DynamicLoader();
    const env = new AsyncEnvironment([loader, () => 'fallback']);
    expect(await env.loadString('main')).to.be('fallback');
    expect(await env.loadString('main')).to.be('fallback');
    expect(loader.calls).to.be(1);
    loader.value = 'preferred';
    loader.emit('update', 'main');
    expect(await env.loadString('main')).to.be('preferred');
    expect(loader.calls).to.be(2);
  });

  it('invalidates all source and compiled modes on a nameless nested race update', async function() {
    class UpdatingLoader extends Loader {
      value = 'old';

      load(name) {
        return {src: name === 'script' ? `return "${this.value}"` : this.value, path: name};
      }
    }
    const loader = new UpdatingLoader();
    const group = raceLoaders([raceLoaders([loader])]);
    const env = new AsyncEnvironment(group);
    expect(await env.renderTemplate('text')).to.be('old');
    expect(await env.renderScript('script')).to.be('old');
    expect(await loadString('text', group)).to.be('old');
    loader.value = 'new';
    loader.emit('update');
    expect(await env.loadString('text')).to.be('new');
    expect(await env.renderTemplate('text')).to.be('new');
    expect(await env.renderScript('script')).to.be('new');
    expect(await loadString('text', group)).to.be('new');
  });

  it('shares cold sources and compiled objects across concurrent requests', async function() {
    const source = deferred();
    let calls = 0;
    const env = new AsyncEnvironment({
      load() { calls++; return source.promise; }
    });
    const requests = Array.from({length: 50}, () => env.getTemplate('row'));
    expect(calls).to.be(1);
    source.resolve({src: 'row', path: 'row'});
    const compiled = await Promise.all(requests);
    expect(compiled.every(template => template === compiled[0])).to.be(true);
    expect(await compiled[0].render()).to.be('row');
  });

  it('loads one row source for a cold parallel include loop', async function() {
    const calls = [];
    const env = new AsyncEnvironment({
      async load(name) {
        calls.push(name);
        return {src: name === 'main' ? '{% for item in items %}{% include "row" with item %}{% endfor %}' : '{{ item }}', path: name};
      }
    });
    const items = Array.from({length: 50}, (_, index) => index);
    expect(await env.renderTemplate('main', {items})).to.be(items.join(''));
    expect(calls).to.eql(['main', 'row']);
  });

  it('releases rejected pending loads and preserves their error for every waiter', async function() {
    const source = deferred();
    const failure = new Error('loader failed');
    let calls = 0;
    const env = new AsyncEnvironment({
      load() { return ++calls === 1 ? source.promise : 'recovered'; }
    });
    const requests = [env.getTemplate('row'), env.loadString('row')];
    source.reject(failure);
    const results = await Promise.allSettled(requests);
    expect(results.map(result => result.reason)).to.eql([failure, failure]);
    expect(await env.renderTemplate('row')).to.be('recovered');
    expect(calls).to.be(2);
  });

  for (const invalidation of ['update', 'invalidate']) {
    it(`starts a new load after synchronous ${invalidation} during loader invocation`, async function() {
      const obsolete = deferred();
      let env;
      class InvalidatingLoader extends Loader {
        calls = 0;

        load(name) {
          if (++this.calls === 1) {
            if (invalidation === 'update') this.emit('update', name);
            else env.invalidateCache();
            return obsolete.promise;
          }
          return {src: 'new', path: name};
        }
      }
      const loader = new InvalidatingLoader();
      env = new AsyncEnvironment(loader);
      const oldText = env.loadString('same');
      expect(await env.renderTemplate('same')).to.be('new');
      obsolete.resolve({src: 'old', path: 'same'});
      expect(await oldText).to.be('old');
      expect(await env.loadString('same')).to.be('new');
      expect(loader.calls).to.be(2);
    });
  }

  it('shares only pending noCache sources and reloads completed requests', async function() {
    const source = deferred();
    let calls = 0;
    const env = new AsyncEnvironment({
      load(name) {
        calls++;
        return calls === 1 ? source.promise : {src: 'new', path: name, noCache: true};
      }
    });
    const first = env.getTemplate('row');
    const concurrent = env.getTemplate('row');
    source.resolve({src: 'old', path: 'row', noCache: true});
    expect(await concurrent).to.be(await first);
    expect(calls).to.be(1);
    expect(await env.renderTemplate('row')).to.be('new');
    expect(await env.renderTemplate('row')).to.be('new');
    expect(calls).to.be(3);
  });

  it('reload policy retries misses, hits and concurrent requests', async function() {
    const pending = [deferred(), deferred()];
    let calls = 0;
    const loader = {
      cachePolicy: 'reload',
      load(name) {
        calls++;
        if (name === 'missing') return null;
        if (name === 'pending') return pending.shift().promise;
        return {src: String(calls), path: name};
      }
    };
    const env = new AsyncEnvironment([loader, () => 'fallback']);
    expect(await env.loadString('missing')).to.be('fallback');
    expect(await env.loadString('missing')).to.be('fallback');
    expect(await env.loadString('hit')).to.be('3');
    expect(await env.loadString('hit')).to.be('4');
    const firstPending = pending[0];
    const secondPending = pending[1];
    const first = env.loadString('pending');
    const second = env.loadString('pending');
    expect(calls).to.be(6);
    firstPending.resolve({src: 'first', path: 'pending'});
    secondPending.resolve({src: 'second', path: 'pending'});
    expect(await Promise.all([first, second])).to.eql(['first', 'second']);
  });

  it('allows an explicit race policy to override the policy derived from its members', async function() {
    let calls = 0;
    const loader = {load: name => ({src: String(++calls), path: name})};
    const group = raceLoaders([loader]);
    expect(group.cachePolicy).to.be('cache');
    group.cachePolicy = 'reload';
    expect(group.cachePolicy).to.be('reload');
    const env = new AsyncEnvironment(group);
    expect(await env.loadString('text')).to.be('1');
    expect(await env.loadString('text')).to.be('2');

    loader.cachePolicy = 'reload';
    const cacheGroup = raceLoaders([loader]);
    expect(cacheGroup.cachePolicy).to.be('reload');
    cacheGroup.cachePolicy = 'cache';
    const cachedEnv = new AsyncEnvironment(cacheGroup);
    expect(await cachedEnv.loadString('text')).to.be('3');
    expect(await cachedEnv.loadString('text')).to.be('3');
  });

  for (const EnvironmentClass of [Environment, AsyncEnvironment]) {
    for (const policy of ['explicit', 'derived']) {
      it(`applies ${policy} race reload policy to nested relative ${EnvironmentClass.name} includes`, async function() {
        let version = 'old';
        const calls = [];
        const owner = {
          isRelative: name => name.startsWith('./'),
          resolve: (from, to) => to.slice(2),
          load(name) {
            calls.push(name);
            return {src: name === 'main' ? '{% include "./part" %}'
              : name === 'part' ? '{% include "./leaf" %}' : version, path: name};
          }
        };
        const members = policy === 'derived' ? [owner, {cachePolicy: 'reload', load: () => null}] : [owner];
        const group = raceLoaders([raceLoaders(members)]);
        if (policy === 'explicit') group.cachePolicy = 'reload';
        const env = new EnvironmentClass(group);
        const render = () => {
          if (EnvironmentClass === AsyncEnvironment) return env.renderTemplate('main');
          return new Promise((resolve, reject) => {
            env.renderTemplate('main', {}, (error, result) => {
              if (error) reject(error);
              else resolve(result);
            });
          });
        };
        expect(await render()).to.be('old');
        version = 'new';
        expect(await render()).to.be('new');
        expect(calls).to.eql(['main', 'part', 'leaf', 'main', 'part', 'leaf']);
      });
    }
  }

  it('applies an explicit cache policy to relative sources from a reload member', async function() {
    let version = 'old';
    const calls = [];
    const owner = {
      cachePolicy: 'reload',
      isRelative: name => name.startsWith('./'),
      resolve: (from, to) => to.slice(2),
      load(name) {
        calls.push(name);
        return {src: name === 'main' ? '{% include "./part" %}' : version, path: name};
      }
    };
    const group = raceLoaders([owner]);
    group.cachePolicy = 'cache';
    const env = new AsyncEnvironment(group);
    expect(await env.renderTemplate('main')).to.be('old');
    version = 'new';
    expect(await env.renderTemplate('main')).to.be('old');
    expect(calls).to.eql(['main', 'part']);
  });

  it('preserves poison and retries relative imports under a race reload policy', async function() {
    let fail = false;
    let value = 1;
    const failure = new Error('relative import failed');
    const owner = {
      isRelative: name => name.startsWith('./'),
      resolve: (from, to) => to.slice(2),
      async load(name) {
        if (name === 'main') return {src: 'import "./lib" as lib\nreturn lib.value', path: name};
        if (fail) throw failure;
        return {src: `var value = ${value}`, path: name};
      }
    };
    const group = raceLoaders([raceLoaders([owner])]);
    group.cachePolicy = 'reload';
    const env = new AsyncEnvironment(group, {loadFailFatal: false});
    expect(await env.renderScript('main')).to.be(1);
    fail = true;
    let rejected;
    try {
      await env.renderScript('main');
    } catch (error) {
      rejected = error;
    }
    expect(isPoisonError(rejected)).to.be(true);
    expect(rejected.cause).to.be(failure);
    fail = false;
    value = 2;
    expect(await env.renderScript('main')).to.be(2);
  });

  it('keeps standalone caches independent from environment invalidation', async function() {
    let calls = 0;
    const loader = () => String(++calls);
    const env = new AsyncEnvironment(loader);
    expect(await loadString('text', loader)).to.be('1');
    expect(await env.loadString('text')).to.be('2');
    env.invalidateCache();
    expect(await loadString('text', loader)).to.be('1');
    expect(await env.loadString('text')).to.be('3');
  });
});
