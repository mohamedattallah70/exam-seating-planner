# Exam Seating Planner — Group 42

Cloud-based automatic exam seat allocation. Admins describe halls and exams once, and the system seats every student according to explicit rules: capacity, blocked seats, spacing, no double bookings. Students look up their own seat, and proctors print an up-to-date plan for their hall.

| Service | Owner |
|---|---|
| Hall & Seat Layout (+ auth hardening, logging/monitoring) | Mohamed Rishi |
| Exam & Enrolment (+ deployment, database, external API) | Nour Alabbas |
| Seat Allocation & Lookup (+ event worker, security testing) | Mohamed Attallah |

**Stack:** HTML/CSS/vanilla JS frontend on S3 · Node.js + Express 5 microservices behind an API gateway · Neon Postgres · deployed on **Floci** (local AWS emulator) using S3, SNS, SQS (+DLQ), DynamoDB, Secrets Manager, EventBridge, IAM, CloudWatch Logs/Metrics/Alarms, ELBv2 and ECS. External API: Calendarific (Egyptian public holidays).

## Run it

You need **Docker Desktop** (running) and **Node.js 20+**. Teammates get the shared `backend/.env` privately (it points at the team's Neon database, which is already set up and seeded), so they skip the two `db:` steps.

```bash
cd backend
# put the shared .env in backend/  (never commit it)
npm install
npm run floci:up            # start Floci (local AWS) in Docker
npm run provision           # create all AWS resources on Floci + load secrets (safe to re-run)
npm run deploy:web          # upload the frontend to the S3 website bucket
npm run dev                 # gateway :8080 + auth, halls, exams, allocation services + event worker
```

First-time database setup (already done for the team database): `npm run db:setup` then `npm run db:seed`.

App: http://localhost:4566/esp-frontend/index.html · Health: http://localhost:8080/api/health · Floci console: http://localhost:4566/_floci/ui

Demo logins: `admin@esp.test`, `proctor1@esp.test` … `proctor3@esp.test`, students `S1001` … `S1080`. Passwords are `SEED_*_PASSWORD` in `.env`.

Tests (with `npm run dev` running): `npm run test:exams`, `npm run test:alloc`. Results are written to [docs/tests/](docs/tests/).

See [docs/CONTRACT.md](docs/CONTRACT.md) for the architecture, ownership, data model, events and business rules.
