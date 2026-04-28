import expect from 'expect.js';
import util from './util.js';

const isBrowser = typeof window !== 'undefined';
const path = isBrowser ? undefined : await import('path');
const environmentModule = isBrowser ? window.nunjucks : await import('../src/environment/environment.js');
const loaderModule = isBrowser ? window.nunjucks : await import('../src/loader/node-loaders.js');
const {Environment} = environmentModule;
const Loader = isBrowser ? window.nunjucks.WebLoader : loaderModule.FileSystemLoader;

(function() {
  'use strict';

  var templatesPath = isBrowser ? '../templates' : 'tests/templates';

  describe('api', function() {
    var env;
    beforeEach(function() {
      env = new Environment(new Loader(templatesPath));
    });

    it('should always force compilation of parent template', function() {

      var child = env.getTemplate('base-inherit.njk');
      expect(child.render()).to.be('Foo*Bar*BazFizzle');
    });

    it('should only call the callback once when conditional import fails', function(done) {
      var called = 0;
      env.render('broken-conditional-include.njk',
        function() {
          expect(++called).to.be(1);
        }
      );
      setTimeout(done, 0);
    });


    it('should handle correctly relative paths', function() {
      var child1;
      var child2;
      if (typeof path === 'undefined') {
        this.skip();
        return;
      }
      child1 = env.getTemplate('relative/test1.njk');
      child2 = env.getTemplate('relative/test2.njk');

      expect(child1.render()).to.be('FooTest1BazFizzle');
      expect(child2.render()).to.be('FooTest2BazFizzle');
    });

    it('should handle correctly cache for relative paths', function() {
      var test;
      if (typeof path === 'undefined') {
        this.skip();
        return;
      }
      test = env.getTemplate('relative/test-cache.njk');

      expect(util.normEOL(test.render())).to.be('Test1\nTest2');
    });

    it('should handle correctly relative paths in renderString', function() {
      if (typeof path === 'undefined') {
        this.skip();
        return;
      }
      expect(env.renderString('{% extends "./relative/test1.njk" %}{% block block1 %}Test3{% endblock %}', {}, {
        path: path.resolve(templatesPath, 'string.njk')
      })).to.be('FooTest3BazFizzle');
    });

    it('should emit "load" event on Environment instance', function(done) {
      env.on('load', function(name, source) {
        expect(name).to.equal('item.njk');
        done();
      });
      env.render('item.njk', {});
    });
  });
}());
