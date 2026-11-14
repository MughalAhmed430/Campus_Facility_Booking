import { api } from './client.js';

/**
 * Students. Resolves to { notifications, unreadCount }: the latest 50, newest first. Each
 * has id, type ('booking_approved', 'booking_rejected', 'booking_cancelled' or 'system'),
 * title, message, bookingId (or null), isRead and createdAt.
 */
export function listNotifications({ signal } = {}) {
  return api.get('/notifications', { signal });
}

/** Students. Resolves to { unreadCount }, for the menu. */
export function getUnreadCount() {
  return api.get('/notifications/unread-count');
}

/** Students. Marks one as read. Resolves to { unreadCount }. Rejects with ApiError 404. */
export function markNotificationRead(id) {
  return api.post(`/notifications/${encodeURIComponent(id)}/read`, {});
}

/** Students. Marks all as read. Resolves to { marked, unreadCount: 0 }. */
export function markAllNotificationsRead() {
  return api.post('/notifications/read-all', {});
}
