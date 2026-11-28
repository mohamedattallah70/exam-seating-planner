# Seat Allocation & Lookup service — API test results

Run: 2026-11-28T14:54:31.426Z against the deployed stack (gateway → services → Neon + Floci, SNS → SQS → worker). **25/25 passed.**

| ID | Type | Scenario | Expected | Actual | Result |
|---|---|---|---|---|---|
| AL-S1 | Authentication | Run allocation without a token | 401 | 401 UNAUTHENTICATED | PASS |
| AL-S2 | Unauthorized role | Student tries to run an allocation | 403 | 403 FORBIDDEN | PASS |
| AL-S3 | Invalid input | Unknown strategy / extra field in body | 400 VALIDATION_ERROR | 400 VALIDATION_ERROR | PASS |
| AL-N1 | Normal | Fill strategy: 20 students, largest hall first | 201, all 20 in Main Hall A, status draft | 201 | PASS |
| AL-N2 | Normal | Row-by-row, left-to-right, student-code order, blocked seats skipped | S1001=A1, S1003=A4 (A3 blocked), S1011=B2 | S1001=A1 S1003=A4 S1011=B2 | PASS |
| AL-N3 | Normal | Balance strategy splits by usable capacity (77:47) | 201, Hall A 12 / Hall B 8 | 201 A=12 B=8 | PASS |
| AL-N4 | Normal | Spacing option uses odd columns only | every seat column is odd | cols 1,3,5,7,9 | PASS |
| AL-N5 | Normal | Search the plan by student code | 200, 1 match | 200 | PASS |
| AL-N6 | Normal | Move one student to a free seat | 200, S1020 now in H1 | 200 | PASS |
| AL-S4 | Business rule | Move a student onto a blocked seat / a taken seat | 409 SEAT_BLOCKED, 409 SEAT_TAKEN | 409 SEAT_BLOCKED, 409 SEAT_TAKEN | PASS |
| AL-S5 | Ownership | Assigned proctor opens the seat map before it is published | 409 NOT_PUBLISHED | 409 NOT_PUBLISHED | PASS |
| AL-N7 | Normal | Publish: every student seated, seat maps exported to S3 | 200 + CSV per used hall in esp-seatmap-exports | 200 | PASS |
| AL-S6 | Business rule | Re-run a published plan | 409 ALREADY_PUBLISHED | 409 ALREADY_PUBLISHED | PASS |
| AL-N8 | Normal | Student sees only their own seat (id from JWT, query ignored) | 200, 1 seat = A1 | 200 | PASS |
| AL-N9 | Normal | Assigned proctor opens published seat map of their hall | 200, 20 students shown | 200 | PASS |
| AL-S7 | Ownership | Proctor2 opens a seat map of a hall they do not supervise | 403 NOT_YOUR_HALL (logged ACCESS_DENIED) | 403 NOT_YOUR_HALL | PASS |
| AL-I1 | Integration | Hall service blocks a seat used by S1001 (hall.seat_blocked event) | worker moves S1001 to next free seat in the same hall; plan stays published | S1001 -> C1, published | PASS |
| AL-I2 | Integration | Student added to a published plan (exam.roster_changed event) | worker seats S1021 automatically | seated, published | PASS |
| AL-I3 | Integration | Exam moved from Main Hall A to Hall B (exam.halls_changed event) | worker relocates all 21 students into Hall B | 21 in Hall B, published | PASS |
| AL-I4 | Integration | Roster changes on a DRAFT plan (exam.roster_changed) | worker marks it needs_reallocation; publish refused | needs_reallocation, publish 409 NEEDS_REALLOCATION | PASS |
| AL-N10 | Normal | Re-run after needs_reallocation | 201, 11 seated, draft | 201 | PASS |
| AL-S8 | Business rule | Not enough seats: 31 students in a 30-seat hall | 409 NOT_ENOUGH_SEATS {needed, available} | 409 NOT_ENOUGH_SEATS | PASS |
| AL-S9 | Concurrency | Two admins run the allocation at the same time | both succeed in turn (advisory lock), no duplicate seats | 201/201, 30 rows, 30 distinct seats | PASS |
| AL-S10 | Least privilege | allocation DB role tries to rename an exam | permission denied (column grant) | permission denied for table exams | PASS |
| AL-N11 | Normal | Admin overview lists both test exams with counts | 200 | 200 | PASS |
