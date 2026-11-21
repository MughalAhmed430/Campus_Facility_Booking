# Demo script

A walk through the system in about 19 minutes, using the sample data. Every step uses
real pages and the real database; nothing is mocked.

## Before the demo

Do these in PowerShell from the project folder, shortly before presenting:

```powershell
npm run db:reset   # fresh sample data; booking dates are relative to today
npm start          # http://localhost:3000
```

- **Run the reset on the day.** The sample bookings are dated relative to the day the
  seed runs, so an old seed shows "upcoming" bookings that are already over. The reset
  deletes everything else in the database, including accounts registered while testing.
- **Open two browser windows:** a normal window for the student and an InPrivate window
  for the administrator. Each keeps its own session, so you can switch without signing out.
- **Sign in before you start:** the administrator in the InPrivate window.

| Role          | Email                     | Password       |
| ------------- | ------------------------- | -------------- |
| Administrator | `admin@kdu.example`       | `Admin@2026`   |
| Student       | `jiho.park@kdu.example`   | `Student@2026` |
| Student       | `seoyeon.lee@kdu.example` | `Student@2026` |

These accounts are sample data only.

## 1. Registration and sign-in (1 minute)

Student window, signed out.

1. Open <http://localhost:3000>. Choose **Create account**.
2. Enter a name, the email `demo@examoke.com` (a domain that does not exist) and a
   password, then submit.
   - **Shows:** the server refuses the address under the email field. It checks that the
     domain can receive mail.
3. Sign in as `jiho.park@kdu.example`.
   - **Shows:** the student dashboard, his start page: upcoming bookings, pending
     requests and unread notifications, each a link to its page, then his next bookings
     and requests. One of the requests is for Computer Lab A; step 4 comes back to it.
   - **Say:** passwords are stored as bcrypt hashes; the session is a random token in an
     httpOnly cookie, and only its SHA-256 hash is in the database.

## 2. Core requirement 1: listing facilities (1 minute)

Student window.

1. Choose **Book a facility** on the dashboard. **Facilities** lists classrooms, laboratories and meeting rooms. Filter by **Type:
   Laboratory**, then tick an equipment item.
   - **Shows:** the filters are in the address bar, so a reload keeps them.
2. Clear the filters. In **Free at**, choose a weekday next week, 10:00 to 12:00.
   - **Shows:** only rooms that are open and have no approved booking then.

## 3. Core requirements 2 and 3: booking form and schedule (2 minutes)

Student window.

1. Open **Computer Lab A**. Scroll to the week schedule.
   - **Shows:** approved bookings as blocks; other students' bookings show times only.
2. Choose a free time on the schedule, then **1 hour**.
   - **Shows:** it asks how long, offering only lengths that fit; the form is filled in
     with that date and time. The times are lists every 30 minutes.
3. Enter 31 participants and a purpose, then submit.
   - **Shows:** it is refused under the field: the lab holds 30. The server applies the
     same rule. Change it to 10 and submit.
4. Open **My bookings**, tab **Pending**.
   - **Shows:** each booking has a reservation reference (`FR-…`), also shown in the
     success message. **Print record** opens a printable page marked NOT CONFIRMED.
   - **Say:** a pending request does not hold the time. Only an approval does. Only an
     approved booking prints as a "Reservation confirmation".

## 4. The conflict rule (3 minutes)

This is the most important part. The sample data has two pending requests for
Computer Lab A that overlap: Lee Seo-yeon 15:00–17:00 and Park Ji-ho 16:00–18:00.

Administrator window.

1. The administrator's start page is the **Dashboard**. Under **Requests starting
   soonest**, the two lab requests are each marked "Overlaps 1 request". Choose **Review
   all requests**.
   - **Shows:** the dashboard only previews; decisions are made on **Requests**, where
     the **Clashes** column says the same and names the other student.
2. Choose **Approve** on Lee Seo-yeon's request. The dialog lists Park Ji-ho's request as
   one it will reject. Add a note and confirm.
   - **Shows:** both leave the queue. One was approved; the other was rejected
     automatically, in the same transaction.
