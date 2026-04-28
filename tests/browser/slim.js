const cascada = await import('../../src/index.js');
const precompiledTemplates = (await import('./precompiled-templates.js')).default;

window.nunjucks = {...cascada};
window.nunjucksFull = window.nunjucks;
window.precompiledTemplates = precompiledTemplates;
window.nunjucks.testing = true;
mocha.setup({
  ui: 'bdd',
  reporter: window.ConsoleReporter
});
mocha.checkLeaks();

await import('../util.js');
await import('../compiler.js');
await import('../runtime.js');
await import('../filters.js');
await import('../globals.js');
await import('../jinja-compat.js');
await import('../tests.js');
