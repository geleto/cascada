
import {spawn} from 'child_process';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    } catch (err) {
      console.error(err);
      resolve(1);
      return;
    }
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code || 0));
  });
}

function npmRunArgs(args) {
  return process.platform === 'win32'
    ? {cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd', ...args]}
    : {cmd: 'npm', args};
}

(async () => {
  // Ensure NODE_ENV=test for all steps
  const env = { ...process.env, NODE_ENV: 'test' };

  const build = npmRunArgs(['run', 'build']);
  const buildCode = await run(build.cmd, build.args, { env });
  if (buildCode !== 0) process.exit(buildCode);

  const precompileCode = await run('node', ['scripts/runprecompile.js'], { env });
  if (precompileCode !== 0) process.exit(precompileCode);

  // Run browser tests first
  const browser = npmRunArgs(['run', 'test:browser']);
  const browserCode = await run(browser.cmd, browser.args, { env });

  const node = npmRunArgs(['run', 'test:node']);
  const nodeCode = await run(node.cmd, node.args, { env });

  // Report combined results
  await run('node', ['scripts/report-results.js'], { env });

  process.exit(nodeCode !== 0 || browserCode !== 0 ? 1 : 0);
})();

