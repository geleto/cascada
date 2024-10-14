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
  //exclude: ['*.min.js', 'scripts/**', 'tests/**', 'src/**', 'node_modules/**'],
  include: ["nunjucks/**/*.js"],
  reporter: ['text', 'html', 'lcov'],
  showProcessTree: true
});

async function runTestFile(browser, port, testFile) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const url = `http://localhost:${port}/tests/browser/${testFile}`;
    console.log(`Navigating to ${url}`);

    page.on('console', msg => console.log(msg.text()));
    page.on('pageerror', err => console.error(`${testFile} page error:`, err));

    const response = await page.goto(url, { waitUntil: 'networkidle' });

    if (!response.ok()) {
      throw new Error(`Failed to load ${url}: ${response.status()} ${response.statusText()}`);
    }

    console.log(`Page loaded: ${testFile}`);

    await page.exposeFunction('logProgress', (message) => {
      console.log(`${testFile} progress:`, message);
    });

    await page.exposeFunction('sendTestResults', async (results) => {
      console.log(`Tests finished for ${testFile}, passed: ${results.passed}, failed: ${results.failures}, total: ${results.total}`);
      if (results.coverage) {
        console.log(`Coverage data received for ${testFile}`);
        const coverageFileName = testFile.includes('slim') ? 'browser-slim.json' : 'browser-std.json';
        const coverageFile = path.join(__dirname, '../.nyc_output', coverageFileName);
        await fs.writeFile(coverageFile, JSON.stringify(results.coverage));
      }
    });

    await page.evaluate(() => {
      console.log('Injected script running');
      if (typeof mocha !== 'undefined') {
        console.log('Mocha found, running tests');
        mocha.run((failures) => {
          window.testResultsReceived = {
            failures: failures,
            total: mocha.suite.total(),
            passed: mocha.suite.total() - failures,
            coverage: window.__coverage__
          };
          window.sendTestResults(window.testResultsReceived);
        });
      } else {
        console.error('Mocha not found on the page');
      }
    });

    const testResult = await page.waitForFunction(() => window.testResultsReceived, { timeout: 120000 });
    const resultValue = await testResult.jsonValue();

    if (resultValue.failures > 0) {
      console.error(`Tests failed in ${testFile}`);
      // We're not throwing an error here anymore, just logging it
    }

    return resultValue;
  } catch (error) {
    console.error(`Error in ${testFile}:`, error);
    return { failures: 1, total: 1, passed: 0 }; // Return a failed result object
  } finally {
    await context.close();
  }
}

async function runTests() {
  let server;
  let browser;
  let port;
  let overallTestsPassed = true;

  try {
    console.log('Starting test process...');
    nyc.reset();

    console.log('Precompiling test templates...');
    await precompileTestTemplates();

    console.log('Starting static server...');
    [server, port] = await getStaticServer();
    console.log(`Static server listening on port ${port}`);

    console.log('Launching browser...');
    browser = await chromium.launch();
    const testFiles = ['index.html', 'slim.html'];

    for (const testFile of testFiles) {
      console.log(`Running tests for ${testFile}...`);
      const result = await runTestFile(browser, port, testFile);
      if (result.failures > 0) {
        overallTestsPassed = false;
      }
    }

    console.log('All test files have been processed');

    console.log('Processing coverage data...');
    const coverageFiles = ['browser-std.json', 'browser-slim.json'];
    for (const file of coverageFiles) {
      const coverageFile = path.join(__dirname, '../.nyc_output', file);
      try {
        const coverageData = JSON.parse(await fs.readFile(coverageFile, 'utf8'));
        Object.keys(coverageData).forEach(filename => {
          nyc.addFileCoverage(coverageData[filename]);
        });
      } catch (error) {
        console.error(`Error processing coverage file ${file}:`, error);
      }
    }

    console.log('\nCoverage Summary:');
    await nyc.report();

    const coverageData = nyc.getCoverageMapFromAllCoverageFiles();
    const summary = coverageData.getCoverageSummary();
    const lines = summary.lines;
    const statements = summary.statements;
    const functions = summary.functions;
    const branches = summary.branches;

    console.log('\nDetailed Coverage Data:');
    console.log(`Lines: ${lines.pct.toFixed(2)}% (${lines.covered}/${lines.total})`);
    console.log(`Statements: ${statements.pct.toFixed(2)}% (${statements.covered}/${statements.total})`);
    console.log(`Functions: ${functions.pct.toFixed(2)}% (${functions.covered}/${functions.total})`);
    console.log(`Branches: ${branches.pct.toFixed(2)}% (${branches.covered}/${branches.total})`);

  } catch (error) {
    console.error('Test runner encountered an error:', error);
    overallTestsPassed = false;
  } finally {
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
    }
    if (server) {
      console.log('Closing server...');
      server.close(() => {
        console.log('Server closed');
      });
    }
  }

  if (!overallTestsPassed) {
    console.error('Some tests failed');
    process.exit(1);
  } else {
    console.log('All tests passed successfully');
  }
}

console.log('Test runner script started');
runTests().catch(error => {
  console.error('Unhandled error in test runner:', error);
  process.exit(1);
});