
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

function nodeRunArgs(args) {
  return process.platform === 'win32'
    ? {cmd: process.execPath, args}
    : {cmd: 'node', args};
}

(async () => {
  // Ensure NODE_ENV=test for all steps
  const env = { ...process.env, NODE_ENV: 'test', CASCADA_TEST_DIST: '1' };
  const nodeDistEnv = {
    ...env,
    NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import ./scripts/lib/register-dist-source-loader.mjs`
  };

  const build = npmRunArgs(['run', 'build']);
  const buildCode = await run(build.cmd, build.args, { env });
  if (buildCode !== 0) process.exit(buildCode);

  const precompileCode = await run('node', ['scripts/runprecompile.js'], { env });
  if (precompileCode !== 0) process.exit(precompileCode);

  // Run browser tests first
  const browser = nodeRunArgs(['scripts/run-browser-tests.js']);
  const browserCode = await run(browser.cmd, browser.args, { env });

  const node = nodeRunArgs([
    'node_modules/c8/bin/c8.js',
    '--include', 'dist/**/*.js',
    '--reporter=html',
    '--reporter=text',
    '--reporter=json',
    process.execPath,
    'scripts/run-node-tests.js'
  ]);
  const nodeCode = await run(node.cmd, node.args, { env: nodeDistEnv });

  // Report combined results
  await run('node', ['scripts/report-results.js'], { env });

  process.exit(nodeCode !== 0 || browserCode !== 0 ? 1 : 0);
})();
