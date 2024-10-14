class ConsoleReporter {
  constructor(runner) {
    const stats = runner.stats;

    runner.on('suite', (suite) => {
      if (suite.root) return;
      console.log('\n  ' + suite.title);
    });

    runner.on('pass', (test) => {
      const symbol = '√';
      const duration = test.duration > 100 ? ` (${test.duration}ms)` : '';
      console.log(`    ${symbol} ${test.title}${duration}`);
    });

    runner.on('fail', (test) => {
      console.log(`    × ${test.title}`);
    });

    runner.on('pending', (test) => {
      console.log(`    ∘︎${test.title}`);
    });

    runner.on('end', () => {
      console.log(`\n  ${stats.passes} passing (${stats.duration}ms)`);
      if (stats.failures) {
        console.log(`  ${stats.failures} failing`);
      }
      if (stats.pending) {
        console.log(`  ${stats.pending} pending`);
      }
    });
  }
}