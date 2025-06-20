(function() {
  'use strict';

  var path = require('path');
  var execFile = require('child_process').execFile;
  var expect = require('expect.js');

  var rootDir = path.resolve(path.join(__dirname, '..'));
  var precompileBin = path.join(rootDir, 'bin', 'precompile');

  if (process.platform === 'win32') {
    precompileBin += '.cmd';
  }

  function execPrecompile(args, cb) {
    const isWindows = process.platform === 'win32';
    execFile(precompileBin, args, {cwd: rootDir, shell: isWindows}, cb);
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

  describe('precompile cli', function() {
    it('should echo a compiled template to stdout', function(done) {
      this.timeout(18000); // execFile can be slow on Windows
      execPrecompile(['tests/templates/item.njk'], function(err, stdout, stderr) {
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
        if (err) {
          done(err);
          return;
        }
        expect(stdout).to.contain('"item.njk"');
        expect(filterDebuggerMessages(stderr)).to.equal('');
        done();
      });
    });
  });
}());
