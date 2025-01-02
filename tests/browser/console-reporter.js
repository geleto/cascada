/* eslint-disable no-console */

export class ConsoleReporter {
  constructor(runner) {
    const stats = runner.stats;
    const testResults = new Map();
    const failedTests = [];
    let failureCount = 0;

    runner.on('suite', (suite) => {
      if (suite.root) return;
      console.log('\n  ' + suite.title);
    });

    runner.on('test end', (test) => {
      const result = testResults.get(test.title);
      if (result) {
        let symbol;
        if (result.failed) {
          failureCount++;
          symbol = `× ${failureCount})`;
        } else if (result.pending) {
          symbol = '∘';
        } else {
          symbol = '√';
        }
        const duration = test.duration > 100 ? ` (${test.duration}ms)` : '';
        console.log(`    ${symbol} ${test.title}${duration}`);
      }
    });

    runner.on('pass', (test) => {
      if (!testResults.has(test.title)) {
        testResults.set(test.title, { passed: true });
      }
    });

    runner.on('fail', (test, err) => {
      const result = testResults.get(test.title) || {};
      result.failed = true;
      result.error = err;
      testResults.set(test.title, result);
      failedTests.push({ test, err });
    });

    runner.on('pending', (test) => {
      if (!testResults.has(test.title)) {
        testResults.set(test.title, { pending: true });
      }
    });

    runner.on('end', () => {
      let passingTests = 0;
      let failingTests = 0;
      let pendingTests = 0;

      for (const result of testResults.values()) {
        if (result.failed) failingTests++;
        else if (result.pending) pendingTests++;
        else passingTests++;
      }

      console.log(`\n  ${passingTests} passing (${stats.duration}ms)`);
      if (failingTests) {
        console.log(`  ${failingTests} failing`);
      }
      if (pendingTests) {
        console.log(`  ${pendingTests} pending`);
      }

      if (failedTests.length > 0) {
        console.log('\nFailed Tests:');
        failedTests.forEach(({ test, err }, index) => {
          console.log(`\n  ${index + 1}) ${test.title}`);
          console.log(`    Error: ${err.message}`);
          console.log('    Stack:');
          err.stack.split('\n').forEach(line => console.log(`      ${line.trim()}`));
        });
      }
    });
  }
}
