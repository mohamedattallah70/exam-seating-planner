-- Least-privilege grants: one database role per service.
-- Roles are created (with random passwords) by db/setup.js before this runs.
-- Rules:
--   * No service role owns tables or can CREATE/ALTER/DROP/TRUNCATE (no DDL).
--   * Each service can write ONLY the tables it owns; it can read what it needs from others.
--   * audit_logs is append-only for everyone (SELECT + INSERT, no UPDATE/DELETE).
--   * Only the auth role can read users.password_hash.

-- Start from zero every run, so re-running never leaves old, wider grants behind.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, esp_auth, esp_halls, esp_exams, esp_allocation;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, esp_auth, esp_halls, esp_exams, esp_allocation;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO esp_auth, esp_halls, esp_exams, esp_allocation;

-- Audit trail (all services): append-only
GRANT SELECT, INSERT ON audit_logs TO esp_auth, esp_halls, esp_exams, esp_allocation;
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO esp_auth, esp_halls, esp_exams, esp_allocation;

-- Auth service
GRANT SELECT ON users TO esp_auth;
GRANT UPDATE (failed_logins, locked_until, last_login_at) ON users TO esp_auth;

-- Public user columns (no password_hash) for the other services
GRANT SELECT (id, name, email, student_code, role) ON users TO esp_halls, esp_exams, esp_allocation;

-- Hall & Seat Layout service: owns halls, seats
GRANT SELECT, INSERT, UPDATE, DELETE ON halls, seats TO esp_halls;
GRANT USAGE ON SEQUENCE halls_id_seq, seats_id_seq TO esp_halls;
GRANT SELECT ON exams, exam_halls, seat_assignments TO esp_halls;

-- Exam & Enrolment service: owns exams, exam_halls, enrollments, proctor_assignments, roster_imports
GRANT SELECT, INSERT, DELETE ON exams TO esp_exams;
-- every column EXCEPT allocation_status (that one belongs to the allocation service)
GRANT UPDATE (course_code, title, exam_date, start_time, duration_min, holiday_note, holiday_checked, updated_at) ON exams TO esp_exams;
GRANT SELECT, INSERT, UPDATE, DELETE ON exam_halls, enrollments, proctor_assignments, roster_imports TO esp_exams;
GRANT USAGE ON SEQUENCE exams_id_seq, proctor_assignments_id_seq, roster_imports_id_seq TO esp_exams;
GRANT SELECT ON halls, seats, seat_assignments TO esp_exams;

-- Seat Allocation service: owns seat_assignments, allocation_runs; may only change exams.allocation_status
GRANT SELECT, INSERT, UPDATE, DELETE ON seat_assignments, allocation_runs TO esp_allocation;
GRANT USAGE ON SEQUENCE seat_assignments_id_seq, allocation_runs_id_seq TO esp_allocation;
GRANT SELECT ON halls, seats, exams, exam_halls, enrollments, proctor_assignments TO esp_allocation;
GRANT UPDATE (allocation_status, updated_at) ON exams TO esp_allocation;
