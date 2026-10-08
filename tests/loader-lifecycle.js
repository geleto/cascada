import expect from 'expect.js';

const isBrowser = typeof window !== 'undefined';
const {AsyncEnvironment, Loader, loadString, raceLoaders} = isBrowser
  ? window.nunjucks
  : await import('../src/index.js');

function listenerCount(loader, event) {
  return typeof loader.listenerCount === 'function'
    ? loader.listenerCount(event)
    : (loader.events[event] || []).length;
}

class UpdatingLoader extends Loader {
  constructor(sources = {text: 'first'}) {
    super();
    this.sources = sources;
    this.calls = 0;
    this.noCache = false;
  }

  resolve(from, to) {
    return new URL(to, new URL(from, 'https://loader.test/')).pathname.slice(1);
  }

  load(name) {
    this.calls++;
    const key = name.startsWith('store/') ? name.slice('store/'.length) : name;
    if (!Object.hasOwn(this.sources, key)) return null;
    const source = {src: this.sources[key], path: 'store/' + key, noCache: this.noCache};
    this.emit('load', name, source);
    return source;
  }
}

describe('loader lifecycle', function() {
  it('shares subscriptions across 100 live environments and 100 race groups', async function() {
    const loader = new UpdatingLoader();
    const environments = Array.from({length: 100}, () => new AsyncEnvironment(loader));
    const groups = Array.from({length: 100}, () => raceLoaders([loader, () => null]));
    let updates = 0;
    let loads = 0;
    let groupUpdates = 0;
    let lastUpdate;
    let lastLoad;
    for (const env of environments) {
      env.on('update', (name, fullname, sourceLoader) => {
        lastUpdate = {name, fullname, sourceLoader};
        updates++;
      });
      env.on('load', (name, source, sourceLoader) => {
        lastLoad = {name, source, sourceLoader};
        loads++;
      });
    }
    for (const group of groups) {
      group.on('update', () => groupUpdates++);
    }

    expect(listenerCount(loader, 'update')).to.be(1);
    expect(listenerCount(loader, 'load')).to.be(1);
    expect(await Promise.all(environments.map(env => env.loadString('text'))))
      .to.eql(Array(100).fill('first'));
    expect(loads).to.be(100 * 100);
    expect(lastLoad.name).to.be('text');
    expect(lastLoad.source.path).to.be('store/text');
    expect(lastLoad.sourceLoader).to.be(loader);

    loader.sources.text = 'second';
    loader.emit('update', 'text', 'store/text');
    expect(updates).to.be(100);
    expect(groupUpdates).to.be(100);
    expect(lastUpdate).to.eql({name: 'text', fullname: 'store/text', sourceLoader: loader});
    expect(await Promise.all(environments.map(env => env.loadString('text'))))
      .to.eql(Array(100).fill('second'));
    expect(loader.calls).to.be(200);
    expect(listenerCount(loader, 'update')).to.be(1);
    expect(listenerCount(loader, 'load')).to.be(1);
  });

  it('invalidates standalone string caches by request name and source path', async function() {
    const loader = new UpdatingLoader();
    const env = new AsyncEnvironment(loader);
    const group = raceLoaders([loader]);
    expect(await loadString('text', loader)).to.be('first');
    expect(await env.loadString('text')).to.be('first');
    expect(await loadString('text', group)).to.be('first');

    loader.sources.text = 'second';
    loader.emit('update', 'text', 'store/text');
    expect(await loadString('text', loader)).to.be('second');
    expect(await env.loadString('text')).to.be('second');
    expect(await loadString('text', group)).to.be('second');

    loader.sources.text = 'third';
    loader.emit('update', 'store/text');
    expect(await loadString('text', loader)).to.be('third');
    expect(await loadString('text', group)).to.be('third');

    loader.sources.text = 'fourth';
    loader.emit('update', 'unrelated', 'store/text');
    expect(await loadString('text', loader)).to.be('fourth');
    expect(await loadString('text', group)).to.be('fourth');
    expect(listenerCount(loader, 'update')).to.be(1);
    expect(listenerCount(loader, 'load')).to.be(1);
  });

  it('keeps standalone noCache sources uncached', async function() {
    const loader = new UpdatingLoader();
    loader.noCache = true;
    expect(await loadString('text', loader)).to.be('first');
    loader.sources.text = '';
    expect(await loadString('text', loader)).to.be('');
    loader.sources.text = 'third';
    expect(await loadString('text', loader)).to.be('third');
    expect(loader.calls).to.be(3);
  });

  it('invalidates async native and callback loader string caches', async function() {
    const native = new UpdatingLoader();
    const nativeLoad = native.load.bind(native);
    native.load = name => Promise.resolve(nativeLoad(name));

    const legacy = new UpdatingLoader();
    legacy.load = undefined;
    legacy.async = true;
    legacy.getSource = function(name, callback) {
      const source = UpdatingLoader.prototype.load.call(this, name);
      queueMicrotask(() => callback(null, source));
    };

    for (const loader of [native, legacy]) {
      expect(await loadString('text', loader)).to.be('first');
      loader.sources.text = '';
      loader.emit('update', 'store/text');
      expect(await loadString('text', loader)).to.be('');
      loader.noCache = true;
      loader.emit('update', 'text');
      loader.sources.text = 'third';
      expect(await loadString('text', loader)).to.be('third');
      loader.sources.text = 'fourth';
      expect(await loadString('text', loader)).to.be('fourth');
    }
  });

  it('lets empty race groups miss and continue to an outer loader', async function() {
    const group = raceLoaders([]);
    expect(await group.load('text')).to.be(null);
    expect(group.isRelative('./part')).to.be(false);
    expect(group.resolve('main', './part')).to.be('./part');
    const env = new AsyncEnvironment([group, () => 'fallback']);
    expect(await env.loadString('text')).to.be('fallback');
    expect(await env.renderTemplate('template')).to.be('fallback');
  });

  it('does not retain path entries for non-relative or noCache sources', async function() {
    const literalGroup = raceLoaders([{
      load: name => ({src: name, path: 'store/' + name})
    }]);
    const relativeLoader = new UpdatingLoader();
    relativeLoader.noCache = true;
    const dynamicGroup = raceLoaders([relativeLoader]);
    for (let i = 0; i < 1000; i++) {
      const name = 'name-' + i;
      relativeLoader.sources[name] = name;
      expect((await literalGroup.load(name)).src).to.be(name);
      expect((await dynamicGroup.load(name)).src).to.be(name);
    }
    expect(literalGroup.pathLoaders.size).to.be(0);
    expect(dynamicGroup.pathLoaders.size).to.be(0);
  });

  it('removes both aliases of cached relative ownership on a member update', async function() {
    const loader = new UpdatingLoader({'dir/main': 'main'});
    const group = raceLoaders([loader]);
    const source = await group.load('dir/main');
    expect(group.pathLoaders.size).to.be(2);
    expect(group.resolve(source.path, './part')).to.be('store/dir/part');

    loader.emit('update', 'dir/main');
    expect(group.pathLoaders.size).to.be(0);
    expect(group.resolve(source.path, './part')).to.be('./part');

    const reloaded = await group.load('dir/main');
    expect(group.pathLoaders.size).to.be(2);
    loader.emit('update', 'unrelated', reloaded.path);
    expect(group.pathLoaders.size).to.be(0);
  });

  it('resolves noCache parents through their source without retaining path entries', async function() {
    const loader = new UpdatingLoader({
      'dir/main.njk': '{% include "./part.njk" %}',
      'dir/part.njk': 'first'
    });
    loader.noCache = true;
    const group = raceLoaders([loader]);
    const env = new AsyncEnvironment(group);
    expect(await env.renderTemplate('dir/main.njk')).to.be('first');
    loader.sources['dir/part.njk'] = 'second';
    expect(await env.renderTemplate('dir/main.njk')).to.be('second');
    expect(group.pathLoaders.size).to.be(0);
  });
});
