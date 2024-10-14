#!/usr/bin/env node

'use strict';

require('@babel/register');

const NYC = require('nyc');
const mocha = require('mocha');
const path = require('path');
const fs = require('fs').promises;
const chalk = require('tiny-chalk');
const libCoverage = require('istanbul-lib-coverage');
const getStaticServer = require('./lib/static-server');
const { chromium } = require('playwright');
const precompileTestTemplates = require('./lib/precompile');

process.env.NODE_ENV = 'test';

// Define shared coverage data
const coverageConfig = {
  dir: path.join(__dirname, '../.nyc_output'),
  files: ['browser-std.json', 'browser-slim.json'],
  getFullPath: (file) => path.join(coverageConfig.dir, file)
};

const nyc = new NYC({
  include: ["nunjucks/**/*.js"],
  reporter: ['text', 'html', 'lcov'],
  showProcessTree: true
});

function colorConsoleOutput(message) {
  // Check for summary lines first
  if (/^\s+\d+ passing/.test(message)) {
    return chalk.green(message);
  }
  if (/^\s+\d+ failing/.test(message)) {
    return chalk.red(message);
  }
  if (/^\s+\d+ pending/.test(message)) {
    return chalk.blue(message);
  }

  // If not a summary line, proceed with other replacements
  return message
    // Test results
    .replace(/√/g, chalk.green('√'))
    .replace(/×/g, chalk.red('×'))
    .replace(/∘︎/g, chalk.blue('∘︎'))

    // Individual test durations (only for lines starting with spaces, which are test results)
    .replace(/^(\s+.*?)\((\d+)ms\)/gm, (match, testName, duration) => {
      const ms = parseInt(duration);
      if (ms > 100) return `${testName}${chalk.red(`(${duration}ms)`)}`;
      if (ms > 50) return `${testName}${chalk.yellow(`(${duration}ms)`)}`;
      return `${testName}${chalk.dim(`(${duration}ms)`)}`;
    })

    // Error messages (assuming they start with "Error:")
    .replace(/^(\s*)(Error:.*)/gm, (match, indent, error) => `${indent}${chalk.red(error)}`);
}

async function deleteCoverageFiles() {
  for (const file of coverageConfig.files) {
    const filePath = coverageConfig.getFullPath(file);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Error deleting coverage file ${file}:`, error);
      }
    }
  }
}

async function runTestFile(browser, port, testFile) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let coverageSavedPromise;

  try {
    const url = `http://localhost:${port}/tests/browser/${testFile}`;
    console.log(`Navigating to ${url}`);

    page.on('console', msg =>
      console.log(colorConsoleOutput(msg.text()))
    );
    page.on('pageerror', err => console.error(`${testFile} page error:`, err));

    const response = await page.goto(url, { waitUntil: 'networkidle' });

    if (!response.ok()) {
      throw new Error(`Failed to load ${url}: ${response.status()} ${response.statusText()}`);
    }

    console.log(`Page loaded: ${testFile}`);

    await page.exposeFunction('logProgress', (message) => {
      console.log(`${testFile} progress:`, message);
    });

    // Create a promise that resolves when coverage data is saved
    coverageSavedPromise = new Promise((resolve, reject) => {
      page.exposeFunction('sendTestResults', async (results) => {
        if (results.coverage) {
          const coverageFileName = testFile.includes('slim') ? 'browser-slim.json' : 'browser-std.json';
          const coverageFile = coverageConfig.getFullPath(coverageFileName);
          try {
            await fs.writeFile(coverageFile, JSON.stringify(results.coverage));
            resolve(); // Resolve the promise when coverage data is saved
          } catch (error) {
            reject(error);
          }
        } else {
          console.log(`No coverage data received for ${testFile}`);
          resolve(); // Resolve even if there's no coverage data
        }
      });
    });

    await page.evaluate(() => {
      console.log('Injected script running');
      if (typeof mocha !== 'undefined') {
        console.log('Mocha found, running tests');
        mocha.run((failures) => {
          window.testResultsReceived = {
            failures: failures,
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

    // Wait for coverage data to be saved before proceeding
    await coverageSavedPromise;

    /*if (resultValue.failures > 0) {
      console.error(`Tests failed in ${testFile}`);
      overallTestsPassed = false;
    }*/

    return resultValue;
  } catch (error) {
    console.error(`Error in ${testFile}:`, error);
    return { failures: 1, total: 1, passed: 0 };
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
    nyc.reset();

    await deleteCoverageFiles();

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

    //console.log('\nProcessing coverage data...');
    const coverageMap = libCoverage.createCoverageMap({});

    for (const file of coverageConfig.files) {
      const coverageFile = coverageConfig.getFullPath(file);
      try {
        const coverageData = JSON.parse(await fs.readFile(coverageFile, 'utf8'));
        const fileCoverageMap = libCoverage.createCoverageMap(coverageData);
        coverageMap.merge(fileCoverageMap);
      } catch (error) {
        console.error(`Error processing coverage file ${file}:`, error);
      }
    }

    console.log('\nCoverage Summary:');
    await nyc.report();

  } catch (error) {
    console.error('Test runner encountered an error:', error);
    overallTestsPassed = false;
  } finally {
    if (browser) {
      //console.log('Closing browser...');
      await browser.close();
    }
    if (server) {
      console.log('Closing server...');
      server.close(() => {
        //console.log('Server closed');
      });
    }
  }

  if (!overallTestsPassed) {
    //console.error('Some tests failed');
    process.exit(1);
  } else {
    //console.log('All tests passed successfully');
  }
}

runTests().catch(error => {
  console.error('Unhandled error in test runner:', error);
  process.exit(1);
});