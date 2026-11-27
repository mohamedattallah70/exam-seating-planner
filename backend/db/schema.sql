-- Exam Seating Planner: database schema (Neon Postgres).
-- Applied by `npm run db:setup` (db/setup.js), which also creates one
-- least-privilege database role per service (see db/roles.sql).
-- Table ownership: see docs/CONTRACT.md.

-- ===== Shared: identity (auth service) =====
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  email          TEXT NOT NULL UNIQUE,
  student_code   TEXT UNIQUE CHECK (student_code ~ '^S[0-9]{4,8}$'),
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'proctor', 'student')),
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role <> 'student' OR student_code IS NOT NULL)
);

-- ===== Hall & Seat Layout service (Mohamed Rishi) =====
CREATE TABLE IF NOT EXISTS halls (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 2 AND 60),
  building    TEXT NOT NULL CHECK (length(building) BETWEEN 1 AND 60),
  rows        INT NOT NULL CHECK (rows BETWEEN 1 AND 40),
  cols        INT NOT NULL CHECK (cols BETWEEN 1 AND 40),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seats (
  id            SERIAL PRIMARY KEY,
  hall_id       INT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  row_no        INT NOT NULL CHECK (row_no >= 1),
  col_no        INT NOT NULL CHECK (col_no >= 1),
  label         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'blocked')),
  block_reason  TEXT,
  UNIQUE (hall_id, row_no, col_no)
);

-- ===== Exam & Enrolment service (Nour) =====
CREATE TABLE IF NOT EXISTS exams (
  id                 SERIAL PRIMARY KEY,
  course_code        TEXT NOT NULL CHECK (course_code ~ '^[A-Z]{2,6}[0-9]{2,4}[A-Z]?$'),
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  exam_date          DATE NOT NULL,
  start_time         TIME NOT NULL,
  duration_min       INT NOT NULL CHECK (duration_min BETWEEN 30 AND 300),
  holiday_note       TEXT,
  holiday_checked    BOOLEAN NOT NULL DEFAULT false,
  allocation_status  TEXT NOT NULL DEFAULT 'none'
                     CHECK (allocation_status IN ('none', 'draft', 'published', 'needs_reallocation')),
  created_by         INT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exams_date_idx ON exams (exam_date);

CREATE TABLE IF NOT EXISTS exam_halls (
  exam_id  INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  hall_id  INT NOT NULL REFERENCES halls(id) ON DELETE RESTRICT,
  PRIMARY KEY (exam_id, hall_id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  exam_id     INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (exam_id, student_id)
);
CREATE INDEX IF NOT EXISTS enrollments_student_idx ON enrollments (student_id);

CREATE TABLE IF NOT EXISTS proctor_assignments (
  id          SERIAL PRIMARY KEY,
  exam_id     INT NOT NULL,
  hall_id     INT NOT NULL,
  proctor_id  INT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exam_id, hall_id, proctor_id),
  FOREIGN KEY (exam_id, hall_id) REFERENCES exam_halls(exam_id, hall_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roster_imports (
  id           SERIAL PRIMARY KEY,
  exam_id      INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('paste', 's3')),
  s3_key       TEXT,
  accepted     INT NOT NULL,
  rejected     INT NOT NULL,
  report       JSONB NOT NULL,
  imported_by  INT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Seat Allocation & Lookup service (Mohamed Attallah) =====
CREATE TABLE IF NOT EXISTS seat_assignments (
  id          SERIAL PRIMARY KEY,
  exam_id     INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  seat_id     INT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  student_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exam_id, seat_id),
  UNIQUE (exam_id, student_id)
);

CREATE TABLE IF NOT EXISTS allocation_runs (
  id          SERIAL PRIMARY KEY,
  exam_id     INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  strategy    TEXT NOT NULL CHECK (strategy IN ('fill', 'balance')),
  spacing     BOOLEAN NOT NULL,
  placed      INT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'event')),
  run_by      INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Shared: append-only audit trail =====
CREATE TABLE IF NOT EXISTS audit_logs (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   INT,
  role      TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  outcome   TEXT NOT NULL,
  ip        TEXT,
  details   JSONB
);
CREATE INDEX IF NOT EXISTS audit_logs_action_at_idx ON audit_logs (action, at DESC);
