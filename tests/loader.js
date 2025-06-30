(function() {
  'use strict';

  var expect,
    Environment,
    WebLoader,
    FileSystemLoader,
    NodeResolveLoader,
    templatesPath,
    StringLoader;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    Environment = require('../src/environment').Environment;
    WebLoader = require('../src/web-loaders').WebLoader;
    FileSystemLoader = require('../src/node-loaders').FileSystemLoader;
    NodeResolveLoader = require('../src/node-loaders').NodeResolveLoader;
    templatesPath = 'tests/templates';
    StringLoader = require('./util').StringLoader;
  } else {
    expect = window.expect;
    Environment = nunjucks.Environment;
    WebLoader = nunjucks.WebLoader;
    FileSystemLoader = nunjucks.FileSystemLoader;
    NodeResolveLoader = nunjucks.NodeResolveLoader;
    templatesPath = '../templates',
    StringLoader = window.util.StringLoader;
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
}());
