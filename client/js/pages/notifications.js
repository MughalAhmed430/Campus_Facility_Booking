import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../api/notifications.js';
import { initAppShell, ROUTES, setUnreadCount } from '../components/app-shell.js';
import { renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading } from '../components/feedback.js';
import { campusDateOf } from '../utils/campus-time.js';
import { h } from '../utils/dom.js';
import { dateLabel, pluralize } from '../utils/format.js';

// Where each kind of notification's booking is on My bookings.
const BOOKING_TAB = { booking_approved: '', booking_rejected: '?tab=closed', booking_cancelled: '?tab=closed' };

const list = document.getElementById('notifications');
const alertBox = document.getElementById('notifications-alert');
const countLine = document.getElementById('notifications-count');
const heading = document.getElementById('notifications-title');
const markAll = document.getElementById('mark-all');
let notifications = null; // null while loading, or when loading failed

const user = await initAppShell({ access: 'student' });
if (user) {
  markAll.addEventListener('click', readAll);
  load();
}

async function load() {
  notifications = null;
  countLine.textContent = '';
  markAll.hidden = true;
  list.setAttribute('aria-busy', 'true');
  renderLoading(list, 'Loading notifications…');
  try {
    let unreadCount;
    ({ notifications, unreadCount } = await listNotifications());
    setUnreadCount(unreadCount);
  } catch (error) {
    renderError(list, error, { title: 'Could not load your notifications', onRetry: load });
    return;
  } finally {
    list.removeAttribute('aria-busy');
  }
  render();
}

function render() {
  const unread = notifications.filter((notification) => !notification.isRead).length;
  markAll.hidden = unread === 0;
  if (notifications.length === 0) {
    countLine.textContent = '';
    renderEmpty(list, {
      title: 'No notifications yet',
      message: 'When an administrator approves, rejects or cancels one of your bookings, it is listed here.',
      action: { label: 'Browse facilities', href: ROUTES.facilities },
    });
    return;
  }
  countLine.textContent = unread === 0 ? 'You have read them all.' : `${unread} unread.`;
  list.replaceChildren(h('ul', { class: 'notice-list list-reset' }, notifications.map(item)));
}

/** '2026-11-10T05:30:00.000Z' -> "Tue, 10 Nov 2026, 14:30" in Korea time */
function momentLabel(isoInstant) {
  const time = new Date(Date.parse(isoInstant) + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
  return `${dateLabel(campusDateOf(isoInstant))}, ${time}`;
}

function item(notification) {
  const read = h('button', { type: 'button', class: 'btn btn--sm' },
    'Mark as read', h('span', { class: 'visually-hidden' }, `: ${notification.title}, ${momentLabel(notification.createdAt)}`));
  read.addEventListener('click', () => readOne(notification, read));
  const tab = BOOKING_TAB[notification.type];
  return h('li', { class: `notice${notification.isRead ? '' : ' is-unread'}`, 'data-notification-id': notification.id },
    h('div', { class: 'notice__head' },
      h('h2', { class: 'notice__title' }, notification.title),
      notification.isRead ? null : h('span', { class: 'badge badge--warning' }, 'Unread')),
    h('p', { class: 'notice__message' }, notification.message),
    h('p', { class: 'notice__meta' }, momentLabel(notification.createdAt)),
    h('div', { class: 'notice__actions' },
      notification.bookingId !== null && tab !== undefined
        ? h('a', { class: 'btn btn--sm', href: `${ROUTES.myBookings}${tab}` },
          'View in My bookings', h('span', { class: 'visually-hidden' }, `: ${notification.title}`))
        : null,
      notification.isRead ? null : read));
}

async function readOne(notification, button) {
  renderAlert(alertBox, {});
  try {
    const { unreadCount } = await withButtonLoading(button, markNotificationRead(notification.id));
    setUnreadCount(unreadCount);
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not mark it as read', message: error.message });
    heading.focus();
    return;
  }
  notifications = notifications.map((entry) => (entry.id === notification.id ? { ...entry, isRead: true } : entry));
  render();
  // The button is gone: stay on the same notification if it has a link, else go to the top.
  (list.querySelector(`[data-notification-id="${notification.id}"] a`) ?? heading).focus();
}

async function readAll() {
  renderAlert(alertBox, {});
  try {
    const { marked } = await withButtonLoading(markAll, markAllNotificationsRead());
    setUnreadCount(0);
    toast(`${pluralize(marked, 'notification')} marked as read.`);
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not mark them as read', message: error.message });
    heading.focus();
    return;
  }
  notifications = notifications.map((entry) => ({ ...entry, isRead: true }));
  render();
  heading.focus(); // the button is hidden now
}
