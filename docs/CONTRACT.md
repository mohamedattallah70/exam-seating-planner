# Team Contract — how our services fit together

Read this before writing code. If you need something here changed, ask Nour first. Shared files belong to everyone, so we don't change them on our own.

## 1. Ownership

| Area | Owner | Folders / files you may edit |
|---|---|---|
| Hall & Seat Layout service | **Mohamed Rishi** | `backend/services/halls/`, `frontend/halls.html`, `frontend/js/halls*.js` |
| Auth hardening + logging/monitoring lead | **Mohamed Rishi** | `backend/services/auth/`, metric filters/alarms in `backend/infra/provision.js` (tell Nour) |
| Seat Allocation & Lookup service (+ event worker) | **Mohamed Attallah** | `backend/services/allocation/`, `frontend/allocation.html`, `my-seat.html`, `seat-map.html`, `frontend/js/alloc*.js` |
| Security test table + integrated test plan lead | **Mohamed Attallah** | `docs/tests/` |
| Exam & Enrolment service | **Nour** | `backend/services/exams/`, `frontend/exams*.html`, `frontend/js/exams*.js` |
| Floci deployment, DB, shared code, report assembly | **Nour** | `backend/shared/`, `backend/gateway/`, `backend/db/`, `backend/infra/`, `frontend/js/{api,layout,config}.js`, `frontend/css/` |

This rebalances shared work after the Phase 1 feedback said Attallah was overloaded. Deployment moved to Nour, and logging moved to Rishi.

## 2. Architecture

```
Browser ──> S3 website (esp-frontend on Floci)
   │ fetch + JWT
   ▼
Gateway :8080  (CORS allow-list, helmet, rate limit, path routing = ALB path rules)
   ├─ /api/auth/*                                   -> auth        :3001  [Rishi]
   ├─ /api/halls/*                                  -> halls       :3002  [Rishi]
   ├─ /api/exams/*, /api/holidays/*, /api/users/*   -> exams       :3003  [Nour]
   └─ /api/exams/:id/allocation*, /api/allocations/*,
      /api/me/seats, /api/exams/:id/halls/:hid/seat-map -> allocation :3004 [Attallah]

halls + exams ──publish──> SNS esp-domain-events ──> SQS esp-allocation-events (+DLQ) ──> allocation worker
every service ──> Neon Postgres (own DB role) · Secrets Manager · CloudWatch Logs · EventBridge audit bus
```

Each service is its own Node process, with its own port, DB role, IAM role and log group. On Floci, ECS and the ALB are created but are "control plane only" (same as Lab 8). The gateway does the ALB's path routing locally.

## 3. Getting started (each member, on your own laptop)

1. Install Docker Desktop and Node 20+, then start Docker Desktop.
2. `git clone https://github.com/ams796/Exam-Seating-Planner.git`, then `git checkout -b <yourname>` (`rishi` / `attallah`).
3. Put the `backend/.env` that Nour sends you **privately** into `backend/`. Never commit it.
4. ```
   cd backend
   npm install
   npm run floci:up      # start Floci (Docker)
   npm run provision     # create all AWS resources on your Floci + load secrets
   npm run deploy:web    # upload frontend to S3
   npm run dev           # start gateway + all services
   ```
5. Open http://localhost:4566/esp-frontend/index.html. Log in as `admin@esp.test` (passwords are in `.env` → `SEED_*`).
   For quicker frontend work, you can also open the HTML files with VS Code Live Server. Add its origin to `CORS_ORIGINS` in `.env` first.

The database is **shared** (one Neon DB for the team), so don't run `db:reset` without telling everyone.

## 4. Writing a service (template)

`backend/services/<name>/index.js`:

```js
const { createService } = require('../../shared/createService');
const routes = require('./routes');
const service = createService('halls', (app) => app.use('/api/halls', routes));
if (require.main === module) service.start();
module.exports = service;
```

Suggested layout: `routes.js` (express.Router + validation + roles), `controller.js` (business rules), `store.js` (SQL). The shared helpers below do the heavy lifting, so use them rather than writing your own:

