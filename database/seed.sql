-- =============================================================================
-- SAMPLE DATA for development and demonstration only.
-- People, emails, rooms and bookings are invented. Emails use the reserved
-- .example domain so they can never reach a real inbox.
--
-- Run on a freshly created schema:   npm run db:schema   then   npm run db:seed
--
-- Demo accounts:
--   admin@kdu.example                               password: Admin@2026
--   minjun.kim / seoyeon.lee / jiho.park / yuna.choi  @kdu.example   password: Student@2026
--
-- Passwords are stored as bcrypt hashes (cost 12, the same cost the API uses, so login
-- timing does not differ between seeded and registered accounts), produced by pgcrypto's crypt().
-- Booking dates are relative to the day the seed runs (Korea time), so the sample
-- schedule always has past, upcoming and pending bookings.
-- =============================================================================

BEGIN;

-- Used only here, to bcrypt-hash the demo passwords. The application hashes in Node.js.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'The database already contains data. Run "npm run db:schema" first to reset it.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------
INSERT INTO users (full_name, email, password_hash, role, student_number) VALUES
  ('Facilities Administrator', 'admin@kdu.example',       crypt('Admin@2026',   gen_salt('bf', 12)), 'admin',   NULL),
  ('Kim Min-jun',              'minjun.kim@kdu.example',  crypt('Student@2026', gen_salt('bf', 12)), 'student', '231001'),
  ('Lee Seo-yeon',             'seoyeon.lee@kdu.example', crypt('Student@2026', gen_salt('bf', 12)), 'student', '231002'),
  ('Park Ji-ho',               'jiho.park@kdu.example',   crypt('Student@2026', gen_salt('bf', 12)), 'student', '241003'),
  ('Choi Yu-na',               'yuna.choi@kdu.example',   crypt('Student@2026', gen_salt('bf', 12)), 'student', '221004');

-- -----------------------------------------------------------------------------
-- Buildings
-- -----------------------------------------------------------------------------
INSERT INTO buildings (code, name, description) VALUES
  ('ENG', 'Engineering Hall', 'Computer science and engineering classrooms and labs.'),
  ('SCI', 'Science Hall',     'Chemistry and physics laboratories and a large lecture room.'),
  ('HUM', 'Humanities Hall',  'General-purpose classrooms and seminar rooms.'),
  ('LIB', 'Central Library',  'Group study rooms on the third floor.'),
  ('STU', 'Student Center',   'Meeting spaces for the student council and clubs.');

-- -----------------------------------------------------------------------------
-- Facilities: 5 classrooms, 4 laboratories, 4 meeting rooms
-- Opening hours (Korea time): classrooms 08:00-22:00, labs 09:00-21:00 (the chemistry
-- lab closes at 18:00, when supervising staff leave), library study rooms 09:00-22:00,
-- the student center 10:00-22:00.
-- Weekends: classrooms, labs and the department conference room are closed on Saturday
-- and Sunday; the library study rooms and the student center meeting room are open every
-- day, with the same hours. All sample bookings fit inside these rules.
-- -----------------------------------------------------------------------------
INSERT INTO facilities (building_id, room_number, name, facility_type, capacity, floor, description, status, opens_at, closes_at, is_open_weekends)
SELECT b.id, v.room_number, v.name, v.facility_type, v.capacity, v.floor, v.description, v.status, v.opens_at::time, v.closes_at::time, v.is_open_weekends
FROM (VALUES
  ('ENG', '101', 'Lecture Room 101',    'classroom',     80, 1, 'Tiered lecture room with a ceiling projector and microphones.',  'active',      '08:00', '22:00', false),
  ('ENG', '204', 'Classroom 204',       'classroom',     40, 2, 'Flat classroom with movable desks for group work.',              'active',      '08:00', '22:00', false),
  ('HUM', '105', 'Classroom 105',       'classroom',     45, 1, 'General-purpose classroom near the main entrance.',              'active',      '08:00', '22:00', false),
  ('HUM', '302', 'Seminar Room 302',    'classroom',     24, 3, 'U-shaped seating for discussion-based classes.',                 'active',      '08:00', '22:00', false),
  ('SCI', '110', 'Lecture Room 110',    'classroom',    120, 1, 'Large lecture room. Closed while the seating is replaced.',      'maintenance', '08:00', '22:00', false),
  ('ENG', '310', 'Computer Lab A',      'laboratory',    30, 3, 'Thirty workstations with programming tools installed.',         'active',      '09:00', '21:00', false),
  ('ENG', '312', 'Networking Lab',      'laboratory',    24, 3, 'Workstations and equipment racks for hands-on networking.',      'active',      '09:00', '21:00', false),
  ('SCI', '205', 'Chemistry Lab',       'laboratory',    24, 2, 'Wet lab with fume hoods. A safety briefing is required.',        'active',      '09:00', '18:00', false),
  ('SCI', '208', 'Physics Lab',         'laboratory',    20, 2, 'Experiment benches with data-logging computers.',                'active',      '09:00', '21:00', false),
  ('LIB', '301', 'Group Study Room A',  'meeting_room',   6, 3, 'Small room with a wall display for screen sharing.',             'active',      '09:00', '22:00', true),
  ('LIB', '302', 'Group Study Room B',  'meeting_room',   8, 3, 'Quiet room with a large whiteboard.',                            'active',      '09:00', '22:00', true),
  ('STU', '201', 'Club Meeting Room',   'meeting_room',  16, 2, 'Meeting table with a video conferencing kit.',                   'active',      '10:00', '22:00', true),
  ('ENG', '401', 'Conference Room 401', 'meeting_room',  20, 4, 'Former department conference room, no longer bookable.',         'inactive',    '09:00', '18:00', false)
) AS v (building_code, room_number, name, facility_type, capacity, floor, description, status, opens_at, closes_at, is_open_weekends)
JOIN buildings b ON b.code = v.building_code;

