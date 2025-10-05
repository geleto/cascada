/*(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
  //var Environment;
  var delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../src/environment').AsyncEnvironment;
    //Environment = require('../src/environment').Environment;
    //unescape = require('he').unescape;
    delay = require('./util').delay;
  } else {
    expect = window.expect;
    //unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    //Environment = nunjucks.Environment;
    delay = window.util.delay;
  }

  describe('Error Propagation Dataflow Poisoning - Integration Tests', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });
  });
})();
*/
