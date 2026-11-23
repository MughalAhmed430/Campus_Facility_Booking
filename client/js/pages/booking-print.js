import { getBooking } from '../api/bookings.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import { renderError, renderLoading } from '../components/feedback.js';
import { statusBadge } from '../components/status-badge.js';
import { h } from '../utils/dom.js';
import { bookingReference, dateLabel, momentLabel, roomLabel } from '../utils/format.js';

// The printable record of one booking. Only an approved (or completed) booking is called
// a confirmation; anything else is printed as a "request record" with its status, so a
// printout of a pending or rejected request can never pass for a confirmed reservation.

const container = document.getElementById('print-record');
const id = Number(new URLSearchParams(window.location.search).get('id'));

const user = await initAppShell({ access: 'signed-in' });
if (user) load();

async function load() {
  if (!Number.isInteger(id) || id < 1) {
    renderError(container, { message: 'This link does not name a booking.' }, { title: 'Booking not found', heading: 'h1' });
    return;
  }
  renderLoading(container, 'Loading the booking…');
  try {
    const { booking } = await getBooking(id);
    render(booking);
  } catch (error) {
    renderError(container, error, {
      title: error.status === 404 ? 'Booking not found' : 'Could not load the booking',
      onRetry: error.status === 404 ? null : load,
      heading: 'h1',
    });
  }
}

function row(term, ...description) {
  return h('div', {}, h('dt', {}, term), h('dd', {}, ...description));
}

function render(booking) {
  const confirmed = ['approved', 'completed'].includes(booking.status);
  const reference = bookingReference(booking.id);
  const title = confirmed ? 'Reservation confirmation' : 'Reservation request record';
  document.title = `${reference} ${title} | Campus Facility Booking`;
  const backHref = user.role === 'admin' ? ROUTES.adminBookings : ROUTES.myBookings;
  const { facility } = booking;

  const notice = {
    approved: 'This reservation is confirmed. Please bring this record or your reference number.',
    completed: 'This reservation took place as booked.',
    pending: 'NOT CONFIRMED: this request is still waiting for a decision. The time is not reserved until it is approved.',
    rejected: 'NOT CONFIRMED: this request was rejected. The time is not reserved.',
    cancelled: 'NOT VALID: this reservation was cancelled. The time is not reserved.',
  }[booking.status];

  container.replaceChildren(
    h('div', { class: 'print-actions no-print' },
      h('a', { class: 'btn', href: backHref }, user.role === 'admin' ? 'Back to bookings' : 'Back to My bookings'),
      h('button', { type: 'button', class: 'btn btn--primary', onClick: () => window.print() }, 'Print')),
    h('article', { class: `card print-record${confirmed ? '' : ' print-record--unconfirmed'}`, 'aria-labelledby': 'print-title' },
      h('div', { class: 'card__body stack' },
        h('header', { class: 'print-record__header' },
          h('div', {},
            h('p', { class: 'print-record__issuer' }, 'Campus Facility Booking · Kyungdong University'),
            h('h1', { class: 'print-record__title', id: 'print-title' }, title)),
          h('div', { class: 'print-record__reference' },
            h('span', { class: 'print-record__reference-label' }, 'Reference'),
            h('span', { class: 'reference print-record__reference-value' }, reference))),
        h('p', { class: `alert alert--${confirmed ? 'success' : 'warning'} print-record__notice` }, notice),
        h('dl', { class: 'details-list' },
          row('Status', statusBadge(booking.status)),
          row('Facility', `${facility.name} (${roomLabel(facility)})`, h('p', { class: 'hint' }, facility.building.name)),
          row('Date and time', `${dateLabel(booking.date)}, ${booking.startTime}–${booking.endTime} (Korea time)`),
          booking.student
            ? row('Booked by', booking.student.fullName,
              h('p', { class: 'hint' }, [booking.student.studentNumber ? `No. ${booking.student.studentNumber}` : null, booking.student.email].filter(Boolean).join(' · ')))
            : row('Booked by', user.fullName, user.studentNumber ? h('p', { class: 'hint' }, `No. ${user.studentNumber}`) : null),
          row('Participants', String(booking.participantCount)),
          row('Purpose', booking.purpose),
          booking.notes ? row('Notes', booking.notes) : null,
          row('Requested', momentLabel(booking.createdAt)),
          booking.decision
            ? row(confirmed ? 'Approved' : 'Decided', momentLabel(booking.decision.decidedAt),
              booking.decision.by ? h('p', { class: 'hint' }, `By ${booking.decision.by.fullName}`) : null,
              booking.decision.note ? h('p', { class: 'hint' }, `Note: ${booking.decision.note}`) : null)
            : null,
          booking.cancellation
            ? row('Cancelled', momentLabel(booking.cancellation.cancelledAt),
              booking.cancellation.reason ? h('p', { class: 'hint' }, `Reason: ${booking.cancellation.reason}`) : null)
            : null),
        h('p', { class: 'print-record__footer' },
          `Printed ${momentLabel(new Date().toISOString())} (Korea time). Student course project: not an official Kyungdong University document.`))),
  );
}
