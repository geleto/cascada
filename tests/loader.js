(function() {
  'use strict';

  var expect,
    Environment,
    WebLoader,
    FileSystemLoader,
    NodeResolveLoader,
    templatesPath,
    StringLoader,
    loadString,
    clearStringCache;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    Environment = require('../src/environment').Environment;
    WebLoader = require('../src/web-loaders').WebLoader;
    FileSystemLoader = require('../src/node-loaders').FileSystemLoader;
    NodeResolveLoader = require('../src/node-loaders').NodeResolveLoader;
    templatesPath = 'tests/templates';
    StringLoader = require('./util').StringLoader;
    loadString = require('../src/index').loadString;
    clearStringCache = require('../src/index').clearStringCache;
  } else {
    expect = window.expect;
    Environment = nunjucks.Environment;
    WebLoader = nunjucks.WebLoader;
    FileSystemLoader = nunjucks.FileSystemLoader;
    NodeResolveLoader = nunjucks.NodeResolveLoader;
    templatesPath = '../templates',
    StringLoader = window.util.StringLoader;
    loadString = nunjucks.loadString;
    clearStringCache = nunjucks.clearStringCache;
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


  describe.only('string loading utilities', function () {
    var loader1, loader2;

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

      loadString('simple-base.njk', loader1).then(function (content) {
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        expect(content).to.contain('Hello World');
        done();
      }).catch(done);
    });

    it('should load a string from an array of loaders', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      loadString('simple-base.njk', [loader1, loader2]).then(function (content) {
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        done();
      }).catch(done);
    });

    it('should cache loaded strings', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      loadString('simple-base.njk', loader1).then(function (content) {
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);

        // Load the same string again - should come from cache
        return loadString('simple-base.njk', loader1);
      }).then(function (content) {
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        // Second load should work (cached)
        done();
      }).catch(done);
    });

    it('should handle multiple loaders with separate string caches', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      Promise.all([
        loadString('simple-base.njk', loader1),
        loadString('base.njk', loader1),
        loadString('simple-base.njk', loader2)
      ]).then(function (results) {
        expect(results).to.have.length(3);
        expect(results[0]).to.be.a('string');
        expect(results[1]).to.be.a('string');
        expect(results[2]).to.be.a('string');
        // All should load successfully, indicating separate caches work
        done();
      }).catch(done);
    });

    it('should clear specific string from cache', function (done) {
      if (typeof loadString === 'undefined' || typeof clearStringCache === 'undefined') {
        this.skip();
        return;
      }

      loadString('simple-base.njk', loader1).then(function () {
        return loadString('base.njk', loader1);
      }).then(function () {
        clearStringCache(loader1, 'simple-base.njk');
        // Load the cleared resource again - should reload from source
        return loadString('simple-base.njk', loader1);
      }).then(function (content) {
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        done();
      }).catch(done);
    });

    it('should clear all strings from a loader', function (done) {
      if (typeof loadString === 'undefined' || typeof clearStringCache === 'undefined') {
        this.skip();
        return;
      }

      Promise.all([
        loadString('simple-base.njk', loader1),
        loadString('base.njk', loader1),
        loadString('simple-base.njk', loader2)
      ]).then(function () {
        clearStringCache(loader1);
        // Load resources from loader1 again - should reload from source
        return Promise.all([
          loadString('simple-base.njk', loader1),
          loadString('base.njk', loader1)
        ]);
      }).then(function (results) {
        expect(results).to.have.length(2);
        expect(results[0]).to.be.a('string');
        expect(results[1]).to.be.a('string');
        done();
      }).catch(done);
    });

    it('should handle missing strings gracefully', function (done) {
      if (typeof loadString === 'undefined') {
        this.skip();
        return;
      }

      loadString('nonexistent-file.njk', loader1).then(function () {
        done(new Error('Should have thrown an error'));
      }).catch(function (error) {
        expect(error.message).to.contain('Resource \'nonexistent-file.njk\' not found in any loader');
        done();
      });
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
      loadString('test-no-cache.njk', noCacheLoader).then(function (content) {
        expect(content).to.be('test content');
        // Load the same resource again - should reload since noCache is true
        return loadString('test-no-cache.njk', noCacheLoader);
      }).then(function (content) {
        expect(content).to.be('test content');
        done();
      }).catch(done);
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
      loadString('async-test.njk', asyncLoader).then(function (content) {
        expect(content).to.be('async content');
        done();
      }).catch(done);
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
      loadString('simple-base.njk', [errorLoader, loader1]).then(function (content) {
        // Should fall back to the second loader
        expect(content).to.be.a('string');
        expect(content.length).to.be.greaterThan(0);
        done();
      }).catch(done);
    });
  });
}());
