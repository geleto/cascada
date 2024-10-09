/* eslint-disable func-names */
const puppeteer = require('puppeteer');
const spawn = require('child_process').spawn;
const getStaticServer = require('./static-server');
const path = require('path');
const fs = require('fs');
const { createInstrumenter } = require('istanbul-lib-instrument');
const { createCoverageMap } = require('istanbul-lib-coverage');
const istanbulReports = require('istanbul-reports');
const libReport = require('istanbul-lib-report');

const utils = require('./utils');
const lookup = utils.lookup;
const promiseSequence = utils.promiseSequence;

function mochaRun({cliTest = false} = {}) {
  const bin = lookup((cliTest) ? '.bin/mocha' : '.bin/nyc', true);
  const runArgs = (cliTest)
    ? []
    : [
      '--require', '@babel/register',
      '--exclude',
      'tests/**',
      '--silent',
      '--no-clean',
      require.resolve('mocha/bin/mocha'),
    ];

  const mochaArgs = (cliTest)
    ? ['tests/cli.js']
    : ['--grep', 'precompile cli', '--invert', 'tests'];

  return new Promise((resolve, reject) => {
    try {
      const proc = spawn(bin, [
        ...runArgs,
        '-R', 'spec',
        '-r', 'tests/setup',
        '-r', '@babel/register',
        ...mochaArgs,
      ], {
        cwd: path.join(__dirname, '../..'),
        env: process.env
      });

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

function instrumentCode(code, filename) {
  try {
    const instrumenter = createInstrumenter({
      esModules: true,
      produceSourceMap: true,
      autoWrap: true,
      preserveComments: true,
      coverageVariable: '__coverage__'
    });
    const instrumentedCode = instrumenter.instrumentSync(code, filename);
    console.log(`Successfully instrumented: ${filename}`);
    return instrumentedCode;
  } catch (error) {
    console.error(`Error instrumenting ${filename}:`, error);
    return code; // Return original code if instrumentation fails
  }
}

function serveInstrumentedFiles(app) {
  const originalStatic = app.static;
  app.static = function(root, options) {
    return function(req, res, next) {
      const filePath = path.join(root, req.path);
      if (path.extname(filePath) === '.js') {
        fs.readFile(filePath, 'utf8', (err, content) => {
          if (err) return next(err);
          try {
            const instrumentedCode = instrumentCode(content, req.path);
            res.type('application/javascript');
            res.send(instrumentedCode);
          } catch (instrumentError) {
            console.error(`Error instrumenting file ${req.path}:`, instrumentError);
            res.status(500).send('Error instrumenting file');
          }
          return undefined;
        });
      } else {
        originalStatic(root, options)(req, res, next);
      }
    };
  };
}

async function runPuppeteerTests(url) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    window.__coverage__ = {};
  });

  await page.goto(url);

  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const element = document.querySelector('#mocha-stats');
        if (element) {
          clearInterval(interval);
          resolve({
            passes: parseInt(element.querySelector('.passes em').innerText, 10),
            failures: parseInt(element.querySelector('.failures em').innerText, 10),
            coverage: window.__coverage__ || {}
          });
        }
      }, 100);
    });
  });

  await browser.close();

  if (result.failures > 0) {
    throw new Error(`${result.failures} test(s) failed`);
  }

  console.log(`${result.passes} test(s) passed`);

  return result.coverage;
}

async function runtests() {
  let server;
  let coverageMap = createCoverageMap({});

  try {
    // Run Node.js tests with nyc
    await promiseSequence([
      () => mochaRun({cliTest: false}),
      () => mochaRun({cliTest: true}),
    ]);

    // Read nyc coverage data
    const nycOutputDir = path.join(process.cwd(), '.nyc_output');
    if (fs.existsSync(nycOutputDir)) {
      console.log(`NYC output directory found at ${nycOutputDir}`);
      const files = fs.readdirSync(nycOutputDir);
      const coverageFiles = files.filter(file => file.endsWith('.json') && file !== 'coverage.json');

      if (coverageFiles.length > 0) {
        console.log(`Found ${coverageFiles.length} coverage file(s)`);
        coverageFiles.forEach(file => {
          const filePath = path.join(nycOutputDir, file);
          const coverage = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          coverageMap.merge(createCoverageMap(coverage));
        });
        console.log('Node.js test coverage data loaded.');
      } else {
        console.log('No coverage files found in .nyc_output');
      }
    } else {
      console.error(`NYC output directory not found at ${nycOutputDir}`);
    }

    // Run browser tests with Puppeteer
    const [serverInstance, port] = await getStaticServer();
    server = serverInstance;
    serveInstrumentedFiles(server);

    const browserTests = [
      () => runPuppeteerTests(`http://localhost:${port}/tests/browser/index.html`),
      () => runPuppeteerTests(`http://localhost:${port}/tests/browser/slim.html`)
    ];

    try {
      const browserCoverages = await Promise.all(browserTests.map(test => test()));
      browserCoverages.forEach(browserCoverage => {
        if (Object.keys(browserCoverage).length > 0) {
          coverageMap.merge(createCoverageMap(browserCoverage));
        } else {
          console.warn('Browser test completed but no coverage data was collected');
        }
      });
    } catch (error) {
      console.error('Error running browser test:', error);
    }

    server.close();

    // Generate combined coverage report
    const context = libReport.createContext({
      dir: './coverage',
      coverageMap: coverageMap
    });

    const reports = [
      istanbulReports.create('lcov'),
      istanbulReports.create('text-summary'),
      istanbulReports.create('json')
    ];

    reports.forEach(report => report.execute(context));

    console.log('Combined coverage report generated in ./coverage directory');
  } catch (err) {
    console.error('Error in runtests:', err);
    if (server) {
      server.close();
    }
    throw err;
  }
}

module.exports = runtests;
