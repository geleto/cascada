/* eslint-disable no-console */
'use strict';

const fs = require('fs').promises;
const path = require('path');
const libCoverage = require('istanbul-lib-coverage');
const NYC = require('nyc');
let chalk;

const coverageConfig = {
  dir: path.join(__dirname, '../coverage'),
  files: [
    'browser-std.json',
    'browser-slim.json',
    'coverage-final.json' // Node coverage
  ],
  getFullPath: (file) => path.join(coverageConfig.dir, file)
};

(async () => {
  chalk = await import('tiny-chalk');

  // Load stats
  let nodeStats = { passes: 0, failures: 0, pending: 0, duration: 0 };
  let browserStats = { passes: 0, failures: 0, pending: 0, duration: 0 };

  try {
    const nodeStatsData = await fs.readFile(path.join(coverageConfig.dir, 'node-tests-stats.json'), 'utf8');
    nodeStats = JSON.parse(nodeStatsData);
  } catch (e) {
    // ignore
  }

  try {
    const browserStatsData = await fs.readFile(path.join(coverageConfig.dir, 'browser-tests-stats.json'), 'utf8');
    browserStats = JSON.parse(browserStatsData);
  } catch (e) {
    // ignore
  }

  const combinedPassed = (nodeStats.passes || 0) + (browserStats.passes || 0);
  const combinedFailed = (nodeStats.failures || 0) + (browserStats.failures || 0);
  const combinedPending = (nodeStats.pending || 0) + (browserStats.pending || 0);
  const combinedDuration = (nodeStats.duration || 0) + (browserStats.duration || 0);

  const durationSec = Math.round(combinedDuration / 1000);

  console.log('\nCombined Coverage Summary from Node and browser tests:');

  // Merge Coverage
  const coverageMap = libCoverage.createCoverageMap({});
  for (const file of coverageConfig.files) {
    try {
      const content = await fs.readFile(coverageConfig.getFullPath(file), 'utf8');
      const fileCoverageMap = libCoverage.createCoverageMap(JSON.parse(content));
      coverageMap.merge(fileCoverageMap);
    } catch (e) {
      // console.error(`Skipping coverage file ${file}: ${e.message}`);
    }
  }

  // Write to NYC temp dir for reporting
  const nycTempDir = path.join(coverageConfig.dir, '.nyc_output');
  await fs.mkdir(nycTempDir, { recursive: true });

  const coverageData = coverageMap.toJSON();
  for (const [filePath, fileCoverage] of Object.entries(coverageData)) {
    const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.json`;
    await fs.writeFile(
      path.join(nycTempDir, fileName),
      JSON.stringify({ [filePath]: fileCoverage })
    );
  }

  const reportNyc = new NYC({
    include: ['src/**/*.js'],
    reporter: ['text', 'html', 'lcov'],
    showProcessTree: false,
    tempDir: nycTempDir,
    cacheDir: nycTempDir,
    cwd: path.join(__dirname, '..')
  });

  await reportNyc.report();

  console.log('\nTOTALS:');
  console.log(chalk.green(`${combinedPassed} passing (${durationSec}s)`));
  console.log(chalk.cyan(`${combinedPending} pending`));
  console.log(chalk.red(`${combinedFailed} failing (${nodeStats.failures} node, ${browserStats.failures} browser)\n`));

})();
