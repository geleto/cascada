/* eslint-disable func-names */

'use strict';

import path from 'path';
import {fileURLToPath} from 'url';
import nunjucks from '../../src/index.js';
import express from 'express';

const sampleDir = path.dirname(fileURLToPath(import.meta.url));
const app = express();

nunjucks.configure(path.join(sampleDir, 'views'), {
  autoescape: true,
  express: app,
  watch: true
});

app.use(express.static(sampleDir));

app.use(function(req, res, next) {
  res.locals.user = 'hello';
  next();
});

app.get('/', function(req, res) {
  res.render('index.html', {
    username: 'James Long <strong>copyright</strong>'
  });
});

app.get('/about', function(req, res) {
  res.render('about.html');
});

app.listen(4000, function() {
  console.log('Express server running on http://localhost:4000');
});
