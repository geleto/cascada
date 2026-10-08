import expect from 'expect.js';
import {isPoisonError} from '../src/runtime/errors.js';

const indexModule = typeof window !== 'undefined' ? window.nunjucks : await import('../src/index.js');
const {AsyncEnvironment, AsyncTemplate, Environment, Loader, raceLoaders} = indexModule;

class SourceLoader extends Loader {
  constructor(sources, prefix, noCache = true) {
    super();
    this.sources = sources;
    this.prefix = prefix;
    this.noCache = noCache;
  }

  resolve(from, to) {
    const parts = from.slice(0, from.lastIndexOf('/') + 1).split('/').filter(Boolean);
    for (const part of to.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  }

  load(name) {
    const key = name.startsWith(this.prefix) ? name.slice(this.prefix.length) : name;
    if (!Object.hasOwn(this.sources, key)) return null;
    return {src: this.sources[key], path: this.prefix + key, noCache: this.noCache};
  }
}

describe('source origin transport through compiled execution', function() {
  it('keeps the actual environment instance for subclasses and resolver overrides', async function() {
    class CustomEnvironment extends AsyncEnvironment {
      #loads = 0;
      #resolves = 0;

      getTemplate(...args) {
        this.#loads++;
        return super.getTemplate(...args);
      }

      _resolveFromLoader(...args) {
        this.#resolves++;
        return super._resolveFromLoader(...args);
      }

      get counts() {
        return [this.#loads, this.#resolves];
      }
    }

    const loader = new SourceLoader({'main': '{% include "./part" %}', 'part': 'PART'}, 'source/');
    const env = new CustomEnvironment(raceLoaders([raceLoaders([loader])]));
    const template = await env.getTemplate('main');
    expect(template.env).to.be(env);
    expect(await template.render()).to.be('PART');
    expect(env.counts[0]).to.be(2);
    expect(env.counts[1]).to.be.greaterThan(1);
  });

  it('keeps the origin of each acquisition when nested members share the same source object', async function() {
    const source = {src: '{% include "./part" %}', path: 'shared/main', noCache: true};
    let selected = 'A';
    const member = id => ({
      isRelative: requested => requested.startsWith('./'),
      resolve: () => id + '/part',
      load(name) {
        if (name === 'main') return selected === id ? source : null;
        return name === id + '/part' ? {src: id, path: name, noCache: true} : null;
      }
    });
    const env = new AsyncEnvironment(raceLoaders([raceLoaders([member('A'), member('B')])]));
    const first = await env.getTemplate('main');
    selected = 'B';
    const second = await env.getTemplate('main');
    expect(await Promise.all([first.render(), second.render()])).to.eql(['A', 'B']);
  });

  it('uses the declaring source for relative includes in inherited blocks', async function() {
    const child = new SourceLoader({
      'main': '{% extends "base" %}{% block body %}{% include "./part" %}{{ super() }}{% endblock %}',
      'part': 'CHILD'
    }, 'child/');
    const base = new SourceLoader({
      'base': '{% block body %}{% include "./part" %}{% endblock %}',
      'part': 'BASE'
    }, 'base/');
    const env = new AsyncEnvironment(raceLoaders([raceLoaders([child, base])]));
    expect(await env.renderTemplate('main')).to.be('CHILDBASE');
    expect(await env.renderTemplate('main')).to.be('CHILDBASE');
  });

  it('allows inheritance between distinct members with the same canonical path', async function() {
    const member = (id, name, src) => ({
      isRelative: requested => requested.startsWith('./'),
      resolve: () => id + '/part',
      load(requested) {
        if (requested === name) return {src, path: 'shared/source', noCache: true};
        return requested === id + '/part' ? {src: id, path: requested, noCache: true} : null;
      }
    });
    const child = member('CHILD', 'main', '{% extends "base" %}{% block body %}{% include "./part" %}{{ super() }}{% endblock %}');
    const base = member('BASE', 'base', '{% block body %}{% include "./part" %}{% endblock %}');
    const env = new AsyncEnvironment(raceLoaders([child, base]));
    expect(await env.renderTemplate('main')).to.be('CHILDBASE');
  });

  it('still rejects inheritance cycles within one noCache member', async function() {
    const loader = new SourceLoader({'main': '{% extends "./main" %}'}, 'source/');
    const env = new AsyncEnvironment(raceLoaders([loader]));
    try {
      await env.renderTemplate('main');
      throw new Error('Expected inheritance cycle to fail');
    } catch (error) {
      expect(error.message).to.contain('inheritance cycle detected');
    }
  });

  it('allows distinct inline inheritance participants with the same diagnostic path', async function() {
    const env = new AsyncEnvironment();
    const parent = new AsyncTemplate('[{% block body %}BASE{% endblock %}]', env, 'inline.njk');
    const child = new AsyncTemplate(
      '{% extends parent %}{% block body %}CHILD{{ super() }}{% endblock %}', env, 'inline.njk'
    );
    expect(await child.render({parent})).to.be('[CHILDBASE]');
  });

  it('preserves poison from an inline parent with the same diagnostic path', async function() {
    const env = new AsyncEnvironment();
    const parent = new AsyncTemplate('{% block body %}{{ fail() }}{% endblock %}', env, 'inline.njk');
    const child = new AsyncTemplate('{% extends parent %}', env, 'inline.njk');
    try {
      await child.render({
        parent,
        async fail() { throw new Error('parent value failed'); }
      });
      throw new Error('Expected parent value to fail');
    } catch (error) {
      expect(isPoisonError(error)).to.be(true);
      expect(error.message).to.contain('parent value failed');
    }
  });

  it('still rejects an inline inheritance cycle through the same object', async function() {
    const env = new AsyncEnvironment();
    const template = new AsyncTemplate('{% extends parent %}', env, 'inline.njk');
    try {
      await template.render({parent: template});
      throw new Error('Expected inheritance cycle to fail');
    } catch (error) {
      expect(error.message).to.contain('inheritance cycle detected');
      expect(error.path).to.be('inline.njk');
    }
  });

  it('resolves relative imports from component methods and their inherited parents', async function() {
    const loader = new SourceLoader({
      'main.casc': 'component "./components/child.casc" as child\nreturn child.value()',
      'components/child.casc': 'extends "./base.casc"\nmethod value()\n  return super()\nendmethod',
      'components/base.casc': 'extends "../grand.casc"\nmethod value()\n  import "./lib.casc" as lib\n  return lib.value + super()\nendmethod',
      'components/lib.casc': 'var value = 40',
      'grand.casc': 'method value()\n  import "./shared.casc" as shared\n  return shared.value\nendmethod',
      'shared.casc': 'var value = 2'
    }, 'source/');
    const env = new AsyncEnvironment(raceLoaders([raceLoaders([loader])]));
    expect(await env.renderScript('main.casc')).to.be(42);
  });

  it('retains poison origins when a component method consumes a missing relative import', async function() {
    const loader = new SourceLoader({
      'main.casc': 'component "./component.casc" as child\nreturn child.value()',
      'component.casc': 'method value()\n  import "./missing.casc" as lib\n  return lib.value\nendmethod'
    }, 'source/');
    const env = new AsyncEnvironment(raceLoaders([loader]), {loadFailFatal: false});
    try {
      await env.renderScript('main.casc');
      throw new Error('Expected missing import to fail');
    } catch (error) {
      expect(isPoisonError(error)).to.be(true);
      expect(error.message).to.contain('missing.casc');
    }
  });

  it('resolves synchronous includes in overridden blocks and nested super calls', function() {
    const child = new SourceLoader({
      'main': '{% extends "base" %}{% block body %}{% include "./part" %}{{ super() }}{% endblock %}',
      'part': 'CHILD'
    }, 'child/');
    const base = new SourceLoader({
      'base': '{% extends "grand" %}{% block body %}{% include "./part" %}{{ super() }}{% endblock %}',
      'part': 'BASE'
    }, 'base/');
    const grand = new SourceLoader({
      'grand': '[{% block body %}{% include "./part" %}{% endblock %}]',
      'part': 'GRAND'
    }, 'grand/');
    const env = new Environment([child, base, grand]);
    const template = env.getTemplate('main');
    expect(template.env).to.be(env);
    expect(template.render()).to.be('[CHILDBASEGRAND]');
  });
});
