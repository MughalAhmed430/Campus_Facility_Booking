// Signed-out visitor: home page, sign-in and registration.
import { ACCOUNTS } from '../harness.js';

/** @param {import('../harness.js').Harness} t */
export default async function publicPages(t) {
  const base = t.baseUrl;

  // Home and protected pages
  {
    const { page } = await t.newPage();
    await page.goto(`${base}/`);
    await page.waitForSelector('.nav__link');
    t.check('home: hero heading', (await page.textContent('h1')).includes('Book classrooms'));
    t.check('home: guest navigation is Sign in + Register',
      JSON.stringify(await page.$$eval('.nav__link', (links) => links.map((link) => link.textContent))) === '["Sign in","Register"]');
    t.check('home: no facility data shown to guests', (await page.locator('article.card').count()) === 0);
    await t.axe(page, 'home (signed out)');

    for (const target of ['/pages/facilities.html', '/pages/facility.html?id=1']) {
      await page.goto(`${base}${target}`);
      await page.waitForURL(/login\.html/);
      t.check(`guest opening ${target} is sent to sign in with next=`,
        new URL(page.url()).searchParams.get('next') === target, page.url());
    }
  }

  // Sign-in: validation, failed sign-in, open-redirect protection
  {
    const { page } = await t.newPage();
    await page.goto(`${base}/pages/login.html`);
    await page.waitForSelector('.nav__link');
    await page.click('#login-form button[type=submit]');
    const invalid = await page.$$eval('[aria-invalid="true"]', (fields) => fields.map((field) => field.name));
    t.check('login: empty submit marks email and password invalid', JSON.stringify(invalid) === '["email","password"]', JSON.stringify(invalid));
    const describedBy = await page.getAttribute('#login-email', 'aria-describedby');
    t.check('login: error text is linked with aria-describedby',
      Boolean(describedBy) && (await page.textContent(`#${describedBy}`)) === 'Email is required.');
    t.check('login: focus moves to the first invalid field', await page.evaluate(() => document.activeElement.id === 'login-email'));
    await t.axe(page, 'login with field errors');

    await page.fill('#login-email', ACCOUNTS.student.email);
    await page.fill('#login-password', 'wrong-password');
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#login-alert .alert--danger');
    t.check('login: wrong password shows "Invalid email or password."',
      (await page.textContent('#login-alert')).includes('Invalid email or password.'));
    t.check('login: wrong password clears and focuses the password field',
      await page.evaluate(() => document.activeElement.id === 'login-password' && document.activeElement.value === ''));
    await t.axe(page, 'login with failed sign-in alert');

    await t.signIn(page, ACCOUNTS.student, 'https://evil.example/steal');
    t.check('login: ?next= pointing to another site is ignored',
      new URL(page.url()).origin === base && page.url().includes('/pages/facilities.html'), page.url());
  }

  // Registration
  {
    const { page } = await t.newPage();
    await page.goto(`${base}/pages/register.html`);
    await page.waitForSelector('.nav__link');
    await page.click('#register-form button[type=submit]');
    const invalid = await page.$$eval('[aria-invalid="true"]', (fields) => fields.map((field) => field.name));
    t.check('register: empty submit flags name, email, password, confirmation',
      JSON.stringify(invalid) === '["fullName","email","password","confirmPassword"]', JSON.stringify(invalid));
    t.check('register: the password hint stays linked next to the error',
      (await page.getAttribute('#register-password', 'aria-describedby')).includes('register-password-hint'));
    await t.axe(page, 'register with field errors');

    await page.fill('#register-name', 'Test Student');
    await page.fill('#register-email', ACCOUNTS.student.email); // already registered
    await page.fill('#register-password', 'Password123');
    await page.fill('#register-confirm', 'Password124');
    await page.click('#register-form button[type=submit]');
    t.check('register: mismatched confirmation is caught in the browser',
      (await page.textContent('#register-form')).includes('The passwords do not match.'));

    await page.fill('#register-confirm', 'Password123');
    await page.fill('#register-student-number', 'ab');
    await page.click('#register-form button[type=submit]');
    t.check('register: short student number is caught', (await page.textContent('#register-form')).includes('4-20 letters or digits'));

    await page.fill('#register-student-number', '');
    await page.click('#register-form button[type=submit]');
    await page.waitForSelector('#register-email[aria-invalid="true"]');
    const errorId = (await page.getAttribute('#register-email', 'aria-describedby')).split(' ').pop();
    const emailError = await page.textContent(`#${errorId}`);
    t.check('register: an existing email shows the server error under the email field',
      emailError === 'An account with this email address already exists.', emailError);
  }

  await emailVerification(t);
}

/**
 * A new account from registration to first sign-in, through the verification email.
 * Runs at 320px, the narrowest layout, checking each new state for overflow and with axe.
 * Emails land in the test server's outbox; the checks open the link from it.
 * @param {import('../harness.js').Harness} t
 */
