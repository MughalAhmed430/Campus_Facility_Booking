import { listMyBookings } from '../api/bookings.js';
import { listNotifications } from '../api/notifications.js';
import { initAppShell, ROUTES, setUnreadCount } from '../components/app-shell.js';
import { renderEmpty, renderError, renderLoading } from '../components/feedback.js';
import { failedStatCard, statCard, statGrid } from '../components/stat-card.js';
import { statusBadge } from '../components/status-badge.js';
import { h } from '../utils/dom.js';
import { dateLabel, momentLabel, roomLabel } from '../utils/format.js';

// The student's start page. It has no data of its own: the figures and both previews come
// from the same two calls as My bookings and Notifications, so they cannot disagree with
// the pages they link to.
const UPCOMING_SHOWN = 5;
const NOTIFICATIONS_SHOWN = 3;

const dashboard = document.getElementById('dashboard');
const stats = document.getElementById('dashboard-stats');
const upcoming = document.getElementById('dashboard-upcoming');
const recent = document.getElementById('dashboard-notifications');

const user = await initAppShell({ access: 'student' });
if (user) {
  document.getElementById('dashboard-title').textContent = `Welcome, ${user.fullName}`;
  load();
}

/** Loads both sources. One failing leaves the other's part of the page working. */
async function load() {
  dashboard.setAttribute('aria-busy', 'true');
  renderLoading(stats, 'Loading your figures…');
  renderLoading(upcoming, 'Loading your bookings…');
  renderLoading(recent, 'Loading notifications…');

  const [bookings, notifications] = await Promise.allSettled([listMyBookings(), listNotifications()]);

  // The same rules as the Upcoming and Pending tabs of My bookings.
  const mine = bookings.status === 'fulfilled' ? bookings.value.bookings : null;
  const approved = mine?.filter((booking) => booking.status === 'approved');
  const pending = mine?.filter((booking) => booking.status === 'pending' && !booking.hasStarted);
  const notices = notifications.status === 'fulfilled' ? notifications.value : null;
  if (notices) setUnreadCount(notices.unreadCount);

  const figures = {
    upcoming: { id: 'upcoming', label: 'Upcoming bookings', href: ROUTES.myBookings },
    pending: { id: 'pending', label: 'Pending requests', href: `${ROUTES.myBookings}?tab=pending` },
    unread: { id: 'unread', label: 'Unread notifications', href: ROUTES.notifications },
  };
  stats.replaceChildren(statGrid([
    mine
      ? statCard({ ...figures.upcoming, value: String(approved.length), note: 'Approved and not over yet' })
      : failedStatCard(figures.upcoming),
    mine
      ? statCard({ ...figures.pending, value: String(pending.length), note: 'Waiting for an administrator' })
      : failedStatCard(figures.pending),
    notices
      ? statCard({
        ...figures.unread,
        value: String(notices.unreadCount),
        note: notices.unreadCount === 0 ? 'You have read them all' : 'Decisions about your bookings',
      })
      : failedStatCard(figures.unread),
  ]));

  if (mine) renderUpcoming([...approved, ...pending]);
  else renderError(upcoming, bookings.reason, { title: 'Could not load your bookings', onRetry: load });

  if (notices) renderRecent(notices.notifications);
  else renderError(recent, notifications.reason, { title: 'Could not load your notifications', onRetry: load });

  dashboard.removeAttribute('aria-busy');
}

/** The next bookings and requests, soonest first. */
function renderUpcoming(list) {
  if (list.length === 0) {
    renderEmpty(upcoming, {
      title: 'No upcoming bookings',
      message: 'Approved bookings, and requests waiting for a decision, appear here.',
      action: { label: 'Browse facilities', href: ROUTES.facilities },
    });
    return;
  }
  list.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`) || a.id - b.id);
  upcoming.replaceChildren(
    h('ul', { class: 'dash-list list-reset' }, list.slice(0, UPCOMING_SHOWN).map(bookingItem)),
    list.length > UPCOMING_SHOWN
      ? h('p', { class: 'dash-more' }, `Showing the next ${UPCOMING_SHOWN} of ${list.length}.`)
      : null,
  );
}

function bookingItem(booking) {
  const { facility } = booking;
  return h('li', { class: 'dash-item', 'data-booking-id': booking.id },
    h('div', {},
      h('a', { class: 'dash-item__title', href: `/pages/facility.html?id=${encodeURIComponent(facility.id)}` }, facility.name),
      h('span', { class: 'dash-item__meta' }, `${roomLabel(facility)} · ${facility.building.name}`),
      h('span', { class: 'dash-item__meta' },
        `${dateLabel(booking.date)}, ${booking.startTime}–${booking.endTime}`,
        booking.status === 'approved' && booking.hasStarted ? ' · Happening now' : null)),
    statusBadge(booking.status));
}

/** The latest notifications, to read; marking as read is done on the Notifications page. */
function renderRecent(list) {
  if (list.length === 0) {
    renderEmpty(recent, {
      title: 'No notifications yet',
      message: 'When an administrator approves, rejects or cancels one of your bookings, it is listed here.',
    });
    return;
  }
  recent.replaceChildren(h('ul', { class: 'notice-list list-reset' }, list.slice(0, NOTIFICATIONS_SHOWN).map((notification) =>
    h('li', { class: `notice${notification.isRead ? '' : ' is-unread'}`, 'data-notification-id': notification.id },
      h('div', { class: 'notice__head' },
        h('h3', { class: 'notice__title' }, notification.title),
        notification.isRead ? null : h('span', { class: 'badge badge--warning' }, 'Unread')),
      h('p', { class: 'notice__message' }, notification.message),
      h('p', { class: 'notice__meta' }, momentLabel(notification.createdAt))))));
}
