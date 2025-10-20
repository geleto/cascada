'use strict';

const { spawn } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
    child.on('exit', (code) => resolve(code || 0));
  });
}

(async () => {
  // Ensure NODE_ENV=test for all steps
  const env = { ...process.env, NODE_ENV: 'test' };

  const buildCode = await run('npm', ['run', 'build'], { env });
  if (buildCode !== 0) process.exit(buildCode);

  const precompileCode = await run('node', ['scripts/runprecompile.js'], { env });
  if (precompileCode !== 0) process.exit(precompileCode);

  const nodeCode = await run('npm', ['run', 'test:node'], { env });

  // Always run browser tests, passing fullTest so the runner merges coverage and totals
  const browserCode = await run('npm', ['run', 'test:browser', '--', 'fullTest'], { env });

  process.exit(nodeCode !== 0 || browserCode !== 0 ? 1 : 0);
})();


