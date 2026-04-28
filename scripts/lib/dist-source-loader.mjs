import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = path.join(projectRoot, 'src') + path.sep;
const distRoot = path.join(projectRoot, 'dist') + path.sep;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);

  if (result.url.startsWith('file:')) {
    const filePath = path.normalize(fileURLToPath(result.url));

    if (filePath.startsWith(srcRoot)) {
      const distPath = path.join(distRoot, path.relative(srcRoot, filePath));
      return {
        ...result,
        url: pathToFileURL(distPath).href
      };
    }
  }

  return result;
}
