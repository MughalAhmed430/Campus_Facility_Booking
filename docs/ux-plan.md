# UX plan: sitemap and low-fidelity wireframes

This plan guides the pages built from Module 5 onward. Every page uses the shared
app shell (header, role-specific navigation, footer) and the design system shown
at `/pages/style-guide.html`.

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
├── /pages/admin/facilities.html   Facility management (create, edit, deactivate)
├── /pages/admin/users.html        User management (activate / deactivate)
└── /pages/admin/reports.html      Utilization statistics

Shared reference
└── /pages/style-guide.html        Design system reference (sample content only)
```

### Navigation per role

| Signed out         | Student                                            | Administrator                                                        |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| Sign in, Register  | Dashboard, Facilities, My bookings, Notifications  | Dashboard, Requests, Bookings, Schedule, Facilities, Users, Reports  |

The header always shows the user's name and role, plus a "Sign out" button. On small
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

**Requests**
- `[Table]` Requested at, student, facility, date/time, attendees/capacity, purpose, and a
  conflict indicator (overlaps another pending request).
- Row actions: "Approve" (with confirmation) and "Reject" (dialog with a required reason).
  Approving one request auto-rejects overlapping pending requests and lists them in
  the confirmation.

**Bookings**: filterable table (status, facility, date range, student) with pagination
and cancel-with-reason.

**Schedule**: day view with facilities as rows and hours as columns, plus a date picker
and a type filter. Blocks link to the booking.

**Facilities (manage)**: table with a "New facility" button. The create/edit form includes
the equipment checklist with quantities. "Deactivate" asks for confirmation and warns
about future approved bookings.

**Users**: searchable table (name, email, student number, role, status), with an
Activate/Deactivate toggle and confirmation. Admins cannot deactivate themselves.

**Reports**: date range picker; bookings by status, by facility type and by facility;
utilization (booked hours ÷ available hours). Shown as tables, with simple bars where
they help.

## States every page handles

Loading (skeleton or spinner) · empty (explains why, plus a next step) · validation
errors (per field, from the API's `details`) · request errors (banner with a retry) ·
success (toast or inline message) · signed out or session ended (redirect to Sign in,
then back).
