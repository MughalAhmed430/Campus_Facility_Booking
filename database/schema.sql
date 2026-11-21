-- =============================================================================
-- Smart Campus Facility Booking & Management System - database schema
-- PostgreSQL 15 or newer.
--
-- WARNING: this file DROPS the application's tables and ALL their data, then
-- recreates them. Use it to create or reset a development database:
--   npm run db:schema      then      npm run db:seed
--
-- Conventions
--   * Stored values for role/status/type are lower case ('pending'); the UI shows labels.
--   * All timestamps are TIMESTAMPTZ (an absolute instant). Display them in Asia/Seoul.
--   * Constraints are named so the API can map violations to clear messages.
-- =============================================================================

BEGIN;

-- btree_gist lets one GiST index combine "=" on a plain column (facility_id) with
-- "&&" (overlaps) on a time range. The bookings exclusion constraint needs both.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP TABLE IF EXISTS submissions, assignments, meetings, office_hours, attendance, marks, assessments, room_occupancy, course_registrations, lecture_sessions, lecture_slots, courses,
                     semesters, professors, departments CASCADE;
DROP TABLE IF EXISTS sessions, notifications, bookings, facility_equipment, equipment, facilities, buildings, users CASCADE;
-- Cleanup only: a development database created while the (since removed) email-link
-- verification existed still has this table. CASCADE above removes just its foreign key,
-- so it is dropped by name. Does nothing in any other database.
DROP TABLE IF EXISTS email_verification_tokens;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS sync_booking_occupancy() CASCADE;
DROP FUNCTION IF EXISTS sync_lecture_occupancy() CASCADE;

-- Keeps updated_at correct on every UPDATE, whichever code path made the change.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- users: students and administrators
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name      VARCHAR(100) NOT NULL,
  email          VARCHAR(254) NOT NULL,
  password_hash  TEXT         NOT NULL,
  role           TEXT         NOT NULL DEFAULT 'student',
  student_number VARCHAR(6),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,   -- deactivate instead of deleting
  -- Profile photo: the name of the file in the storage folder (outside the public client
  -- folder; see server/src/utils/file-storage.js). NULL = no photo.
  photo_file     VARCHAR(64),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT users_email_key          UNIQUE (email),
  CONSTRAINT users_student_number_key UNIQUE (student_number),
  -- Optional, but when given it is 1 to 6 digits. The API applies the same rule.
  CONSTRAINT users_student_number_check CHECK (student_number ~ '^[0-9]{1,6}$'),
  CONSTRAINT users_role_check         CHECK (role IN ('student', 'admin')),
  -- A random name the server chose: never a path, never the uploader's file name.
  CONSTRAINT users_photo_file_check   CHECK (photo_file ~ '^[0-9a-f]{32}\.(jpg|png|webp)$'),
  CONSTRAINT users_full_name_check    CHECK (btrim(full_name) <> ''),
  -- The API lower-cases emails, so "Kim@x" and "kim@x" cannot become two accounts.
  CONSTRAINT users_email_lowercase    CHECK (email = lower(email)),
  -- Only bcrypt hashes are accepted: a plain-text password can never be stored by mistake.
  CONSTRAINT users_password_is_bcrypt CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$')
);

-- -----------------------------------------------------------------------------
-- sessions: server-side login sessions
--
-- The browser holds a random 256-bit token in an httpOnly cookie. Only its
-- SHA-256 hash is stored, so a copy of this table cannot be used to log in.
-- Logout deletes the row; deactivating a user makes their sessions stop working
-- immediately because every lookup also checks users.is_active.
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
  token_hash TEXT        PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_expiry_check     CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_id_idx    ON sessions (user_id);     -- "log this user out everywhere"
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);  -- clean-up of expired sessions

-- -----------------------------------------------------------------------------
-- buildings
-- -----------------------------------------------------------------------------
CREATE TABLE buildings (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        VARCHAR(10)  NOT NULL,              -- short code shown in room labels, e.g. ENG
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT buildings_code_key   UNIQUE (code),
  CONSTRAINT buildings_name_key   UNIQUE (name),
  CONSTRAINT buildings_code_check CHECK (code ~ '^[A-Z0-9]{2,10}$')
);

