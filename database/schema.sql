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

DROP TABLE IF EXISTS sessions, notifications, bookings, facility_equipment, equipment, facilities, buildings, users CASCADE;
-- Cleanup only: a development database created while the (since removed) email-link
-- verification existed still has this table. CASCADE above removes just its foreign key,
-- so it is dropped by name. Does nothing in any other database.
DROP TABLE IF EXISTS email_verification_tokens;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;

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
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT users_email_key          UNIQUE (email),
  CONSTRAINT users_student_number_key UNIQUE (student_number),
  -- Optional, but when given it is 1 to 6 digits. The API applies the same rule.
  CONSTRAINT users_student_number_check CHECK (student_number ~ '^[0-9]{1,6}$'),
  CONSTRAINT users_role_check         CHECK (role IN ('student', 'admin')),
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
    type IN ('booking_submitted', 'booking_approved', 'booking_rejected', 'booking_cancelled', 'system')
  )
);

CREATE INDEX notifications_user_id_created_at_idx ON notifications (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at      BEFORE UPDATE ON users      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER buildings_set_updated_at  BEFORE UPDATE ON buildings  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER facilities_set_updated_at BEFORE UPDATE ON facilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER equipment_set_updated_at  BEFORE UPDATE ON equipment  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bookings_set_updated_at   BEFORE UPDATE ON bookings   FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
