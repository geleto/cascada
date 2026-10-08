
import fs from 'fs';
import path from 'path';
import {createRequire} from 'module';
import chokidar from 'chokidar';
import {Loader} from './loader.js';
import {PrecompiledLoader} from './precompiled-loader.js';

const resolvePackagePath = createRequire(process.cwd() + path.sep).resolve;

function isWithinPath(basePath, filename) {
  const relative = path.relative(basePath, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

class FileSystemLoader extends Loader {
  constructor(searchPaths, opts) {
    super();
    if (typeof opts === 'boolean') {
      console.error(
        '[nunjucks] Warning: you passed a boolean as the second ' +
        'argument to FileSystemLoader, but it now takes an options ' +
        'object. See http://mozilla.github.io/nunjucks/api.html#filesystemloader'
      );
    }

    opts = opts || {};
    this.pathsToNames = {};
    this.noCache = !!opts.noCache;
    this.cachePolicy = this.noCache ? 'reload' : 'cache';

    if (searchPaths) {
      searchPaths = Array.isArray(searchPaths) ? searchPaths : [searchPaths];
      // For windows, convert to forward slashes
      this.searchPaths = searchPaths.map(path.normalize);
    } else {
      this.searchPaths = ['.'];
    }

    if (opts.watch) {
      // Watch all the templates in the paths and fire an event when
      // they change
      // On Windows, ready can precede Chokidar's fallback watcher for a missing
      // root. Start at its existing ancestor and ignore unrelated sibling trees.
      const paths = [...new Set(this.searchPaths.map(searchPath => {
        let root = path.resolve(searchPath);
        while (!fs.existsSync(root)) {
          const parent = path.dirname(root);
          if (parent === root) break;
          root = parent;
        }
        return root;
      }))];
      const watcher = this.watcher = chokidar.watch(paths, {
        ignoreInitial: true,
        ignored: filename => !this.searchPaths.some(searchPath =>
          isWithinPath(searchPath, filename) || isWithinPath(filename, searchPath))
      });
      watcher.on('all', (event, fullname) => {
        fullname = path.resolve(fullname);
        if (event === 'add' || event === 'change' || event === 'unlink') {
          const names = new Set();
          for (const searchPath of this.searchPaths) {
            const relative = path.relative(path.resolve(searchPath), fullname);
            if (relative && isWithinPath(searchPath, fullname)) {
              names.add(relative.replace(/\\/g, '/'));
            }
          }
          const loadedName = this.pathsToNames[fullname];
          if (loadedName) names.add(loadedName);
          for (const name of names) this.emit('update', name, fullname);
        }
      });
      watcher.on('error', (error) => {
        console.error('Watcher error: ' + error);
      });
    }
  }

  getSource(name) {
    var fullpath = null;
    var paths = this.searchPaths;

    for (let i = 0; i < paths.length; i++) {
      const basePath = path.resolve(paths[i]);
      const p = path.resolve(paths[i], name);

      // Only allow the current directory and anything
      // underneath it to be searched
      if (isWithinPath(basePath, p) && fs.existsSync(p)) {
        fullpath = p;
        break;
      }
    }

    if (!fullpath) {
      return null;
    }

    this.pathsToNames[fullpath] = name;

    const source = {
      src: fs.readFileSync(fullpath, 'utf-8'),
      path: fullpath,
      noCache: this.noCache
    };
    this.emit('load', name, source);
    return source;
  }
}

class NodeResolveLoader extends Loader {
  constructor(opts) {
    super();
    opts = opts || {};
    this.pathsToNames = {};
    this.noCache = !!opts.noCache;
    this.cachePolicy = this.noCache ? 'reload' : 'cache';

    if (opts.watch) {
      this.watcher = chokidar.watch();

      this.watcher.on('change', (fullname) => {
        this.emit('update', this.pathsToNames[fullname], fullname);
      });
      this.watcher.on('error', (error) => {
        console.error('Watcher error: ' + error);
      });

      this.on('load', (name, source) => {
        this.watcher.add(source.path);
      });
    }
  }

  getSource(name) {
    // Don't allow file-system traversal
    if ((/^\.?\.?(\/|\\)/).test(name)) {
      return null;
    }
    if ((/^[A-Z]:/).test(name)) {
      return null;
    }

    let fullpath;

    try {
      fullpath = resolvePackagePath(name);
    } catch (e) {
      return null;
    }

    this.pathsToNames[fullpath] = name;

    const source = {
      src: fs.readFileSync(fullpath, 'utf-8'),
      path: fullpath,
      noCache: this.noCache,
    };

    this.emit('load', name, source);
    return source;
  }
}

export { FileSystemLoader, PrecompiledLoader, NodeResolveLoader };
