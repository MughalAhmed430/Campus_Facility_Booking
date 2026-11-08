// Signed in: the facility list with search and filters, facility details, session
// expiry, sign-out, and what an administrator sees. Expects the seed data (13 facilities).
import { ACCOUNTS, cardCount, waitForResults } from '../harness.js';

/** Waits until the list shows exactly `count` facility cards. */
function waitForCards(page, count) {
  return page.waitForFunction((expected) => document.querySelectorAll('#results article').length === expected, count);
}

/** @param {import('../harness.js').Harness} t */
export default async function facilities(t) {
  const base = t.baseUrl;
  const { context, page } = await t.newPage();

  // List
  await t.signIn(page, ACCOUNTS.student, '/pages/facilities.html');
  await waitForResults(page);
  t.check('facilities: 13 facility cards', (await cardCount(page)) === 13);
  t.check('facilities: count says "13 facilities"', (await page.textContent('#result-count')) === '13 facilities');
  t.check('facilities: student navigation shows only built pages',
    JSON.stringify(await page.$$eval('.nav__link', (links) => links.map((link) => link.textContent))) === '["Facilities"]');
  t.check('facilities: Facilities is the current page', (await page.getAttribute('.nav__link', 'aria-current')) === 'page');
  t.check('facilities: badge says Bookable', (await page.locator('.badge--active').first().textContent()) === 'Bookable');
  const cardText = (name) => page.locator('#results article', { hasText: name }).textContent();
  t.check('card: a lab closed at weekends reads "Open 09:00–21:00 on weekdays"',
    (await cardText('Computer Lab A')).includes('Open 09:00–21:00 on weekdays'));
  t.check('card: a library room open at weekends reads "Open 09:00–22:00 every day"',
    (await cardText('Group Study Room A')).includes('Open 09:00–22:00 every day'));
  await t.axe(page, 'facilities list (desktop)');

  // Filters
  await page.selectOption('#filter-type', 'laboratory');
  await waitForResults(page);
  t.check('filter: type=laboratory gives 4 cards', (await cardCount(page)) === 4);
  t.check('filter: the URL keeps the filter', new URL(page.url()).searchParams.get('type') === 'laboratory');
  t.check('filter: count wording', (await page.textContent('#result-count')) === '4 facilities match your filters');

  await page.fill('#filter-q', 'eng 310');
  await waitForCards(page, 1);
  t.check('filter: search "eng 310" + laboratory gives Computer Lab A', (await page.textContent('#results article h3')) === 'Computer Lab A');
  t.check('filter: one result reads "1 facility matches your filters"', (await page.textContent('#result-count')) === '1 facility matches your filters');

  await page.click('#filter-clear');
  await waitForCards(page, 13);
  t.check('filter: Clear filters restores all 13 and clears the URL', new URL(page.url()).search === '');

  for (const name of ['Projector', 'Whiteboard']) await page.getByLabel(name, { exact: true }).check();
  await waitForCards(page, 4);
  t.check('filter: Projector AND Whiteboard gives 4', true);
  await page.click('#filter-clear');
  await waitForCards(page, 13);

  await page.check('#filter-bookable');
  await waitForCards(page, 11);
  t.check('filter: only bookable gives 11', true);
  await page.click('#filter-clear');
  await waitForCards(page, 13);

  await page.fill('#filter-capacity', '5000');
  await page.waitForSelector('#filter-capacity[aria-invalid="true"]');
  t.check('filter: 5000 seats shows "Enter a whole number from 1 to 1000."',
    (await page.textContent('#filter-form')).includes('Enter a whole number from 1 to 1000.'));
  t.check('filter: invalid seats keep the previous results', (await cardCount(page)) === 13);
  await t.axe(page, 'facilities with a filter error');

  await page.fill('#filter-capacity', '500');
  await page.waitForSelector('#results .state');
  t.check('empty state: "No facilities match these filters" with a Clear filters button',
    (await page.textContent('#results')).includes('No facilities match these filters')
      && (await page.locator('#results .state button').count()) === 1);
  await t.axe(page, 'facilities empty state');
  await page.click('#results .state button');
  await waitForCards(page, 13);

  // Filters in the URL are applied on load; unknown values are ignored
  await page.goto(`${base}/pages/facilities.html?type=meeting_room&building=999&minCapacity=10`);
  await waitForResults(page);
  t.check('URL filters are applied on load (meeting rooms with 10+ seats)', (await cardCount(page)) === 2);
  t.check('unknown building id in the URL is ignored', (await page.inputValue('#filter-building')) === '');

  // Details
  await page.click('text=Club Meeting Room');
  await page.waitForSelector('h1.page-header__title');
  t.check('details: opens from the card', (await page.textContent('h1')) === 'Club Meeting Room');
  t.check('details: document title names the facility', (await page.title()).startsWith('Club Meeting Room |'));
  const body = await page.textContent('main');
  for (const text of ['About this facility', 'Equipment and amenities', 'Video conferencing kit', 'Opening hours',
    '10:00–22:00', 'Every day, Korea time (KST).', 'Student Center (STU)', 'STU 201', 'Floor 2', '16 people',
    'Takes booking requests.']) {
    t.check(`details: shows "${text}"`, body.includes(text));
  }
  t.check('details: a room open at weekends does not say it is closed then', !body.includes('Closed on Saturdays and Sundays'));
  const back = await page.getAttribute('.breadcrumb a', 'href');
  t.check('details: breadcrumb returns to the list with the same filters',
    back.includes('type=meeting_room') && back.includes('minCapacity=10'), back);
  await t.axe(page, 'facility details (active)');

  async function openDetails(name) {
    await page.goto(`${base}/pages/facilities.html?q=${encodeURIComponent(name)}`);
    await waitForResults(page);
    await page.click(`text=${name}`);
    await page.waitForSelector('h1.page-header__title');
  }

  await openDetails('Computer Lab A');
  t.check('details: a lab closed at weekends says "Monday to Friday … Closed on Saturdays and Sundays."',
    (await page.textContent('main')).includes('Monday to Friday, Korea time (KST). Closed on Saturdays and Sundays.'));

  for (const [name, notice] of [['Lecture Room 110', 'Under maintenance'], ['Conference Room 401', 'No longer in use']]) {
    await openDetails(name);
    await page.waitForSelector('.alert');
    t.check(`details: ${name} shows "${notice}"`, (await page.textContent('.alert')).includes(notice));
    await t.axe(page, `facility details (${notice})`);
  }

  for (const [query, label] of [['?id=999999', 'unknown id'], ['?id=abc', 'malformed id'], ['', 'missing id']]) {
    await page.goto(`${base}/pages/facility.html${query}`);
    await page.waitForSelector('.state');
    t.check(`details: ${label} shows "Facility not found" with a way back`,
      (await page.textContent('.state')).includes('Facility not found') && (await page.locator('.state a').count()) === 1);
  }
  await t.axe(page, 'facility not found');

  // Signed-in users skip the public pages
  for (const target of ['/', '/pages/login.html', '/pages/register.html']) {
    await page.goto(`${base}${target}`);
    await page.waitForURL(/facilities\.html/);
    t.check(`signed in: ${target} redirects to Facilities`, true);
  }

  // The session ends while the page is open
  await waitForResults(page);
  await context.clearCookies();
  await page.selectOption('#filter-type', 'classroom');
  await page.waitForURL(/login\.html/);
  const expired = new URL(page.url());
  t.check('session ended: next change sends the user to sign in with reason=expired',
    expired.searchParams.get('reason') === 'expired' && expired.searchParams.get('next').startsWith('/pages/facilities.html'), page.url());
  await page.waitForSelector('#login-alert .alert--info');
  t.check('session ended: sign-in page explains why', (await page.textContent('#login-alert')).includes('Your session has ended'));
  await t.signIn(page, ACCOUNTS.student, expired.searchParams.get('next'));
  t.check('session ended: signing in returns to the same filtered list', page.url().includes('/pages/facilities.html?type=classroom'), page.url());

  // Sign out
  await waitForResults(page);
  await Promise.all([page.waitForURL(`${base}/`), page.click('text=Sign out')]);
  t.check('sign out returns to the home page', true);

  // Administrator
  {
    const { page: adminPage } = await t.newPage();
    await t.signIn(adminPage, ACCOUNTS.admin);
    t.check('admin: lands on Facilities (admin pages are built later)', adminPage.url().endsWith('/pages/facilities.html'), adminPage.url());
    await waitForResults(adminPage);
    t.check('admin: can browse all 13 facilities', (await cardCount(adminPage)) === 13);
    t.check('admin: no links to unbuilt admin pages', (await adminPage.locator('.nav__link').count()) === 0);
    t.check('admin: role tag shows Admin', (await adminPage.textContent('.role-tag')) === 'Admin');
  }
}
