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

-- Rules, services and contact details (sample text). No photos: those are added in the
-- app, each with its credit.
UPDATE facilities f SET
  rules = CASE f.facility_type
    WHEN 'laboratory' THEN E'No food or drink.\nLog off and leave the workstation as you found it.\nReport broken equipment to the lab office.'
    WHEN 'meeting_room' THEN E'Keep the noise down: other rooms are in use.\nLeave the room tidy and the whiteboard clean.\nNo more people than the room holds.'
    ELSE E'Leave the desks as you found them.\nSwitch off the projector and lights when you leave.\nNo food in the room.' END,
  services = CASE f.facility_type
    WHEN 'laboratory' THEN E'Wi-Fi (KDU-Campus)\nLab technician on call during opening hours\nPrinting from the lab printer'
    WHEN 'meeting_room' THEN E'Wi-Fi (KDU-Campus)\nWhiteboard markers at the front desk'
    ELSE E'Wi-Fi (KDU-Campus)\nHDMI cable at the lectern' END,
  location_notes = 'Sample directions: ' || b.name || ', floor ' || f.floor || '. Follow the room numbers from the main stairs.',
  contact_email = lower(b.code) || '.office@kdu.example',
  contact_phone = '033-000-' || lpad((100 + f.id)::text, 4, '0')
FROM buildings b
WHERE b.id = f.building_id;

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
       CASE WHEN status = 'rejected' THEN 'Reservation request rejected' ELSE 'Reservation request approved' END,
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
SELECT user_id, id, 'booking_cancelled', 'Reservation cancelled',
       'Your reservation for ' || facility_label || ' on ' || slot ||
         ' was cancelled by the Facilities Office. Reason: ' || COALESCE(cancellation_reason, 'none given.'),
       NULL, cancelled_at
FROM info
WHERE status = 'cancelled' AND cancelled_by <> user_id;
-- Administrators get no notifications: the Requests page is their list of what is waiting.

-- =============================================================================
-- ACADEMIC SAMPLE DATA. Every department, professor, course, timetable and registration
-- below is invented for the demonstration; the semester's name says "(sample)" wherever
-- it is shown. Real data is entered by the academic office (an administrator) in the app.
-- Professors have no photos here: a photo is only added in the app, with its credit.
-- =============================================================================

INSERT INTO departments (code, name) VALUES
  ('CSE', 'Computer Science and Engineering'),
  ('BUS', 'Business Administration'),
  ('HTM', 'Hospitality and Tourism Management'),
  ('GEN', 'General Education');

INSERT INTO professors (full_name, department_id)
SELECT v.full_name, d.id
FROM (VALUES
  ('Dr. Han Ji-won',    'CSE'),
  ('Dr. Oh Seung-woo',  'CSE'),
  ('Dr. Kang Mi-rae',   'BUS'),
  ('Dr. Yoon Tae-hee',  'HTM'),
  ('Dr. Jung Hye-jin',  'GEN')
) AS v (full_name, department_code)
JOIN departments d ON d.code = v.department_code;

-- The semester runs for 16 weeks and is always in progress when the seed runs: it began
-- on the Monday ten weeks before this one, and ends on the Friday of its 16th week.
WITH kst AS (
  SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS today
),
dates AS (
  SELECT (today - (extract(isodow FROM today)::int - 1) - 70) AS starts_on, today FROM kst
)
INSERT INTO semesters (name, starts_on, ends_on)
SELECT CASE WHEN extract(month FROM today) BETWEEN 3 AND 8
            THEN extract(year FROM today)::int || ' Spring (sample)'
            ELSE (extract(year FROM today)::int - CASE WHEN extract(month FROM today) <= 2 THEN 1 ELSE 0 END) || ' Fall (sample)'
       END,
       starts_on, starts_on + 16 * 7 - 3
FROM dates;

