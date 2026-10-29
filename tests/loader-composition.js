import expect from 'expect.js';
import {isPoisonError} from '../src/runtime/errors.js';

const {Environment, AsyncEnvironment, Loader, loadString, clearStringCache, raceLoaders} = typeof window !== 'undefined'
  ? window.nunjucks : await import('../src/index.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => { resolve = complete; reject = fail; });
  return {promise, resolve, reject};
}

function sources(values) {
  return {load: name => (Object.hasOwn(values, name) ? {src: values[name], path: 'physical/' + name} : null)};
}

async function rejection(promise) {
  try { await promise; }
  catch (error) { return error; }
  throw new Error('Expected a loading failure');
}

describe('recursive loader composition', function() {
  for (const EnvironmentClass of [Environment, AsyncEnvironment]) {
    it(`preserves nested chain order in ${EnvironmentClass.name}`, async function() {
      const calls = [];
      const miss = () => { calls.push('miss'); return null; };
      const hit = () => { calls.push('hit'); return ''; };
      const unused = () => { calls.push('unused'); return 'unused'; };
      const env = new EnvironmentClass([[], [[miss], [hit, unused]], unused]);
      expect(await env.renderTemplate('entry')).to.be('');
      expect(await env.loadString('entry')).to.be('');
      expect(calls).to.eql(['miss', 'hit']);
    });

    it(`overrides relative dependencies using logical names in ${EnvironmentClass.name}`, async function() {
      const override = sources({'pages/part': 'override'});
      const base = sources({'pages/main': '{% include "./part" %}', 'pages/part': 'base'});
      const env = new EnvironmentClass([[override], [[base]]]);
      expect(await env.renderTemplate('pages/main')).to.be('override');
      expect(await env.renderTemplate('pages/main')).to.be('override');
    });
  }

  it('waits for a miss before starting the next nested chain entry', async function() {
    const first = deferred();
    const calls = [];
    const env = new AsyncEnvironment([[() => { calls.push('first'); return first.promise; }], [() => { calls.push('second'); return 'found'; }]]);
    const pending = env.loadString('entry');
    expect(calls).to.eql(['first']);
    first.resolve(null);
    expect(await pending).to.be('found');
    expect(calls).to.eql(['first', 'second']);
  });

  it('preserves URL parent names through nested chains', async function() {
    const name = 'https://sources.test/pages/part';
    const env = new AsyncEnvironment([[sources({[name]: 'URL source'})], () => null]);
    expect(await env.loadString('./part', 'https://sources.test/pages/main')).to.be('URL source');
  });

  it('races a sequential chain against another source without cancelling started work', async function() {
    const first = deferred();
    const other = deferred();
    const calls = [];
    const group = raceLoaders([
      [() => { calls.push('first'); return first.promise; }, () => { calls.push('fallback'); return 'later'; }],
      () => { calls.push('other'); return other.promise; }
    ]);
    const pending = new AsyncEnvironment(group).loadString('entry');
    expect(calls).to.eql(['first', 'other']);
    other.resolve('winner');
    expect(await pending).to.be('winner');
    first.resolve(null);
    await first.promise;
    await Promise.resolve();
    expect(calls).to.eql(['first', 'other', 'fallback']);
  });

  it('retains ordered overrides inside and around a selected race', async function() {
    const override = sources({'pages/part': 'override'});
    const base = sources({'pages/main': '{% include "./part" %}', 'pages/part': 'base'});
    for (const group of [raceLoaders([[override, base], () => null]), [override, raceLoaders([base, () => null])]]) {
      expect(await new AsyncEnvironment(group).renderTemplate('pages/main')).to.be('override');
    }
  });

  it('does not search another race competitor for a relative dependency', async function() {
    const selected = sources({'pages/main': 'import "./missing" as missing\nreturn missing.value'});
    const calls = [];
    const competitor = {load: name => { calls.push(name); return name === 'pages/missing' ? 'unrelated' : null; }};
    const env = new AsyncEnvironment(raceLoaders([[selected, () => null], competitor]), {loadFailFatal: false});
    expect(isPoisonError(await rejection(env.renderScript('pages/main')))).to.be(true);
    expect(calls).to.eql(['pages/main']);
  });

  it('preserves per-acquisition scopes when concurrent races share a physical path', async function() {
    const entered = deferred();
    const childName = deferred();
    const shared = {src: '{% include childName() %}', path: 'physical/shared', noCache: true};
    let selected = 'first';
    const member = id => ({load: name => {
      if (name === 'pages/main') return selected === id ? shared : null;
      return name === 'pages/part' ? {src: id, path: 'physical/shared-part', noCache: true} : null;
    }});
    const group = raceLoaders([[member('first'), () => null], [member('second'), () => null]]);
    const env = new AsyncEnvironment(group);
    const first = env.renderTemplate('pages/main', {childName: () => { entered.resolve(); return childName.promise; }});
    await entered.promise;
    selected = 'second';
    const second = await env.renderTemplate('pages/main', {childName: () => './part'}).finally(() => childName.resolve('./part'));
    expect(await first).to.be('first');
    expect(second).to.be('second');
  });

  it('invalidates nested misses and relative overrides on leaf updates', async function() {
    class Overrides extends Loader {
      value = null;
      load(name) { return name === 'pages/part' && this.value !== null ? {src: this.value, path: 'override/part'} : null; }
    }
    const override = new Overrides();
    const base = sources({'pages/main': '{% include "./part" %}', 'pages/part': 'base'});
    const env = new AsyncEnvironment([[[override]], [base]]);
    expect(await env.renderTemplate('pages/main')).to.be('base');
    override.value = 'override';
    override.emit('update', 'pages/part', 'override/part');
    expect(await env.renderTemplate('pages/main')).to.be('override');
    override.value = 'after invalidate';
    env.invalidateCache();
    expect(await env.renderTemplate('pages/main')).to.be('after invalidate');
  });

  it('retains cached fallback compilation while rechecking an earlier reload source', async function() {
    let calls = 0;
    const reload = Object.assign(() => { calls++; return null; }, {cachePolicy: 'reload'});
    const env = new AsyncEnvironment([[reload], [() => 'cached']]);
    const first = await env.getTemplate('entry');
    expect(await env.getTemplate('entry')).to.be(first);
    expect(calls).to.be(2);
  });

  for (const policy of ['cache', 'reload']) {
    it(`applies an explicit race ${policy} policy throughout the winning chain`, async function() {
      let version = 0;
      const member = sources({'pages/main': '{% include "./part" %}'});
      const relative = Object.assign(name => (name === 'pages/part' ? String(++version) : null), {cachePolicy: 'reload'});
      const group = raceLoaders([[member, relative], () => null]);
      group.cachePolicy = policy;
      const env = new AsyncEnvironment(group);
      expect(await env.renderTemplate('pages/main')).to.be('1');
      expect(await env.renderTemplate('pages/main')).to.be(policy === 'cache' ? '1' : '2');
    });
  }

  it('shares pending hierarchical sources but releases noCache results', async function() {
    const ready = deferred();
    let calls = 0;
    const leaf = () => { calls++; return ready.promise; };
    const env = new AsyncEnvironment([[leaf, () => null], []]);
    const pending = [env.loadString('entry'), env.renderTemplate('entry')];
    expect(calls).to.be(1);
    ready.resolve({src: 'source', path: 'entry', noCache: true});
    expect(await Promise.all(pending)).to.eql(['source', 'source']);
    expect(await env.loadString('entry')).to.be('source');
    expect(calls).to.be(2);
  });

  for (const invalidation of ['update', 'invalidate']) {
    it(`does not revive obsolete pending chain acquisitions after ${invalidation}`, async function() {
      const obsolete = deferred();
      class UpdatingLoader extends Loader {
        calls = 0;
        load() { return ++this.calls === 1 ? obsolete.promise : 'new'; }
      }
      const loader = new UpdatingLoader();
      const env = new AsyncEnvironment([[loader], () => null]);
      const old = env.loadString('entry');
      if (invalidation === 'update') loader.emit('update', 'entry');
      else env.invalidateCache();
      expect(await env.loadString('entry')).to.be('new');
      obsolete.resolve('old');
      expect(await old).to.be('old');
      expect(await env.loadString('entry')).to.be('new');
      expect(loader.calls).to.be(2);
    });
  }

  it('keeps environment errors fatal to a chain and preserves standalone utility fallback', async function() {
    const failure = new Error('load failed');
    const group = [[() => { throw failure; }, () => 'fallback']];
    expect(await rejection(new AsyncEnvironment(group).loadString('entry'))).to.be(failure);
    expect(await loadString('entry', group)).to.be('fallback');
    let version = 'first';
    const cached = [[() => version]];
    expect(await loadString('entry', cached)).to.be('first');
    version = 'second';
    clearStringCache(cached);
    expect(await loadString('entry', cached)).to.be('second');
  });

  it('lets empty and failed competitors finish according to the native race policy', async function() {
    expect(await new AsyncEnvironment([raceLoaders([[], [[]]]), () => 'fallback']).loadString('entry')).to.be('fallback');
    const failure = new Error('failed competitor');
    const group = raceLoaders([[() => { throw failure; }], [], () => null]);
    expect(await rejection(group.load('entry'))).to.be(failure);
    expect(() => raceLoaders([[{}]])).to.throwException(TypeError);
  });

  it('keeps legacy callback sources and their metadata inside recursive races', async function() {
    const source = {src: '', path: 'legacy', noCache: true};
    const failure = new Error('legacy failure');
    const group = raceLoaders([
      [{async: true, getSource: (_name, callback) => callback(failure)}],
      [{async: true, getSource: (_name, callback) => callback(null, source)}]
    ]);
    expect(await group.load('entry')).to.be(source);
  });

  it('reports the first settled race error and consumes late loser failures', async function() {
    const first = deferred();
    const second = deferred();
    const group = raceLoaders([[() => first.promise], [() => second.promise]]);
    const pending = group.load('entry');
    const failure = new Error('second settled first');
    second.reject(failure);
    await Promise.resolve();
    first.resolve(null);
    expect(await rejection(pending)).to.be(failure);
    const loser = deferred();
    expect(await raceLoaders([[() => 'winner'], [() => loser.promise]]).load('entry')).to.eql({src: 'winner', path: 'entry', noCache: false});
    loser.reject(new Error('late failure'));
    await Promise.resolve();
  });

  it('does not deduplicate independently authored race competitors', async function() {
    let calls = 0;
    const repeated = () => { calls++; return null; };
    expect(await raceLoaders([repeated, [repeated]]).load('entry')).to.be(null);
    expect(calls).to.be(2);
  });
});
