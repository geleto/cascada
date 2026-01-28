#!/usr/bin/env node
/* eslint-disable no-console */

'use strict';

// Run browser tests
require('@babel/register');

const NYC = require('nyc');
const mocha = require('mocha');
const path = require('path');
const fs = require('fs').promises;
//const chalk = require('tiny-chalk');
let chalk;

const libCoverage = require('istanbul-lib-coverage');
const getStaticServer = require('./lib/static-server');
const { chromium } = require('playwright');
const precompileTestTemplates = require('./lib/precompile');

process.env.NODE_ENV = 'test';
let mergeNodeTestsCoverage = process.argv.includes('fullTest');
const NODE_TESTS_COVERAGE_FILE = 'coverage-final.json';

const coverageConfig = {
  dir: path.join(__dirname, '../coverage'),
  files: [
    'browser-std.json',
    'browser-slim.json'],
  fileData: {},
  getFullPath: (file) => path.join(coverageConfig.dir, file)
};

const nyc = new NYC({
  include: ['src/**/*.js'],
  reporter: ['text', 'html', 'lcov'],
  showProcessTree: true,
  tempDir: path.join(__dirname, '../coverage/.nyc_output'),
  cacheDir: path.join(__dirname, '../coverage/.nyc_output')
});

(async () => {
  chalk = await import('tiny-chalk');
  runTests().catch(error => {
    console.error('Unhandled error in test runner:', error);
    process.exit(1);
  });
})();

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
      const ms = parseInt(duration, 10);
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
    let coverageSavedResolve, coverageSavedReject;
    const coverageSavedPromise = new Promise((resolve, reject) => {
      coverageSavedResolve = resolve;
      coverageSavedReject = reject;
    });

    await page.exposeFunction('sendTestResults', async (results) => {
      if (results.coverage) {
        const coverageFileName = testFile.includes('slim') ? 'browser-slim.json' : 'browser-std.json';
        const coverageFile = coverageConfig.getFullPath(coverageFileName);
        try {
          await fs.writeFile(coverageFile, JSON.stringify(results.coverage));
          coverageSavedResolve(); // Resolve the promise when coverage data is saved
        } catch (error) {
          console.error(`Error saving coverage data for ${testFile}:`, error);
          coverageSavedReject(error); // Reject the promise if there's an error saving coverage data
        }
      } else {
        console.error(`No coverage data received for ${testFile}`);
        coverageSavedReject(new Error('No coverage data received')); // Reject the promise if no coverage data
      }
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

  let totalPassed = 0;
  let totalFailed = 0;
  let totalPending = 0;
  let totalDuration = 0;
  const fileResults = {};

  // Node stats (populated only in full test flow)
  let nodeStats = null;

  try {

    //the coverage file from the node tests has to be read in advance because nyc initialization deletes it
    if (mergeNodeTestsCoverage) {
      try {
        coverageConfig.files.push(NODE_TESTS_COVERAGE_FILE);
        coverageConfig.fileData[NODE_TESTS_COVERAGE_FILE] = JSON.parse(await fs.readFile(coverageConfig.getFullPath(NODE_TESTS_COVERAGE_FILE), 'utf8'));
        console.log('node coverage file loaded');
      } catch (e) {
        console.error(`Failed to open node tests coverage file ${coverageConfig.getFullPath(NODE_TESTS_COVERAGE_FILE)} , error: ${e}`);
      }
    }

    nyc.reset();

    await precompileTestTemplates();

    [server, port] = await getStaticServer();
    console.log(`Static server listening on port ${port}`);

    browser = await chromium.launch();
    const testFiles = ['slim.html', 'index.html'];

    for (const testFile of testFiles) {
      console.log(`\nRunning tests for ${testFile}...`);
      const result = await runTestFile(browser, port, testFile);
      fileResults[testFile] = result.stats;

      if (result.stats.failures > 0) {
        overallTestsPassed = false;
      }

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
        if (file === NODE_TESTS_COVERAGE_FILE) {
          mergeNodeTestsCoverage = false;
          console.error(`Error processing Node tests coverage file ${file}:`, error);
        }
        else {
          console.error(`Error processing browser coverage file ${file}:`, error);
        }
      }
    }

    // Write the merged coverage data to a new file
    const mergedCoverageFile = path.join(coverageConfig.dir, 'merged-coverage.json');
    await fs.writeFile(mergedCoverageFile, JSON.stringify(coverageMap));

    // Write the merged coverage data to NYC's temp directory so it can read it
    const nycTempDir = path.join(coverageConfig.dir, '.nyc_output');
    await fs.mkdir(nycTempDir, { recursive: true });

    // Write each file's coverage data as separate files in NYC temp directory
    const coverageData = coverageMap.toJSON();
    for (const [filePath, fileCoverage] of Object.entries(coverageData)) {
      const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.json`;
      await fs.writeFile(
        path.join(nycTempDir, fileName),
        JSON.stringify({ [filePath]: fileCoverage })
      );
    }

    if (mergeNodeTestsCoverage) {
      console.log('\nCombined Coverage Summary from Node and browser tests:');
    } else {
      console.log('\nCoverage Summary from browser tests:');
    }

    // Create a new NYC instance that reads from our merged coverage data
    const reportNyc = new NYC({
      include: ['src/**/*.js'],
      reporter: ['text', 'html', 'lcov'],
      showProcessTree: true,
      tempDir: nycTempDir,
      cacheDir: nycTempDir,
      cwd: path.join(__dirname, '..')
    });

    await reportNyc.report();

  } catch (error) {
    console.error('Test runner encountered an error:', error);
    overallTestsPassed = false;
  } finally {
    if (mergeNodeTestsCoverage) {
      // Try to read node stats if present
      try {
        const statsPath = path.join(__dirname, '../coverage/node-tests-stats.json');
        const statsRaw = await fs.readFile(statsPath, 'utf8');
        nodeStats = JSON.parse(statsRaw);
        // eslint-disable-next-line no-empty
      } catch (_) { }

      const combinedPassed = (nodeStats?.passes || 0) + totalPassed;
      const combinedFailed = (nodeStats?.failures || 0) + totalFailed;
      const combinedPending = (nodeStats?.pending || 0) + totalPending;
      const combinedDuration = (nodeStats?.duration || 0) + totalDuration;

      const nodeFail = nodeStats?.failures || 0;
      const browserFail = totalFailed;
      const durationSec = Math.round(combinedDuration / 1000);

      console.log('\nTOTALS:');
      console.log(chalk.green(`${combinedPassed} passing (${durationSec}s)`));
      console.log(chalk.cyan(`${combinedPending} pending`));
      console.log(chalk.red(`${combinedFailed} failing (${nodeFail} node, ${browserFail} browser)\n`));
    } else {
      const durationSec = Math.round(totalDuration / 1000);

      console.log('\nBROWSER TOTALS:');
      for (const [fileName, stats] of Object.entries(fileResults)) {
        if (!stats) continue;
        const d = Math.round(stats.duration / 1000);
        console.log(`${fileName}: ${chalk.green(stats.passes + ' passing')} ${chalk.cyan(stats.pending + ' pending')} ${chalk.red(stats.failures + ' failing')} (${d}s)`);
      }
      console.log('---------------------------------------------------');
      console.log(chalk.green(`${totalPassed} passing (${durationSec}s)`));
      console.log(chalk.cyan(`${totalPending} pending`));
      console.log(chalk.red(`${totalFailed} failing\n`));
    }

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