INSERT INTO courses (semester_id, code, title, credits, department_id, professor_id, description, seat_limit)
SELECT s.id, v.code, v.title, v.credits, d.id, p.id, v.description, v.seat_limit
FROM (VALUES
  ('CSE2010', 'Data Structures',                 3, 'CSE', 'Dr. Han Ji-won',   40,
   'Sample course. Lists, stacks, queues, trees, hash tables and graphs, with their running times.'),
  ('CSE3020', 'Web Application Development',     3, 'CSE', 'Dr. Oh Seung-woo', 30,
   'Sample course. HTML, CSS and JavaScript in the browser; REST APIs with Node.js and PostgreSQL.'),
  ('CSE3050', 'Computer Networks',               3, 'CSE', 'Dr. Oh Seung-woo', 35,
   'Sample course. The Internet protocol stack, from links and routing to TCP and HTTP.'),
  ('BUS1010', 'Principles of Management',        3, 'BUS', 'Dr. Kang Mi-rae',  80,
   'Sample course. Planning, organising, leading and controlling, with case studies.'),
  ('BUS2040', 'Marketing',                       3, 'BUS', 'Dr. Kang Mi-rae',  45,
   'Sample course. Markets, customers and the marketing mix.'),
  ('HTM2010', 'Introduction to Tourism',         3, 'HTM', 'Dr. Yoon Tae-hee', 45,
   'Sample course. The tourism industry, destinations and visitor behaviour.'),
  ('GEN1001', 'Academic English',                2, 'GEN', 'Dr. Jung Hye-jin', 24,
   'Sample course. Reading and writing academic texts in English.'),
  ('GEN1100', 'Korean Culture and Society',      2, 'GEN', 'Dr. Jung Hye-jin',  3,
   'Sample course. A small seminar; one seat is left in the sample data.')
) AS v (code, title, credits, department_code, professor_name, seat_limit, description)
CROSS JOIN semesters s
JOIN departments d ON d.code = v.department_code
JOIN professors p  ON p.full_name = v.professor_name;

-- Weekly lectures, Korea time, only in the four bookable classrooms. They avoid the
-- sample bookings above (ENG 204 is booked 13:00-15:00 on one weekday), and BUS2040 and
-- CSE3050 overlap on purpose, to show the timetable clash check.
INSERT INTO lecture_slots (course_id, weekday, starts_at, ends_at, facility_id)
SELECT c.id, v.weekday, v.starts_at::time, v.ends_at::time, f.id
FROM (VALUES
  ('CSE2010', 1, '09:00', '10:30', 'ENG', '204'), ('CSE2010', 3, '09:00', '10:30', 'ENG', '204'),
  ('CSE3020', 2, '16:00', '17:30', 'ENG', '204'), ('CSE3020', 4, '16:00', '17:30', 'ENG', '204'),
  ('CSE3050', 1, '15:00', '16:30', 'ENG', '204'), ('CSE3050', 3, '15:00', '16:30', 'ENG', '204'),
  ('BUS1010', 2, '10:00', '11:30', 'ENG', '101'), ('BUS1010', 4, '10:00', '11:30', 'ENG', '101'),
  ('BUS2040', 1, '14:00', '15:30', 'HUM', '105'), ('BUS2040', 3, '14:00', '15:30', 'HUM', '105'),
  ('HTM2010', 2, '15:00', '16:30', 'HUM', '105'), ('HTM2010', 4, '15:00', '16:30', 'HUM', '105'),
  ('GEN1001', 5, '10:00', '12:00', 'HUM', '302'),
  ('GEN1100', 5, '14:00', '16:00', 'HUM', '302')
) AS v (course_code, weekday, starts_at, ends_at, building_code, room_number)
JOIN courses c    ON c.code = v.course_code
JOIN buildings b  ON b.code = v.building_code
JOIN facilities f ON f.building_id = b.id AND f.room_number = v.room_number;

-- One session for every week of the semester (the triggers make each one hold its room).
INSERT INTO lecture_sessions (course_id, slot_id, facility_id, start_time, end_time)
SELECT ls.course_id, ls.id, ls.facility_id,
       (day + ls.starts_at) AT TIME ZONE 'Asia/Seoul',
       (day + ls.ends_at)   AT TIME ZONE 'Asia/Seoul'
FROM lecture_slots ls
JOIN courses c   ON c.id = ls.course_id
JOIN semesters s ON s.id = c.semester_id
CROSS JOIN LATERAL generate_series(s.starts_on::timestamp, s.ends_on::timestamp, interval '1 day') AS day
WHERE extract(isodow FROM day) = ls.weekday;

