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

  // Run browser tests first
  const browserCode = await run('npm', ['run', 'test:browser'], { env });

  const nodeCode = await run('npm', ['run', 'test:node'], { env });

  // Report combined results
  await run('node', ['scripts/report-results.js'], { env });

  process.exit(nodeCode !== 0 || browserCode !== 0 ? 1 : 0);
})();


