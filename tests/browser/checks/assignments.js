// Phase 3: a student hands in a file (checked by content), the academic office marks it
// with feedback, and sets a new assignment. Uses a student of its own in CSE2010.
const PASSWORD = 'Student@2026';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 0x20)]);

/** @param {import('../harness.js').Harness} t */
export default async function assignments(t) {
  const db = t.db;
  const { rows: [course] } = await db.query("SELECT id FROM courses WHERE code = 'CSE2010'");
  const { rows: [student] } = await db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ('Assign Xi', 'assign.xi@kdu.example', crypt($1, gen_salt('bf', 4)), 'student', '876543') RETURNING id`,
    [PASSWORD],
  );
  await db.query('INSERT INTO course_registrations (course_id, student_id) VALUES ($1, $2)', [course.id, student.id]);

  // ---- Student ------------------------------------------------------------------------------
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, { email: 'assign.xi@kdu.example', password: PASSWORD }, '/pages/timetable.html');
  await page.waitForSelector('#timetable .week');
  await page.getByRole('link', { name: 'Assignments for CSE2010' }).click();
  await page.waitForSelector('#course-page li[data-assignment-id]');
  t.check('course page: the course and its two sample assignments', (await page.textContent('h1')) === 'CSE2010 Data Structures'
    && (await page.locator('#course-page li[data-assignment-id]').count()) === 2);
  const linked = page.locator('#course-page li[data-assignment-id]', { hasText: 'Linked lists' });
  const trees = page.locator('#course-page li[data-assignment-id]', { hasText: 'Binary search trees' });
  t.check('course page: a past-due assignment says so, and a file now would be late',
    /Not handed in, past due/.test(await linked.textContent()) && /it will be marked late/.test(await linked.textContent()));
  await t.axe(page, 'course page');
  await t.noHorizontalOverflow(page, 'course page @ 1280px');

  t.expectConsoleError(/status of 400/);
  await trees.locator('input[type=file]').setInputFiles({ name: 'trees.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ this is a program') });
  await trees.getByRole('button', { name: 'Hand in' }).click();
  await trees.locator('.alert--danger').waitFor();
  t.check('hand in: a renamed program is refused, with the reason', /not really a PDF/.test(await trees.locator('.alert--danger').textContent()));

  await trees.locator('input[type=file]').setInputFiles({ name: 'trees.pdf', mimeType: 'application/pdf', buffer: PDF });
  await trees.getByRole('button', { name: 'Hand in' }).click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Handed in'));
  await page.waitForSelector('#course-page li[data-assignment-id] .submission');
  const treesAfter = page.locator('#course-page li[data-assignment-id]', { hasText: 'Binary search trees' });
  t.check('hand in: shown as handed in, with the file to download, and it can be replaced',
    /Handed in/.test(await treesAfter.locator('.badge').first().textContent())
      && (await treesAfter.locator('.submission a[download="trees.pdf"]').count()) === 1
      && (await treesAfter.getByRole('button', { name: 'Replace my file' }).count()) === 1);
  t.check('hand in: focus moves to the assignment', await page.evaluate(() => /^assignment-\d+$/.test(document.activeElement?.id ?? '')));
  await t.axe(page, 'course page after handing in');

  // ---- Administrators ---------------------------------------------------------------------
  const { page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, { email: 'admin@kdu.example', password: 'Admin@2026' }, `/pages/admin/course-form.html?id=${course.id}`);
  await admin.waitForSelector('#slot-form');
  await Promise.all([admin.waitForURL(/assignments\.html\?course=/), admin.click('.page-header a:has-text("Assignments")')]);
  await admin.waitForSelector('#assignments-table');
  const listed = await admin.locator('#assignments-table tr', { hasText: 'Binary search trees' }).locator('td').allTextContents();
  t.check('admin: the list says how many handed in and marked', listed[1] === '1' && listed[2] === '0', JSON.stringify(listed));
  await admin.locator('#assignments-table tr', { hasText: 'Binary search trees' }).getByRole('link', { name: /^Submissions/ }).click();
  await admin.waitForSelector('#submissions-title');
  const row = admin.locator(`li[data-student-id="${student.id}"]`);
  t.check('admin: each registered student, with a download for what was handed in',
    (await row.locator('a[download="trees.pdf"]').count()) === 1 && /Not handed in/.test(await admin.textContent('#submissions-title ~ ul')));
  await t.axe(admin, 'admin assignments');
  await t.noHorizontalOverflow(admin, 'admin assignments @ 1280px');

  await row.locator('input[name=points]').fill('18');
  await row.locator('textarea[name=feedback]').fill('Clear code; add a delete operation next time.');
  await row.getByRole('button', { name: 'Save mark' }).click();
  await admin.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Mark saved'));
  t.check('admin: the mark is saved', true);

  // New assignment with a handout.
  await admin.fill('#new-title', 'Hash tables');
  await admin.fill('#new-instructions', 'Implement a hash table with chaining and measure its load factor.');
  await admin.fill('#new-maxPoints', '20');
  await admin.setInputFiles('#new-attachment', { name: 'handout.pdf', mimeType: 'application/pdf', buffer: PDF });
  await admin.click('#assignment-form button[type=submit]');
  await admin.waitForSelector('#assignments-table tr:has-text("Hash tables")');
  t.check('admin: a new assignment with its handout is listed', (await admin.locator('#assignments-table a[download="handout.pdf"]').count()) === 1);

  // The student sees the mark, the feedback and the new assignment.
  await page.reload();
  await page.waitForSelector('#course-page li[data-assignment-id]');
  const marked = page.locator('#course-page li[data-assignment-id]', { hasText: 'Binary search trees' });
  t.check('student: mark and feedback shown, and the file can no longer be replaced',
    /Mark: 18 \/ 20/.test(await marked.textContent()) && /Clear code/.test(await marked.textContent())
      && (await marked.locator('input[type=file]').count()) === 0);
  t.check('student: the new assignment with its handout', (await page.locator('a[download="handout.pdf"]').count()) === 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await t.noHorizontalOverflow(page, 'course page @ 390px');
  await t.axe(page, 'course page @ 390px');
}