-- -----------------------------------------------------------------------------
-- facilities: bookable rooms
-- -----------------------------------------------------------------------------
CREATE TABLE facilities (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  building_id      INTEGER      NOT NULL REFERENCES buildings (id) ON DELETE RESTRICT,
  room_number      VARCHAR(20)  NOT NULL,
  name             VARCHAR(100) NOT NULL,
  facility_type    TEXT         NOT NULL,
  capacity         INTEGER      NOT NULL,
  floor            SMALLINT     NOT NULL,
  description      TEXT,
  status           TEXT         NOT NULL DEFAULT 'active',
  -- Opening hours: campus local time (Asia/Seoul), the same on every day the facility
  -- is open. The booking service will only accept requests that start and end inside them.
  opens_at         TIME(0)      NOT NULL DEFAULT '09:00',
  closes_at        TIME(0)      NOT NULL DEFAULT '21:00',
  -- false: closed on Saturday and Sunday (Korea time), so requests for those days are
  -- refused. There are no separate weekend hours: opens_at/closes_at apply on all open days.
  is_open_weekends BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Also serves as the index for "facilities in building X".
  CONSTRAINT facilities_building_room_key UNIQUE (building_id, room_number),
  CONSTRAINT facilities_hours_check       CHECK (closes_at > opens_at),
  CONSTRAINT facilities_type_check        CHECK (facility_type IN ('classroom', 'laboratory', 'meeting_room')),
  -- active: bookable. maintenance: temporarily unavailable. inactive: retired by an admin.
  CONSTRAINT facilities_status_check      CHECK (status IN ('active', 'maintenance', 'inactive')),
  CONSTRAINT facilities_capacity_check    CHECK (capacity BETWEEN 1 AND 1000),
  CONSTRAINT facilities_floor_check       CHECK (floor BETWEEN -5 AND 50),
  CONSTRAINT facilities_name_check        CHECK (btrim(name) <> '')
);

-- -----------------------------------------------------------------------------
-- equipment and facility_equipment (many-to-many, with a quantity)
-- -----------------------------------------------------------------------------
CREATE TABLE equipment (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT equipment_name_key UNIQUE (name)
);

CREATE TABLE facility_equipment (
  facility_id  INTEGER NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  -- RESTRICT: an equipment type still listed in a room cannot be deleted by accident.
  equipment_id INTEGER NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
  quantity     INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (facility_id, equipment_id),
  CONSTRAINT facility_equipment_quantity_check CHECK (quantity BETWEEN 1 AND 1000)
);

-- Supports "find facilities that have a projector" (the primary key starts with facility_id).
CREATE INDEX facility_equipment_equipment_id_idx ON facility_equipment (equipment_id);

