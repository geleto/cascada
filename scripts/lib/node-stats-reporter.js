'use strict';

const fs = require('fs');
const path = require('path');
const Mocha = require('mocha');

/**
 * Custom Mocha reporter that extends Spec and writes Node test stats
 * to coverage/node-tests-stats.json for aggregation by the browser runner.
 */
class NodeStatsReporter extends Mocha.reporters.Spec {
  constructor(runner, options) {
    super(runner, options);

    runner.once('end', () => {
      try {
        const stats = this.stats || {};
        const outDir = path.join(__dirname, '../../coverage');
        const outFile = path.join(outDir, 'node-tests-stats.json');
        try {
          fs.mkdirSync(outDir, { recursive: true });
		  // eslint-disable-next-line no-empty
        } catch (_) {}
        fs.writeFileSync(outFile, JSON.stringify({
          tests: stats.tests || 0,
          passes: stats.passes || 0,
          failures: stats.failures || 0,
          pending: stats.pending || 0,
          duration: stats.duration || 0
        }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to write node test stats:', err);
      }
    });
  }
}

module.exports = NodeStatsReporter;


