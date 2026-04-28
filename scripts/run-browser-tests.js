#!/usr/bin/env node
/* eslint-disable no-console */
import mocha from 'mocha';
import path from 'path';
import {fileURLToPath} from 'url';
import {promises as fs} from 'fs';
let chalk;

import libCoverage from 'istanbul-lib-coverage';
import {getStaticServer} from './lib/static-server.js';
import {chromium} from 'playwright';
import {precompileTestTemplates} from './lib/precompile.js';
import {writeCoverageReports} from './lib/coverage-report.js';

process.env.NODE_ENV = 'test';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const coverageConfig = {
  dir: path.join(scriptDir, '../coverage'),
  files: [
    'browser-std.json',
    'browser-precompiled.json'],
  getFullPath: (file) => path.join(coverageConfig.dir, file)
};

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

    page.on('console', msg => {
      const text = msg.text();
      if (text === 'Failed to load resource: the server responded with a status of 404 (Not Found)') {
        return;
      }
      console.log(colorConsoleOutput(text));
    });
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
        const coverageFileName = testFile.includes('precompiled') ? 'browser-precompiled.json' : 'browser-std.json';
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
    return { stats: { failures: 1, passes: 0, pending: 0, duration: 0 } };
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

  try {
    await fs.mkdir(coverageConfig.dir, {recursive: true});

    await precompileTestTemplates();

    [server, port] = await getStaticServer();
    console.log(`Static server listening on port ${port}`);

    browser = await chromium.launch();
    const testFiles = ['precompiled.html', 'index.html'];

    for (const testFile of testFiles) {
      console.log(`\nRunning tests for ${testFile}...`);
      const result = await runTestFile(browser, port, testFile);
      fileResults[testFile] = result.stats;

      if (!result.stats || (result.stats.passes + result.stats.failures + result.stats.pending) === 0) {
        overallTestsPassed = false;
      }

      if (result.stats.failures > 0) {
        overallTestsPassed = false;
      }

      totalPassed += result.stats.passes;
      totalFailed += result.stats.failures;
      totalPending += result.stats.pending;
      totalDuration += result.stats.duration;
    }

    // Save browser stats for aggregation
    const browserStats = {
      passes: totalPassed,
      failures: totalFailed,
      pending: totalPending,
      duration: totalDuration
    };
    await fs.writeFile(path.join(coverageConfig.dir, 'browser-tests-stats.json'), JSON.stringify(browserStats));

    // Merge coverage from the browser test pages.
    const coverageMap = libCoverage.createCoverageMap({});
    for (const file of coverageConfig.files) {
      try {
        const coverageData = JSON.parse(await fs.readFile(coverageConfig.getFullPath(file), 'utf8'));
        const fileCoverageMap = libCoverage.createCoverageMap(coverageData);
        coverageMap.merge(fileCoverageMap);
      } catch (error) {
        console.error(`Error processing browser coverage file ${file}:`, error);
      }
    }

    // Write the merged coverage data to a new file
    const mergedCoverageFile = path.join(coverageConfig.dir, 'merged-coverage.json');
    await fs.writeFile(mergedCoverageFile, JSON.stringify(coverageMap));

    console.log('\nCoverage Summary from browser tests:');
    writeCoverageReports(coverageMap, coverageConfig.dir);

  } catch (error) {
    console.error('Test runner encountered an error:', error);
    overallTestsPassed = false;
  } finally {
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
