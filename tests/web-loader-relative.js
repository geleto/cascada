import expect from 'expect.js';
import {isPoisonError} from '../src/runtime/errors.js';

const isBrowser = typeof window !== 'undefined';
const {AsyncEnvironment, Environment, raceLoaders} = isBrowser ? window.nunjucks : await import('../src/index.js');
const {WebLoader} = isBrowser ? window.nunjucks : await import('../src/loader/web-loaders.js');

class MockWebLoader extends WebLoader {
  constructor(baseURL, sources, opts) {
    super(baseURL, opts);
    this.sources = sources;
    this.calls = [];
  }

  fetch(url, callback) {
    this.calls.push(url);
    const respond = () => {
      if (Object.hasOwn(this.sources, url)) {
        const source = this.sources[url];
        if (source instanceof Error) {
          callback({status: 500, content: source});
        } else {
          callback(null, source);
        }
      } else {
        callback({status: 404, content: '404 Not Found'});
      }
    };
    if (this.async) {
      queueMicrotask(respond);
    } else {
      respond();
    }
  }
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
}

describe('WebLoader relative URLs', function() {
  it('resolves names against directory base URLs with or without a trailing slash', function() {
    for (const baseURL of ['https://example.test/views', 'https://example.test/views/']) {
      const loader = new MockWebLoader(baseURL, {'https://example.test/views/dir/main.njk': ''});
      expect(loader.getSource('dir/main.njk')).to.eql({
        src: '', path: 'https://example.test/views/dir/main.njk', noCache: true
      });
      expect(loader.resolve('dir/main.njk', './part.njk')).to.be('https://example.test/views/dir/part.njk');
      expect(loader.resolve('https://example.test/views/dir/main.njk', '../tail.njk')).to.be('https://example.test/views/tail.njk');
    }
  });

  it('loads resolved absolute URLs without adding the base a second time', function() {
    const url = 'https://example.test/views/dir/part.njk';
    const loader = new MockWebLoader('https://example.test/views', {[url]: 'part'}, {useCache: true});
    expect(loader.getSource(url)).to.eql({src: 'part', path: url, noCache: false});
    expect(loader.calls).to.eql([url]);
  });

  it('renders relative includes through the synchronous environment', function() {
    const loader = new MockWebLoader('https://example.test/views', {
      'https://example.test/views/dir/main.njk': '{% include "./part.njk" %}{% include "../tail.njk" %}',
      'https://example.test/views/dir/part.njk': 'PART',
      'https://example.test/views/tail.njk': 'TAIL'
    });
    const env = new Environment(loader);
    expect(env.render('dir/main.njk')).to.be('PARTTAIL');
    expect(loader.calls).to.eql([
      'https://example.test/views/dir/main.njk',
      'https://example.test/views/dir/part.njk',
      'https://example.test/views/tail.njk'
    ]);
  });

  for (const grouped of [false, true]) {
    const mode = grouped ? 'nested race groups' : 'the direct loader';

    it('renders relative includes and imports through ' + mode, async function() {
      const loader = new MockWebLoader('https://example.test/views/', {
        'https://example.test/views/dir/main.njk': '{% include "./part.njk" %}{% include "../tail.njk" %}',
        'https://example.test/views/dir/part.njk': 'PART',
        'https://example.test/views/tail.njk': 'TAIL',
        'https://example.test/views/dir/main.casc': 'import "./lib.casc" as lib\nreturn lib.value',
        'https://example.test/views/dir/lib.casc': 'var value = 42'
      }, {async: true, useCache: true});
      const env = new AsyncEnvironment(grouped ? raceLoaders([() => null, raceLoaders([loader])]) : loader);
      expect(await env.renderTemplate('dir/main.njk')).to.be('PARTTAIL');
      expect(await env.renderScript('dir/main.casc')).to.be(42);
      expect(await env.renderTemplate('dir/main.njk')).to.be('PARTTAIL');
      expect(await env.renderScript('dir/main.casc')).to.be(42);
      expect(loader.calls).to.have.length(5);
    });

    it('keeps relative imports in poison flow when the source is missing through ' + mode, async function() {
      const loader = new MockWebLoader('https://example.test/views', {
        'https://example.test/views/dir/main.casc': 'import "./missing.casc" as lib\nreturn lib.value'
      }, {async: true});
      const env = new AsyncEnvironment(grouped ? raceLoaders([loader]) : loader, {loadFailFatal: false});
      const error = await rejection(env.renderScript('dir/main.casc'));
      expect(isPoisonError(error)).to.be(true);
      expect(error.message).to.contain('./missing.casc');
    });
  }

  it('uses noCache defaults for repeatedly loaded relative sources', async function() {
    const sources = {
      'https://example.test/views/main.njk': '{% include "./part.njk" %}',
      'https://example.test/views/part.njk': 'first'
    };
    const loader = new MockWebLoader('https://example.test/views', sources, {async: true});
    const env = new AsyncEnvironment(raceLoaders([loader]));
    expect(await env.renderTemplate('main.njk')).to.be('first');
    sources['https://example.test/views/part.njk'] = 'second';
    expect(await env.renderTemplate('main.njk')).to.be('second');
    expect(loader.calls).to.have.length(4);
  });

  it('invalidates cached relative sources when an update carries the canonical URL', async function() {
    const partURL = 'https://example.test/views/dir/part.njk';
    const sources = {
      'https://example.test/views/dir/main.njk': '{% include "./part.njk" %}',
      [partURL]: 'first'
    };
    const loader = new MockWebLoader('https://example.test/views', sources, {async: true, useCache: true});
    const env = new AsyncEnvironment(raceLoaders([loader]));
    expect(await env.renderTemplate('dir/main.njk')).to.be('first');
    sources[partURL] = 'second';
    loader.emit('update', 'dir/part.njk', partURL);
    expect(await env.renderTemplate('dir/main.njk')).to.be('second');
    expect(loader.calls).to.eql(['https://example.test/views/dir/main.njk', partURL, partURL]);
  });

  it('treats HTTP 404 as a miss and allows another loader to handle the source', async function() {
    const loader = new MockWebLoader('https://example.test/views', {}, {async: true});
    const env = new AsyncEnvironment([loader, () => 'fallback']);
    expect(await env.renderTemplate('missing.njk')).to.be('fallback');
    expect(new MockWebLoader('https://example.test/views', {}).getSource('missing.njk')).to.be(null);
  });

  it('preserves HTTP failures from relative sources', async function() {
    const failure = new Error('server unavailable');
    const loader = new MockWebLoader('https://example.test/views', {
      'https://example.test/views/dir/main.casc': 'import "./part.casc" as part\nreturn part.value',
      'https://example.test/views/dir/part.casc': failure
    }, {async: true});
    const env = new AsyncEnvironment(loader, {loadFailFatal: false});
    expect(await rejection(env.loadString('./part.casc', 'https://example.test/views/dir/main.casc'))).to.be(failure);
    const error = await rejection(env.renderScript('dir/main.casc'));
    expect(isPoisonError(error)).to.be(true);
    expect(error.message).to.contain(failure.message);
  });

  if (isBrowser) {
    for (const baseURL of ['.', '../templates', '/templates']) {
      it('resolves the browser base URL ' + baseURL + ' against the document', function() {
        const base = new URL(baseURL, document.baseURI);
        if (!base.pathname.endsWith('/')) base.pathname += '/';
        const url = new URL('dir/main.njk', base).href;
        const loader = new MockWebLoader(baseURL, {[url]: 'main'});
        expect(loader.getSource('dir/main.njk').path).to.be(url);
        expect(loader.resolve(url, '../part.njk')).to.be(new URL('part.njk', base).href);
      });
    }
  }
});
