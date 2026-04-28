'use strict';

import fs from 'fs';
import path from 'path';
import {createRequire} from 'module';

const requireFromHere = createRequire(import.meta.url);

function lookup(relPath, isExecutable) {
  const searchPaths = requireFromHere.resolve.paths(relPath) || [];
  for (let i = 0; i < searchPaths.length; i++) {
    let absPath = path.join(searchPaths[i], relPath);
    if (isExecutable && process.platform === 'win32') {
      absPath += '.cmd';
    }
    if (fs.existsSync(absPath)) {
      return absPath;
    }
  }
  return undefined;
}

function promiseSequence(promises) {
  return new Promise((resolve, reject) => {
    var results = [];

    function iterator(prev, curr) {
      return prev.then((result) => {
        results.push(result);
        return curr(result, results);
      }).catch((err) => {
        reject(err);
      });
    }

    promises.push(() => Promise.resolve());
    promises.reduce(iterator, Promise.resolve(false)).then((res) => resolve(res));
  });
}

export default {
  lookup: lookup,
  promiseSequence: promiseSequence
};
export { lookup, promiseSequence };
