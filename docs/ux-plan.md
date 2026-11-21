# UX plan: sitemap and low-fidelity wireframes

This plan covers every page of the application. Each one uses the shared
app shell (header, role-specific navigation, footer) and the design system shown
at `/pages/style-guide.html`.

**What was built:** every page below. After signing in, each role starts on its
dashboard. The facility form (`/pages/admin/facility-form.html`) was added to the plan
while building. Where a page differs from its wireframe, an *As built* note says how.

**Decision for review:** facility browsing requires signing in. This is an internal
campus system, and keeping every page behind login keeps the authorization model
simple. Only the home, sign-in and registration pages are public.

## Sitemap

```text
Public
├── /                              Home: what the system does, Sign in / Register
├── /pages/login.html              Sign in
└── /pages/register.html           Create a student account

Student (role: student)
├── /pages/dashboard.html          Student dashboard
├── /pages/facilities.html         Browse, search and filter facilities
├── /pages/facility.html?id=…      Facility details, schedule and booking form
├── /pages/my-bookings.html        My booking history, status, cancel
└── /pages/notifications.html      Notifications

Administrator (role: admin)
├── /pages/admin/dashboard.html    Admin dashboard
├── /pages/admin/requests.html     Pending requests: approve / reject
├── /pages/admin/bookings.html     All bookings, filters
├── /pages/admin/schedule.html     Day/week schedule across facilities
├── /pages/admin/facilities.html   Facility management (list, close, deactivate)
├── /pages/admin/facility-form.html  New facility, or edit one (?id=)
├── /pages/admin/users.html        User management (activate / deactivate)
└── /pages/admin/reports.html      Utilization statistics

Students: courses (sample academic data)
├── /pages/courses.html            Course catalogue: register and drop
└── /pages/timetable.html          My weekly timetable

Administrators: the academic office
├── /pages/admin/courses.html      Courses of a semester, new semester
├── /pages/admin/course-form.html  One course: details, weekly lectures, class list
└── /pages/admin/professors.html   Professors and their credited photos

Both roles (signed in)
├── /pages/profile.html            My profile: photo, name, change password
└── /pages/booking-print.html?id=… Printable reservation confirmation / request record

Shared reference
└── /pages/style-guide.html        Design system reference (sample content only)
```

### Navigation per role

| Signed out         | Student                                            | Administrator                                                        |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| Sign in, Register  | Dashboard, Facilities, My bookings, Notifications  | Dashboard, Requests, Bookings, Schedule, Facilities, Users, Reports  |

The header always shows the user's picture (photo or initials), name and role, plus a
"Sign out" button. The picture and name link to My profile. On small
screens the navigation collapses behind a "Menu" button.

## Wireframe descriptions

Notation: `[ ]` is a region. Each page lists its main regions, top to bottom, on desktop.
On mobile, multi-column regions stack in the order listed.

### Public

**Home `/`**
- `[Hero]` One-sentence purpose, with "Sign in" and "Create account" buttons.
- `[Three feature cards]` Find a room · Request a booking · Track approval.
- Signed-in users are redirected to their dashboard.

**Sign in**: one centered card: email, password, "Sign in" button, and a link to Register.
Errors show above the form ("Invalid email or password." from the API). The button
shows a loading state while waiting.

**Register**: one centered card: full name, email, student number (optional), password
(with a hint: 8+ characters), and confirm password. Field errors from the API appear
under each field. On success, the user goes to Sign in with a success message.

### Student

**Dashboard**
- `[Page header]` "Welcome, {name}" and a "Book a facility" primary button.
- `[Stat cards ×3]` Upcoming approved bookings · Pending requests · Unread notifications.
- `[Upcoming bookings list]` The next 5, each with facility, date/time and status badge.
  Empty state: "No upcoming bookings", with a "Browse facilities" link.