-- -----------------------------------------------------------------------------
-- bookings
--
-- Lifecycle: pending -> approved | rejected | cancelled
--            approved -> completed | cancelled
-- Transitions are enforced by the booking service with conditional updates
-- (UPDATE ... WHERE status = 'pending'); the constraints below guarantee that
-- every row is internally consistent and that approved bookings never overlap.
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             INTEGER      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  facility_id         INTEGER      NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  start_time          TIMESTAMPTZ  NOT NULL,
  end_time            TIMESTAMPTZ  NOT NULL,
  attendees           INTEGER      NOT NULL,
  purpose             VARCHAR(500) NOT NULL,
  notes               VARCHAR(500),                       -- optional extra detail from the student
  status              TEXT         NOT NULL DEFAULT 'pending',

  -- Administrator decision (approve / reject).
  decided_by          INTEGER      REFERENCES users (id) ON DELETE RESTRICT,
  decided_at          TIMESTAMPTZ,
  decision_note       VARCHAR(500),

  -- Cancellation, by the student or by an administrator.
  cancelled_by        INTEGER      REFERENCES users (id) ON DELETE RESTRICT,
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason VARCHAR(500),

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT bookings_status_check     CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'completed')),
  CONSTRAINT bookings_time_order_check CHECK (end_time > start_time),
  CONSTRAINT bookings_attendees_check  CHECK (attendees BETWEEN 1 AND 1000),
  CONSTRAINT bookings_purpose_check    CHECK (btrim(purpose) <> ''),

  -- Who decided and when is always recorded for approved, rejected and completed
  -- bookings, never present on pending ones, and optional on cancelled ones
  -- (a booking can be cancelled before or after it was approved).
  -- (Unknown status values pass this check so that bookings_status_check reports them.)
  CONSTRAINT bookings_decision_check CHECK (
    CASE
      WHEN status = 'pending'
        THEN decided_by IS NULL AND decided_at IS NULL
      WHEN status IN ('approved', 'rejected', 'completed')
        THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      ELSE (decided_by IS NULL) = (decided_at IS NULL)
    END
  ),

  -- Who cancelled and when is recorded if, and only if, the booking is cancelled.
  CONSTRAINT bookings_cancellation_check CHECK (
    (status = 'cancelled') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
  ),

  -- THE DOUBLE-BOOKING GUARD.
  -- No two rows for the same facility whose time ranges overlap (&&) may both be
  -- approved or completed. '[)' means start is included and end is excluded, so
  -- back-to-back bookings (10:00-11:00 then 11:00-12:00) are allowed.
  -- Pending, rejected and cancelled requests do not hold the slot.
  -- Violations raise SQLSTATE 23P01 (exclusion_violation). A new pending request can never
  -- raise it, because pending rows are outside this constraint: the booking service checks
  -- for an approved overlap inside its INSERT. This constraint is what stops an approval.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    facility_id                            WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status IN ('approved', 'completed'))
);

CREATE INDEX bookings_user_id_start_time_idx     ON bookings (user_id, start_time DESC); -- "my bookings"
CREATE INDEX bookings_facility_id_start_time_idx ON bookings (facility_id, start_time);  -- facility schedule
CREATE INDEX bookings_pending_start_time_idx     ON bookings (start_time)                -- admin review queue
  WHERE status = 'pending';

-- -----------------------------------------------------------------------------
-- notifications: in-app messages for one user
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER       NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  booking_id INTEGER       REFERENCES bookings (id) ON DELETE CASCADE,
  type       TEXT          NOT NULL,
  title      VARCHAR(150)  NOT NULL,
  message    VARCHAR(1000) NOT NULL,
  read_at    TIMESTAMPTZ,                       -- NULL = unread
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT notifications_type_check CHECK (
    type IN ('booking_approved', 'booking_rejected', 'booking_cancelled', 'system',
             'meeting_approved', 'meeting_rejected', 'meeting_cancelled', 'assignment_marked')
  )
);

CREATE INDEX notifications_user_id_created_at_idx ON notifications (user_id, created_at DESC);

-- =============================================================================
-- ACADEMIC MODULE: courses, professors and course registration
--
-- A separate module next to facility reservations. There is no professor role: the
-- administrator acts as the academic office and enters this data. Professors are
-- records, not user accounts.
-- =============================================================================

CREATE TABLE departments (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       VARCHAR(10)  NOT NULL,              -- short code, e.g. CSE
  name       VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT departments_code_key   UNIQUE (code),
  CONSTRAINT departments_name_key   UNIQUE (name),
  CONSTRAINT departments_code_check CHECK (code ~ '^[A-Z]{2,10}$')
);

-- Only a name, a department and (optionally) a publicly available photo with its credit.
CREATE TABLE professors (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name     VARCHAR(100) NOT NULL,
  department_id INTEGER      NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
  photo_file    VARCHAR(64),                      -- in the storage folder, like users.photo_file
  photo_credit  VARCHAR(200),                     -- where the photo comes from, shown under it
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT professors_full_name_check  CHECK (btrim(full_name) <> ''),
  CONSTRAINT professors_photo_file_check CHECK (photo_file ~ '^[0-9a-f]{32}\.(jpg|png|webp)$'),
  -- A photo is never shown without saying where it comes from.
  CONSTRAINT professors_photo_credit_check CHECK (photo_file IS NULL OR btrim(photo_credit) <> '')
);