3. Open **Schedule** and go to that day. Choose the approved booking.
   - **Shows:** the approved booking on the lab's row, with its reference. A pending
     request chosen here has **Approve** and **Reject** buttons, with the same
     confirmations as on Requests.

Student window (Park Ji-ho).

4. The **Notifications** link in the menu shows an unread count. Open it.
   - **Shows:** "Booking request rejected ... Reason: Another request for this time was
     approved." The notification was written in the same transaction as the decision.
5. Open **Facilities**, then Computer Lab A, and request 16:00–17:00 on that same day.
   - **Shows:** "This time is already booked."

**Say:** two approved bookings for one room can never overlap. The frontend check is only
a convenience. The rule is an exclusion constraint in PostgreSQL (`bookings_no_overlap`),
so the database itself refuses a second approval, whatever the application does. To show
it under real concurrency, run this in a terminal:

```powershell
npm run verify:concurrency
```

It starts six approvals of overlapping requests at the same moment on separate
connections and shows that exactly one succeeds. It removes its temporary data afterwards.

## 5. Managing bookings (1 minute)

Administrator window.

1. Open **Bookings**. Filter by **Status: Approved**. Open **Details** on one.
   - **Shows:** the whole record, including who approved it and when.
2. Choose **Cancel** on an approved booking, give a reason, and confirm.
   - **Shows:** the reason is required. The student gets a notification with it, and the
     time is free again.

## 6. Closing a facility that has bookings (2 minutes)

This shows a deliberate design decision. The sample data gives Group Study Room B two
approved bookings two days from today.

Administrator window.

1. Open **Facilities**. On **Group Study Room B**, choose **Deactivate**.
   - **Shows:** the dialog says "It has 2 upcoming approved bookings", that they are not
     cancelled automatically, and links to them.
2. Confirm.
   - **Shows:** the facility is inactive. A warning on the page repeats that the two
     bookings were left in place, with **Review in Bookings**.
3. Follow the link.
   - **Shows:** the Bookings page, filtered to exactly those two bookings, each with its
     own Cancel button.
4. Go back to **Facilities** and choose **Reactivate** on the room, so the sample data is
   as before.

**Say:** closing a facility cancels nothing, on purpose. An automatic bulk cancellation
would give every student the same generic reason and would be hard to undo if the
closure was a mistake. Instead the administrator is told exactly how many bookings
remain, is taken straight to them, and cancels each with a reason that student sees.
Facilities are never deleted either, so past bookings keep their history.

## 7. Users and access control (1 minute)

Administrator window.

1. Open **Users**. Search for `jiho`. Choose **Deactivate** and confirm.
   - **Shows:** the same count-and-link warning for that student's bookings.

Student window (Park Ji-ho).

2. Reload the page.
   - **Shows:** the session ended at once; the student is sent to sign in, and signing in
     is refused.

Administrator window.

3. Choose **Activate** on the account. Your own row has no button: an administrator
   cannot deactivate their own account.

Student window, signed in again as any student.

4. Type `/pages/admin/users.html` in the address bar.
   - **Shows:** "This page is not available to your account."
   - **Say:** hiding the page is only for convenience. Every admin API route checks the
     role on the server and answers 403 to a student.

## 8. Dashboard and reports (1 minute)

This shows a deliberate simplification, stated on the page itself.

Administrator window.

1. Open **Dashboard**. Point at the four figures: pending requests, bookings today,
   active facilities and **Utilization this week (estimate)**.
   - **Say:** the dashboards have no data of their own. Each figure comes from the same
     API call as the page it links to, so the two cannot disagree.
2. Choose the utilization card.
   - **Shows:** **Reports** opens on the same week, Monday to Sunday, with the same
     percentage, the bookings by status, and every facility, busiest first.
3. Scroll to **How these figures are calculated**.
   - **Say:** utilization is booked hours out of open hours, using each facility's
     opening hours and status as they are today. The database keeps no history of
     earlier hours, closures or holidays, so the figure is an estimate, and every place
     that shows it says so. An exact figure would need a table recording each change.
4. Choose **Last 30 days**.
   - **Shows:** the default range, with the approval rate counted over decided requests
     only.

## 9. My profile (1 minute, optional)

Student window.