- `[Recent notifications]` The latest 3, plus a link to all.
- *As built:* the upcoming list holds approved bookings and requests still waiting for a
  decision together, soonest first, which is why each has a status badge. Every stat card
  links to its page. Notifications are marked as read on the Notifications page only.

**Facilities**
- `[Page header]` Title and result count.
- `[Filter bar]` Search text · Type (classroom / laboratory / meeting room) · Building ·
  Min. capacity · Equipment · Date + time range ("available only"). On mobile it collapses
  into a "Filters" disclosure.
- `[Card grid]` Facility cards: name, building and room, type, capacity, equipment chips,
  status badge (maintenance and inactive are shown but cannot be booked), "View details".
- Loading skeleton; empty state "No facilities match these filters", with "Clear filters".

**Facility details `?id=`**
- `[Header]` Name, building/room/floor, type, capacity, status badge.
- `[Two columns]` Left: description and equipment list. Right: the booking form (date,
  start/end time, attendees, purpose), with live validation: end after start, attendees
  ≤ capacity.
- `[Schedule]` Week view (Mon–Sun × hours). Approved bookings appear as blocks; the
  user's own pending requests are outlined. Week navigation is previous / next / today.
- Submit opens a confirmation summary. A server conflict (409) is shown inline:
  "This time is no longer available."

**My bookings**
- `[Tabs]` Upcoming · Pending · Past · Cancelled/Rejected.
- `[Table]` (cards on mobile) Facility, date, time, status badge, decision note, actions.
- "Cancel" is shown only when the rules allow it, and asks for confirmation.

**Notifications**: a list with unread items emphasised, "Mark as read" per item and
"Mark all as read". Empty state.

### Administrator

**Admin dashboard**
- `[Stat cards ×4]` Pending requests · Bookings today · Active facilities · Utilization this week (%).
- `[Pending requests preview]` The oldest 5, plus a link to Requests.
- `[Today's schedule]` A compact timeline of approved bookings today.
- *As built:* the preview shows the 5 requests that start soonest, the order of the
  Requests page, not the 5 oldest; approving and rejecting stay on Requests. Today's
  bookings are a table by start time (cards on a phone) rather than a timeline; the
  timeline is on Schedule. Utilization covers Monday to Sunday of this week and is
  labelled "(estimate)", linking to Reports for the same week. The dashboards have no API
  of their own: every figure comes from the call behind the page it links to.

**Requests**
- `[Table]` Requested at, student, facility, date/time, attendees/capacity, purpose, and a
  conflict indicator (overlaps another pending request).
- Row actions: "Approve" (with confirmation) and "Reject" (dialog with a required reason).
  Approving one request auto-rejects overlapping pending requests and lists them in
  the confirmation.

**Bookings**: filterable table (status, facility, date range, student) with pagination,
a details dialog showing the whole record, and cancel-with-reason for approved bookings
(pending requests are decided on Requests).

**Schedule**: day view with facilities as rows and hours as columns, plus a date picker
and a type filter. Pending requests are outlined. Choosing a block shows the booking's
details; a pending one links to Requests.

**Facilities (manage)**: table with a "New facility" button. The create/edit form includes
the equipment checklist with quantities. "Deactivate" asks for confirmation and warns
about future approved bookings.

**Users**: searchable table (name, email, student number, role, status), with an
Activate/Deactivate toggle and confirmation. Admins cannot deactivate themselves.

**Reports**: date range picker; bookings by status, by facility type and by facility;
utilization (booked hours ÷ available hours). Shown as tables, with simple bars where
they help. *As built:* four key figures (requests, approval rate, hours booked,
utilization), bookings by status and by facility; no table by facility type. Utilization
is an estimate from each facility's current hours and status (see the README).

## States every page handles

Loading (skeleton or spinner) · empty (explains why, plus a next step) · validation
errors (per field, from the API's `details`) · request errors (banner with a retry) ·
success (toast or inline message) · signed out or session ended (redirect to Sign in,
then back).