CREATE TABLE semesters (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       VARCHAR(40) NOT NULL,                -- e.g. "2026 Fall"
  starts_on  DATE        NOT NULL,                -- first day of lectures (Korea time)
  ends_on    DATE        NOT NULL,                -- last day of lectures, inclusive

  CONSTRAINT semesters_name_key    UNIQUE (name),
  CONSTRAINT semesters_dates_check CHECK (ends_on > starts_on),
  CONSTRAINT semesters_no_overlap  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&)
);

CREATE TABLE courses (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  semester_id   INTEGER      NOT NULL REFERENCES semesters (id) ON DELETE RESTRICT,
  code          VARCHAR(12)  NOT NULL,            -- e.g. CSE2010
  title         VARCHAR(150) NOT NULL,
  credits       SMALLINT     NOT NULL,
  department_id INTEGER      NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
  professor_id  INTEGER      NOT NULL REFERENCES professors (id) ON DELETE RESTRICT,
  description   TEXT,
  seat_limit    INTEGER      NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT courses_semester_code_key UNIQUE (semester_id, code),
  CONSTRAINT courses_code_check        CHECK (code ~ '^[A-Z]{2,5}[0-9]{3,4}[A-Z]?$'),
  CONSTRAINT courses_title_check       CHECK (btrim(title) <> ''),
  CONSTRAINT courses_credits_check     CHECK (credits BETWEEN 1 AND 6),
  CONSTRAINT courses_seat_limit_check  CHECK (seat_limit BETWEEN 1 AND 1000)
);

CREATE INDEX courses_professor_id_idx ON courses (professor_id);

-- The weekly pattern: "Tuesdays 10:00-11:30 in ENG 204", Korea time.
CREATE TABLE lecture_slots (
  id          INTEGER  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id   INTEGER  NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  weekday     SMALLINT NOT NULL,                  -- ISO: 1 = Monday ... 7 = Sunday
  starts_at   TIME(0)  NOT NULL,
  ends_at     TIME(0)  NOT NULL,
  facility_id INTEGER  NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lecture_slots_weekday_check CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT lecture_slots_time_check    CHECK (ends_at > starts_at),
  CONSTRAINT lecture_slots_grid_check    CHECK (extract(minute FROM starts_at)::int % 30 = 0
                                                AND extract(minute FROM ends_at)::int % 30 = 0
                                                AND extract(second FROM starts_at) = 0
                                                AND extract(second FROM ends_at) = 0)
);

CREATE INDEX lecture_slots_course_id_idx ON lecture_slots (course_id);

-- Each dated lecture, generated from a slot for every week of the semester. These rows
-- are what hold the room (see room_occupancy), and what attendance is taken for.
-- Removing a slot deletes its sessions from now on; past sessions stay, with slot_id NULL.
CREATE TABLE lecture_sessions (
  id          INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id   INTEGER     NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  slot_id     INTEGER     REFERENCES lecture_slots (id) ON DELETE SET NULL,
  facility_id INTEGER     NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,

  CONSTRAINT lecture_sessions_time_check CHECK (end_time > start_time),
  CONSTRAINT lecture_sessions_slot_start_key UNIQUE (slot_id, start_time)
);

CREATE INDEX lecture_sessions_course_id_start_idx   ON lecture_sessions (course_id, start_time);
CREATE INDEX lecture_sessions_facility_id_start_idx ON lecture_sessions (facility_id, start_time);

-- A student's place in a course. Dropping keeps the row (status 'dropped'), so the
-- history stays; registering again turns it back to 'registered'.
CREATE TABLE course_registrations (
  course_id     INTEGER     NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  student_id    INTEGER     NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status        TEXT        NOT NULL DEFAULT 'registered',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dropped_at    TIMESTAMPTZ,

  PRIMARY KEY (course_id, student_id),
  CONSTRAINT course_registrations_status_check  CHECK (status IN ('registered', 'dropped')),
  CONSTRAINT course_registrations_dropped_check CHECK ((status = 'dropped') = (dropped_at IS NOT NULL))
);

