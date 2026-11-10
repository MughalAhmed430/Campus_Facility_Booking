// Shared helpers for the browser checks: a PASS/FAIL log, pages that record console
// errors and CSP violations, axe-core accessibility scans, and an overflow test.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** Demo accounts from database/seed.sql. */
export const ACCOUNTS = {
  student: { email: 'minjun.kim@kdu.example', password: 'Student@2026' },
  admin: { email: 'admin@kdu.example', password: 'Admin@2026' },
};

/** Viewport widths for the responsive checks: small phones up to a full HD desktop. */
export const WIDTHS = [320, 360, 390, 414, 768, 1024, 1280, 1440, 1920];

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA, plus axe's best-practice rules. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

// The pages cause some 4xx responses on purpose (signed-out /api/auth/me, a wrong password,
// a duplicate email, an unknown facility, an invalid filter). The browser logs each one as
// a console error; they are counted separately instead of failing the run.
const EXPECTED_HTTP_ERROR = /Failed to load resource: the server responded with a status of (400|401|404|409)/;

export class Harness {
  results = [];
  consoleProblems = [];
  expectedHttpErrors = 0;
  #contexts = new Set();
  #expectedConsoleErrors = [];

  /**
   * db: the in-memory test database, for checks that set up data directly.
   * screenshotDir: where screenshot() saves PNGs, or null to skip screenshots.
   */
  constructor({ browser, baseUrl, db, screenshotDir = null }) {
    this.browser = browser;
    this.baseUrl = baseUrl;
    this.db = db;
    this.screenshotDir = screenshotDir;
    if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
  }

  check(name, ok, detail = '') {
    this.results.push({ name, ok: Boolean(ok) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -- ${detail}` : ''}`);
  }

  get failures() {
    return this.results.filter((result) => !result.ok);
  }

  /**
   * The next console error matching `pattern` is caused on purpose (e.g. a check that
   * makes the API fail with 500) and is counted with the expected HTTP errors instead.
   */
  expectConsoleError(pattern) {
    this.#expectedConsoleErrors.push(pattern);
  }

  /** A page in its own browser context (separate cookies). cookies: sign the context in. */
  async newPage({ width = 1280, height = 900, cookies } = {}) {
    const context = await this.browser.newContext({ viewport: { width, height } });
    this.#contexts.add(context);
    context.setDefaultTimeout(10_000);
    if (cookies) await context.addCookies(cookies);
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) =>
        console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline code'}`));
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const expected = this.#expectedConsoleErrors.findIndex((pattern) => pattern.test(message.text()));
      if (expected !== -1) this.#expectedConsoleErrors.splice(expected, 1);
      if (expected !== -1 || EXPECTED_HTTP_ERROR.test(message.text())) {
        this.expectedHttpErrors += 1;
        return;
      }
      this.consoleProblems.push(`${page.url()} :: ${message.text()}`);
    });
    page.on('pageerror', (error) => this.consoleProblems.push(`${page.url()} :: uncaught ${error.message}`));
    return { context, page };
  }

  /** Closes every context opened by newPage() (also after a check run stops on an error). */
  async closePages() {
    await Promise.all([...this.#contexts].map((context) => context.close()));
    this.#contexts.clear();
  }

  /** Signs in through the real sign-in form and waits until the page has moved on. */
  async signIn(page, { email, password }, next) {
    await page.goto(`${this.baseUrl}/pages/login.html${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    await page.fill('#login-email', email);
    await page.fill('#login-password', password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.endsWith('/login.html')),
      page.click('#login-form button[type=submit]'),
    ]);
  }

  /** Runs axe-core on the page as it is now; any violation fails the check. */
  async axe(page, label) {
    await page.evaluate(AXE_SOURCE);
    const { violations, incomplete } = await page.evaluate(async (tags) => {
      const result = await window.axe.run(document, {
        runOnly: { type: 'tag', values: tags },
        resultTypes: ['violations', 'incomplete'],
      });
      const summarize = (rule) => ({
        id: rule.id,
        impact: rule.impact,
        help: rule.help,
        nodes: rule.nodes.slice(0, 3).map((node) => node.target.join(' ')
          + (node.failureSummary ? ` | ${node.failureSummary.replace(/\s+/g, ' ').slice(0, 160)}` : '')),
      });
      return {
        violations: result.violations.map(summarize),
        incomplete: result.incomplete.filter((rule) => rule.id === 'color-contrast').map(summarize),
      };
    }, AXE_TAGS);
    this.check(`axe WCAG 2.2 AA + best practice: ${label}`, violations.length === 0,
      violations.map((rule) => `${rule.id} (${rule.impact}): ${rule.help} @ ${rule.nodes.join(' ; ')}`).join(' || '));
    // axe cannot measure contrast over gradients, pseudo-element backgrounds or images:
    // those colours need a manual check (see README, Browser checks).
    if (incomplete.length > 0) {
      console.log(`      note: axe could not decide colour contrast on ${label}: ${incomplete[0].nodes.join(' ; ')}`);
    }
  }

  /** Fails if the page scrolls sideways, naming up to four elements that stick out. */
  async noHorizontalOverflow(page, label) {
    const info = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const offenders = [];
      for (const element of document.querySelectorAll('body *')) {
        if (element.classList.contains('visually-hidden')) continue;
        if (element.closest('.table-wrap')) continue; // wide tables scroll inside their own frame
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.right > viewport + 1) {
          const classes = [...element.classList].map((name) => `.${name}`).join('');
          offenders.push(`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes} right=${Math.round(rect.right)}`);
        }
      }
      return { scrollWidth: document.documentElement.scrollWidth, viewport, offenders: offenders.slice(0, 4) };
    });
    this.check(`no horizontal scroll: ${label}`, info.scrollWidth <= info.viewport && info.offenders.length === 0,
      `scrollWidth=${info.scrollWidth} viewport=${info.viewport} ${info.offenders.join(', ')}`);
  }

  /** Saves a full-page screenshot when the run was started with --screenshots. */
  async screenshot(page, name) {
    if (!this.screenshotDir) return;
    await page.screenshot({ path: path.join(this.screenshotDir, `${name}.png`), fullPage: true });
  }
}

/** Waits until the facility list has finished loading and shows something. */
export async function waitForResults(page) {
  await page.waitForFunction(() => {
    const results = document.getElementById('results');
    return results && !results.hasAttribute('aria-busy') && results.children.length > 0;
  });
}

export function cardCount(page) {
  return page.locator('#results article.card').count();
}