INSERT INTO course_registrations (course_id, student_id, registered_at)
SELECT c.id, u.id, s.starts_on - 10 + interval '10 hours'
FROM (VALUES
  ('CSE2010', 'jiho.park@kdu.example'),   ('CSE3050', 'jiho.park@kdu.example'),   ('GEN1100', 'jiho.park@kdu.example'),
  ('CSE2010', 'seoyeon.lee@kdu.example'), ('CSE3020', 'seoyeon.lee@kdu.example'), ('GEN1100', 'seoyeon.lee@kdu.example'),
  ('CSE2010', 'minjun.kim@kdu.example'),  ('BUS1010', 'minjun.kim@kdu.example'),
  ('HTM2010', 'yuna.choi@kdu.example'),   ('BUS1010', 'yuna.choi@kdu.example')
) AS v (course_code, email)
JOIN courses c   ON c.code = v.course_code
JOIN semesters s ON s.id = c.semester_id
JOIN users u     ON u.email = v.email;

-- -----------------------------------------------------------------------------
-- Grades (sample). The previous semester is over and fully marked, so students have a
-- semester GPA and a CGPA; in the current one only the midterm has been marked.
-- The previous semester has no lecture times: its rooms are history.
-- -----------------------------------------------------------------------------
INSERT INTO semesters (name, starts_on, ends_on)
SELECT CASE WHEN extract(month FROM past.starts_on) BETWEEN 3 AND 8
            THEN extract(year FROM past.starts_on)::int || ' Spring (sample)'
            ELSE (extract(year FROM past.starts_on)::int - CASE WHEN extract(month FROM past.starts_on) <= 2 THEN 1 ELSE 0 END) || ' Fall (sample)'
       END,
       past.starts_on, past.starts_on + 16 * 7 - 3
FROM (SELECT starts_on - 26 * 7 AS starts_on FROM semesters) AS past;

INSERT INTO courses (semester_id, code, title, credits, department_id, professor_id, description, seat_limit)
SELECT s.id, v.code, v.title, v.credits, d.id, p.id, v.description, 40
FROM (VALUES
  ('CSE1010', 'Introduction to Programming', 3, 'CSE', 'Dr. Han Ji-won',   'Sample course. Variables, control flow and functions in Python.'),
  ('CSE2020', 'Discrete Mathematics',        3, 'CSE', 'Dr. Oh Seung-woo', 'Sample course. Logic, sets, relations, counting and graphs.'),
  ('GEN1002', 'Academic Writing',            2, 'GEN', 'Dr. Jung Hye-jin', 'Sample course. Planning, drafting and citing in academic English.'),
  ('BUS1020', 'Accounting Basics',           3, 'BUS', 'Dr. Kang Mi-rae',  'Sample course. The accounting cycle and financial statements.'),
  ('HTM1010', 'Hospitality Fundamentals',    3, 'HTM', 'Dr. Yoon Tae-hee', 'Sample course. Hotels, food service and guest experience.')
) AS v (code, title, credits, department_code, professor_name, description)
JOIN semesters s   ON s.starts_on = (SELECT min(starts_on) FROM semesters)
JOIN departments d ON d.code = v.department_code
JOIN professors p  ON p.full_name = v.professor_name;

INSERT INTO course_registrations (course_id, student_id, registered_at)
SELECT c.id, u.id, s.starts_on - 10 + interval '10 hours'
FROM (VALUES
  ('CSE1010', 'jiho.park@kdu.example'),   ('CSE2020', 'jiho.park@kdu.example'),   ('GEN1002', 'jiho.park@kdu.example'),
  ('CSE1010', 'seoyeon.lee@kdu.example'), ('GEN1002', 'seoyeon.lee@kdu.example'),
  ('CSE1010', 'minjun.kim@kdu.example'),  ('CSE2020', 'minjun.kim@kdu.example'),
  ('HTM1010', 'yuna.choi@kdu.example'),   ('BUS1020', 'yuna.choi@kdu.example')
) AS v (course_code, email)
JOIN courses c   ON c.code = v.course_code
JOIN semesters s ON s.id = c.semester_id
JOIN users u     ON u.email = v.email;