CREATE INDEX course_registrations_student_id_idx ON course_registrations (student_id) WHERE status = 'registered';

-- -----------------------------------------------------------------------------
-- room_occupancy: THE ROOM GUARD shared by reservations and lectures
--
-- One row for every approved or completed booking and for every lecture session,
-- kept in step by the triggers below (application code never writes here). The
-- exclusion constraint means that no two things holding the same room can overlap,
-- whichever kind they are: a lecture cannot be scheduled over an approved booking,
-- a booking cannot be approved over a lecture, and two lectures cannot share a room.
-- Like bookings_no_overlap, violations raise SQLSTATE 23P01, here with the constraint
-- name room_occupancy_no_overlap. bookings_no_overlap stays as it is.
-- -----------------------------------------------------------------------------
CREATE TABLE room_occupancy (
  id                 INTEGER   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  facility_id        INTEGER   NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  during             TSTZRANGE NOT NULL,
  booking_id         INTEGER   REFERENCES bookings (id) ON DELETE CASCADE,
  lecture_session_id INTEGER   REFERENCES lecture_sessions (id) ON DELETE CASCADE,

  CONSTRAINT room_occupancy_booking_key UNIQUE (booking_id),
  CONSTRAINT room_occupancy_session_key UNIQUE (lecture_session_id),
  CONSTRAINT room_occupancy_one_source  CHECK ((booking_id IS NULL) <> (lecture_session_id IS NULL)),
  CONSTRAINT room_occupancy_no_overlap  EXCLUDE USING gist (facility_id WITH =, during WITH &&)
);

-- A booking holds its room while approved or completed, and stops when it leaves those.
CREATE FUNCTION sync_booking_occupancy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('approved', 'completed') THEN
    INSERT INTO room_occupancy (facility_id, during, booking_id)
    VALUES (NEW.facility_id, tstzrange(NEW.start_time, NEW.end_time, '[)'), NEW.id)
    ON CONFLICT (booking_id) DO UPDATE SET facility_id = EXCLUDED.facility_id, during = EXCLUDED.during;
  ELSE
    DELETE FROM room_occupancy WHERE booking_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

-- A lecture session always holds its room. Deleting the session deletes its row (CASCADE).
CREATE FUNCTION sync_lecture_occupancy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO room_occupancy (facility_id, during, lecture_session_id)
  VALUES (NEW.facility_id, tstzrange(NEW.start_time, NEW.end_time, '[)'), NEW.id)
  ON CONFLICT (lecture_session_id) DO UPDATE SET facility_id = EXCLUDED.facility_id, during = EXCLUDED.during;
  RETURN NULL;
END;
$$;

CREATE TRIGGER bookings_sync_occupancy
  AFTER INSERT OR UPDATE OF status, facility_id, start_time, end_time ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_booking_occupancy();
CREATE TRIGGER lecture_sessions_sync_occupancy
  AFTER INSERT OR UPDATE OF facility_id, start_time, end_time ON lecture_sessions
  FOR EACH ROW EXECUTE FUNCTION sync_lecture_occupancy();

-- -----------------------------------------------------------------------------
-- Grades: each course has weighted assessments (e.g. assignments 30, midterm 30,
-- final 40); the administrator enters each student's marks. The course total, letter
-- grade and GPA are computed by the server from the grade scale in
-- server/src/services/grade.service.js (documented in README.md), not stored.
-- -----------------------------------------------------------------------------
CREATE TABLE assessments (
  id         INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id  INTEGER      NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  name       VARCHAR(60)  NOT NULL,
  weight     NUMERIC(5,2) NOT NULL,                -- share of the course total, in percent
  max_points NUMERIC(6,2) NOT NULL DEFAULT 100,    -- marks are out of this
  -- 'manual': the administrator enters each mark. 'assignments': the mark is worked out
  -- from the student's marked assignments in the course (see grade.service.js).
  source     TEXT         NOT NULL DEFAULT 'manual',
  position   SMALLINT     NOT NULL DEFAULT 0,      -- display order
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT assessments_course_name_key UNIQUE (course_id, name),
  CONSTRAINT assessments_name_check      CHECK (btrim(name) <> ''),
  CONSTRAINT assessments_weight_check    CHECK (weight > 0 AND weight <= 100),
  CONSTRAINT assessments_max_check       CHECK (max_points > 0 AND max_points <= 1000),
  CONSTRAINT assessments_source_check    CHECK (source IN ('manual', 'assignments'))
);

