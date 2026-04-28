import fs from 'fs';
import path from 'path';
import {execFile} from 'child_process';
import expect from 'expect.js';
import {fileURLToPath} from 'url';

(function() {

  const testDir = path.dirname(fileURLToPath(import.meta.url));
  var rootDir = path.resolve(path.join(testDir, '..'));
  var precompileBin = path.join(rootDir, 'bin', 'precompile');
  var distEntry = path.join(rootDir, 'dist', 'index.js');

  function execPrecompile(args, cb) {
    execFile(process.execPath, [precompileBin, ...args], {cwd: rootDir}, cb);
  }

  // https://github.com/nodejs/node/issues/34799
  function filterDebuggerMessages(data) {
    const debuggerMessages = [
      'Debugger attached.',
      'Waiting for the debugger'
    ];
    return data.split('\n')
      .filter(line => !debuggerMessages.some(msg => line.trim().startsWith(msg)))
      .join('\n');
  }

  function expectMissingBuild(err, stdout, stderr, done) {
    expect(err).to.be.ok();
    expect(err.code).to.be(1);
    expect(stdout).to.equal('');
    expect(filterDebuggerMessages(stderr)).to.contain('Run `npm run build`');
    done();
  }

  describe('precompile cli', function() {
    it('should echo a compiled template to stdout', function(done) {
      this.timeout(18000); // execFile can be slow on Windows
      execPrecompile(['tests/templates/item.njk'], function(err, stdout, stderr) {
        if (!fs.existsSync(distEntry)) {
          expectMissingBuild(err, stdout, stderr, done);
          return;
        }
        if (err) {
          done(err);
          return;
        }
        expect(stdout).to.contain('window.nunjucksPrecompiled');
        expect(filterDebuggerMessages(stderr)).to.equal('');
        done();
      });
    });

    it('should support --name', function(done) {
      var args = [
        '--name', 'item.njk',
        'tests/templates/item.njk',
      ];
      this.timeout(18000); // execFile can be slow on Windows
      execPrecompile(args, function(err, stdout, stderr) {
        if (!fs.existsSync(distEntry)) {
          expectMissingBuild(err, stdout, stderr, done);
          return;
        }
        if (err) {
          done(err);
          return;
        }
        expect(stdout).to.contain('"item.njk"');
        expect(filterDebuggerMessages(stderr)).to.equal('');
        done();
      });
    });

    it('should support ESM output', function(done) {
      var args = [
        '--format', 'esm',
        '--name', 'item.njk',
        'tests/templates/item.njk',
      ];
      this.timeout(18000); // execFile can be slow on Windows
      execPrecompile(args, function(err, stdout, stderr) {
        if (!fs.existsSync(distEntry)) {
          expectMissingBuild(err, stdout, stderr, done);
          return;
        }
        if (err) {
          done(err);
          return;
        }
        expect(stdout).to.contain('const templates = {};');
        expect(stdout).to.contain('templates["item.njk"] =');
        expect(stdout).to.contain('export default templates;');
        expect(filterDebuggerMessages(stderr)).to.equal('');
        done();
      });
    });

    it('should support async template mode', function(done) {
      var args = [
        '--mode', 'template-async',
        '--name', 'item.njk',
        'tests/templates/item.njk',
      ];
      this.timeout(18000); // execFile can be slow on Windows
      execPrecompile(args, function(err, stdout, stderr) {
        if (!fs.existsSync(distEntry)) {
          expectMissingBuild(err, stdout, stderr, done);
          return;
        }
        if (err) {
          done(err);
          return;
        }
        expect(stdout).to.contain('function root(env, context, runtime, cb');
        expect(stdout).to.not.contain('function root(env, context, frame, runtime, cb');
        expect(filterDebuggerMessages(stderr)).to.equal('');
        done();
      });
    });

    it('should support script mode', function(done) {
      var args = [
        '--mode', 'script',
        '--name', 'precompile-script.casc',
        'tests/templates/precompile-script.casc',
      ];
      this.timeout(18000); // execFile can be slow on Windows
      execPrecompile(args, function(err, stdout, stderr) {
        if (!fs.existsSync(distEntry)) {
          expectMissingBuild(err, stdout, stderr, done);
          return;
        }
        if (err) {
          done(err);
          return;
        }
        expect(stdout).to.contain('runtime.declareBufferChannel(output, "x", "var"');
        expect(stdout).to.contain('new runtime.VarCommand');
        expect(filterDebuggerMessages(stderr)).to.equal('');
        done();
      });
    });

    it('should reject invalid mode', function(done) {
      var args = [
        '--mode', 'nope',
        'tests/templates/item.njk',
      ];
      this.timeout(18000); // execFile can be slow on Windows
      execPrecompile(args, function(err, stdout, stderr) {
        if (!fs.existsSync(distEntry)) {
          expectMissingBuild(err, stdout, stderr, done);
          return;
        }
        expect(err).to.be.ok();
        expect(err.code).to.be(1);
        expect(stdout).to.equal('');
        expect(filterDebuggerMessages(stderr)).to.contain('Invalid precompile mode "nope"');
        done();
      });
    });
  });
}());
