import { api } from './client.js';

/**
 * Administrators. Key figures for bookings dated from `from` to `to` (YYYY-MM-DD, Korea
 * time, inclusive; both optional: the last 30 days). Resolves to
 * { range, totals, byStatus, facilities }:
 *   range       { from, to, days, weekdays }
 *   totals      { requests, decided, approved, approvalRatePercent, bookedHours, openHours,
 *                 utilizationPercent } (a percentage is null when there is nothing to divide by)
 *   byStatus    { pending, approved, rejected, cancelled, completed }
 *   facilities  busiest first: id, name, building { code, name }, roomNumber, type, status,
 *               bookings, bookedHours, openHours and utilizationPercent (null when inactive)
 * Rejects with ApiError 400 (details.from / details.to) for dates the server refuses.
 */
export function getReportSummary({ from, to } = {}, { signal } = {}) {
  return api.get('/reports/summary', { query: { from, to }, signal });
}
