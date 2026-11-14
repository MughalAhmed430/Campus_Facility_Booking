import { query } from '../db/pool.js';
import AppError from '../utils/app-error.js';

// How many a student sees: the latest ones. Older notifications stay in the database.
export const NOTIFICATIONS_LIMIT = 50;

/**
 * SQL: the notification for each booking in `source`, as rows for
 * INSERT INTO notifications (user_id, booking_id, type, title, message).
 *
 * `source` is a table or CTE with the bookings columns, holding bookings whose status
 * has just become approved, rejected or cancelled (by an administrator). What the
 * student is told comes from the booking itself, so it cannot disagree with it:
 *   approved   "Your request for Computer Lab A (ENG 310) on Mon 16 Nov, 10:00-11:00 was approved. Note: ..."
 *   rejected   "... was rejected. Reason: ..."
 *   cancelled  "Your booking for ... was cancelled by an administrator. Reason: ..."
 *
 * Callers run it in the same transaction as the status change (or in the same
 * statement, which is one transaction by itself), so a change is never stored without
 * its notification, and a notification never without its change.
 */
export function bookingNotificationsSql(source) {
  const facility = "f.name || ' (' || bl.code || ' ' || f.room_number || ')'";
  const slot = `to_char(s.start_time AT TIME ZONE 'Asia/Seoul', 'Dy DD Mon, HH24:MI') || '-' ||
                to_char(s.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI')`;
  return `
    SELECT s.user_id, s.id,
           CASE s.status WHEN 'approved' THEN 'booking_approved'
                         WHEN 'rejected' THEN 'booking_rejected'
                         ELSE 'booking_cancelled' END,
           CASE s.status WHEN 'approved' THEN 'Booking request approved'
                         WHEN 'rejected' THEN 'Booking request rejected'
                         ELSE 'Booking cancelled' END,
           CASE s.status
             WHEN 'approved' THEN 'Your request for ' || ${facility} || ' on ' || ${slot} || ' was approved.'
                                  || COALESCE(' Note: ' || s.decision_note, '')
             WHEN 'rejected' THEN 'Your request for ' || ${facility} || ' on ' || ${slot} || ' was rejected. Reason: '
                                  || COALESCE(s.decision_note, 'none given.')
             ELSE 'Your booking for ' || ${facility} || ' on ' || ${slot} || ' was cancelled by an administrator. Reason: '
                  || COALESCE(s.cancellation_reason, 'none given.')
           END
    FROM ${source} s
    JOIN facilities f ON f.id = s.facility_id
    JOIN buildings bl ON bl.id = f.building_id`;
}

/**
 * Inside a transaction: tells the owner of each of these bookings what has just
 * happened to it. `tx` is the transaction from withTransaction().
 */
export async function notifyBookingOwners(tx, bookingIds) {
  if (bookingIds.length === 0) return;
  await tx.query(
    `INSERT INTO notifications (user_id, booking_id, type, title, message)
     ${bookingNotificationsSql('bookings')}
     WHERE s.id = ANY($1::int[])`,
    [bookingIds],
  );
}

/** The user's latest notifications, newest first, and how many of all of theirs are unread. */
export async function listNotifications(userId) {
  const [{ rows }, unreadCount] = await Promise.all([
    query(
      `SELECT id, booking_id, type, title, message, read_at, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [userId, NOTIFICATIONS_LIMIT],
    ),
    countUnread(userId),
  ]);
  return {
    notifications: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      message: row.message,
      bookingId: row.booking_id,
      isRead: row.read_at !== null,
      createdAt: row.created_at.toISOString(),
    })),
    unreadCount,
  };
}

export async function countUnread(userId) {
  const { rows: [row] } = await query(
    'SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return row.unread;
}

/**
 * Marks one of the user's notifications as read. Marking one that is already read
 * changes nothing and succeeds. 404 NOTIFICATION_NOT_FOUND if it does not exist or
 * belongs to someone else: the two look the same, so ids reveal nothing.
 * Returns the user's unread count afterwards.
 */
export async function markRead(userId, notificationId) {
  const { rows } = await query(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [notificationId, userId],
  );
  if (rows.length === 0) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'This notification does not exist.');
  return countUnread(userId);
}

/** Marks all of the user's notifications as read. Returns how many were unread. */
export async function markAllRead(userId) {
  const { rows } = await query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id',
    [userId],
  );
  return rows.length;
}
