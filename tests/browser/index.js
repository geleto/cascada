// Include the necessary test files
require('../util.js');
require('../api.js');
require('../lexer.js');
require('../loader.js');
require('../parser.js');
require('../compiler.js');
require('../runtime.js');
require('../filters.js');
require('../globals.js');
require('../jinja-compat.js');
require('../tests.js');

// Set up the test environment
nunjucks.testing = true;
mocha.checkLeaks();
mocha.run();
