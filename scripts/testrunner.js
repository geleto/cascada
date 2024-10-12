#!/usr/bin/env node

'use strict';

require('@babel/register');

const NYC = require('nyc');
const mocha = require('mocha');
const path = require('path');
const fs = require('fs').promises;
const getStaticServer = require('./lib/static-server');
const { chromium } = require('playwright');
const precompileTestTemplates = require('./lib/precompile');

process.env.NODE_ENV = 'test';

const nyc = new NYC({
  exclude: ['*.min.js', 'scripts/**', 'tests/**', 'src/**', 'node_modules/**'],
  reporter: ['text', 'html', 'lcov'],
  showProcessTree: true
});

async function runTestFile(browser, port, testFile) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`http://localhost:${port}/tests/browser/${testFile}`);

    const testResult = await page.evaluate(() => {
      return new Promise((resolve) => {
        mocha.run((failures) => resolve({ failures }));
      });
    });

    if (testResult.failures > 0) {
      throw new Error(`Tests failed in ${testFile}`);
    }

    const coverage = await page.evaluate(() => window.__coverage__);
    if (coverage) {
      const coverageFileName = testFile.includes('slim') ? 'browser-slim.json' : 'browser-std.json';
      const coverageFile = path.join(__dirname, '../.nyc_output', coverageFileName);
      await fs.writeFile(coverageFile, JSON.stringify(coverage));
    }
  } finally {
    await context.close();
  }
}

async function runTests() {
  let server;
  let browser;
  let port;

  try {
    nyc.reset();

    await precompileTestTemplates();
    [server, port] = await getStaticServer();

    browser = await chromium.launch();
    const testFiles = ['index.html', 'slim.html'];

    await Promise.all(testFiles.map(testFile => runTestFile(browser, port, testFile)));

    nyc.writeCoverageFile();
    await nyc.report();

    console.log('All tests passed successfully');
  } catch (error) {
    console.error('Test runner failed:', error);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
}

runTests().catch(error => {
  console.error('Unhandled error in test runner:', error);
  process.exit(1);
});
