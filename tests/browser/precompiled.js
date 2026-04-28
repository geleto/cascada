const cascada = await import('../../src/precompiled/index.js');
const precompiledTemplates = (await import('./precompiled-templates.js')).default;

window.cascada = {...cascada};
window.nunjucks = window.cascada;
window.precompiledTemplates = precompiledTemplates;
window.cascada.testing = true;
mocha.setup({
  ui: 'bdd',
  reporter: window.ConsoleReporter
});
mocha.checkLeaks();

const expect = window.expect;

describe('precompiled runtime entry', function() {
  let env;

  beforeEach(function() {
    env = new cascada.AsyncEnvironment(new cascada.PrecompiledLoader(precompiledTemplates));
  });

  it('renders a precompiled template', async function() {
    const result = await env.renderTemplate('include.njk', {name: 'Browser'});

    expect(result).to.be('FooInclude Browser');
  });

  it('renders precompiled includes through the loader map', async function() {
    const result = await env.renderTemplate('includeMany.njk', {name: 'Browser'});

    expect(result).to.contain('FooInclude');
  });

  it('renders precompiled inheritance through the loader map', async function() {
    const result = await env.renderTemplate('base-inherit.njk');

    expect(result).to.contain('Foo*Bar*BazFizzle');
  });

  it('rejects runtime string compilation', async function() {
    try {
      await env.renderTemplateString('Hello {{ name }}', {name: 'Browser'});
      expect().fail('Expected precompiled environment to reject string templates');
    } catch (err) {
      expect(err.message).to.contain('Template string rendering is not available');
    }
  });
});