-- -----------------------------------------------------------------------------
-- Equipment
-- -----------------------------------------------------------------------------
INSERT INTO equipment (name, description) VALUES
  ('Projector',               'Ceiling-mounted projector with HDMI input.'),
  ('Whiteboard',              'Wall-mounted whiteboard with markers.'),
  ('Interactive display',     'Touch screen for presentations and screen sharing.'),
  ('Microphone and speakers', 'Wireless microphones with room speakers.'),
  ('Desktop computer',        'Workstation with the standard lab software image.'),
  ('Video conferencing kit',  'Camera, speakerphone and display for online meetings.'),
  ('Fume hood',               'Ventilated enclosure for working with chemicals.');

INSERT INTO facility_equipment (facility_id, equipment_id, quantity)
SELECT f.id, e.id, v.quantity
FROM (VALUES
  ('ENG', '101', 'Projector', 1), ('ENG', '101', 'Microphone and speakers', 1), ('ENG', '101', 'Whiteboard', 2),
  ('ENG', '204', 'Projector', 1), ('ENG', '204', 'Whiteboard', 1),
  ('HUM', '105', 'Projector', 1), ('HUM', '105', 'Whiteboard', 1),
  ('HUM', '302', 'Interactive display', 1), ('HUM', '302', 'Whiteboard', 1),
  ('SCI', '110', 'Projector', 2), ('SCI', '110', 'Microphone and speakers', 1),
  ('ENG', '310', 'Desktop computer', 30), ('ENG', '310', 'Projector', 1),
  ('ENG', '312', 'Desktop computer', 24), ('ENG', '312', 'Projector', 1), ('ENG', '312', 'Whiteboard', 1),
  ('SCI', '205', 'Fume hood', 4), ('SCI', '205', 'Whiteboard', 1),
  ('SCI', '208', 'Desktop computer', 10), ('SCI', '208', 'Projector', 1),
  ('LIB', '301', 'Interactive display', 1), ('LIB', '301', 'Whiteboard', 1),
  ('LIB', '302', 'Whiteboard', 1),
  ('STU', '201', 'Video conferencing kit', 1), ('STU', '201', 'Whiteboard', 1),
  ('ENG', '401', 'Video conferencing kit', 1), ('ENG', '401', 'Interactive display', 1)
) AS v (building_code, room_number, equipment_name, quantity)
JOIN buildings b  ON b.code = v.building_code
JOIN facilities f ON f.building_id = b.id AND f.room_number = v.room_number
JOIN equipment e  ON e.name = v.equipment_name;

