(function () {
  'use strict';

  var expect,
    Environment,
    AsyncEnvironment,
    WebLoader,
    FileSystemLoader,
    NodeResolveLoader,
    templatesPath,
    StringLoader,
    loadString,
    clearStringCache,
    raceLoaders,
    precompileTemplateString,
    precompileScriptString,
    Template,
    delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    Environment = require('../src/environment').Environment;
    AsyncEnvironment = require('../src/environment').AsyncEnvironment;
    WebLoader = require('../src/loader/web-loaders').WebLoader;
    FileSystemLoader = require('../src/loader/node-loaders').FileSystemLoader;
    NodeResolveLoader = require('../src/loader/node-loaders').NodeResolveLoader;
    templatesPath = 'tests/templates';
    StringLoader = require('./util').StringLoader;
    loadString = require('../src/index').loadString;
    clearStringCache = require('../src/index').clearStringCache;
    raceLoaders = require('../src/index').raceLoaders;
    precompileTemplateString = require('../src/index').precompileTemplateString;
    precompileScriptString = require('../src/index').precompileScriptString;
    Template = require('../src/environment').Template;
    delay = require('./util').delay;
  } else {
    expect = window.expect;
    Environment = nunjucks.Environment;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    WebLoader = nunjucks.WebLoader;
    FileSystemLoader = nunjucks.FileSystemLoader;
    NodeResolveLoader = nunjucks.NodeResolveLoader;
    templatesPath = '../templates',
    StringLoader = window.util.StringLoader;
    loadString = nunjucks.loadString;
    clearStringCache = nunjucks.clearStringCache;
    raceLoaders = nunjucks.raceLoaders;
    precompileTemplateString = nunjucks.precompileTemplateString;
    precompileScriptString = nunjucks.precompileScriptString;
    Template = nunjucks.Template;
    delay = window.util.delay;
  }

  describe('loader', function() {
    it('should allow a simple loader to be created', function() {
      // From Docs: http://mozilla.github.io/nunjucks/api.html#writing-a-loader
      // We should be able to create a loader that only exposes getSource
      var env, parent;

      function MyLoader() {
        // configuration
      }

      MyLoader.prototype.getSource = function() {
        return {
          src: 'Hello World',
          path: '/tmp/somewhere'
        };
      };

      env = new Environment(new MyLoader(templatesPath));
      parent = env.getTemplate('fake.njk');
      expect(parent.render()).to.be('Hello World');
    });

    it('should catch loader error', function(done) {
      // From Docs: http://mozilla.github.io/nunjucks/api.html#writing-a-loader
      // We should be able to create a loader that only exposes getSource
      var env;

      function MyLoader() {
        // configuration
        this.async = true;
      }

      MyLoader.prototype.getSource = function(s, cb) {
        setTimeout(function() {
          cb(new Error('test'));
        }, 1);
      };

      env = new Environment(new MyLoader(templatesPath));
      env.getTemplate('fake.njk', function(err, parent) {
        expect(err).to.be.a(Error);
        expect(parent).to.be(undefined);

        done();
      });
    });

    describe('WebLoader', function() {
      it('should have default opts for WebLoader', function() {
        var webLoader = new WebLoader(templatesPath);
        expect(webLoader).to.be.a(WebLoader);
        expect(webLoader.useCache).to.be(false);
        expect(webLoader.async).to.be(false);
      });

      it('should emit a "load" event', function(done) {
        var loader = new WebLoader(templatesPath);

        if (typeof window === 'undefined') {
          this.skip();
        }

        loader.on('load', function(name, source) {
          expect(name).to.equal('simple-base.njk');
          done();
        });

        loader.getSource('simple-base.njk');
      });
    });

    if (typeof FileSystemLoader !== 'undefined') {
      describe('FileSystemLoader', function() {
        it('should have default opts', function() {
          var loader = new FileSystemLoader(templatesPath);
          expect(loader).to.be.a(FileSystemLoader);
          expect(loader.noCache).to.be(false);
        });

        it('should emit a "load" event', function(done) {
          var loader = new FileSystemLoader(templatesPath);
          loader.on('load', function(name, source) {
            expect(name).to.equal('simple-base.njk');
            done();
          });

          loader.getSource('simple-base.njk');
        });
      });
    }

    if (typeof NodeResolveLoader !== 'undefined') {
      describe('NodeResolveLoader', function() {
        it('should have default opts', function() {
          var loader = new NodeResolveLoader();
          expect(loader).to.be.a(NodeResolveLoader);
          expect(loader.noCache).to.be(false);
        });

        it('should emit a "load" event', function(done) {
          var loader = new NodeResolveLoader();
          loader.on('load', function(name, source) {
            expect(name).to.equal('dummy-pkg/simple-template.html');
            done();
          });

          loader.getSource('dummy-pkg/simple-template.html');
        });

        it('should render templates', function() {
          var env = new Environment(new NodeResolveLoader());
          var tmpl = env.getTemplate('dummy-pkg/simple-template.html');
          expect(tmpl.render({foo: 'foo'})).to.be('foo');
        });

        it('should not allow directory traversal', function() {
          var loader = new NodeResolveLoader();
          var dummyPkgPath = require.resolve('dummy-pkg/simple-template.html');
          expect(loader.getSource(dummyPkgPath)).to.be(null);
        });

        it('should return null if no match', function() {
          var loader = new NodeResolveLoader();
          var tmplName = 'dummy-pkg/does-not-exist.html';
          expect(loader.getSource(tmplName)).to.be(null);
        });
      });
    }
  });

  describe('scoping rules verification', function() {
    /*
        Corrected Scoping Rules Summary Table:
        | Operation            | Read Parent Frame | Modify Parent Frame | Read Parent Context |
        |----------------------|-------------------|---------------------|---------------------|
        | include              | Yes               | No                  | Yes (copy)          |
        | import               | No                | No                  | No                  |
        | import with context  | Yes               | Yes                 | Yes (copy)          |
        | extends/block        | Yes (shared)      | Yes (top-level)     | Yes (shared)        |
        | (inside block)       | Yes (shared)      | No (isolated)       | Yes (shared)        |
    */

    var env;
    var loader;

    beforeEach(function() {
      loader = new StringLoader();
      env = new Environment(loader);
    });

    describe('include', function() {
      it('should read parent frame and context vars but not modify parent frame', function() {
        loader.addTemplate('parent.njk',
          '{% set frameVar = "parent" %}' +
          '{{ contextVar }}|' +
          '{% include "child.njk" %}|' +
          '{{ frameVar }}'
        );
        loader.addTemplate('child.njk',
          '{{ frameVar }}-{{ contextVar }}' +
          '{% set frameVar = "child" %}'
        );

        let result = env.render('parent.njk', { contextVar: 'context' });
        // 1. Reads parent context var ("context")
        // 2. Child reads parent frame var ("parent") and context var ("context")
        // 3. Child's `set` is isolated and does not change parent's `frameVar`
        expect(result).to.be('context|parent-context|parent');
      });
    });

    describe('import', function() {
      it('should NOT read or modify parent frame/context vars', function() {
        loader.addTemplate('parent.njk',
          '{% set myVar = "parent" %}' +
          '{{ myVar }}|' +
          // The imported template attempts to read and modify myVar, but it can't
          // because it gets a new, disconnected frame.
          '{% import "child.njk" as child %}|' +
          '{{ myVar }}'
        );
        loader.addTemplate('child.njk',
          '{% set myVar = "child" %}'
        );

        let result = env.render('parent.njk');
        expect(result).to.be('parent||parent');
      });
    });

    describe('import with context', function() {
      it('should read parent context vars and read/modify parent frame vars', function() {
        loader.addTemplate('parent.njk',
          '{% set frameVar = "parent" %}' +
          '{{ contextVar }}|' +
          '{% import "child.njk" as child with context %}|' +
          // The parent's frameVar should now be modified by the import
          '{{ frameVar }}'
        );
        loader.addTemplate('child.njk',
          // Reads parent context var and modifies parent frame var
          '{% set frameVar = "child_from_" + contextVar %}'
        );

        let result = env.render('parent.njk', { contextVar: 'context' });
        // 1. Reads parent context var ("context").
        // 2. `import` produces no output.
        // 3. `with context` allows child to read context vars AND modify parent frame.
        expect(result).to.be('context||child_from_context');
      });
    });

    describe('extends/block', function() {
      it('should allow child top-level set to modify shared variables', function() {
        loader.addTemplate('base.njk',
          '{{ myVar }}'
        );
        loader.addTemplate('child.njk',
          '{% extends "base.njk" %}' +
          '{% set myVar = "child_toplevel" %}'
        );

        let result = env.render('child.njk');
        expect(result).to.be('child_toplevel');
      });

      it('should isolate set within a block from affecting other scopes', function() {
        loader.addTemplate('base.njk',
          '{% set myVar = "base" %}' +
          '{% block b1 %}{% endblock %}|' +
          '{{ myVar }}'
        );
        loader.addTemplate('child.njk',
          '{% extends "base.njk" %}' +
          '{% block b1 %}{% set myVar = "child_block" %}{% endblock %}'
        );

        let result = env.render('child.njk');
        // 1. `set` inside child block `b1` is isolated by a `frame.push(true)`.
        // 2. It does not modify `myVar` in the shared/base scope.
        // 3. The final output of `myVar` is still "base".
        expect(result).to.be('|base');
      });

      it('should read all shared variables', function() {
        loader.addTemplate('base.njk',
          '{% set frameVar = "base" %}' +
          '{% block content %}{% endblock %}'
        );
        loader.addTemplate('child.njk',
          '{% extends "base.njk" %}' +
          '{% block content %}{{ contextVar }}-{{ frameVar }}{% endblock %}'
        );

        let result = env.render('child.njk', { contextVar: 'context' });
        expect(result).to.be('context-base');
      });
    });

    describe('scoping rules verification', function() {
      /*
          Scoping Rules Summary Table:
          | Operation            | Read Parent Frame | Modify Parent Frame | Read Parent Context |
          |----------------------|-------------------|---------------------|---------------------|
          | include              | Yes               | No                  | Yes (copy)          |
          | import               | No                | No                  | No                  |
          | import with context  | Yes               | Yes                 | Yes (copy)          |
          | extends/block        | Yes (shared)      | Yes(child-top-level)| Yes (shared)        |
          | (inside block)       | Yes (shared)      | No (isolated)       | Yes (shared)        |
      */

      beforeEach(function() {
        loader = new StringLoader();
        env = new Environment(loader);
      });

      describe('include', function() {
        it('should read parent frame and context vars but not modify parent frame', function() {
          loader.addTemplate('parent.njk',
            '{% set frameVar = "parent" %}' +
            '{{ contextVar }}|' +
            '{% include "child.njk" %}|' +
            '{{ frameVar }}'
          );
          loader.addTemplate('child.njk',
            '{{ frameVar }}-{{ contextVar }}' +
            '{% set frameVar = "child" %}'
          );
          let result = env.render('parent.njk', { contextVar: 'context' });
          expect(result).to.be('context|parent-context|parent');
        });
      });

      describe('import', function() {
        it('should NOT read or modify parent frame/context, but CAN read its own top-level vars', function() {
          loader.addTemplate('parent.njk',
            '{% set parentFrameVar = "parent" %}' +
            '{% import "child.njk" as child %}' +
            // The macro call proves that it CANNOT read the parent's frame or context vars.
            'read_parent_frame:{{ child.readParentFrame() }}|' +
            // The macro call proves that it CAN read its own defining file's top-level vars.
            'read_own_frame:{{ child.readOwnFrame() }}|' +
            // This proves the import did not modify the parent's frame.
            'after_import:{{ parentFrameVar }}'
          );
          loader.addTemplate('child.njk',
            // This `set` is in a disconnected frame and is only visible to the macro below.
            '{% set childFrameVar = "child" %}' +
            '{% macro readParentFrame() %}{{ parentFrameVar }}{% endmacro %}' +
            '{% macro readOwnFrame() %}{{ childFrameVar }}{% endmacro %}'
          );
          let result = env.render('parent.njk', { contextVar: 'context' });
          expect(result).to.be('read_parent_frame:|read_own_frame:child|after_import:parent');
        });
      });

      describe('import with context', function() {
        it('should read parent context vars and read/modify parent frame vars', function() {
          loader.addTemplate('parent.njk',
            '{% set frameVar = "parent" %}' +
            '{{ contextVar }}|' +
            '{% import "child.njk" as child with context %}|' +
            // The parent's frameVar should now be modified by the import
            '{{ frameVar }}'
          );
          loader.addTemplate('child.njk',
            // Reads parent context var and modifies parent frame var
            '{% set frameVar = "child_from_" + contextVar %}'
          );
          let result = env.render('parent.njk', { contextVar: 'context' });
          expect(result).to.be('context||child_from_context');
        });
      });

      describe('extends/block', function() {
        it('should allow child top-level set to modify shared variables', function() {
          loader.addTemplate('base.njk',
            '{{ myVar }}'
          );
          loader.addTemplate('child.njk',
            '{% extends "base.njk" %}' +
            '{% set myVar = "child_toplevel" %}'
          );
          let result = env.render('child.njk');
          expect(result).to.be('child_toplevel');
        });

        it('should isolate set within a block from affecting other scopes', function() {
          loader.addTemplate('base.njk',
            '{% set myVar = "base" %}' +
            '{% block b1 %}{% endblock %}|' +
            '{{ myVar }}'
          );
          loader.addTemplate('child.njk',
            '{% extends "base.njk" %}' +
            '{% block b1 %}{% set myVar = "child_block" %}{% endblock %}'
          );
          let result = env.render('child.njk');
          expect(result).to.be('|base');
        });

        it('should read all shared variables', function() {
          loader.addTemplate('base.njk',
            '{% set frameVar = "base" %}' +
            '{% block content %}{% endblock %}'
          );
          loader.addTemplate('child.njk',
            '{% extends "base.njk" %}' +
            '{% block content %}{{ contextVar }}-{{ frameVar }}{% endblock %}'
          );
          let result = env.render('child.njk', { contextVar: 'context' });
          expect(result).to.be('context-base');
        });
      });
    });
  });


  describe('string loading utilities', function () {
    var loader1, loader2;

    // Helper function to handle both sync and async loadString results
    function handleLoadStringResult(result, callback) {
      if (result instanceof Promise) {
        result.then(function(content) {
          callback(null, content);
        }).catch(function(error) {
          callback(error, null);
        });
      } else {
        try {
          callback(null, result);
        } catch (error) {
          callback(error, null);
        }
      }
    }

    // Helper function to handle multiple loadString results
    function handleMultipleLoadStringResults(results, callback) {
      const promises = results.map(result => {
        if (result instanceof Promise) {
          return result;
        } else {
          return Promise.resolve(result);
        }
      });

      Promise.all(promises).then(callback).catch(callback);
    }

    beforeEach(function () {
      // Clear any existing cache
      if (typeof clearStringCache !== 'undefined') {
        // Create a simple test loader that works in both Node.js and browser
        function TestLoader() {}
        TestLoader.prototype.getSource = function(name) {
          // Return some test content for common template names
          if (name === 'simple-base.njk') {
            return {
              src: '{% block content %}Hello World{% endblock %}',
              path: 'simple-base.njk',
              noCache: false
            };
          }
          if (name === 'base.njk') {
            return {
              src: '{% extends "simple-base.njk" %}{% block content %}Extended{% endblock %}',
              path: 'base.njk',
              noCache: false
            };
          }
          return null;
        };

        loader1 = new TestLoader();
        loader2 = new TestLoader();
      }
    });

    it('should load a string from a single loader', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      const result = loadString('simple-base.njk', loader1);

      handleLoadStringResult(result, function (err, content) {
        if (err) return done(err);
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        expect(content).to.contain('Hello World');
        done();
      });
    });

    it('should load a string from an array of loaders', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      const result = loadString('simple-base.njk', [loader1, loader2]);

      handleLoadStringResult(result, function (err, content) {
        if (err) return done(err);
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        done();
      });
    });

    it('should cache loaded strings', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      const firstResult = loadString('simple-base.njk', loader1);

      handleLoadStringResult(firstResult, function (err, content) {
        if (err) return done(err);
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);

        // Load the same string again - should come from cache
        const secondResult = loadString('simple-base.njk', loader1);
        handleLoadStringResult(secondResult, function (err2, content2) {
          if (err2) return done(err2);
          expect(content2).to.be.a('string');
          expect(content2.length).to.be.greaterThan(0);
          // Second load should work (cached)
          done();
        });
      });
    });

    it('should handle multiple loaders with separate string caches', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      const results = [
        loadString('simple-base.njk', loader1),
        loadString('base.njk', loader1),
        loadString('simple-base.njk', loader2)
      ];

      handleMultipleLoadStringResults(results, function (resultsArray) {
        expect(resultsArray).to.have.length(3);
        expect(resultsArray[0]).to.be.a('string');
        expect(resultsArray[1]).to.be.a('string');
        expect(resultsArray[2]).to.be.a('string');
        // All should load successfully, indicating separate caches work
        done();
      });
    });

    it('should clear specific string from cache', function (done) {
      if (typeof loadString === 'undefined' || typeof clearStringCache === 'undefined') {
        this.skip();
        return;
      }

      const firstResult = loadString('simple-base.njk', loader1);

      handleLoadStringResult(firstResult, function (err) {
        if (err) return done(err);

        const secondResult = loadString('base.njk', loader1);
        handleLoadStringResult(secondResult, function (err2) {
          if (err2) return done(err2);

          clearStringCache(loader1, 'simple-base.njk');
          // Load the cleared resource again - should reload from source
          const thirdResult = loadString('simple-base.njk', loader1);
          handleLoadStringResult(thirdResult, function (err3, content) {
            if (err3) return done(err3);
            expect(content).to.be.a('string');
            expect(content.length).to.be.greaterThan(0);
            done();
          });
        });
      });
    });

    it('should clear all strings from a loader', function (done) {
      if (typeof loadString === 'undefined' || typeof clearStringCache === 'undefined') {
        this.skip();
        return;
      }

      const initialResults = [
        loadString('simple-base.njk', loader1),
        loadString('base.njk', loader1),
        loadString('simple-base.njk', loader2)
      ];

      handleMultipleLoadStringResults(initialResults, function () {
        clearStringCache(loader1);
        // Load resources from loader1 again - should reload from source
        const reloadResults = [
          loadString('simple-base.njk', loader1),
          loadString('base.njk', loader1)
        ];

        handleMultipleLoadStringResults(reloadResults, function (results) {
          expect(results).to.have.length(2);
          expect(results[0]).to.be.a('string');
          expect(results[1]).to.be.a('string');
          done();
        });
      });
    });

    it('should handle missing strings gracefully', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      try {
        const result = loadString('nonexistent-file.njk', loader1);
        // If we get here, it's either a Promise (async) or a successful result (sync)
        if (result instanceof Promise) {
          // Async case - handle with Promise
          result.then(function() {
            done(new Error('Should have thrown an error'));
          }).catch(function(err) {
            expect(err.message).to.contain('Resource \'nonexistent-file.njk\' not found in any loader');
            done();
          });
        } else {
          // Sync case - if we got a result, it means no error was thrown
          done(new Error('Should have thrown an error'));
        }
      } catch (error) {
        // Sync case - error was thrown synchronously
        expect(error.message).to.contain('Resource \'nonexistent-file.njk\' not found in any loader');
        done();
      }
    });

    it('should respect noCache flag from loader source', function (done) {
      var noCacheLoader;
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      // Create a custom loader that returns noCache: true
      function NoCacheLoader() { }
      NoCacheLoader.prototype.getSource = function (name) {
        if (name === 'test-no-cache.njk') {
          return {
            src: 'test content',
            path: 'test-no-cache.njk',
            noCache: true
          };
        }
        return null;
      };

      noCacheLoader = new NoCacheLoader();
      const firstResult = loadString('test-no-cache.njk', noCacheLoader);

      handleLoadStringResult(firstResult, function (err, content) {
        if (err) return done(err);
        expect(content).to.be('test content');

        // Load the same resource again - should reload since noCache is true
        const secondResult = loadString('test-no-cache.njk', noCacheLoader);
        handleLoadStringResult(secondResult, function (err2, content2) {
          if (err2) return done(err2);
          expect(content2).to.be('test content');
          done();
        });
      });
    });

    it('should work with async loaders', function (done) {
      var asyncLoader;
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      // Create a custom async loader
      function AsyncTestLoader() {
        this.async = true;
      }
      AsyncTestLoader.prototype.getSource = function (name, callback) {
        if (name === 'async-test.njk') {
          setTimeout(function () {
            callback(null, {
              src: 'async content',
              path: 'async-test.njk',
              noCache: false
            });
          }, 10);
        } else {
          callback(null, null);
        }
      };

      asyncLoader = new AsyncTestLoader();
      const result = loadString('async-test.njk', asyncLoader);

      handleLoadStringResult(result, function (err, content) {
        if (err) return done(err);
        expect(content).to.be('async content');
        done();
      });
    });

    it('should handle loader errors properly', function (done) {
      var errorLoader;
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      // Create a loader that throws an error for specific files
      function ErrorLoader() { }
      ErrorLoader.prototype.getSource = function (name) {
        if (name === 'simple-base.njk') {
          throw new Error('Loader error');
        }
        return null;
      };

      errorLoader = new ErrorLoader();
      const result = loadString('simple-base.njk', [errorLoader, loader1]);
      handleLoadStringResult(result, function (err, content) {
        if (err) return done(err);
        // Should fall back to the second loader
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        done();
      });
    });
  });

  describe('New Loader Types', function() {
    describe('Function-based Loaders', function() {
      it('should work with synchronous function loader', function() {
        var env, template;

        // Create a synchronous function loader
        function syncFunctionLoader(name) {
          if (name === 'test.njk') {
            return 'Hello from sync function loader!';
          }
          return null;
        }

        env = new Environment([syncFunctionLoader]);
        template = env.getTemplate('test.njk');
        expect(template.render()).to.be('Hello from sync function loader!');
      });

      it('should work with asynchronous function loader', function(done) {
        var env;

        // Create an asynchronous function loader
        function asyncFunctionLoader(name) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              if (name === 'async-test.njk') {
                resolve('Hello from async function loader!');
              } else {
                resolve(null);
              }
            }, 10);
          });
        }

        env = new Environment([asyncFunctionLoader]);
        env.getTemplate('async-test.njk', function(err, template) {
          expect(err).to.be(null);
          expect(template.render()).to.be('Hello from async function loader!');
          done();
        });
      });

      it('should work with function loader in loadString', function(done) {
        var result;

        if (typeof loadString === 'undefined') {
          this.skip();
          return;
        }

        function testFunctionLoader(name) {
          if (name === 'function-test.njk') {
            return 'Function loader content';
          }
          return null;
        }

        result = loadString('function-test.njk', testFunctionLoader);
        if (result && typeof result.then === 'function') {
          result.then(function(content) {
            expect(content).to.be('Function loader content');
            done();
          }).catch(done);
        } else {
          expect(result).to.be('Function loader content');
          done();
        }
      });

      it('should accept LoaderSource from function loader and respect noCache', function(done) {
        var calls = 0, r1, r2;
        if (typeof loadString === 'undefined') {
          this.skip();
          return;
        }
        function fn(name) {
          if (name === 'fn-nocache.njk') {
            calls++;
            return { src: 'FN-' + calls, path: name, noCache: true };
          }
          return null;
        }

        r1 = loadString('fn-nocache.njk', fn);
        r2 = loadString('fn-nocache.njk', fn);

        function toPromise(v) { return (v && typeof v.then === 'function') ? v : Promise.resolve(v); }
        Promise.all([toPromise(r1), toPromise(r2)]).then(function(res) {
          expect(res[0]).to.be('FN-1');
          expect(res[1]).to.be('FN-2');
          expect(calls).to.be(2);
          done();
        }).catch(done);
      });
    });

    describe('Class-based Loaders (LoaderInterface)', function() {
      it('should work with synchronous class loader', function() {
        var env, template;

        // Create a synchronous class loader
        function SyncClassLoader() {}
        SyncClassLoader.prototype.load = function(name) {
          if (name === 'class-test.njk') {
            return 'Hello from sync class loader!';
          }
          return null;
        };

        env = new Environment([new SyncClassLoader()]);
        template = env.getTemplate('class-test.njk');
        expect(template.render()).to.be('Hello from sync class loader!');
      });

      it('should work with asynchronous class loader', function(done) {
        var env;

        // Create an asynchronous class loader
        function AsyncClassLoader() {}
        AsyncClassLoader.prototype.load = function(name) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              if (name === 'async-class-test.njk') {
                resolve('Hello from async class loader!');
              } else {
                resolve(null);
              }
            }, 10);
          });
        };

        env = new Environment([new AsyncClassLoader()]);
        env.getTemplate('async-class-test.njk', function(err, template) {
          expect(err).to.be(null);
          expect(template.render()).to.be('Hello from async class loader!');
          done();
        });
      });

      it('should work with class loader in loadString', function(done) {
        var result;

        if (typeof loadString === 'undefined') {
          this.skip();
          return;
        }

        function TestClassLoader() {}
        TestClassLoader.prototype.load = function(name) {
          if (name === 'class-loadstring-test.njk') {
            return 'Class loader content';
          }
          return null;
        };

        result = loadString('class-loadstring-test.njk', new TestClassLoader());
        if (result && typeof result.then === 'function') {
          result.then(function(content) {
            expect(content).to.be('Class loader content');
            done();
          }).catch(done);
        } else {
          expect(result).to.be('Class loader content');
          done();
        }
      });

      it('should respect LoaderSource.noCache for class loader', function() {
        var env, callCount = 0, t1, t2;

        function NoCacheClassLoader() {}
        NoCacheClassLoader.prototype.load = function(name) {
          if (name === 'nocache-class.njk') {
            callCount++;
            return { src: 'Class #' + callCount, path: name, noCache: true };
          }
          return null;
        };

        env = new Environment([new NoCacheClassLoader()]);
        t1 = env.getTemplate('nocache-class.njk');
        expect(t1.render()).to.be('Class #1');

        // Because noCache is true, the next call should invoke the loader again
        t2 = env.getTemplate('nocache-class.njk');
        expect(t2.render()).to.be('Class #2');
        expect(callCount).to.be(2);
      });
    });

    describe('Resolution and events for LoaderInterface', function() {
      it('should resolve relative includes and emit update events', function() {
        var loader, parentName, childName, env, updated, tmpl, tmpl2;
        updated = false;

        function MapLoader(base) {
          this.base = base || '';
          this.map = {};
          this._listeners = {};
        }
        MapLoader.prototype.on = function(event, handler) {
          (this._listeners[event] = this._listeners[event] || []).push(handler);
        };
        MapLoader.prototype.emit = function(event) {
          var args = Array.prototype.slice.call(arguments, 1);
          var list = this._listeners[event] || [];
          var i;
          for (i = 0; i < list.length; i++) {
            list[i].apply(this, args);
          }
        };
        MapLoader.prototype.isRelative = function(name) {
          return name.indexOf('./') === 0 || name.indexOf('../') === 0;
        };
        MapLoader.prototype.resolve = function(from, to) {
          // Return a normalized relative path like 'dir/child.njk'
          var base = from.replace(/[^\/]+$/, ''); // strip filename, keep trailing slash
          var combined = (base + to).replace(/\\/g, '/');
          var parts = [];
          combined.split('/').forEach(function(seg) {
            if (!seg || seg === '.') return;
            if (seg === '..') parts.pop(); else parts.push(seg);
          });
          return parts.join('/');
        };
        MapLoader.prototype.load = function(name) {
          var value, src;
          if (this.map[name]) {
            value = this.map[name];
            src = { src: value, path: name, noCache: false };
            this.emit('load', name, src);
            return src;
          }
          return null;
        };

        loader = new MapLoader();
        parentName = 'dir/parent.njk';
        childName = 'dir/child.njk';
        loader.map[parentName] = '{% include "./child.njk" %}';
        loader.map[childName] = 'CHILD';

        env = new Environment([loader]);
        env.on('update', function(name) {
          if (name === parentName) updated = true;
        });

        tmpl = env.getTemplate(parentName);
        expect(tmpl.render()).to.be('CHILD');

        // Update the parent; environment should observe the event
        loader.map[parentName] = 'X{% include "./child.njk" %}';
        loader.emit('update', parentName, parentName);

        // Re-fetch and render should reflect the update
        tmpl2 = env.getTemplate(parentName);
        expect(tmpl2.render()).to.be('XCHILD');
        expect(updated).to.be(true);
      });
    });

    describe('Mixed Loader Types', function() {
      it('should work with mixed loader types in Environment', function() {
        var env, template;

        // Function loader
        function functionLoader(name) {
          if (name === 'mixed-test.njk') {
            return 'From function loader';
          }
          return null;
        }

        // Class loader
        function ClassLoader() {}
        ClassLoader.prototype.load = function(name) {
          if (name === 'mixed-test2.njk') {
            return 'From class loader';
          }
          return null;
        };

        // Legacy loader
        function LegacyLoader() {}
        LegacyLoader.prototype.getSource = function(name) {
          if (name === 'mixed-test3.njk') {
            return { src: 'From legacy loader', path: name, noCache: false };
          }
          return null;
        };

        env = new Environment([functionLoader, new ClassLoader(), new LegacyLoader()]);

        template = env.getTemplate('mixed-test.njk');
        expect(template.render()).to.be('From function loader');

        template = env.getTemplate('mixed-test2.njk');
        expect(template.render()).to.be('From class loader');

        template = env.getTemplate('mixed-test3.njk');
        expect(template.render()).to.be('From legacy loader');
      });

      it('should work with mixed async loaders', function(done) {
        let env;

        // Async function loader
        function asyncFunctionLoader(name) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              if (name === 'async-mixed-test.njk') {
                resolve('From async function');
              } else {
                resolve(null);
              }
            }, 5);
          });
        }

        // Async class loader
        function AsyncClassLoader() { }
        AsyncClassLoader.prototype.load = function (name) {
          return new Promise(function (resolve) {
            setTimeout(function () {
              if (name === 'async-mixed-test2.njk') {
                resolve('From async class');
              } else {
                resolve(null);
              }
            }, 5);
          });
        };

        env = new AsyncEnvironment([asyncFunctionLoader, new AsyncClassLoader()]);

        let completed = 0;
        function checkDone() {
          completed++;
          if (completed === 2) {
            done();
          }
        }

        env.renderTemplate('async-mixed-test.njk', {}).then(function(result) {
          expect(result).to.be('From async function');
          checkDone();
        }).catch(done);

        env.renderTemplate('async-mixed-test2.njk', {}).then(function(result) {
          expect(result).to.be('From async class');
          checkDone();
        }).catch(done);
      });
    });


    describe('Error Handling', function() {
      it('should handle function loader errors', function(done) {
        var env;

        function errorFunctionLoader(name) {
          throw new Error('Function loader error');
        }

        env = new Environment([errorFunctionLoader]);
        env.getTemplate('error-test.njk', function(err, template) {
          expect(err).to.be.a(Error);
          expect(err.message).to.contain('Function loader error');
          done();
        });
      });

      it('should handle class loader errors', function(done) {
        var env;

        function ErrorClassLoader() {}
        ErrorClassLoader.prototype.load = function(name) {
          throw new Error('Class loader error');
        };

        env = new Environment([new ErrorClassLoader()]);
        env.getTemplate('error-test.njk', function(err, template) {
          expect(err).to.be.a(Error);
          expect(err.message).to.contain('Class loader error');
          done();
        });
      });

      it('should handle async function loader rejections', function(done) {
        var env;

        function asyncErrorFunctionLoader(name) {
          return Promise.reject(new Error('Async function error'));
        }

        env = new Environment([asyncErrorFunctionLoader]);
        env.getTemplate('async-error-test.njk', function(err, template) {
          expect(err).to.be.a(Error);
          expect(err.message).to.contain('Async function error');
          done();
        });
      });
    });
  });

  describe('Loader Integration Tests', function() {
    describe('clearStringCache with new loader types', function() {
      it('should clear all caches (Environment + string cache) for function loaders', function() {
        if (typeof clearStringCache === 'undefined') {
          this.skip();
          return;
        }

        let env;
        let callCount = 0;

        function countingLoader(name) {
          callCount++;
          if (name === 'cache-test.njk') {
            return 'Cached content ' + callCount;
          }
          return null;
        }

        env = new Environment([countingLoader]);

        // First load - should call the loader
        let template1 = env.getTemplate('cache-test.njk');
        expect(template1.render()).to.be('Cached content 1');

        // Second load - should use cache, no loader call
        let template2 = env.getTemplate('cache-test.njk');
        expect(template2.render()).to.be('Cached content 1');
        expect(callCount).to.be(1);

        // Clear cache
        env.invalidateCache();

        // Third load - should call loader again
        let template3 = env.getTemplate('cache-test.njk');
        expect(template3.render()).to.be('Cached content 2');
        expect(callCount).to.be(2);
      });

      it('should clear all caches (Environment + string cache) for class loaders', function() {
        if (typeof clearStringCache === 'undefined') {
          this.skip();
          return;
        }

        let env;
        let callCount = 0;

        function CountingClassLoader() {}
        CountingClassLoader.prototype.load = function(name) {
          callCount++;
          if (name === 'class-cache-test.njk') {
            return 'Class cached content ' + callCount;
          }
          return null;
        };

        let loader = new CountingClassLoader();
        env = new Environment([loader]);

        // First load
        let template1 = env.getTemplate('class-cache-test.njk');
        expect(template1.render()).to.be('Class cached content 1');

        // Second load - should use cache
        let template2 = env.getTemplate('class-cache-test.njk');
        expect(template2.render()).to.be('Class cached content 1');
        expect(callCount).to.be(1);

        // Clear cache
        env.invalidateCache();

        // Third load - should call loader again
        let template3 = env.getTemplate('class-cache-test.njk');
        expect(template3.render()).to.be('Class cached content 2');
        expect(callCount).to.be(2);
      });
    });

    describe('Precompile functions with custom environments', function() {
      it('should work with precompileTemplateString using function loader', function() {
        function testLoader(name) {
          if (name === 'precompile-test.njk') {
            return 'Hello {{ name }}!';
          }
          return null;
        }

        let env = new Environment([testLoader]);
        let result = precompileTemplateString('Hello {{ name }}!', {
          name: 'precompile-test.njk',
          env: env
        });

        expect(result).to.be.a('string');
        expect(result).to.contain('Hello');
      });

      it('should work with precompileScriptString using class loader', function() {
        function TestScriptLoader() {}
        TestScriptLoader.prototype.load = function(name) {
          if (name === 'script-test.njk') {
            return 'let x = {{ value }};';
          }
          return null;
        };

        let env = new Environment([new TestScriptLoader()]);
        let result = precompileScriptString('let x = {{ value }};', {
          name: 'script-test.njk',
          env: env
        });

        expect(result).to.be.a('string');
        expect(result).to.contain('let x');
      });
    });

    describe('Template/Script constructors with custom environments', function() {
      it('should work with Template constructor using function loader', function() {

        function templateLoader(name) {
          if (name === 'constructor-test.njk') {
            return 'Template from function loader: {{ message }}';
          }
          return null;
        }

        let env = new Environment([templateLoader]);
        let template = new Template('Template from function loader: {{ message }}', env, 'constructor-test.njk');
        let result = template.render({ message: 'Hello World' });

        expect(result).to.be('Template from function loader: Hello World');
      });

      it('should work with Script constructor using class loader', async function() {
        class ScriptClassLoader {
          load(name) {
            if (name === 'script-constructor-test.njk') {
              return `:data
              @data = value`;
            }
          }
        }

        let env = new AsyncEnvironment([new ScriptClassLoader()]);
        let script = await env.getScript('script-constructor-test.njk');
        let result = await script.render({ value: 42 });

        expect(result).to.be(42);
      });
    });

    describe('AsyncEnvironment with new loader types', function() {
      it('should work with AsyncEnvironment using async function loaders', function(done) {
        function asyncFunctionLoader(name) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              if (name === 'async-env-test.njk') {
                resolve('Async environment test: {{ message }}');
              } else {
                resolve(null);
              }
            }, 10);
          });
        }

        let env = new AsyncEnvironment([asyncFunctionLoader]);
        env.renderTemplate('async-env-test.njk', { message: 'Hello Async' }).then(function(result) {
          expect(result).to.be('Async environment test: Hello Async');
          done();
        }).catch(done);
      });

      it('should work with AsyncEnvironment using async class loaders', function(done) {
        function AsyncClassLoader() {}
        AsyncClassLoader.prototype.load = function(name) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              if (name === 'async-class-env-test.njk') {
                resolve('Async class environment test: {{ message }}');
              } else {
                resolve(null);
              }
            }, 10);
          });
        };

        let env = new AsyncEnvironment([new AsyncClassLoader()]);
        env.renderTemplate('async-class-env-test.njk', { message: 'Hello Async Class' }).then(function(result) {
          expect(result).to.be('Async class environment test: Hello Async Class');
          done();
        }).catch(done);
      });
    });

    describe('Mixed loader types in real-world scenarios', function() {
      it('should work with fallback chain: function -> class -> legacy', function() {
        let env, template;

        // Function loader (first priority)
        function functionLoader(name) {
          if (name === 'fallback-test.njk') {
            return 'From function loader';
          }
          return null;
        }

        // Class loader (second priority)
        function ClassLoader() {}
        ClassLoader.prototype.load = function(name) {
          if (name === 'fallback-test2.njk') {
            return 'From class loader';
          }
          return null;
        };

        // Legacy loader (fallback)
        function LegacyLoader() {}
        LegacyLoader.prototype.getSource = function(name) {
          if (name === 'fallback-test3.njk') {
            return { src: 'From legacy loader', path: name, noCache: false };
          }
          return null;
        };

        env = new Environment([functionLoader, new ClassLoader(), new LegacyLoader()]);

        // Test each loader in the chain
        template = env.getTemplate('fallback-test.njk');
        expect(template.render()).to.be('From function loader');

        template = env.getTemplate('fallback-test2.njk');
        expect(template.render()).to.be('From class loader');

        template = env.getTemplate('fallback-test3.njk');
        expect(template.render()).to.be('From legacy loader');
      });

      it('should work with loadString using mixed loader types', function(done) {
        if (typeof loadString === 'undefined') {
          this.skip();
          return;
        }

        function functionLoader(name) {
          if (name === 'mixed-loadstring-test.njk') {
            return 'From function in loadString';
          }
          return null;
        }

        function ClassLoader() {}
        ClassLoader.prototype.load = function(name) {
          if (name === 'mixed-loadstring-test2.njk') {
            return 'From class in loadString';
          }
          return null;
        };

        function LegacyLoader() {}
        LegacyLoader.prototype.getSource = function(name) {
          if (name === 'mixed-loadstring-test3.njk') {
            return { src: 'From legacy in loadString', path: name, noCache: false };
          }
          return null;
        };

        let loaders = [functionLoader, new ClassLoader(), new LegacyLoader()];
        let completed = 0;

        function checkDone() {
          completed++;
          if (completed === 3) {
            done();
          }
        }

        function handleLoadStringResult(result, expectedContent) {
          if (result && typeof result.then === 'function') {
            return result.then(function(content) {
              expect(content).to.be(expectedContent);
              checkDone();
            }).catch(done);
          } else {
            expect(result).to.be(expectedContent);
            checkDone();
          }
        }

        handleLoadStringResult(loadString('mixed-loadstring-test.njk', loaders), 'From function in loadString');
        handleLoadStringResult(loadString('mixed-loadstring-test2.njk', loaders), 'From class in loadString');
        handleLoadStringResult(loadString('mixed-loadstring-test3.njk', loaders), 'From legacy in loadString');
      });
    });

    describe('Concurrent loading', function() {
      it('should race async templates using raceLoaders function', function(done) {

        let callOrder = [];
        let startTime = Date.now();

        // Create async loaders that simulate different delays
        class SlowLoader1 {
          async load(name) {
            callOrder.push('loader1-start');
            await delay(9);
            callOrder.push('loader1-end');
            if (name === 'concurrent-test.njk.njk') {
              return { src: 'From slow loader 1', path: name };
            } else {
              return null;
            }
          }
        }

        class SlowLoader2 {
          async = true;
          getSource(name, callback) {
            callOrder.push('loader2-start');
            setTimeout(() => {
              callOrder.push('loader2-end');
              if (name === 'concurrent-test.njk') {
                callback(null, { src: 'From slow loader 2', path: name });
              } else {
                callback(null, null);
              }
            }, 6);
          }
        }

        class SlowLoader3 {
          async load(name) {
            callOrder.push('loader3-start');
            await delay(3);
            callOrder.push('loader3-end');
            if (name === 'some-other-template.njk') {
              return { src: 'From slow loader 3', path: name };
            } else {
              return null;
            }
          }
        }

        const env = new AsyncEnvironment(raceLoaders([new SlowLoader1(), new SlowLoader2(), new SlowLoader3()]));

        env.getTemplate('concurrent-test.njk').then((template) => {
          const endTime = Date.now();
          const duration = endTime - startTime;

          // Verify that all loaders started, and the first completion is from loader2
          expect(callOrder).to.eql([
            'loader1-start',
            'loader2-start',
            'loader3-start',
            'loader3-end', // First to finish
            'loader2-end' // Second to finsh, returns the correct template
          ]);

          // Verify that the total time is close to the slowest loader (50ms)
          // Allow some tolerance for test execution overhead
          expect(duration).to.be.lessThan(100);

          // Verify the template was loaded successfully
          expect(template).to.be.ok();

          // AsyncTemplate.render() returns a Promise when no callback is provided
          return template.render();
        }).then((result) => {
          expect(result).to.be('From slow loader 2'); // First successful result
          done();
        }).catch(done);
      });

      it('should load templates sequentially in sync mode', function(done) {
        let callOrder = [];

        // Create sync loaders that track call order
        function SyncLoader1() {}
        SyncLoader1.prototype.getSource = function(name) {
          callOrder.push('loader1');
          if (name === 'sequential-test.njk') {
            return { src: 'From sync loader 1', path: name };
          }
          return null;
        };

        function SyncLoader2() {}
        SyncLoader2.prototype.getSource = function(name) {
          callOrder.push('loader2');
          if (name === 'sequential-test.njk') {
            return { src: 'From sync loader 2', path: name };
          }
          return null;
        };

        function SyncLoader3() {}
        SyncLoader3.prototype.getSource = function(name) {
          callOrder.push('loader3');
          if (name === 'sequential-test.njk') {
            return { src: 'From sync loader 3', path: name };
          }
          return null;
        };

        const env = new Environment([new SyncLoader1(), new SyncLoader2(), new SyncLoader3()]);

        env.getTemplate('sequential-test.njk', (err, template) => {
          if (err) return done(err);

          // Verify that loaders were called sequentially
          expect(callOrder).to.eql(['loader1']); // Only first loader should be called

          // Verify the template was loaded successfully
          expect(template).to.be.ok();
          expect(template.render()).to.be('From sync loader 1');

          done();
        });
      });
    });
  });

}());
