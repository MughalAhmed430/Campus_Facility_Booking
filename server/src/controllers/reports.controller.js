import * as reportService from '../services/report.service.js';
import { addDays, campusToday } from '../utils/campus-time.js';
import { FieldValidator } from '../utils/validation.js';

/**
 * GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * -> 200 { range, totals, byStatus, facilities } (see report.service.js).
 * from and to are booking dates in Korea time, inclusive. Without them the range is the
 * last 30 days: `to` is today, `from` is 29 days before `to`. At most one year.
 * 400 lists every problem with the dates at once.
 */
export async function summary(req, res) {
  const v = new FieldValidator(req.query);
  const givenFrom = v.date('from', { label: 'From', required: false });
  const givenTo = v.date('to', { label: 'To', required: false });
  v.assertValid(); // the checks below need both dates to be real ones

  const to = givenTo ?? campusToday();
  const from = givenFrom ?? addDays(to, 1 - reportService.REPORT_DEFAULT_DAYS);
  if (to < from) {
    v.addError('to', 'Must be on or after the "From" date.');
  } else if (addDays(from, reportService.REPORT_MAX_DAYS - 1) < to) {
    v.addError('to', 'The range can be at most one year.');
  }
  v.assertValid();
  res.json({ success: true, data: await reportService.getSummary({ from, to }) });
}
