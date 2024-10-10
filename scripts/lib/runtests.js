const spawn = require('child_process').spawn;
const getStaticServer = require('./static-server');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs');

// Utilities for the project
const utils = require('./utils');
const lookup = utils.lookup;
const promiseSequence = utils.promiseSequence;

// Function to run Mocha tests in Node.js (CLI tests and general tests)
function mochaRun({ cliTest = false } = {}) {
  const bin = lookup(cliTest ? '.bin/mocha' : '.bin/nyc', true);
  const runArgs = cliTest
    ? []
    : [
      '--require',
      '@babel/register',
      '--exclude',
      'tests/**',
      '--silent',
      '--no-clean',
      require.resolve('mocha/bin/mocha'),
    ];

  const mochaArgs = cliTest
    ? ['tests/cli.js']
    : ['--grep', 'precompile cli', '--invert', 'tests'];

  return new Promise((resolve, reject) => {
    try {
      const proc = spawn(
        bin,
        [
          ...runArgs,
          '-R',
          'spec',
          '-r',
          'tests/setup',
          '-r',
          '@babel/register',
          ...mochaArgs,
        ],
        {
          cwd: path.join(__dirname, '../..'),
          env: process.env,
        }
      );

      proc.stdout.pipe(process.stdout);
      proc.stderr.pipe(process.stderr);

      proc.on('error', (err) => reject(err));

      proc.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('test failed. nyc/mocha exit code: ' + code));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Function to run browser-based tests using Puppeteer
async function runPuppeteerTest(pageUrl) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Navigate to the test page
  await page.goto(pageUrl);

  // Wait for the tests to complete
  await page.waitForFunction('window.tests_failed !== undefined');

  const failures = await page.evaluate(() => window.tests_failed);

  // Extract coverage data from the browser
  const coverage = await page.evaluate(() => window.__coverage__);

  if (coverage) {
    const coveragePath = path.join(process.cwd(), '.nyc_output', `browser.${Date.now()}.json`);
    fs.writeFileSync(coveragePath, JSON.stringify(coverage));
  }

  await browser.close();

  // Check if any tests failed
  if (failures > 0) {
    throw new Error(`${failures} tests failed on ${pageUrl}`);
  }
}

// Main test runner function
function runtests() {
  return new Promise((resolve, reject) => {
    let server;

    // Sequence for running Node.js tests using Mocha
    const mochaPromise = promiseSequence([
      () => mochaRun({ cliTest: false }),
      () => mochaRun({ cliTest: true }),
    ]);

    // After Node.js tests, run browser tests
    return mochaPromise
      .then(() => getStaticServer()) // Start the static server to serve browser tests
      .then((args) => {
        server = args[0]; // Get the server instance
        const port = args[1]; // Get the assigned port

        // List of browser test pages
        const testPages = ['index', 'slim'].map(
          (f) => `http://localhost:${port}/tests/browser/${f}.html`
        );

        // Run Puppeteer tests on all test pages
        const puppeteerPromises = testPages.map((pageUrl) => () =>
          runPuppeteerTest(pageUrl)
        );

        // Run the browser tests in sequence
        return promiseSequence(puppeteerPromises).then(() => {
          server.close(); // Close the server when done
          resolve();
        });
      })
      .catch((err) => {
        if (server) {
          server.close();
        }
        reject(err);
      });
  });
}

module.exports = runtests;
