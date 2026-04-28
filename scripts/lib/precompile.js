import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(scriptDir, '../..');
const testDir = path.join(scriptDir, '../../tests');
const templateDir = path.join(testDir, 'templates');
const outputFile = path.join(testDir, 'browser/precompiled-templates.js');

async function loadPrecompile() {
  const candidates = [
    path.join(projectRoot, 'src/precompile.js'),
    path.join(projectRoot, 'dist/precompile.js')
  ];
  const precompilePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!precompilePath) {
    throw new Error('Unable to find precompile module. Run `npm run build` first.');
  }
  const precompileModule = await import(pathToFileURL(precompilePath));
  return precompileModule.precompile;
}

async function precompileTestTemplates() {
  try {
    const precompile = await loadPrecompile();
    // Generate precompiled content
    const output = precompile(templateDir, {
      include: [/\.(njk|html)$/],
      format: 'esm'
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