-- -----------------------------------------------------------------------------
-- Bookings
--   day_offset: days from today (Korea time); starts/ends: local wall-clock time.
--   For a facility closed at weekends, a day that falls on Saturday or Sunday moves to
--   the nearest weekday (see resolved below), so the data follows the weekend rule
--   whichever day the seed runs.
--   requested_days_ago: when the request was created. Decisions are recorded
--   5 hours after the request, cancellations 1 day after.
-- -----------------------------------------------------------------------------
WITH
kst AS (
  -- Midnight today in Korea, as a local (time-zone-less) timestamp.
  SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AS today
),
admin AS (
  SELECT id FROM users WHERE email = 'admin@kdu.example'
),
src (email, building_code, room_number, day_offset, starts, ends, attendees, purpose, status,
     requested_days_ago, decided, decision_note, cancelled_by_email, cancellation_reason) AS (
  VALUES
    -- Past, approved and then completed
    ('minjun.kim@kdu.example',  'ENG', '310', -7, '10:00', '12:00', 18, 'Data Structures study group: practice problems', 'completed', 12, true,  NULL, NULL, NULL),
    ('seoyeon.lee@kdu.example', 'LIB', '301', -3, '14:00', '16:00',  5, 'Capstone project team meeting',                   'completed',  6, true,  NULL, NULL, NULL),
    -- Upcoming and approved; the two LIB 302 bookings are back-to-back, which is allowed
    ('jiho.park@kdu.example',   'ENG', '204',  1, '13:00', '15:00', 25, 'Robotics club weekly meeting',                    'approved',   4, true,  NULL, NULL, NULL),
    ('yuna.choi@kdu.example',   'STU', '201',  2, '18:00', '20:00', 12, 'Student council budget review',                   'approved',   3, true,  NULL, NULL, NULL),
    ('minjun.kim@kdu.example',  'LIB', '302',  2, '10:00', '12:00',  6, 'Exam revision group',                             'approved',   2, true,  NULL, NULL, NULL),
    ('jiho.park@kdu.example',   'LIB', '302',  2, '12:00', '13:00',  4, 'Lab report write-up session',                     'approved',   2, true,  NULL, NULL, NULL),
    -- Two pending requests competing for overlapping times in the same lab:
    -- pending requests do not block each other; an admin can approve only one of them.
    ('seoyeon.lee@kdu.example', 'ENG', '310',  3, '15:00', '17:00', 20, 'Web programming lab practice',                    'pending',    1, false, NULL, NULL, NULL),
    ('jiho.park@kdu.example',   'ENG', '310',  3, '16:00', '18:00', 12, 'Programming contest practice',                    'pending',    0, false, NULL, NULL, NULL),
    -- Rejected with a reason
    ('yuna.choi@kdu.example',   'HUM', '105',  4, '09:00', '12:00', 40, 'Photography club recruitment event',              'rejected',   2, true,
       'Classrooms are reserved for academic activities on weekday mornings. Please request the Club Meeting Room in the Student Center instead.', NULL, NULL),
    -- Cancelled by the student while still pending (no admin decision)
    ('minjun.kim@kdu.example',  'HUM', '302',  5, '13:00', '14:00',  8, 'Presentation rehearsal',                          'cancelled',  3, false, NULL,
       'minjun.kim@kdu.example', 'The rehearsal moved online.'),
    -- Approved, then cancelled by an administrator
    ('seoyeon.lee@kdu.example', 'ENG', '101',  6, '10:00', '12:00', 60, 'Guest lecture: careers in software engineering',  'cancelled',  5, true,  NULL,
       'admin@kdu.example', 'The room is needed for a make-up examination. Sorry for the inconvenience.')
),
resolved AS (
  SELECT s.*,
         u.id  AS user_id,
         f.id  AS facility_id,
         cu.id AS cancelled_by,
         (d.booking_day + s.starts::time) AT TIME ZONE 'Asia/Seoul'          AS start_time,
         (d.booking_day + s.ends::time)   AT TIME ZONE 'Asia/Seoul'          AS end_time,
         now() - s.requested_days_ago * interval '1 day' - interval '1 hour' AS created_at
  FROM src s
  CROSS JOIN kst
  JOIN users u       ON u.email = s.email
  JOIN buildings b   ON b.code = s.building_code
  JOIN facilities f  ON f.building_id = b.id AND f.room_number = s.room_number
  LEFT JOIN users cu ON cu.email = s.cancelled_by_email
  -- The planned day and its ISO weekday (1 = Monday ... 6 = Saturday, 7 = Sunday).
  CROSS JOIN LATERAL (
    SELECT kst.today + s.day_offset * interval '1 day' AS day,
           extract(isodow FROM kst.today + s.day_offset * interval '1 day')::int AS isodow
  ) p
  -- Facilities closed at weekends: a Saturday or Sunday moves away from today, so past
  -- bookings stay in the past and upcoming ones stay upcoming: back to the Friday
  -- before, or forward to the Monday after.
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN f.is_open_weekends OR p.isodow <= 5 THEN p.day
             WHEN s.day_offset < 0 THEN p.day - (p.isodow - 5) * interval '1 day'
             ELSE p.day + (8 - p.isodow) * interval '1 day'
           END AS booking_day
  ) d
),
timed AS (
  SELECT r.*,
         CASE WHEN r.decided              THEN r.created_at + interval '5 hours' END AS decided_at,
         CASE WHEN r.status = 'cancelled' THEN r.created_at + interval '1 day'   END AS cancelled_at
  FROM resolved r
)
INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status,
                      decided_by, decided_at, decision_note,
                      cancelled_by, cancelled_at, cancellation_reason,
                      created_at, updated_at)