CREATE TABLE marks (
  assessment_id INTEGER      NOT NULL REFERENCES assessments (id) ON DELETE RESTRICT,
  student_id    INTEGER      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  points        NUMERIC(6,2) NOT NULL,
  entered_by    INTEGER      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  PRIMARY KEY (assessment_id, student_id),
  CONSTRAINT marks_points_check CHECK (points >= 0)  -- at most max_points: checked by the service
);

CREATE INDEX marks_student_id_idx ON marks (student_id);

-- -----------------------------------------------------------------------------
-- Attendance: one mark per student per lecture session, which the administrator can
-- change. A session deleted with its course takes its marks with it; removing a weekly
-- lecture only deletes future sessions, which have no marks.
-- -----------------------------------------------------------------------------
CREATE TABLE attendance (
  session_id INTEGER     NOT NULL REFERENCES lecture_sessions (id) ON DELETE CASCADE,
  student_id INTEGER     NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status     TEXT        NOT NULL,
  marked_by  INTEGER     NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (session_id, student_id),
  CONSTRAINT attendance_status_check CHECK (status IN ('present', 'absent', 'excused'))
);

CREATE INDEX attendance_student_id_idx ON attendance (student_id);

-- -----------------------------------------------------------------------------
-- Counselling: the professors are the advisors. Each has weekly office hours; students
-- request a meeting inside them, and an administrator approves or declines it. The
-- statuses and their transitions are the bookings' own (see booking.service.js).
-- -----------------------------------------------------------------------------
CREATE TABLE office_hours (
  id           INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  professor_id INTEGER     NOT NULL REFERENCES professors (id) ON DELETE CASCADE,
  weekday      SMALLINT    NOT NULL,              -- ISO: 1 = Monday ... 7 = Sunday
  starts_at    TIME(0)     NOT NULL,
  ends_at      TIME(0)     NOT NULL,
  location     VARCHAR(100) NOT NULL,             -- e.g. "ENG 405 (professor's office)"

  CONSTRAINT office_hours_weekday_check CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT office_hours_time_check    CHECK (ends_at > starts_at),
  CONSTRAINT office_hours_grid_check    CHECK (extract(minute FROM starts_at)::int % 30 = 0 AND extract(minute FROM ends_at)::int % 30 = 0),
  CONSTRAINT office_hours_location_check CHECK (btrim(location) <> '')
);

CREATE INDEX office_hours_professor_id_idx ON office_hours (professor_id, weekday);

CREATE TABLE meetings (
  id                  INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id          INTEGER      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  professor_id        INTEGER      NOT NULL REFERENCES professors (id) ON DELETE RESTRICT,
  start_time          TIMESTAMPTZ  NOT NULL,
  end_time            TIMESTAMPTZ  NOT NULL,
  category            TEXT         NOT NULL,
  description         VARCHAR(500) NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'pending',
  decided_by          INTEGER      REFERENCES users (id) ON DELETE RESTRICT,
  decided_at          TIMESTAMPTZ,
  decision_note       VARCHAR(500),
  cancelled_by        INTEGER      REFERENCES users (id) ON DELETE RESTRICT,
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason VARCHAR(500),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT meetings_status_check   CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'completed')),
  CONSTRAINT meetings_category_check CHECK (category IN ('academic_advising', 'course_planning', 'career_guidance',
                                                         'research_supervision', 'internship', 'other')),
  CONSTRAINT meetings_time_check     CHECK (end_time > start_time),
  CONSTRAINT meetings_description_check CHECK (btrim(description) <> ''),
  CONSTRAINT meetings_decision_check CHECK (
    CASE
      WHEN status = 'pending' THEN decided_by IS NULL AND decided_at IS NULL
      WHEN status IN ('approved', 'rejected', 'completed') THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      ELSE (decided_by IS NULL) = (decided_at IS NULL)
    END
  ),
  CONSTRAINT meetings_cancellation_check CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)),

  -- THE ADVISOR GUARD, like bookings_no_overlap: one professor never has two overlapping
  -- approved (or completed) meetings. Pending requests do not hold the time.
  CONSTRAINT meetings_no_overlap EXCLUDE USING gist (
    professor_id                          WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status IN ('approved', 'completed'))
);