| Need | Use |
|---|---|
| Login required / role check | `requireAuth()`, `requireRole('admin')` from `shared/auth` → 401/403 |
| Validate input | `validate({ body: z.object({...}), params, query })` from `shared/validate`. Values go in `req.valid.body` |
| SQL | `query(sql, params)` / `withTransaction(async (client) => ...)` from `shared/db`. **Always `$1` parameters** |
| Errors | `throw conflict('CODE', 'message')`, `notFound('Hall')`, `badRequest(...)` from `shared/errors` |
| Audit trail | `await audit(req, 'HALL_DELETED', { target: 'hall:3' })` from `shared/audit` |
| Logs | `log('info', 'event_name', {...})` from `shared/logger` (goes to CloudWatch `/esp/<service>`) |
| Publish event | `publishEvent('hall.seat_blocked', payload, 'halls')` from `shared/events` |
| AWS clients | `require('../../shared/aws').s3()` / `.sqs()` / `.dynamo()` / `.cloudwatch()` … |
| Secrets | `getSecret('esp/...')` from `shared/secrets`. Never read secrets from `.env` in a service |

Error response format (everyone): `{ "error": { "code": "SOME_CODE", "message": "Human text", "details": [...] } }`.

Frontend: include `js/config.js`, `js/api.js`, `js/layout.js` and call `const user = await ESP.initPage({ roles: ['admin'] })`. Call the API with `ESP.api('/halls', { method: 'POST', body })`. Build DOM with `ESP.el(...)`, and **never use innerHTML with data**.

## 5. Database (Neon) — tables and who may write them

See `backend/db/schema.sql` and `backend/db/roles.sql`. Each service connects as its own role. **You cannot write another service's tables.** That is on purpose: it's our least-privilege story.

| Table | Owner (read/write) | Read-only for |
|---|---|---|
| users | auth (only role that sees `password_hash`) | all (id, name, email, student_code, role) |
| halls, seats | **halls** | exams, allocation |
| exams, exam_halls, enrollments, proctor_assignments, roster_imports | **exams** | halls (exams, exam_halls), allocation |
| seat_assignments, allocation_runs | **allocation** | halls, exams (seat_assignments) |
| exams.allocation_status | **allocation** only (column grant) | all |
| audit_logs | append-only for all (INSERT + SELECT, no UPDATE/DELETE) | |

`exams.allocation_status`: `none` → `draft` → `published`. It becomes `needs_reallocation` when a change makes the plan invalid.

## 6. Events (SNS → SQS → allocation worker)

Message body: `{ id, type, source, occurredAt, payload }`. Producers call `publishEvent(type, payload, source)` **after** their DB transaction commits.

