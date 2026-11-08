// Browser checks: the real app in a real browser engine.
//
//   npm run test:browser                       all checks, in Microsoft Edge
//   npm run test:browser -- --screenshots      also save screenshots in tests/browser/screenshots/
//   npm run test:browser -- --only layout      one group (public-pages, facilities or layout)
//   npm run test:browser -- --browser chrome   use Google Chrome instead of Edge
//   npm run test:browser -- --headed           show the browser window
//
// The app runs in this process on a random port, backed by a fresh in-memory PostgreSQL
// (PGlite) loaded from database/schema.sql and seed.sql, exactly like `npm test`. The
// database in server/.env is never used. Edge or Chrome must be installed; Playwright
// drives the installed browser, so no browser download is needed.
//
// Prints PASS/FAIL per check and a summary; the exit code is 1 if any check failed or a
// page logged an unexpected console error or CSP violation.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { startTestServer } from '../../server/tests/helpers/test-server.js';
import { Harness } from './harness.js';
import facilities from './checks/facilities.js';
import layout from './checks/layout.js';
import publicPages from './checks/public-pages.js';

const GROUPS = { 'public-pages': publicPages, facilities, layout };

const { values: options } = parseArgs({
  options: {
    screenshots: { type: 'boolean', default: false },
    only: { type: 'string' },
    browser: { type: 'string', default: 'msedge' },
    headed: { type: 'boolean', default: false },
  },
});

if (options.only && !GROUPS[options.only]) {
  console.error(`Unknown group "${options.only}". Groups: ${Object.keys(GROUPS).join(', ')}`);
  process.exit(2);
}
const groups = options.only ? { [options.only]: GROUPS[options.only] } : GROUPS;
const channel = { edge: 'msedge', msedge: 'msedge', chrome: 'chrome' }[options.browser];
if (!channel) {
  console.error(`Unknown browser "${options.browser}". Use msedge or chrome.`);
  process.exit(2);
}

const server = await startTestServer();
let browser;
try {
  browser = await chromium.launch({ channel, headless: !options.headed });
} catch (error) {
  await server.close();
  console.error(`Could not start ${channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'}: ${error.message.split('\n')[0]}`);
  console.error('Install it, or pick the other one with --browser chrome / --browser msedge.');
  process.exit(2);
}

const screenshotDir = options.screenshots ? path.join(import.meta.dirname, 'screenshots') : null;
const t = new Harness({ browser, baseUrl: server.baseUrl, screenshotDir });
console.log(`Browser checks: ${channel} ${browser.version()} against ${server.baseUrl} (in-memory database)`);

const started = performance.now();
try {
  for (const [name, run] of Object.entries(groups)) {
    console.log(`\n## ${name}`);
    try {
      await run(t);
    } catch (error) {
      // A step that times out or throws ends its group; the other groups still run.
      t.check(`${name}: the group ran to the end`, false, error.message.split('\n')[0]);
    } finally {
      await t.closePages();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const failed = t.failures;
console.log('\n## Console errors and CSP violations');
console.log(t.consoleProblems.length > 0 ? t.consoleProblems.join('\n') : '(none)');
console.log(`(${t.expectedHttpErrors} expected 4xx responses logged by the browser were not counted)`);
if (failed.length > 0) console.log(`\nFailed:\n${failed.map((result) => `  ${result.name}`).join('\n')}`);
if (screenshotDir) console.log(`\nScreenshots: ${screenshotDir}`);
console.log(`\n${t.results.length - failed.length} passed, ${failed.length} failed, `
  + `${t.consoleProblems.length} console problems (${Math.round((performance.now() - started) / 1000)}s)`);
process.exitCode = failed.length > 0 || t.consoleProblems.length > 0 ? 1 : 0;
