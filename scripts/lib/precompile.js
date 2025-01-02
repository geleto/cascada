const fs = require('fs');
const path = require('path');
const precompile = require('../../nunjucks/src/precompile').precompile;

const testDir = path.join(__dirname, '../../tests');
const templateDir = path.join(testDir, 'templates');
const outputFile = path.join(testDir, 'browser/precompiled-templates.js');

async function precompileTestTemplates() {
  try {
    // Generate precompiled content
    const output = precompile(templateDir, {
      include: [/\.(njk|html)$/],
    });

    // Write file with explicit encoding
    fs.writeFileSync(outputFile, output, { encoding: 'utf8', flag: 'w' });

    return true;
  } catch (err) {
    console.error('Error precompiling templates:', err);
    throw err;
  }
}

module.exports = precompileTestTemplates;
