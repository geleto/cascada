'use strict';

var expect;
var AsyncEnvironment;
var Template;
var delay;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  const index = require('../../src/index');
  AsyncEnvironment = index.AsyncEnvironment;
  Template = index.Template;
  const util = require('../util');
  delay = util.delay;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
  delay = window.util.delay;
  Template = nunjucks.Template;
}

describe('Sequential Expressions Extra Tests', function () {

  it('should handle sequence operation in condition (true case)', function (done) {
    const src = `
    {% set res = ('yes' if account!.check() else 'no') %}
    {{ res }}
    `;
    const env = new AsyncEnvironment(null, { asyncControl: true });
    const tmpl = new Template(src, env);

    const account = {
      check: function () { return true; }
    };

    tmpl.render({ account: account }, function (err, res) {
      if (err) return done(err);
      expect(res.trim()).to.be('yes');
      done();
    });
  });

  it('should handle sequence operation in condition (false case)', function (done) {
    const src = `
    {% set res = ('yes' if account!.check() else 'no') %}
    {{ res }}
    `;
    const env = new AsyncEnvironment(null, { asyncControl: true });
    const tmpl = new Template(src, env);

    const account = {
      check: function () { return false; }
    };

    tmpl.render({ account: account }, function (err, res) {
      if (err) return done(err);
      expect(res.trim()).to.be('no');
      done();
    });
  });

  it('should propagate error from sequence operation inside condition', function (done) {
    const src = `
    {% set res = ('yes' if account!.broken() else 'no') %}
    {{ res }}
    `;
    const env = new AsyncEnvironment(null, { asyncControl: true });
    const tmpl = new Template(src, env);

    const account = {
      broken: function () { throw new Error('Condition Failed'); }
    };

    tmpl.render({ account: account }, function (err, res) {
      expect(err).to.be.ok();
      expect(err.message).to.contain('Condition Failed');
      done();
    });
  });

  it('should handle sequence in condition AND branch (lock contention check)', function (done) {
    const src = `
    {% set res = (account!.op('B') if account!.op('A') else 'no') %}
    {{ res }}
    `;
    const env = new AsyncEnvironment(null, { asyncControl: true });
    const tmpl = new Template(src, env);

    const ops = [];
    const account = {
      op: async function (name) {
        await delay(10);
        ops.push(name);
        return true;
      }
    };

    tmpl.render({ account: account }, function (err, res) {
      if (err) return done(err);
      expect(res.trim()).to.not.contain('[object Promise]'); // Should resolve
      expect(res.trim()).to.be('true');
      expect(ops).to.eql(['A', 'B']); // Must be sequential
      done();
    });
  });

  it('should fail if sequential operation in AND right-hand side fails (executed path)', function (done) {
    const src = `
    {{ true and account!.fail() }}
    `;
    const env = new AsyncEnvironment(null, { asyncControl: true });
    const tmpl = new Template(src, env);

    const account = {
      fail: function () { throw new Error('Right Side Error'); }
    };

    tmpl.render({ account: account }, function (err, res) {
      expect(err).to.be.ok();
      expect(err.message).to.contain('Right Side Error');
      done();
    });
  });
});
