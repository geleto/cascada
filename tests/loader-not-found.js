import expect from 'expect.js';
import * as precompiled from '../src/precompiled/index.js';

const {Environment, AsyncEnvironment, NotFoundError, loadString} = typeof window !== 'undefined'
  ? window.nunjucks
  : await import('../src/index.js');

function expectNotFound(error, resourceName) {
  expect(error instanceof NotFoundError).to.be(true);
  expect(error.name).to.be('NotFoundError');
  expect(error.resourceName).to.be(resourceName);
  expect(error.message).to.be(`Resource not found: ${resourceName}`);
}

function thrown(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

describe('resource not found errors', function() {
  it('exports the same typed error from both entry points', function() {
    expect(precompiled.NotFoundError).to.be(NotFoundError);
    expectNotFound(new NotFoundError('nested/missing.njk'), 'nested/missing.njk');
  });

  it('uses the same missing-resource error for synchronous template acquisition and rendering', function() {
    const env = new Environment(() => null);
    expectNotFound(thrown(() => env.getTemplate('missing.njk')), 'missing.njk');
    expectNotFound(thrown(() => env.renderTemplate('missing.njk')), 'missing.njk');
  });

  it('returns the typed missing error through synchronous rendering callbacks', function(done) {
    new Environment(() => null).renderTemplate('missing.njk', (error) => {
      try {
        expectNotFound(error, 'missing.njk');
        done();
      } catch (assertionError) {
        done(assertionError);
      }
    });
  });

  it('uses the same missing-resource error for templates, scripts, and raw text', async function() {
    const env = new AsyncEnvironment(() => null);
    for (const method of ['getTemplate', 'renderTemplate', 'getScript', 'renderScript', 'loadString']) {
      expectNotFound(await rejected(env[method]('missing')), 'missing');
    }
    expectNotFound(await rejected(new Environment(() => null).loadString('missing')), 'missing');
  });

  it('uses the same missing-resource error with asynchronous loader chains', async function() {
    const env = new AsyncEnvironment([async () => null, () => null]);
    expectNotFound(await rejected(env.renderTemplate('missing.njk')), 'missing.njk');
    expectNotFound(await rejected(env.renderScript('missing.casc')), 'missing.casc');
    expectNotFound(await rejected(env.loadString('missing.txt')), 'missing.txt');
  });

  it('uses the same missing-resource error in the precompiled environments', async function() {
    const syncEnv = new precompiled.Environment(() => null);
    expectNotFound(thrown(() => syncEnv.renderTemplate('missing')), 'missing');
    const asyncEnv = new precompiled.AsyncEnvironment(() => null);
    expectNotFound(await rejected(asyncEnv.renderTemplate('missing')), 'missing');
    expectNotFound(await rejected(asyncEnv.renderScript('missing')), 'missing');
    expectNotFound(await rejected(asyncEnv.loadString('missing')), 'missing');
  });

  it('uses the same missing-resource error for synchronous and asynchronous standalone loading', async function() {
    expectNotFound(thrown(() => loadString('missing', () => null)), 'missing');
    expectNotFound(thrown(() => loadString('missing', [])), 'missing');
    expectNotFound(await rejected(loadString('missing', [() => null, async () => null])), 'missing');
    expectNotFound(await rejected(loadString('missing', {
      async: true,
      getSource(name, callback) { callback(null, null); }
    })), 'missing');
  });

  it('keeps ignoreMissing behavior for absent templates', async function() {
    const syncEnv = new Environment(() => null);
    expect(syncEnv.getTemplate('missing', false, null, true).render()).to.be('');
    const asyncEnv = new AsyncEnvironment(() => null);
    expect(await (await asyncEnv.getTemplate('missing', false, null, true)).render()).to.be('');
    expect(await asyncEnv.renderTemplateString('{% include "missing" ignore missing %}done')).to.be('done');
  });

  it('preserves genuine loader failures through environment and standalone entry points', async function() {
    const failure = new Error('Loader is unavailable');
    const fail = () => { throw failure; };
    const env = new AsyncEnvironment(fail);
    for (const method of ['getTemplate', 'getScript', 'loadString']) {
      expect(await rejected(env[method]('x'))).to.be(failure);
    }
    expect(thrown(() => new Environment(fail).getTemplate('x'))).to.be(failure);
    expect(thrown(() => loadString('x', [fail, () => null]))).to.be(failure);
    expect(await rejected(loadString('x', [async () => { throw failure; }, () => null]))).to.be(failure);
    expect(loadString('x', [fail, () => 'fallback'])).to.be('fallback');
  });
});
