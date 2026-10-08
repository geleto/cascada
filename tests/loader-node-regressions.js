import fs from 'fs';
import os from 'os';
import path from 'path';
import {spawnSync} from 'child_process';
import expect from 'expect.js';
import {Environment, AsyncEnvironment} from '../src/index.js';
import {NodeResolveLoader, PrecompiledLoader} from '../src/loader/node-loaders.js';

describe('Node loader regressions', function() {
  describe('NodeResolveLoader path guards', function() {
    it('loads linked and scoped packages with normal subpaths', function() {
      const loader = new NodeResolveLoader();
      for (const name of [
        'dummy-pkg/simple-template.html',
        'dummy-pkg/./simple-template.html'
      ]) {
        expect(loader.getSource(name).src).to.be('{{ foo }}');
      }
      expect(JSON.parse(loader.getSource('@babel/core/package.json').src).name).to.be('@babel/core');
      expect(JSON.parse(loader.getSource('@babel/./core/package.json').src).name).to.be('@babel/core');
      expect(loader.getSource('chokidar').src).to.be.a('string');
    });

    it('loads extensionless single-file modules from node_modules', function() {
      const temporary = fs.mkdtempSync(path.join(process.cwd(), 'node_modules/cascada-loader-'));
      fs.rmdirSync(temporary);
      const filename = temporary + '..template.js';
      try {
        fs.writeFileSync(filename, 'single file template');
        expect(new NodeResolveLoader().getSource(path.basename(temporary) + '..template').src).to.be('single file template');
      } finally {
        if (fs.existsSync(filename)) fs.unlinkSync(filename);
      }
    });

    it('preserves exported self-references from the original package scope', function() {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cascada-loader-self-'));
      const nested = path.join(fixture, 'work');
      const loaderPath = process.env.CASCADA_TEST_DIST === '1'
        ? '../dist/loader/node-loaders.js' : '../src/loader/node-loaders.js';
      const loaderUrl = new URL(loaderPath, import.meta.url).href;
      const childEnv = {...process.env};
      delete childEnv.NODE_OPTIONS;
      try {
        fs.mkdirSync(nested);
        fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
          name: 'cascada-loader-self-fixture',
          exports: {'.': './view.html', './view': './view.html'}
        }));
        fs.writeFileSync(path.join(fixture, 'view.html'), 'SELF');

        const code = `
          import {createRequire} from 'module';
          import path from 'path';
          import {NodeResolveLoader} from ${JSON.stringify(loaderUrl)};
          const req = createRequire(process.cwd() + path.sep);
          const loader = new NodeResolveLoader();
          process.chdir(${JSON.stringify(process.cwd())});
          const names = ['cascada-loader-self-fixture', 'cascada-loader-self-fixture/view'];
          const resolved = names.map(name => req.resolve(name));
          const sources = names.map(name => loader.getSource(name)?.src);
          const privateSource = loader.getSource('cascada-loader-self-fixture/package.json');
          process.stdout.write(JSON.stringify({resolved, sources, privateSource}));
        `;
        for (const cwd of [fixture, nested]) {
          const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            cwd, env: childEnv, encoding: 'utf8'
          });
          expect(result.status).to.be(0);
          expect(result.stderr).to.be('');
          const output = JSON.parse(result.stdout);
          expect(output.resolved).to.eql([path.join(fixture, 'view.html'), path.join(fixture, 'view.html')]);
          expect(output.sources).to.eql(['SELF', 'SELF']);
          expect(output.privateSource).to.be(null);
        }
      } finally {
        for (const filename of ['package.json', 'view.html']) {
          const filepath = path.join(fixture, filename);
          if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        }
        if (fs.existsSync(nested)) fs.rmdirSync(nested);
        fs.rmdirSync(fixture);
      }
    });

    it('rejects every parent-directory segment on either separator', function() {
      const loader = new NodeResolveLoader();
      const loaded = [];
      loader.on('load', name => loaded.push(name));
      for (const name of [
        'dummy-pkg/../../package.json',
        'dummy-pkg/../chokidar/package.json',
        'dummy-pkg/nested/../simple-template.html',
        'dummy-pkg/nested\\..\\simple-template.html',
        'dummy-pkg/nested/..\\simple-template.html',
        '@babel/core/../../../package.json',
        '@babel/../chokidar/package.json',
        'dummy-pkg/..',
        '../package.json',
        '..\\package.json',
        './package.json',
        '.\\package.json',
        'dummy-pkg/does-not-exist.html'
      ]) {
        expect(loader.getSource(name)).to.be(null);
      }
      expect(loaded).to.eql([]);
    });

    it('rejects absolute and drive-relative paths regardless of platform or drive case', function() {
      const loader = new NodeResolveLoader();
      const fullpath = loader.getSource('dummy-pkg/simple-template.html').path;
      for (const name of [
        fullpath,
        fullpath.replace(/^[A-Z]:/, drive => drive.toLowerCase()),
        path.resolve('package.json'),
        '/tmp/template.html',
        'c:\\template.html',
        'C:\\template.html',
        'c:template.html',
        '\\\\server\\share\\template.html'
      ]) {
        expect(loader.getSource(name)).to.be(null);
      }
    });

    it('initializes watch mode and watches sources loaded afterward', async function() {
      const loader = new NodeResolveLoader({watch: true});
      try {
        const added = [];
        const add = loader.watcher.add.bind(loader.watcher);
        loader.watcher.add = filename => {
          added.push(filename);
          return add(filename);
        };
        const source = loader.getSource('dummy-pkg/simple-template.html');
        expect(added).to.eql([source.path]);
        const updates = [];
        loader.on('update', (name, filename) => updates.push([name, filename]));
        loader.watcher.emit('change', source.path);
        expect(updates).to.eql([['dummy-pkg/simple-template.html', source.path]]);
      } finally {
        await loader.watcher.close();
      }
    });
  });

  describe('PrecompiledLoader own properties', function() {
    it('ignores inherited names and allows synchronous and async fallbacks', async function() {
      const loader = new PrecompiledLoader({});
      const sync = new Environment([loader, name => 'fallback ' + name]);
      const asyncEnv = new AsyncEnvironment([loader, name => 'fallback ' + name]);
      for (const name of ['toString', 'constructor', '__proto__']) {
        expect(loader.getSource(name)).to.be(null);
        expect(sync.renderTemplate(name)).to.be('fallback ' + name);
        expect(await asyncEnv.renderTemplate(name)).to.be('fallback ' + name);
      }
    });

    it('loads own entries whose names also exist on Object.prototype', function() {
      const compiled = {root() {}};
      const templates = Object.create(null);
      for (const name of ['toString', 'constructor', '__proto__']) {
        templates[name] = compiled;
        const source = new PrecompiledLoader(templates).getSource(name);
        expect(source.path).to.be(name);
        expect(source.src.obj).to.be(compiled);
      }
    });

    it('ignores template objects inherited from a custom prototype', function() {
      const inherited = {root() {}};
      const loader = new PrecompiledLoader(Object.create({inherited}));
      expect(loader.getSource('inherited')).to.be(null);
    });
  });
});
