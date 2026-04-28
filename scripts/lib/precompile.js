import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(scriptDir, '../..');
const testDir = path.join(scriptDir, '../../tests');
const templateDir = path.join(testDir, 'templates');
const outputFile = path.join(testDir, 'browser/precompiled-templates.js');

async function loadPrecompile() {
  const sourcePath = path.join(projectRoot, 'src/precompile.js');
  const distPath = path.join(projectRoot, 'dist/precompile.js');
  const precompilePath = process.env.CASCADA_TEST_DIST === '1'
    ? distPath
    : sourcePath;

  if (!fs.existsSync(precompilePath)) {
    const message = process.env.CASCADA_TEST_DIST === '1'
      ? 'Unable to find dist precompile module. Run `npm run build` first.'
      : 'Unable to find source precompile module.';
    throw new Error(message);
  }

  const precompileModule = await import(pathToFileURL(precompilePath));
  return precompileModule.precompile;
}

async function precompileTestTemplates() {
  try {
    const precompile = await loadPrecompile();
    // Generate precompiled content
    const output = precompile(templateDir, {
      include: [/^(include|includeMany|base|base-inherit)\.njk$/],
      isAsync: true,
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

export {precompileTestTemplates};
