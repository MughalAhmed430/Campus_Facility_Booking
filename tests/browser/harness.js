// Shared helpers for the browser checks: a PASS/FAIL log, pages that record console
// errors and CSP violations, axe-core accessibility scans, and an overflow test.
import { createHash, randomBytes } from 'node:crypto';
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

// The pages cause some 4xx responses on purpose: signed-out /api/auth/me (401), a wrong
// password (401), an unconfirmed account signing in (403), a duplicate email or a used
// verification link (409), an expired link (410), an unknown facility (404), an invalid
// filter or link (400). The browser logs each one as a console error; they are counted
// separately instead of failing the run. The checks themselves verify each outcome.
const EXPECTED_HTTP_ERROR = /Failed to load resource: the server responded with a status of (400|401|403|404|409|410)/;

export class Harness {
  results = [];
  consoleProblems = [];
  expectedHttpErrors = 0;
  #contexts = new Set();

  /**
   * server: the test server from startTestServer() (its outbox of emails and its database).
   * screenshotDir: where screenshot() saves PNGs, or null to skip screenshots.
   */
  constructor({ browser, server, screenshotDir = null }) {
    this.browser = browser;
    this.server = server;
    this.baseUrl = server.baseUrl;
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
      if (EXPECTED_HTTP_ERROR.test(message.text())) {
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

  /** The verification page URL from the newest email sent to `email`, on this server. */
  verificationUrlFromEmail(email) {
    const message = this.server.lastEmailTo(email);
    if (!message) throw new Error(`No email was sent to ${email}`);
    const token = new URL(message.link).searchParams.get('token');
    return `${this.baseUrl}/pages/verify-email.html?token=${token}`;
  }

  /**
   * A new, unused verification link for an existing account, made directly in the test
   * database (links are single-use, and the API would email them). Verifying an account
   * that is already verified still succeeds, so a demo account works.
   */
  async freshVerificationUrl(email) {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const { affectedRows } = await this.server.db.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       SELECT id, $2, now() + interval '1 day' FROM users WHERE email = $1`,
      [email, hash],
    );
    if (affectedRows !== 1) throw new Error(`No account ${email}`);
    return `${this.baseUrl}/pages/verify-email.html?token=${token}`;
  }

  /** Makes the newest emailed link for `email` expired (as if 25 hours had passed). */
  async expireLatestLink(email) {
    const token = new URL(this.server.lastEmailTo(email).link).searchParams.get('token');
    await this.server.db.query(
      `UPDATE email_verification_tokens
       SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
       WHERE token_hash = $1`,
      [createHash('sha256').update(token).digest('hex')],
    );
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