-- Every course, both semesters: assignments 30, midterm 30, final 40.
INSERT INTO assessments (course_id, name, weight, max_points, position)
SELECT c.id, a.name, a.weight, 100, a.position
FROM courses c
CROSS JOIN (VALUES ('Assignments', 30, 1), ('Midterm exam', 30, 2), ('Final exam', 40, 3)) AS a (name, weight, position);

-- Marks out of 100: (assignments, midterm, final). NULL: not marked yet.
INSERT INTO marks (assessment_id, student_id, points, entered_by, updated_at)
SELECT a.id, u.id, m.points, admin.id, LEAST(now() - interval '1 day', s.ends_on + interval '3 days')
FROM (VALUES
  -- Previous semester, complete
  ('CSE1010', 'jiho.park@kdu.example',   92, 88, 95),
  ('CSE2020', 'jiho.park@kdu.example',   80, 75, 78),
  ('GEN1002', 'jiho.park@kdu.example',   96, 94, 97),
  ('CSE1010', 'seoyeon.lee@kdu.example', 85, 90, 88),
  ('GEN1002', 'seoyeon.lee@kdu.example', 91, 87, 90),
  ('CSE1010', 'minjun.kim@kdu.example',  70, 65, 72),
  ('CSE2020', 'minjun.kim@kdu.example',  83, 79, 81),
  ('HTM1010', 'yuna.choi@kdu.example',   90, 85, 91),
  ('BUS1020', 'yuna.choi@kdu.example',   60, 55, 58),
  -- Current semester: the midterm only
  ('CSE2010', 'jiho.park@kdu.example',   NULL, 84, NULL),
  ('CSE3050', 'jiho.park@kdu.example',   NULL, 76, NULL),
  ('GEN1100', 'jiho.park@kdu.example',   NULL, 91, NULL),
  ('CSE2010', 'seoyeon.lee@kdu.example', NULL, 88, NULL),
  ('CSE3020', 'seoyeon.lee@kdu.example', NULL, 93, NULL),
  ('CSE2010', 'minjun.kim@kdu.example',  NULL, 71, NULL),
  ('BUS1010', 'minjun.kim@kdu.example',  NULL, 80, NULL),
  ('HTM2010', 'yuna.choi@kdu.example',   NULL, 86, NULL),
  ('BUS1010', 'yuna.choi@kdu.example',   NULL, 77, NULL)
) AS v (course_code, email, assignments, midterm, final)
CROSS JOIN LATERAL (VALUES (1, v.assignments), (2, v.midterm), (3, v.final)) AS m (position, points)
JOIN courses c     ON c.code = v.course_code
JOIN semesters s   ON s.id = c.semester_id
JOIN assessments a ON a.course_id = c.id AND a.position = m.position
JOIN users u       ON u.email = v.email
CROSS JOIN (SELECT id FROM users WHERE email = 'admin@kdu.example') AS admin
WHERE m.points IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Attendance (sample): every lecture of the current semester held before today is
-- marked for its registered students. Mostly present; a few absences and excused ones,
-- chosen by a fixed rule so the numbers are the same whichever day the seed runs:
--   week number (1 = first week) and the student decide. Kim Min-jun misses most
--   BUS1010 lectures, so he is below 80% there and gets the warning.
-- -----------------------------------------------------------------------------
INSERT INTO attendance (session_id, student_id, status, marked_by, updated_at)
SELECT ls.id, r.student_id,
       CASE
         WHEN u.email = 'minjun.kim@kdu.example' AND c.code = 'BUS1010' AND w.week % 3 <> 0 THEN 'absent'
         WHEN w.week = 4 AND u.email = 'seoyeon.lee@kdu.example' THEN 'excused'
         WHEN (w.week + r.student_id) % 7 = 0 THEN 'absent'
         ELSE 'present'
       END,
       admin.id, ls.end_time + interval '1 hour'
FROM lecture_sessions ls
JOIN courses c ON c.id = ls.course_id
JOIN semesters s ON s.id = c.semester_id
JOIN course_registrations r ON r.course_id = c.id AND r.status = 'registered'
JOIN users u ON u.id = r.student_id
CROSS JOIN (SELECT id FROM users WHERE email = 'admin@kdu.example') AS admin
CROSS JOIN LATERAL (SELECT ((ls.start_time AT TIME ZONE 'Asia/Seoul')::date - s.starts_on) / 7 + 1 AS week) AS w
WHERE (ls.start_time AT TIME ZONE 'Asia/Seoul')::date < (now() AT TIME ZONE 'Asia/Seoul')::date;

