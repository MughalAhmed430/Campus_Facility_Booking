// Phase 5: a student's grades, the printable transcript, and the administrators' gradebook.
// Park Ji-ho's sample grades are only read. The gradebook is tried on a course of its own.
const PASSWORD = 'Student@2026';

/** @param {import('../harness.js').Harness} t */
export default async function grades(t) {
  const db = t.db;
  const waitFilled = (page, selector) => page.waitForFunction((sel) => {
    const element = document.querySelector(sel);
    return element && !element.hasAttribute('aria-busy') && element.children.length > 0 && !element.querySelector('.spinner, [role=progressbar]');
  }, selector);

  // ---- A student's grades -------------------------------------------------------------------
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, { email: 'jiho.park@kdu.example', password: PASSWORD }, '/pages/grades.html');
  await page.waitForSelector('#grades section[data-semester-id]');
  t.check('grades: the menu has Grades, current', (await page.getAttribute('.nav__link[href="/pages/grades.html"]', 'aria-current')) === 'page');
  t.check('grades: the CGPA of the completed semester', /Overall CGPA\s*3\.56/.test(await page.textContent('#grades .grid--stats')));
  const sections = page.locator('#grades section[data-semester-id]');
  t.check('grades: two semesters, latest first, both labelled sample',
    (await sections.count()) === 2 && /Fall \(sample\)/.test(await sections.nth(0).textContent()) && /Spring \(sample\)/.test(await sections.nth(1).textContent()));
  const previous = sections.nth(1);
  t.check('grades: a completed course shows its total and letter',
    /Total\s*92\s*Grade\s*A(?!\+)/.test(await previous.locator('tr[data-course-code="CSE1010"]').textContent()));
  t.check('grades: the semester GPA', /Semester GPA 3\.56/.test(await previous.textContent()));
  const current = sections.nth(0).locator('tr[data-course-code="CSE2010"]');
  t.check('grades: a course in progress shows a provisional total and no letter',
    /25\.2 so far \(30% marked\)/.test(await current.textContent()) && /In progress/.test(await current.textContent())
      && /Midterm exam \(30%\): 84 \/ 100/.test(await current.textContent()));
  t.check('grades: the grade scale is explained', /A\+\s*95 to 100\s*4\.5/.test(await page.textContent('#grades')));
  await t.axe(page, 'grades');
  await t.noHorizontalOverflow(page, 'grades @ 1280px');
  await t.screenshot(page, 'grades-1280');
  await page.setViewportSize({ width: 390, height: 844 });
  await t.noHorizontalOverflow(page, 'grades @ 390px');
  await t.axe(page, 'grades @ 390px');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('a[href="/pages/transcript.html"]');
  await page.waitForSelector('.transcript');
  t.check('transcript: CGPA, student and a sample-data notice',
    /3\.56 \/ 4\.5/.test(await page.textContent('.print-record__reference'))
      && /Park Ji-ho/.test(await page.textContent('.transcript')) && /SAMPLE DATA/.test(await page.textContent('.transcript')));
  t.check('transcript: courses in progress have no grade', /CSE2010\s*Data Structures\s*3\s*In progress/.test(await page.textContent('.transcript')));
  await page.emulateMedia({ media: 'print' });
  t.check('transcript: printing leaves out the menu and the buttons',
    !(await page.isVisible('.app-header')) && !(await page.isVisible('.print-actions')) && (await page.isVisible('.transcript')));
  await page.emulateMedia({ media: 'screen' });
  await t.axe(page, 'transcript');
  await t.screenshot(page, 'transcript-1280');

  // ---- The gradebook ---------------------------------------------------------------------
  const { rows: [semester] } = await db.query('SELECT id FROM semesters ORDER BY starts_on DESC LIMIT 1');
  const { rows: [professor] } = await db.query("SELECT id, department_id FROM professors WHERE full_name = 'Dr. Kang Mi-rae'");
  const { rows: [course] } = await db.query(
    `INSERT INTO courses (semester_id, code, title, credits, department_id, professor_id, seat_limit)
     VALUES ($1, 'GBK101', 'Gradebook Check', 3, $2, $3, 10) RETURNING id`,
    [semester.id, professor.department_id, professor.id],
  );
  const email = 'gradebook.mu@kdu.example';
  const { rows: [student] } = await db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ('Gradebook Mu', $1, crypt($2, gen_salt('bf', 4)), 'student', '654321') RETURNING id`,
    [email, PASSWORD],
  );
  await db.query('INSERT INTO course_registrations (course_id, student_id) VALUES ($1, $2)', [course.id, student.id]);

  const { page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, { email: 'admin@kdu.example', password: 'Admin@2026' }, `/pages/admin/course-form.html?id=${course.id}`);
  await admin.waitForSelector('#slot-form');
  await Promise.all([admin.waitForURL(/gradebook\.html\?course=/), admin.click('text=Assessments and marks')]);
  await admin.waitForSelector('#assessment-form');
  t.check('gradebook: a new course has no assessments and says why marks wait',
    /No assessments yet/.test(await admin.textContent('#gradebook-page')) && /Add an assessment first/.test(await admin.textContent('#gradebook-page')));

  async function addAssessment(name, weight, max) {
    await admin.fill('#assessment-name', name);
    await admin.fill('#assessment-weight', String(weight));
    await admin.fill('#assessment-maxPoints', String(max));
    await admin.click('#assessment-form button[type=submit]');
  }
  await addAssessment('Coursework', 60, 100);
  await admin.waitForSelector('tr[data-assessment-id]');
  t.check('gradebook: the weights are not yet 100, and it says so', /add up to 60, not 100/.test(await admin.textContent('#gradebook-page')));
  await addAssessment('Exam', 50, 80);
  await admin.waitForSelector('#assessment-form .field-error');
  t.check('gradebook: weights over 100 are refused under the field', /At most 40 is left/.test(await admin.textContent('#assessment-form')));
  await admin.fill('#assessment-weight', '40');
  await admin.click('#assessment-form button[type=submit]');
  await admin.waitForFunction(() => document.querySelectorAll('tr[data-assessment-id]').length === 2);
  t.check('gradebook: then they add up to 100', /The weights add up to 100/.test(await admin.textContent('#gradebook-page')));
  await t.axe(admin, 'gradebook');
  await t.noHorizontalOverflow(admin, 'gradebook @ 1280px');

  const box = (name) => admin.getByRole('spinbutton', { name: new RegExp(`^${name}, Gradebook Mu`) });
  await box('Coursework').fill('90');
  await box('Exam').fill('81');
  await admin.click('#marks-form button[type=submit]');
  await admin.waitForSelector('#marks-alert .alert--danger');
  t.check('marks: a mark above the maximum is refused, at its box', /from 0 to 80/.test(await admin.textContent('#marks-form'))
    && (await box('Exam').getAttribute('aria-invalid')) === 'true');
  await box('Exam').fill('70.5');
  await admin.click('#marks-form button[type=submit]');
  await admin.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Marks saved'));
  await admin.waitForSelector('#marks-form');
  const row = admin.locator(`#marks-form tr[data-student-id="${student.id}"]`);
  t.check('marks: saved; the server works out the total and the letter', /89\.25\s*B\+/.test(await row.textContent()));
  await t.screenshot(admin, 'gradebook-1280');

  // The student sees it.
  const { page: mu } = await t.newPage({ width: 1280 });
  await t.signIn(mu, { email, password: PASSWORD }, '/pages/grades.html');
  await mu.waitForSelector('#grades tr[data-course-code="GBK101"]');
  t.check('student: the new grade is on My grades, and in the CGPA',
    /Total\s*89\.25\s*Grade\s*B\+/.test(await mu.textContent('#grades tr[data-course-code="GBK101"]')) && /Overall CGPA\s*3\.50/.test(await mu.textContent('#grades .grid--stats')));
}
