const cascada = await import('../../src/index.js');

window.nunjucks = {...cascada};
window.nunjucks.testing = true;
mocha.setup({
  ui: 'bdd',
  reporter: window.ConsoleReporter
});
mocha.checkLeaks();

await import('../util.js');
await import('../api.js');
await import('../pasync/calls.js');
await import('../pasync/conditional.js');
await import('../pasync/custom.js');
await import('../pasync/expressions.js');
await import('../pasync/loader.js');
await import('../pasync/loops.js');
await import('../pasync/macros.js');
await import('../pasync/race.js');
await import('../pasync/setblock.js');
await import('../pasync/structures.js');
await import('../lexer.js');
await import('../loader.js');
await import('../parser.js');
await import('../compiler.js');
await import('../runtime.js');
await import('../filters.js');
await import('../globals.js');
await import('../jinja-compat.js');
await import('../tests.js');
