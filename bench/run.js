'use strict';

import fs from 'fs';
import bench from 'bench';
import oldNunjucks from 'nunjucks';
import nunjucks from '../src/index.js';

const src = fs.readFileSync('case.html', 'utf-8');

const oldEnv = new oldNunjucks.Environment(null);
const oldTmpl = new oldNunjucks.Template(src, oldEnv, null, null, true);

const env = new nunjucks.Environment(null);
const tmpl = new nunjucks.Template(src, env, null, null, true);

const ctx = {
  items: [
    {
      current: true,
      name: 'James'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    },
    {
      name: 'Foo',
      url: 'http://example.com'
    }
  ]
};

export const time = 1000;
export const compareCount = 8;

export const compare = {
  'old-nunjucks': function() {
    oldTmpl.render(ctx);
  },

  'new-nunjucks': function(done) {
    tmpl.render(ctx, done);
  }
};

bench.runMain();
