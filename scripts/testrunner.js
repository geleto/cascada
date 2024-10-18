#!/usr/bin/env node
/* eslint-disable no-console */

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
let mergeNodeTestsCoverage = process.argv.includes('fullTest');
const NODE_TESTS_COVERAGE_FILE = 'coverage-final.json';

const coverageConfig = {
  dir: path.join(__dirname, '../.nyc_output'),
  files: [
    'browser-std.json',
    'browser-slim.json'],
  fileData: {},
  getFullPath: (file) => path.join(coverageConfig.dir, file)
};

const nyc = new NYC({
  include: ['nunjucks/**/*.js'],
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

async function runTestFile(browser, port, testFile) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let coverageSavedPromise;

  try {
    const url = `http://localhost:${port}/tests/browser/${testFile}`;

    page.on('console', msg =>
      console.log(colorConsoleOutput(msg.text()))
    );
    page.on('pageerror', err => console.error(`${testFile} page error:`, err));

    const response = await page.goto(url, { waitUntil: 'networkidle' });

    if (!response.ok()) {
      throw new Error(`Failed to load ${url}: ${response.status()} ${response.statusText()}`);
    }

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
          console.error(`No coverage data received for ${testFile}`);
          resolve(); // Resolve even if there's no coverage data
        }
      });
    });

    await page.evaluate(() => {
      if (typeof mocha !== 'undefined') {
        const runner = mocha.run((failures) => {
          window.testResultsReceived = {
            stats: runner.stats,
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

    await coverageSavedPromise;// Wait for coverage data to be saved before proceeding

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

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalPending = 0;
  let totalDuration = 0;

  try {

    //the coverage file from the node tests has to be read in advance because nyc initialization deletes it
    if( mergeNodeTestsCoverage ){
      try{
        coverageConfig.files.push(NODE_TESTS_COVERAGE_FILE);
        coverageConfig.fileData[NODE_TESTS_COVERAGE_FILE] = JSON.parse(await fs.readFile(coverageConfig.getFullPath(NODE_TESTS_COVERAGE_FILE), 'utf8'));
        console.log('node coverage file loaded');
      }catch(e){
        console.error(`Failed to open node tests coverage file ${coverageConfig.getFullPath(NODE_TESTS_COVERAGE_FILE)} , error: ${e}`);
      }
    }

    nyc.reset();

    await precompileTestTemplates();

    [server, port] = await getStaticServer();
    console.log(`Static server listening on port ${port}`);

    browser = await chromium.launch();
    const testFiles = ['index.html', 'slim.html'];

    for (const testFile of testFiles) {
      console.log(`\nRunning tests for ${testFile}...`);
      const result = await runTestFile(browser, port, testFile);

      if (result.stats.failures > 0) {
        overallTestsPassed = false;
      }

      totalTests += result.stats.tests;
      totalPassed += result.stats.passes;
      totalFailed += result.stats.failures;
      totalPending += result.stats.pending;
      totalDuration += result.stats.duration;
    }

    // Merge the coverage files from browser tests and Node.js tests
    const coverageMap = libCoverage.createCoverageMap({});
    for (const file of coverageConfig.files) {
      try {
        //the coverage file from the node tests has to be read in advance because nyc initialization deletes it
        const data = coverageConfig.fileData[file];
        const coverageData = data || JSON.parse(await fs.readFile(coverageConfig.getFullPath(file), 'utf8'));
        const fileCoverageMap = libCoverage.createCoverageMap(coverageData);
        coverageMap.merge(fileCoverageMap);
      } catch (error) {
        if( file===NODE_TESTS_COVERAGE_FILE ){
          mergeNodeTestsCoverage = false;
          console.error(`Error processing Node tests coverage file ${file}:`, error);
        }
        else{
          console.error(`Error processing browser coverage file ${file}:`, error);
        }
      }
    }

    // Write the merged coverage data to a new file
    const mergedCoverageFile = path.join(coverageConfig.dir, 'merged-coverage.json');
    await fs.writeFile(mergedCoverageFile, JSON.stringify(coverageMap));

    if (mergeNodeTestsCoverage){
      console.log('\nCombined Coverage Summary from Node and browser tests:');
    }
    else{
      console.log('\nCoverage Summary from browser tests:');
    }

    await nyc.report();

  } catch (error) {
    console.error('Test runner encountered an error:', error);
    overallTestsPassed = false;
  } finally {
    console.log('\nBrowser Tests Summary:');
    console.log(`Tests: ${totalTests}`);
    console.log(chalk.green(`Passed: ${totalPassed}`));
    console.log(chalk.red(`Failed: ${totalFailed}`));
    console.log(chalk.blue(`Pending: ${totalPending}`));
    console.log(`Duration: (${totalDuration}ms)`);

    if (browser) {
      await browser.close();
    }
    if (server) {
      server.close(() => {
      });
    }
  }

  if (!overallTestsPassed) {
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Unhandled error in test runner:', error);
  process.exit(1);
});