-- -----------------------------------------------------------------------------
-- Assignments (sample): two for CSE2010 and one for CSE3050, without attached files.
-- In the current semester the "Assignments" assessment takes its marks from these
-- (source 'assignments'); nothing is handed in yet, so students do that in the app.
-- -----------------------------------------------------------------------------
UPDATE assessments a SET source = 'assignments'
FROM courses c
WHERE c.id = a.course_id AND a.name = 'Assignments'
  AND c.semester_id = (SELECT id FROM semesters ORDER BY starts_on DESC LIMIT 1);

INSERT INTO assignments (course_id, title, instructions, due_at, max_points, created_at)
SELECT c.id, v.title, v.instructions,
       ((now() AT TIME ZONE 'Asia/Seoul')::date + v.due_in_days + time '23:59') AT TIME ZONE 'Asia/Seoul',
       v.max_points, now() - interval '14 days'
FROM (VALUES
  ('CSE2010', 'Linked lists',      'Sample assignment. Implement a singly linked list with insert, delete and reverse, and explain the running time of each.', -3, 20),
  ('CSE2010', 'Binary search trees', 'Sample assignment. Implement insertion and in-order traversal of a binary search tree. Hand in your source file or a ZIP.', 7, 20),
  ('CSE3050', 'Packet capture report', 'Sample assignment. Capture an HTTP request with a packet analyser and explain each layer in a PDF of two pages.', 10, 100)
) AS v (course_code, title, instructions, due_in_days, max_points)
JOIN courses c ON c.code = v.course_code;

-- -----------------------------------------------------------------------------
-- Counselling (sample): weekly office hours, and a few meetings. Dr. Han Ji-won has two
-- pending requests at the same time next Tuesday (approving one declines the other);
-- Kim Min-jun has an approved meeting with Dr. Oh Seung-woo; Lee Seo-yeon had one last week.
-- -----------------------------------------------------------------------------
INSERT INTO office_hours (professor_id, weekday, starts_at, ends_at, location)
SELECT p.id, v.weekday, v.starts_at::time, v.ends_at::time, v.location
FROM (VALUES
  ('Dr. Han Ji-won',   2, '13:00', '15:00', 'ENG 405 (professor''s office)'),
  ('Dr. Han Ji-won',   4, '13:00', '15:00', 'ENG 405 (professor''s office)'),
  ('Dr. Oh Seung-woo', 1, '10:00', '12:00', 'ENG 407 (professor''s office)'),
  ('Dr. Kang Mi-rae',  3, '13:00', '15:00', 'HUM 210 (professor''s office)'),
  ('Dr. Yoon Tae-hee', 4, '10:00', '12:00', 'HUM 214 (professor''s office)'),
  ('Dr. Jung Hye-jin', 5, '13:00', '14:00', 'HUM 220 (professor''s office)')
) AS v (professor_name, weekday, starts_at, ends_at, location)
JOIN professors p ON p.full_name = v.professor_name;

WITH kst AS (
  SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS today
),
-- The first date on ISO weekday w at least `ahead` days from today (negative: in the past).
days AS (
  SELECT w, ahead, (today + ahead + ((w - extract(isodow FROM today + ahead)::int + 7) % 7)) AS day
  FROM kst CROSS JOIN (VALUES (2, 2), (1, 2), (2, -9)) AS d (w, ahead)
),
src (email, professor_name, w, ahead, starts, ends, category, description, status) AS (
  VALUES
    ('jiho.park@kdu.example',   'Dr. Han Ji-won',   2,  2, '13:30', '14:00', 'course_planning',   'Which electives to take next semester with Data Structures.', 'pending'),
    ('seoyeon.lee@kdu.example', 'Dr. Han Ji-won',   2,  2, '13:30', '14:30', 'research_supervision', 'Ideas for an undergraduate research project.',            'pending'),
    ('minjun.kim@kdu.example',  'Dr. Oh Seung-woo', 1,  2, '10:00', '10:30', 'academic_advising', 'Help with attendance and catching up in my courses.',       'approved'),
    ('seoyeon.lee@kdu.example', 'Dr. Han Ji-won',   2, -9, '14:00', '14:30', 'career_guidance',   'Internships in software companies.',                        'completed')
)
INSERT INTO meetings (student_id, professor_id, start_time, end_time, category, description, status, decided_by, decided_at, created_at)
SELECT u.id, p.id,
       (d.day + s.starts::time) AT TIME ZONE 'Asia/Seoul',
       (d.day + s.ends::time) AT TIME ZONE 'Asia/Seoul',
       s.category, s.description, s.status,
       CASE WHEN s.status <> 'pending' THEN admin.id END,
       CASE WHEN s.status <> 'pending' THEN LEAST(now(), (d.day - 1)::timestamp AT TIME ZONE 'Asia/Seoul') END,
       LEAST(now(), (d.day - 2)::timestamp AT TIME ZONE 'Asia/Seoul') - interval '1 day'
