/* eslint-disable no-console */
import {execSync} from 'child_process';

// Skip installation in production or CI environments
if (process.env.NODE_ENV === 'production' || process.env.CI) {
  //console.log('Skipping Playwright installation in production/CI environment');
  process.exit(0);
}

try {
  console.log('Installing Playwright in development environment...');
  execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' });
} catch (error) {
  console.error('Failed to install Playwright:', error);
  process.exit(1);
}