CREATE INDEX meetings_student_id_idx   ON meetings (student_id, start_time DESC);
CREATE INDEX meetings_professor_id_idx ON meetings (professor_id, start_time);

-- Notifications about a meeting point at it (as booking_id does for bookings).
ALTER TABLE notifications ADD COLUMN meeting_id INTEGER REFERENCES meetings (id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- Assignments and submissions. Files live in the storage folder (outside the public
-- client folder) under random names; they are served only through the API, to the
-- student who handed one in or an administrator. Each column *_file is that name.
-- -----------------------------------------------------------------------------
CREATE TABLE assignments (
  id              INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id       INTEGER      NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  title           VARCHAR(150) NOT NULL,
  instructions    TEXT         NOT NULL,
  due_at          TIMESTAMPTZ  NOT NULL,
  max_points      NUMERIC(6,2) NOT NULL DEFAULT 100,
  attachment_file VARCHAR(64),                  -- optional file from the academic office
  attachment_name VARCHAR(255),                 -- its original name, for the download
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT assignments_title_check      CHECK (btrim(title) <> ''),
  CONSTRAINT assignments_max_check        CHECK (max_points > 0 AND max_points <= 1000),
  CONSTRAINT assignments_file_check       CHECK (attachment_file ~ '^[0-9a-f]{32}\.[a-z0-9]{1,8}$'),
  CONSTRAINT assignments_attachment_check CHECK ((attachment_file IS NULL) = (attachment_name IS NULL))
);

CREATE INDEX assignments_course_id_idx ON assignments (course_id, due_at);

-- One submission per student per assignment; handing in again replaces the file.
CREATE TABLE submissions (
  assignment_id INTEGER      NOT NULL REFERENCES assignments (id) ON DELETE RESTRICT,
  student_id    INTEGER      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  file          VARCHAR(64)  NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size_bytes    INTEGER      NOT NULL,
  submitted_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_late       BOOLEAN      NOT NULL,           -- handed in after the due time
  points        NUMERIC(6,2),                    -- NULL: not marked yet
  feedback      VARCHAR(2000),
  marked_by     INTEGER      REFERENCES users (id) ON DELETE RESTRICT,
  marked_at     TIMESTAMPTZ,

  PRIMARY KEY (assignment_id, student_id),
  CONSTRAINT submissions_file_check   CHECK (file ~ '^[0-9a-f]{32}\.[a-z0-9]{1,8}$'),
  CONSTRAINT submissions_size_check   CHECK (size_bytes > 0),
  CONSTRAINT submissions_points_check CHECK (points >= 0),
  CONSTRAINT submissions_marked_check CHECK ((points IS NULL) = (marked_at IS NULL) AND (marked_at IS NULL) = (marked_by IS NULL))
);

CREATE INDEX submissions_student_id_idx ON submissions (student_id);

ALTER TABLE notifications ADD COLUMN assignment_id INTEGER REFERENCES assignments (id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at      BEFORE UPDATE ON users      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER buildings_set_updated_at  BEFORE UPDATE ON buildings  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER facilities_set_updated_at BEFORE UPDATE ON facilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER equipment_set_updated_at  BEFORE UPDATE ON equipment  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bookings_set_updated_at   BEFORE UPDATE ON bookings   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER professors_set_updated_at BEFORE UPDATE ON professors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER courses_set_updated_at    BEFORE UPDATE ON courses    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER meetings_set_updated_at   BEFORE UPDATE ON meetings   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER assignments_set_updated_at BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
