// Phase 7: the grouped menu (keyboard and pointer), the student-project label, facility
// rules, services, contact and photos.
import { ACCOUNTS } from '../harness.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** @param {import('../harness.js').Harness} t */
export default async function branding(t) {
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, ACCOUNTS.student, '/pages/dashboard.html');
  await page.waitForSelector('#dashboard-stats .stat');
  t.check('footer: labelled a student project; no permission line without the university logo',
    /Student project/.test(await page.textContent('.app-footer')) && !(await page.isVisible('[data-footer-credit]')));

  // ---- The menu (administrators have the grouped Facilities Office menu) -------------------
  const { page: menu } = await t.newPage({ width: 1280 });
  await t.signIn(menu, ACCOUNTS.admin, '/pages/admin/dashboard.html');
  await menu.waitForSelector('#dashboard-stats .stat');
  t.check('menu: fits in the header at 1280px', await menu.isVisible('.nav__link[href="/pages/admin/dashboard.html"]'));
  const toggle = menu.locator('.nav__group-toggle', { hasText: 'Facilities Office' });
  t.check('menu: Facilities Office starts closed', (await toggle.getAttribute('aria-expanded')) === 'false' && !(await menu.isVisible('.nav__link[href="/pages/admin/reports.html"]')));
  await toggle.focus();
  await menu.keyboard.press('Enter');
  t.check('menu: Enter opens it', (await toggle.getAttribute('aria-expanded')) === 'true' && await menu.isVisible('.nav__link[href="/pages/admin/reports.html"]'));
  await t.axe(menu, 'menu with Facilities Office open');
  await menu.keyboard.press('Tab');
  t.check('menu: Tab goes into its links', await menu.evaluate(() => document.activeElement?.getAttribute('href') === '/pages/admin/requests.html'));
  await menu.keyboard.press('Escape');
  t.check('menu: Escape closes it and returns to the button',
    (await toggle.evaluate((el) => el.getAttribute('aria-expanded'))) === 'false' && await toggle.evaluate((el) => el === document.activeElement));
  await toggle.click();
  await menu.click('h1');
  t.check('menu: a click elsewhere closes it', (await toggle.getAttribute('aria-expanded')) === 'false');

  // ---- Phone: the group opens inside the Menu panel ---------------------------------------------
  await menu.setViewportSize({ width: 390, height: 844 });
  await menu.click('.nav-toggle');
  await menu.locator('.nav__group-toggle', { hasText: 'Facilities Office' }).click();
  t.check('phone: Facilities Office opens inside the Menu panel', await menu.isVisible('.nav__link[href="/pages/admin/reports.html"]'));
  await t.noHorizontalOverflow(menu, 'menu open @ 390px');
  await t.axe(menu, 'menu open @ 390px');

  // ---- Facility details and photos ---------------------------------------------------------------
  const { rows: [lab] } = await t.db.query("SELECT id FROM facilities WHERE name = 'Physics Lab'");
  const { page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, ACCOUNTS.admin, `/pages/admin/facility-form.html?id=${lab.id}`);
  await admin.waitForSelector('#photo-form');
  t.check('admin: the form has rules, services and contact details, filled in',
    /No food or drink/.test(await admin.inputValue('[name=rules]')) && (await admin.inputValue('[name=contactEmail]')) === 'sci.office@kdu.example');
  await admin.setInputFiles('#facility-image', { name: 'lab.png', mimeType: 'image/png', buffer: PNG });
  await admin.fill('#facility-caption', 'Experiment benches');
  await admin.click('#photo-form button[type=submit]');
  await admin.waitForSelector('#photo-form .field-error');
  t.check('admin: a photo needs a credit', /Say who took the photo/.test(await admin.textContent('#photo-form')));
  await admin.fill('#facility-credit', 'Photo: browser check (sample)');
  await admin.click('#photo-form button[type=submit]');
  await admin.waitForSelector('#photo-list img');
  t.check('admin: the photo is listed with its caption and credit', /Experiment benches[\s\S]*Photo: browser check/.test(await admin.textContent('#photo-list')));
  await t.axe(admin, 'facility form with photos');

  await page.goto(`${t.baseUrl}/pages/facility.html?id=${lab.id}`);
  await page.waitForSelector('#gallery-title');
  t.check('facility page: the photo, its caption (also its alt text) and credit',
    (await page.getAttribute('.gallery__img', 'alt')) === 'Experiment benches' && /Photo: browser check/.test(await page.textContent('.gallery')));
  t.check('facility page: rules and services as lists', (await page.locator('section[aria-labelledby=rules-title] li').count()) === 3
    && /Wi-Fi/.test(await page.textContent('section[aria-labelledby=services-title]')));
  t.check('facility page: how to find it, and contact links',
    /Sample directions/.test(await page.textContent('section[aria-labelledby=location-title]'))
      && (await page.getAttribute('section[aria-labelledby=location-title] a[href^="mailto:"]', 'href')) === 'mailto:sci.office@kdu.example');
  t.check('facility page: the week is called the Facility Calendar', (await page.textContent('#schedule-title')) === 'Facility Calendar');
  await t.axe(page, 'facility page with photos');
  await t.noHorizontalOverflow(page, 'facility page with photos @ 1280px');

  await admin.locator('#photo-list li', { hasText: 'Experiment benches' }).getByRole('button', { name: /^Remove/ }).click();
  await admin.click('dialog[open] .btn--danger');
  await admin.waitForFunction(() => !document.querySelector('#photo-list'));
  t.check('admin: the photo can be removed', true);

}
