import {fileURLToPath} from 'url';
import path from 'path';

export default function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
};