FROM src s
JOIN days d ON d.w = s.w AND d.ahead = s.ahead
JOIN users u ON u.email = s.email
JOIN professors p ON p.full_name = s.professor_name
CROSS JOIN (SELECT id FROM users WHERE email = 'admin@kdu.example') AS admin;

INSERT INTO notifications (user_id, meeting_id, type, title, message, created_at)
SELECT m.student_id, m.id, 'meeting_approved', 'Meeting approved',
       'Your meeting with ' || p.full_name || ' on ' || to_char(m.start_time AT TIME ZONE 'Asia/Seoul', 'Dy DD Mon, HH24:MI')
         || '-' || to_char(m.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') || ' was approved.',
       m.decided_at
FROM meetings m JOIN professors p ON p.id = m.professor_id
WHERE m.status = 'approved';

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
    'notifications',      (SELECT count(*) FROM notifications WHERE booking_id IS NOT NULL),
    'meeting_notifications', (SELECT count(*) FROM notifications WHERE meeting_id IS NOT NULL),
    'office_hours',       (SELECT count(*) FROM office_hours),
    'meetings',           (SELECT count(*) FROM meetings),
    'assignments',        (SELECT count(*) FROM assignments),
    'assignment_assessments', (SELECT count(*) FROM assessments WHERE source = 'assignments'),
    'departments',        (SELECT count(*) FROM departments),
    'professors',         (SELECT count(*) FROM professors),
    'semesters',          (SELECT count(*) FROM semesters),
    'courses',            (SELECT count(*) FROM courses),
    'lecture_slots',      (SELECT count(*) FROM lecture_slots),
    'lecture_sessions',   (SELECT count(*) FROM lecture_sessions),
    'course_registrations', (SELECT count(*) FROM course_registrations),
    -- 6 approved or completed bookings, plus one row per lecture session
    'room_occupancy',     (SELECT count(*) FROM room_occupancy),
    'assessments',        (SELECT count(*) FROM assessments),
    'marks',              (SELECT count(*) FROM marks),
    -- every lecture before today, for each registered student: 10 weeks, plus this week's earlier days
    'attendance_weeks',   (SELECT count(DISTINCT ((ls.start_time AT TIME ZONE 'Asia/Seoul')::date - s.starts_on) / 7)
                           FROM attendance a JOIN lecture_sessions ls ON ls.id = a.session_id
                           JOIN courses c ON c.id = ls.course_id JOIN semesters s ON s.id = c.semester_id
                           WHERE ((ls.start_time AT TIME ZONE 'Asia/Seoul')::date - s.starts_on) / 7 < 10)
  );
  expected jsonb := '{"users": 5, "buildings": 5, "facilities": 13, "equipment": 7,
                      "facility_equipment": 27, "bookings": 11, "notifications": 9,
                      "departments": 4, "professors": 5, "semesters": 2, "courses": 13,
                      "lecture_slots": 14, "lecture_sessions": 224, "course_registrations": 19,
                      "room_occupancy": 230, "assessments": 39, "marks": 36,
                      "attendance_weeks": 10, "office_hours": 6, "meetings": 4, "meeting_notifications": 1,
                      "assignments": 3, "assignment_assessments": 8}';
BEGIN
  IF actual <> expected THEN
    RAISE EXCEPTION 'Seed row counts do not match. Expected %, got %', expected, actual;
  END IF;
END $$;

COMMIT;