async function emailVerification(t) {
  const base = t.baseUrl;
  const email = `new.student.${Date.now()}@kdu.example`;
  const password = 'Password123';
  const { page } = await t.newPage({ width: 320, height: 800 });
  const mainText = () => page.textContent('main');

  // Register: "Check your email" instead of going to sign in
  await page.goto(`${base}/pages/register.html`);
  await page.waitForSelector('#register-form');
  await page.fill('#register-name', 'Test Student');
  await page.fill('#register-email', email);
  await page.fill('#register-password', password);
  await page.fill('#register-confirm', password);
  await page.click('#register-form button[type=submit]');
  await page.waitForSelector('h1:has-text("Check your email")');
  t.check('register: success shows "Check your email" with the address, and stays on the page',
    page.url().endsWith('/pages/register.html') && (await mainText()).includes(email), page.url());
  t.check('register: focus moves to the "Check your email" heading', await page.evaluate(() => document.activeElement.tagName === 'H1'));
  t.check('register: a verification email was sent to the new address', Boolean(t.server.lastEmailTo(email)));
  await t.noHorizontalOverflow(page, 'register "check your email" @ 320px');
  await t.axe(page, 'register "check your email" @ 320px');
  await t.screenshot(page, 'register-check-email-320');

  await page.click('#register-resend');
  await page.waitForSelector('#register-alert .alert--success');
  t.check('register: "Send a new link" answers with the generic message',
    (await page.textContent('#register-alert')).includes('If an account with this email address'));

  // Sign in before confirming: its own state, with a resend action
  await Promise.all([page.waitForURL(/login\.html/), page.click('.auth-card__switch a')]);
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#login-alert .alert--warning');
  const warning = await page.textContent('#login-alert');
  t.check('login: an unconfirmed account gets "Confirm your email address first", not "Sign-in failed"',
    warning.includes('Confirm your email address first') && !warning.includes('Sign-in failed'), warning);
  t.check('login: the warning is announced (role="alert")', (await page.getAttribute('#login-alert .alert', 'role')) === 'alert');
  t.check('login: the password stays filled in', (await page.inputValue('#login-password')) === password);
  await t.noHorizontalOverflow(page, 'login "confirm your email first" @ 320px');
  await t.axe(page, 'login "confirm your email first" @ 320px');
  await t.screenshot(page, 'login-not-verified-320');

  const sentBefore = t.server.outbox.length;
  await page.click('#login-alert button');
  await page.waitForSelector('#login-alert .alert--success');
  t.check('login: "Send a new confirmation email" sends one and says so',
    t.server.outbox.length === sentBefore + 1 && (await page.textContent('#login-alert')).includes('Check your email'));
  t.check('login: focus moves to that message (the button is gone)',
    await page.evaluate(() => Boolean(document.activeElement.closest('#login-alert'))));
  await t.axe(page, 'login "new confirmation email sent" @ 320px');

  // An expired link offers a new one
  await t.expireLatestLink(email);
  await page.goto(t.verificationUrlFromEmail(email));
  await page.waitForSelector('#resend-form');
  t.check('verify: an expired link says "This link has expired"', (await page.textContent('h1')) === 'This link has expired');
  await t.noHorizontalOverflow(page, 'verify email: expired @ 320px');
  await t.axe(page, 'verify email: expired @ 320px');
  await t.screenshot(page, 'verify-expired-320');
  await page.click('#resend-form button[type=submit]');
  t.check('verify: "Send a new link" with no email shows a field error',
    (await page.getAttribute('#resend-email', 'aria-invalid')) === 'true');
  await page.fill('#resend-email', email);
  await page.click('#resend-form button[type=submit]');
  await page.waitForSelector('#resend-alert .alert--success');
  t.check('verify: asking for a new link confirms it', (await page.textContent('#resend-alert')).includes('Check your email'));
  await t.axe(page, 'verify email: new link requested @ 320px');

  // The newest link confirms the address; sign-in then fills in the email
  const link = t.verificationUrlFromEmail(email);
  await page.goto(link);
  await page.waitForSelector('h1:has-text("Email address confirmed")');
  t.check('verify: the newest link confirms the address', true);
  t.check('verify: focus is on the result heading', await page.evaluate(() => document.activeElement.id === 'verify-title'));
  await t.noHorizontalOverflow(page, 'verify email: confirmed @ 320px');
  await t.axe(page, 'verify email: confirmed @ 320px');
  await t.screenshot(page, 'verify-confirmed-320');
  await Promise.all([page.waitForURL(/login\.html\?verified=1/), page.click('main a:has-text("Sign in")')]);
  await page.waitForSelector('#login-alert .alert--success');
  t.check('login: after confirming, it says so and fills in the email',
    (await page.textContent('#login-alert')).includes('Your email address is confirmed') && (await page.inputValue('#login-email')) === email);
  await page.fill('#login-password', password);
  await Promise.all([page.waitForURL(/facilities\.html/), page.click('#login-form button[type=submit]')]);
  t.check('the confirmed account signs in and lands on Facilities', true);

  // The same link again, and broken links
  await page.goto(link);
  await page.waitForSelector('h1:has-text("This link has already been used")');
  t.check('verify: a used link says so and offers Sign in', (await page.locator('main a.btn:has-text("Sign in")').count()) === 1);
  await t.axe(page, 'verify email: already used @ 320px');

  await page.goto(`${base}/pages/verify-email.html?token=${'x'.repeat(43)}`);
  await page.waitForSelector('#resend-form');
  t.check('verify: an unknown link says "This link is not valid" and explains why',
    (await page.textContent('h1')) === 'This link is not valid' && (await mainText()).includes('a newer link may have replaced it'));
  await page.goto(`${base}/pages/verify-email.html`);
  await page.waitForSelector('#resend-form');
  t.check('verify: a link without a token says it is incomplete', (await mainText()).includes('This link is incomplete'));
}
