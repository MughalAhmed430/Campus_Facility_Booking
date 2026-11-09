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

  // Registration, at the narrowest width. The test server's fake DNS knows that
  // examoke.com does not exist; every other domain has an MX record.
  {
    const { page } = await t.newPage({ width: 320, height: 800 });
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

    const email = `new.student.${Date.now()}@kdu.example`;
    await page.fill('#register-email', email);
    await Promise.all([page.waitForURL(/login\.html\?registered=1/), page.click('#register-form button[type=submit]')]);
    await page.waitForSelector('#login-alert .alert--success');
    t.check('register: success goes to sign in with a confirmation', (await page.textContent('#login-alert')).includes('Your account has been created'));
    t.check('register: the new email is pre-filled', (await page.inputValue('#login-email')) === email);
    await t.axe(page, 'login after registration (success alert)');

    await page.fill('#login-password', 'Password123');
    await Promise.all([page.waitForURL(/facilities\.html/), page.click('#login-form button[type=submit]')]);
    t.check('register: the new account can sign in and lands on Facilities', page.url().endsWith('/pages/facilities.html'));
  }
}
