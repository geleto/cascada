import expect from 'expect.js';
import {isPoisonError} from '../src/runtime/errors.js';

const {AsyncEnvironment, Environment, raceLoaders} = typeof window !== 'undefined'
  ? window.nunjucks
  : await import('../src/index.js');

function renderSyncEnvironment(env, name) {
  return new Promise((resolve, reject) => {
    env.renderTemplate(name, {}, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function members(noCache) {
  const calls = {owner: [], other: []};
  const owner = {
    isRelative: name => name.startsWith('./'),
    resolve: (from, to) => 'dir/' + to.slice(2),
    load(name) {
      calls.owner.push(name);
      const sources = {
        'main': '{% include "./part" %}',
        'dir/part': 'OWNER'
      };
      if (!Object.hasOwn(sources, name)) return null;
      const source = {src: sources[name], path: name === 'main' ? 'dir/main' : name, noCache};
      return name === 'main' ? source : Promise.resolve(source);
    }
  };
  const other = {
    isRelative: owner.isRelative,
    resolve: owner.resolve,
    load(name) {
      calls.other.push(name);
      return name === 'dir/part' ? {src: 'OTHER', path: name, noCache} : null;
    }
  };
  return {owner, other, calls};
}

describe('loader origins and public parent names', function() {
  for (const noCache of [false, true]) {
    it(`pins relative dependencies to the winning member with noCache=${noCache}`, async function() {
      const {owner, other, calls} = members(noCache);
      const env = new AsyncEnvironment(raceLoaders([raceLoaders([owner, other])]));
      expect(await env.renderTemplate('main')).to.be('OWNER');
      expect(await env.renderTemplate('main')).to.be('OWNER');
      expect(calls.other.filter(name => name === 'dir/part')).to.eql([]);
    });
  }

  it('passes string parent names through asynchronous subclass overrides', async function() {
    class CheckingEnvironment extends AsyncEnvironment {
      #parents = [];

      getTemplate(name, eagerCompile, parentName, ignoreMissing, origin) {
        expect(parentName == null || typeof parentName === 'string').to.be(true);
        if (parentName) this.#parents.push(parentName);
        return super.getTemplate(name, eagerCompile, parentName, ignoreMissing, origin);
      }

      getScript(name, eagerCompile, parentName, ignoreMissing, origin) {
        expect(parentName == null || typeof parentName === 'string').to.be(true);
        if (parentName) this.#parents.push(parentName);
        return super.getScript(name, eagerCompile, parentName, ignoreMissing, origin);
      }

      get parents() { return this.#parents; }
    }
    const sources = {
      'main': '{% extends "./base" %}{% block body %}{% include "./part" %}{% endblock %}',
      'base': '{% block body %}{% endblock %}',
      'part': 'PART',
      'main.casc': 'import "./lib.casc" as lib\nreturn lib.value',
      'lib.casc': 'var value = 42'
    };
    const loader = {
      isRelative: name => name.startsWith('./'),
      resolve: (from, to) => to.slice(2),
      load: name => (Object.hasOwn(sources, name) ? {src: sources[name], path: name} : null)
    };
    const competitor = {
      isRelative: loader.isRelative,
      resolve: loader.resolve,
      load: name => (name === 'part' || name === 'lib.casc' ? {src: name === 'part' ? 'OTHER' : 'var value = 0', path: name} : null)
    };
    const env = new CheckingEnvironment(raceLoaders([competitor, loader]));
    expect(await env.renderTemplate('main')).to.be('PART');
    expect(await env.renderScript('main.casc')).to.be(42);
    expect(env.parents).to.contain('main');
    expect(env.parents).to.contain('main.casc');
  });

  it('preserves a failed relative import instead of falling back to another race member', async function() {
    const resolve = () => 'dir/lib.casc';
    const owner = {
      isRelative: name => name.startsWith('./'),
      resolve,
      load: name => (name === 'main.casc'
        ? {src: 'import "./lib.casc" as lib\nreturn lib.value', path: 'dir/main.casc'}
        : null)
    };
    const other = {
      isRelative: owner.isRelative,
      resolve,
      load: name => (name === 'dir/lib.casc' ? {src: 'var value = 123', path: name} : null)
    };
    const env = new AsyncEnvironment(raceLoaders([owner, other]), {loadFailFatal: false});
    let failure;
    try {
      await env.renderScript('main.casc');
    } catch (error) {
      failure = error;
    }
    expect(isPoisonError(failure)).to.be(true);
    expect(failure.message).to.contain('lib.casc');
  });

  it('passes string parent names through synchronous subclass overrides', async function() {
    class CheckingEnvironment extends Environment {
      #parents = [];

      getTemplate(name, eagerCompile, parentName, ignoreMissing, callback, origin) {
        expect(parentName == null || typeof parentName === 'string').to.be(true);
        if (parentName) this.#parents.push(parentName);
        return super.getTemplate(name, eagerCompile, parentName, ignoreMissing, callback, origin);
      }

      get parents() { return this.#parents; }
    }
    const {owner, other} = members(true);
    const env = new CheckingEnvironment(raceLoaders([owner, other]));
    expect(await renderSyncEnvironment(env, 'main')).to.be('OWNER');
    expect(env.parents).to.eql(['dir/main']);
  });

  it('keeps a synchronous imported macro on its declaring member when canonical paths coincide', async function() {
    const partRequests = [];
    function member(id, sources) {
      return {
        isRelative: name => name.startsWith('./'),
        resolve: () => 'shared/part',
        load(name) {
          if (name === 'shared/part') {
            partRequests.push(id);
            return {src: id, path: name, noCache: true};
          }
          return Object.hasOwn(sources, name)
            ? {src: sources[name], path: 'shared/source', noCache: true}
            : null;
        }
      };
    }
    const main = member('MAIN', {'main': '{% import "library" as lib %}{{ lib.value() }}'});
    const library = member('LIBRARY', {'library': '{% macro value() %}{% include "./part" %}{% endmacro %}'});
    const env = new Environment(raceLoaders([raceLoaders([main, library])]));
    expect(await renderSyncEnvironment(env, 'main')).to.be('LIBRARY');
    expect(partRequests).to.eql(['LIBRARY']);
  });
});
