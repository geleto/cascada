const cascada = await import('../../src/index.js');

window.nunjucks = {...cascada};
window.nunjucksFull = window.nunjucks;
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
