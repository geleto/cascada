/* eslint-disable no-console */
import {execSync} from 'child_process';
import {existsSync} from 'fs';

// This script is published only so the package's postinstall hook can safely
// no-op for consumers. It should do real work only in a source checkout.
if (!existsSync('src') || !existsSync('tests')) {
  process.exit(0);
}

// Skip installation in production or CI environments.
if (process.env.NODE_ENV === 'production' || process.env.CI) {
  process.exit(0);
}

try {
  console.log('Installing Playwright in development environment...');
  execSync('npx playwright install chromium --with-deps', {stdio: 'inherit'});
} catch (error) {
  console.error('Failed to install Playwright:', error);
  process.exit(1);
}
