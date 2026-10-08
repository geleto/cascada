import expect from 'expect.js';
import {Loader, raceLoaders} from '../src/index.js';
import {Environment, AsyncEnvironment} from '../src/precompiled/index.js';
import {
  precompileTemplateString,
  precompileTemplateStringAsync,
  precompileScriptString
} from '../src/precompile.js';

async function compileSource(compile, source, name) {
  const output = compile(source, {name, format: 'esm'});
  const templates = (await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'))).default;
  return {type: 'code', obj: templates[name]};
}

class CanonicalLoader extends Loader {
  constructor(sources) {
    super();
    this.sources = sources;
  }

  resolve(from, to) {
    return new URL(to, new URL(from, 'https://loader.test/')).pathname;
  }

  load(name) {
    const key = name === 'main' ? '/physical/main' : name;
    return Object.hasOwn(this.sources, key) ? {src: this.sources[key], path: key} : null;
  }
}

describe('canonical origins for precompiled resources', function() {
  for (const asynchronous of [false, true]) {
    it(`resolves ${asynchronous ? 'asynchronous' : 'synchronous'} includes from the loaded canonical path`, async function() {
      const compile = asynchronous ? precompileTemplateStringAsync : precompileTemplateString;
      const main = await compileSource(compile, '{% include "./part" %}', 'logical/main');
      const part = await compileSource(compile, 'PART', 'logical/part');
      const loader = new CanonicalLoader({'/physical/main': main, '/physical/part': part});
      if (asynchronous) {
        expect(await new AsyncEnvironment(raceLoaders([loader])).renderTemplate('main')).to.be('PART');
      } else {
        expect(new Environment(loader).renderTemplate('main')).to.be('PART');
      }
    });
  }

  it('resolves precompiled script imports from the loaded canonical path', async function() {
    const main = await compileSource(precompileScriptString, 'import "./lib" as lib\nreturn lib.value', 'logical/main');
    const lib = await compileSource(precompileScriptString, 'var value = 42', 'logical/lib');
    const loader = new CanonicalLoader({'/physical/main': main, '/physical/lib': lib});
    expect(await new AsyncEnvironment(raceLoaders([loader])).renderScript('main')).to.be(42);
  });
});
