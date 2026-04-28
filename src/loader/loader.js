
import path from 'path';
import {EmitterObj} from '../object.js';

class Loader extends EmitterObj {
  resolve(from, to) {
    return path.resolve(path.dirname(from), to);
  }

  isRelative(filename) {
    return (filename.indexOf('./') === 0 || filename.indexOf('../') === 0);
  }
};

export {Loader};
