import * as notificationService from '../services/notification.service.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

// Every handler works on the signed-in student's own notifications only.

/** GET /api/notifications -> 200 { notifications, unreadCount }: the latest 50, newest first */
export async function list(req, res) {
  res.json({ success: true, data: await notificationService.listNotifications(req.user.id) });
}

/** GET /api/notifications/unread-count -> 200 { unreadCount }, for the menu */
export async function unreadCount(req, res) {
  res.json({ success: true, data: { unreadCount: await notificationService.countUnread(req.user.id) } });
}

/** POST /api/notifications/:id/read -> 200 { unreadCount }, 404 NOTIFICATION_NOT_FOUND */
export async function markRead(req, res) {
  const v = new FieldValidator({ id: req.params.id });
  const id = v.integer('id', { label: 'Notification id', min: 1, max: MAX_INTEGER });
  v.assertValid();
  res.json({ success: true, data: { unreadCount: await notificationService.markRead(req.user.id, id) } });
}

/** POST /api/notifications/read-all -> 200 { marked, unreadCount: 0 } */
export async function markAllRead(req, res) {
  const marked = await notificationService.markAllRead(req.user.id);
  res.json({ success: true, data: { marked, unreadCount: 0 } });
}
