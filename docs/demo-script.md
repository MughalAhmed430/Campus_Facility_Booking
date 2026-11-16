# Demo script

A walk through the system in about 12 minutes, using the sample data. Every step uses
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
   - **Say:** passwords are stored as bcrypt hashes; the session is a random token in an
     httpOnly cookie, and only its SHA-256 hash is in the database.

## 2. Core requirement 1: listing facilities (1 minute)

Student window.

1. **Facilities** lists classrooms, laboratories and meeting rooms. Filter by **Type:
   Laboratory**, then tick an equipment item.
   - **Shows:** the filters are in the address bar, so a reload keeps them.
2. Clear the filters. In **Free at**, choose a weekday next week, 10:00 to 12:00.
   - **Shows:** only rooms that are open and have no approved booking then.

## 3. Core requirements 2 and 3: booking form and schedule (2 minutes)

Student window.

1. Open **Computer Lab A**. Scroll to the week schedule.
   - **Shows:** approved bookings as blocks; other students' bookings show times only.
2. Choose a free time on the schedule.
   - **Shows:** the booking form is filled in with that date and time.
3. Enter 31 participants and a purpose, then submit.
   - **Shows:** it is refused under the field: the lab holds 30. The server applies the
     same rule. Change it to 10 and submit.
4. Open **My bookings**, tab **Pending**.
   - **Say:** a pending request does not hold the time. Only an approval does.

## 4. The conflict rule (3 minutes)

This is the most important part. The sample data has two pending requests for
Computer Lab A that overlap: Lee Seo-yeon 15:00–17:00 and Park Ji-ho 16:00–18:00.

Administrator window.

1. Open **Requests**. Point at the **Clashes** column: each of the two says it overlaps
   the other.
2. Choose **Approve** on Lee Seo-yeon's request. The dialog lists Park Ji-ho's request as
   one it will reject. Add a note and confirm.
   - **Shows:** both leave the queue. One was approved; the other was rejected
     automatically, in the same transaction.
3. Open **Schedule** and go to that day.
   - **Shows:** the approved booking on the lab's row.

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

## 8. Quality (1 minute, optional)

In a terminal:

```powershell
npm test               # about 350 API tests on an in-memory PostgreSQL
npm run test:browser   # about 630 checks in a real browser, with accessibility scans
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
- **What is not built?** The student and administrator dashboards and the reports page.
  After signing in, students start on Facilities and administrators on Requests. Also
  out of scope: email or SMS, payments, recurring bookings, password reset.
- **What was simplified?** See "Security notes and academic simplifications" in the
  README: in-memory rate limits, no record of who changed a facility or an account, and
  administrator accounts that come only from the sample data.