1. Choose your name in the header. **My profile** opens.
2. Upload a photo (JPEG, PNG or WebP, up to 2 MB).
   - **Shows:** it appears on the page and in the header at once.
   - **Say:** the server checks the file's content, not its name: a renamed program is
     refused. Photos are stored outside the public folder and served only to their owner
     and administrators.
3. Optionally, show **Change password** with a wrong current password.
   - **Shows:** it is refused under that field. Do not actually change the demo account's
     password, or the table above no longer works (`npm run db:reset` restores it).

## 10. Courses and the room guard (3 minutes)

The academic data is sample data; the semester's name says "(sample)". The administrator
acts as the academic office: there is no professor role.

Student window (Park Ji-ho).

1. Open **Courses**.
   - **Shows:** the semester's courses, each with its professor, weekly lectures and rooms,
     and seats left. Korean Culture and Society has 1 of 3 seats left.
2. Choose **Register** on **BUS2040 Marketing**.
   - **Shows:** it is refused: its Monday lecture overlaps CSE3050 Computer Networks, which
     he already takes.
3. Choose **My timetable** at the top of Courses.
   - **Shows:** his week, Monday to Friday, and "8 credits in 3 courses".

Administrator window.

4. Open **Courses**, then **Manage** on any course. Under **Add a weekly lecture**, choose
   Friday, 10:00, Seminar Room 302.
   - **Shows:** refused: "The room is taken … lecture GEN1001". Try a time a reservation
     holds and it names the reservation (`FR-…`).
5. Open **Schedule** on a Tuesday.
   - **Shows:** lectures on the classroom rows, next to the bookings.
   - **Say:** a lecture and an approved booking are both rows of one table,
     `room_occupancy`, with one exclusion constraint. The database refuses a lecture over a
     booking and a booking over a lecture, whatever the application does. Adding a lecture
     also rejects pending requests for its times, with a notification.

**Say (last seat):** registering locks the course row, so two students taking the last
seat at the same moment are served one after the other; the second is told it is full.

## 11. Grades (2 minutes)

Student window (Park Ji-ho).

1. Open **Grades**.
   - **Shows:** CGPA 3.56. Last semester is complete: CSE1010 92 (A), CSE2020 77.7 (C+),
     GEN1002 95.8 (A+), GPA 3.56. This semester only the midterm is marked, so each course
     says "so far" and "In progress", and does not count in the GPA yet.
   - **Say:** the server computes the totals, letters and GPAs from the documented 4.5 scale
     on the page. A student only ever receives their own marks.
2. Choose **Printable transcript**, then **Print**.
   - **Shows:** completed courses with grades, courses in progress without a mark, marked
     as sample data.

Administrator window.

3. Open **Courses**, **Manage** on a course, then **Assessments and marks**.
   - **Shows:** the weighted assessments (30, 30, 40) and a mark box per student. Enter a
     mark above the maximum: it is refused at that box. A mark in range saves, and the total
     and letter update.

## 12. Quality (1 minute, optional)

In a terminal:

```powershell
npm test               # about 430 API tests on an in-memory PostgreSQL
npm run test:browser   # about 980 checks in a real browser, with accessibility scans
```

- **Say:** the browser checks cover every page at nine widths from 320 to 1920 px, with
  axe-core scans for WCAG 2.2 AA.
- Resize the student window to phone width to show tables turning into cards and the
  menu folding behind a button.

## If you are asked

- **Do pending requests block a slot?** No. Several can overlap; an administrator
  approves at most one, and the others are rejected automatically with a reason.
- **What stops two administrators approving overlapping requests at the same moment?**
  Row locks taken in a fixed order, then the exclusion constraint as the final guard.
- **What is not built?** Every page in the plan is built. Courses have no assignments or
  attendance yet. Out of scope: email or SMS,
  payments, recurring bookings, password reset by email. Reports have no charts, no CSV export
  and no table by facility type.
- **Why is utilization only an estimate?** It uses today's opening hours and status for
  the whole range, because no history of them is stored. It is good for comparing
  facilities with each other, not as an audited number.
- **What was simplified?** See "Security notes and academic simplifications" in the
  README: in-memory rate limits, no record of who changed a facility or an account, and
  administrator accounts that come only from the sample data.
