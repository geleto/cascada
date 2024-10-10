const puppeteer = require('puppeteer');
const mocha = require('mocha');

module.exports = async function mochaPuppeteer(url) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Forward console messages from the browser to Node.js console
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    console.log(`PAGE ${type.toUpperCase()}: ${text}`);
  });

  await page.goto(url);

  // Run the Mocha tests in the browser
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      mocha.run((failures) => {
        resolve({ failures });
      });
    });
  });

  await browser.close();

  if (result.failures) {
    throw new Error(`Test failed with ${result.failures} failures`);
  }
};
