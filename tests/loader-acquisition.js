import expect from 'expect.js';

const isBrowser = typeof window !== 'undefined';
const {Environment, AsyncEnvironment, Loader, clearStringCache, loadString, raceLoaders} = isBrowser
  ? window.nunjucks
  : await import('../src/index.js');

class Sources extends Loader {
  constructor(sources, noCache = false) {
    super();
    this.sources = sources;
    this.noCache = noCache;
  }

  resolve(from, to) {
    return new URL(to, new URL(from, 'https://loader.test/')).pathname.slice(1);
  }

  load(name) {
    const key = name.startsWith('store/') ? name.slice(6) : name;
    if (!Object.hasOwn(this.sources, key)) return null;
    return {src: this.sources[key], path: 'store/' + key, noCache: this.noCache};
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return {promise, resolve};
}

describe('loader acquisitions', function() {
  it('uses the real environment for includes and subclass private state', async function() {
    class CountingEnvironment extends AsyncEnvironment {
      #calls = 0;

      get calls() { return this.#calls; }

      getTemplate(...args) {
        this.#calls++;
        return super.getTemplate(...args);
      }
    }
    const loader = new Sources({'dir/main': '{% include "./child" %}', 'dir/child': 'child'});
    const env = new CountingEnvironment(raceLoaders([loader]));
    const template = await env.getTemplate('dir/main');
    expect(template.env).to.be(env);
    expect(await template.render()).to.be('child');
    expect(env.calls).to.be(2);
  });

  it('preserves a custom name resolver inside nested race includes', async function() {
    class RewritingEnvironment extends AsyncEnvironment {
      _resolveFromLoader(loader, parent, filename) {
        if (filename === './child') return 'rewritten/child';
        return super._resolveFromLoader(loader, parent, filename);
      }
    }
    const loader = new Sources({
      'dir/main': '{% include "./child" %}',
      'dir/child': 'original',
      'rewritten/child': 'rewritten'
    });
    const env = new RewritingEnvironment(raceLoaders([raceLoaders([loader])]));
    expect(await env.renderTemplate('dir/main')).to.be('rewritten');
  });

  it('preserves the real synchronous environment and custom relative resolver', function() {
    class RewritingEnvironment extends Environment {
      #calls = 0;

      get calls() { return this.#calls; }

      getTemplate(...args) {
        this.#calls++;
        return super.getTemplate(...args);
      }

      _resolveFromLoader(loader, parent, filename) {
        if (filename === './child') return 'rewritten/child';
        return super._resolveFromLoader(loader, parent, filename);
      }
    }
    const loader = new Sources({'dir/main': '{% include "./child" %}', 'rewritten/child': 'child'});
    const env = new RewritingEnvironment(loader);
    const template = env.getTemplate('dir/main');
    expect(template.env).to.be(env);
    expect(template.render()).to.be('child');
    expect(env.calls).to.be(2);
  });

  it('keeps synchronous child block and parent block origins across noCache races', async function() {
    const loader = new Sources({
      'child/main': '{% extends "../parent/base" %}{% block content %}{% include "./part" %}{{ super() }}{% endblock %}',
      'child/part': 'child-',
      'parent/base': '{% block content %}{% include "./part" %}{% endblock %}',
      'parent/part': 'parent'
    }, true);
    const env = new Environment(raceLoaders([loader]));
    const result = await new Promise((resolve, reject) => {
      env.renderTemplate('child/main', {}, (error, output) => {
        if (error) reject(error);
        else resolve(output);
      });
    });
    expect(result).to.be('child-parent');
  });

  for (const nested of [false, true]) {
    it(`keeps independent origins when ${nested ? 'nested' : 'direct'} race members reuse a source object`, async function() {
      const shared = {src: '{% include "./child" %}', path: 'shared/main', noCache: true};
      let winner = 'A';
      function member(id) {
        return {
          load(name) {
            if (name === 'main') return winner === id ? shared : null;
            return name === id + '/child' ? {src: id, path: name, noCache: true} : null;
          },
          isRelative: name => name.startsWith('./'),
          resolve: () => id + '/child'
        };
      }
      const inner = raceLoaders([member('A'), member('B')]);
      const env = new AsyncEnvironment(nested ? raceLoaders([inner]) : inner);
      const first = await env.getTemplate('main');
      winner = 'B';
      const second = await env.getTemplate('main');
      expect(await Promise.all([first.render(), second.render()])).to.eql(['A', 'B']);
    });
  }

  it('keeps compiled entries matched to their selected concurrent source acquisitions', async function() {
    const textSource = deferred();
    const templateSource = deferred();
    let calls = 0;
    const env = new AsyncEnvironment({
      load() { return ++calls === 1 ? textSource.promise : templateSource.promise; }
    });
    const text = env.loadString('same');
    const template = env.getTemplate('same');
    templateSource.resolve({src: 'template source', path: 'same'});
    const originalTemplate = await template;
    expect(await originalTemplate.render()).to.be('template source');
    expect(await env.loadString('same')).to.be('template source');
    textSource.resolve({src: 'text source', path: 'same'});
    expect(await text).to.be('text source');
    expect(await env.loadString('same')).to.be('text source');
    expect(await env.renderTemplate('same')).to.be('text source');
    expect(await originalTemplate.render()).to.be('template source');
    expect(calls).to.be(2);
  });

  it('rejects eager compilation errors from an asynchronous source acquisition', async function() {
    const env = new AsyncEnvironment({
      load: async name => ({src: '{% invalid syntax %}', path: name})
    });
    let failure;
    try {
      await env.getTemplate('invalid', true);
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.an(Error);
    expect(failure.message).to.contain('unknown block tag');
  });

  for (const kind of ['text', 'template', 'script', 'standalone']) {
    for (const invalidation of ['update', 'invalidate']) {
      it(`does not cache a pending ${kind} acquisition after ${invalidation}`, async function() {
        const pending = deferred();
        const script = kind === 'script';
        const content = value => (script ? `return "${value}"` : value);
        class PendingLoader extends Loader {
          calls = 0;

          load(name) {
            this.calls++;
            return this.calls === 1 ? pending.promise : {src: content('new'), path: name};
          }
        }
        const loader = new PendingLoader();
        const env = new AsyncEnvironment(loader);
        const read = kind === 'standalone' ? () => loadString('same', loader)
          : kind === 'script' ? () => env.renderScript('same')
            : kind === 'template' ? () => env.renderTemplate('same')
              : () => env.loadString('same');
        const first = read();
        if (invalidation === 'update') loader.emit('update', 'same');
        else if (kind === 'standalone') clearStringCache(loader);
        else env.invalidateCache();
        pending.resolve({src: content('old'), path: 'same'});
        expect(await first).to.be('old');
        expect(await read()).to.be('new');
        expect(await read()).to.be('new');
        expect(loader.calls).to.be(2);
      });
    }
  }

  it('does not restore stale race path aliases after an update during acquisition', async function() {
    const pending = deferred();
    const loader = new Sources({});
    loader.load = () => pending.promise;
    const group = raceLoaders([loader]);
    const result = group.load('dir/main');
    loader.emit('update', 'dir/main', 'store/dir/main');
    pending.resolve({src: 'old', path: 'store/dir/main'});
    expect((await result).src).to.be('old');
    expect(group.pathLoaders.size).to.be(0);
    expect(group.resolve('store/dir/main', './child')).to.be('./child');
  });

  it('starts a fresh acquisition after an update while the obsolete one is still pending', async function() {
    const obsolete = deferred();
    const current = deferred();
    class PendingLoader extends Loader {
      calls = 0;

      load() {
        return ++this.calls === 1 ? obsolete.promise : current.promise;
      }
    }
    const loader = new PendingLoader();
    const env = new AsyncEnvironment(loader);
    const oldText = env.loadString('same');
    loader.emit('update', 'same');
    const newTemplate = env.getTemplate('same');
    current.resolve({src: 'new', path: 'same'});
    expect(await (await newTemplate).render()).to.be('new');
    obsolete.resolve({src: 'old', path: 'same'});
    expect(await oldText).to.be('old');
    expect(await env.loadString('same')).to.be('new');
    expect(await env.renderTemplate('same')).to.be('new');
    expect(loader.calls).to.be(2);
  });

  it('loads relative raw text from canonical noCache parent paths with direct and raced loaders', async function() {
    const loader = new Sources({'dir/main': 'parent', 'dir/part': 'part'}, true);
    for (const candidate of [loader, raceLoaders([raceLoaders([loader])])]) {
      const env = new AsyncEnvironment(candidate);
      expect(await env.loadString('dir/main')).to.be('parent');
      expect(await env.loadString('./part', 'store/dir/main')).to.be('part');
    }
  });
});
