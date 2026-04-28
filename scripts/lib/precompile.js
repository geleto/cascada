import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import precompileModule from '../../src/precompile.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(scriptDir, '../../tests');
const templateDir = path.join(testDir, 'templates');
const outputFile = path.join(testDir, 'browser/precompiled-templates.js');
const {precompile} = precompileModule;

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

export default precompileTestTemplates;
