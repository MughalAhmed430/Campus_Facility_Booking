import { h } from '../utils/dom.js';

// Stored values are lower case (database convention); these are the labels users see.
const LABELS = {
  // Booking statuses
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed',
  // Facility statuses
  active: 'Available',
  maintenance: 'Under maintenance',
  inactive: 'Inactive',
};

export function statusLabel(status) {
  return LABELS[status] ?? status;
}

/** <span class="badge badge--approved">Approved</span> */
export function statusBadge(status) {
  const known = Object.hasOwn(LABELS, status);
  return h('span', { class: known ? `badge badge--${status}` : 'badge' }, statusLabel(status));
}