SELECT t.user_id, t.facility_id, t.start_time, t.end_time, t.attendees, t.purpose, t.status,
       CASE WHEN t.decided THEN admin.id END, t.decided_at, t.decision_note,
       t.cancelled_by, t.cancelled_at, t.cancellation_reason,
       t.created_at, COALESCE(t.cancelled_at, t.decided_at, t.created_at)
FROM timed t
CROSS JOIN admin
ORDER BY t.start_time;

-- -----------------------------------------------------------------------------
-- Notifications, derived from the bookings above
-- -----------------------------------------------------------------------------
WITH info AS (
  SELECT bk.*,
         f.name || ' (' || bl.code || ' ' || f.room_number || ')' AS facility_label,
         to_char(bk.start_time AT TIME ZONE 'Asia/Seoul', 'Dy DD Mon, HH24:MI') || '-' ||
         to_char(bk.end_time   AT TIME ZONE 'Asia/Seoul', 'HH24:MI')            AS slot
  FROM bookings bk
  JOIN facilities f ON f.id = bk.facility_id
  JOIN buildings bl ON bl.id = f.building_id
)
INSERT INTO notifications (user_id, booking_id, type, title, message, read_at, created_at)
-- Decisions, sent to the student who made the request
SELECT user_id, id,
       CASE WHEN status = 'rejected' THEN 'booking_rejected' ELSE 'booking_approved' END,
       CASE WHEN status = 'rejected' THEN 'Booking request rejected' ELSE 'Booking request approved' END,
       'Your request for ' || facility_label || ' on ' || slot || ' was ' ||
         CASE WHEN status = 'rejected'
              THEN 'rejected. Reason: ' || COALESCE(decision_note, 'none given.')
              ELSE 'approved.' END,
       CASE WHEN status = 'completed' THEN decided_at + interval '2 hours' END,  -- older ones already read
       decided_at
FROM info
WHERE decided_at IS NOT NULL
UNION ALL
-- Cancellations made by an administrator, sent to the student
SELECT user_id, id, 'booking_cancelled', 'Booking cancelled',
       'Your booking for ' || facility_label || ' on ' || slot ||
         ' was cancelled by an administrator. Reason: ' || COALESCE(cancellation_reason, 'none given.'),
       NULL, cancelled_at
FROM info
WHERE status = 'cancelled' AND cancelled_by <> user_id;
-- Administrators get no notifications: the Requests page is their list of what is waiting.

-- -----------------------------------------------------------------------------
-- Safety net: a typo in a lookup above would silently drop rows from an
-- INSERT ... SELECT, so check that everything arrived. Any mismatch rolls back.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  actual jsonb := jsonb_build_object(
    'users',              (SELECT count(*) FROM users),
    'buildings',          (SELECT count(*) FROM buildings),
    'facilities',         (SELECT count(*) FROM facilities),
    'equipment',          (SELECT count(*) FROM equipment),
    'facility_equipment', (SELECT count(*) FROM facility_equipment),
    'bookings',           (SELECT count(*) FROM bookings),
    'notifications',      (SELECT count(*) FROM notifications)
  );
  expected jsonb := '{"users": 5, "buildings": 5, "facilities": 13, "equipment": 7,
                      "facility_equipment": 27, "bookings": 11, "notifications": 9}';
BEGIN
  IF actual <> expected THEN
    RAISE EXCEPTION 'Seed row counts do not match. Expected %, got %', expected, actual;
  END IF;
END $$;

COMMIT;