| type | producer | payload | worker must do |
|---|---|---|---|
| `hall.seat_blocked` | halls | `{ hallId, seatId }` | For each exam with an assignment on that seat: **draft** → delete the assignment, set the exam to `needs_reallocation`. **published** → move the student to the nearest free seat (same hall first, then the exam's other halls) and log/audit `STUDENT_RELOCATED` |
| `hall.resized` | halls | `{ hallId, removedSeatIds: [] }` | Affected draft exams → `needs_reallocation` (their assignments were already removed by FK cascade) |
| `exam.rescheduled` | exams | `{ examId, from: {date,start,duration}, to: {...} }` | Published plan stays valid (seats don't depend on time). Regenerate the seat-map export in S3 |
| `exam.halls_changed` | exams | `{ examId, addedHallIds, removedHallIds }` | Delete assignments in removed halls. If any student is left unseated → `needs_reallocation` |
| `exam.roster_changed` | exams | `{ examId, addedStudentIds, removedStudentIds }` | Removed → delete their assignment. Added + published → seat them in a free seat, else `needs_reallocation` |
| `exam.deleted` | exams | `{ examId }` | Delete the S3 seat-map exports |

Failed messages are retried 3 times, then go to `esp-allocation-events-dlq`. The worker must be idempotent: handling the same event twice must not break anything.

## 7. Business rules per service (these answer the Phase 1 feedback, so implement them)

### Halls — Rishi (feedback: "mostly CRUD" → add these rules)
- **Create**: name unique (409), rows/cols 1–40, and seats generated as a grid (`A1`…) in one transaction.
- **List/search**: by building, by min **usable capacity** (available seats), and optional `spacing=true` capacity (alternate columns only).
- **Impact preview** `GET /api/halls/:id/seats/:seatId/impact` and `GET /api/halls/:id/resize-impact?rows=&cols=`. These return which exams/students would be affected, before any change.
- **Block/unblock a seat** `PATCH /api/halls/:id/seats/:seatId`:
  - If the seat is used in a **published** plan, it's allowed only if that exam still has a free seat to move the student to. Otherwise return 409 `NO_RELOCATION_CAPACITY`.
  - Publish `hall.seat_blocked`.
- **Resize** (`PUT` rows/cols): refused with 409 `HALL_IN_USE_PUBLISHED` if a removed seat holds a published assignment. Otherwise add/remove seats in one transaction and publish `hall.resized`.
- **Delete**: 409 if any exam uses the hall.
- **Availability** `GET /api/halls/available?date=&start=&duration=`: halls not booked in that time slot (reads exam data). Used by Nour's exam form.
- AWS: SNS publish, S3 layout export (`esp-hall-layouts`, CSV/JSON of the seat grid), Secrets Manager.

### Auth hardening — Rishi
- Lock the account for 15 min after 5 failed logins (`users.failed_logins`, `locked_until`). Return 423 or 429.
- Logout revokes the token: put its `jti` into DynamoDB `EspRevokedTokens` (TTL = token expiry). Set `requireAuth.isRevoked` in the auth service so all services check it.
- Stricter rate limit on `/api/auth/login`. Turnstile (from the proposal) is optional.
- Logging lead: CloudWatch metric filters + alarms already exist (`FailedLogins`, `Forbidden403`, `Unauthorized401`, `ServerErrors5xx`). Produce the screenshots and the log-query evidence for the report.

### Allocation — Attallah (feedback: "state the allocation rules")
- **Run** `POST /api/exams/:id/allocation` with `{ strategy: 'fill' | 'balance', spacing: boolean }`:
  - Students are ordered by `student_code` ascending.
  - Halls are ordered by usable capacity (largest first), then by name.
  - `fill`: fill hall 1 completely, then hall 2…
  - `balance`: each hall gets a share proportional to its usable capacity.
  - Inside a hall, seats go row by row (front row first), left to right.
  - `spacing` uses odd columns only. Blocked seats are always skipped.
  - Not enough seats → 409 `NOT_ENOUGH_SEATS` with `{ needed, available }`.
  - One transaction. Status becomes `draft`. Save an `allocation_runs` row.
- **View/search/move** (move target must be free, available and in the exam's halls, else 409). **Clear** the draft (409 if published).
- **Publish**: every enrolled student must be seated. Status becomes `published`. Export the seat map per hall to S3 `esp-seatmap-exports`. Put custom metrics in CloudWatch namespace `ESP/Allocation`.
- **My seats** (student, id from JWT only). **Seat map** (admin, or the proctor assigned to that hall, published plans only).
- **Worker** (`services/allocation/worker.js`): long-polls SQS and applies section 6.
- AWS: SQS (+DLQ), S3, CloudWatch metrics, Secrets Manager.
- **Status: implemented.** The rules, lifecycle, move/publish checks and lookups were written by Attallah (team repo commit `0840a36`, Lab 5 structure). They were ported into this service (`engine.js`, `allocationService.js`, `routes.js`). His "cross-service functions" became the SQS worker (`reconcile.js`, `worker.js`). Advisory locks per exam stop two admins (or an admin and the worker) changing a plan at the same time. Tests: `npm run test:alloc` (25 cases).

### Exams — Nour
- Create/edit an exam with halls:
  - Hall double-booking check: overlapping time in the same hall → 409.
  - Holiday warning via Calendarific, cached in DynamoDB.
  - Capacity warning.
- Roster import (paste, or CSV uploaded to S3 with a presigned URL). Each row is validated, and the rejection reasons are:
  - bad format
  - unknown code
  - duplicate in the file
  - already enrolled
  - **timetable clash** (the student has another overlapping exam)

  Publishes `exam.roster_changed`.
- Reschedule: re-checks holiday, hall clash, student clashes and proctor clashes. Publishes `exam.rescheduled` / `exam.halls_changed`.
- Proctor assignment: must be a proctor, the hall must belong to the exam, and there must be no overlapping assignment (409).
- Delete: 409 if the plan is published.
- AWS: S3, DynamoDB, Secrets Manager, SNS.

## 8. Git rules

- Work only on **your own branch** (`nour`, `rishi`, `attallah`). Commit small and often from **your own GitHub account**.
- Merge to `main` only through a **Pull Request**, and ask another member to approve it.
- Before every commit run `git status` and make sure **no `.env`** is staged.
- Pull `main` into your branch often: `git pull origin main`.
- Also push your work to **your personal proof-of-work repo** (lecturer requirement).
