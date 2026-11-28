# Exam & Enrolment service — API test results

Run: 2026-11-28T14:50:50.609Z against the deployed stack (gateway → services → Neon + Floci). **27/27 passed.**

| ID | Type | Scenario | Expected | Actual | Result |
|---|---|---|---|---|---|
| EX-N1 | Normal | Admin creates exam in two halls | 201 + exam returned | 201 | PASS |
| EX-N2 | Normal | Search exams by course code | 200, finds TST101 | 200 | PASS |
| EX-N3 | Normal | Import roster by paste (5 valid, 1 bad format, 1 duplicate, 1 unknown) | 201, 5 accepted, 3 rejected with reasons | 201 accepted=5 rejected=DUPLICATE_IN_FILE,INVALID_FORMAT,UNKNOWN_STUDENT | PASS |
| EX-N4 | Normal | Upload roster CSV to S3 (presigned URL) then import it | 201, 3 accepted | S3 PUT 200; import 201 accepted=3 | PASS |
| EX-N5 | Normal | Assign proctor1 to hall A of the exam | 201 | 201 | PASS |
| EX-N6 | Normal | Proctor views exam they are assigned to | 200 | 200 | PASS |
| EX-N7 | Normal | Proctor list only shows own exams | 200, every exam assigned to proctor1 | 200 | PASS |
| EX-N8 | Normal | Holiday check: 2027-01-07 (Coptic Christmas) via Calendarific | 200, isHoliday=true | 200 isHoliday=true source=cache Egyptian public holiday: Coptic Christmas Day | PASS |
| EX-N9 | Normal | Second holiday check is served from DynamoDB cache | 200, source=cache | 200 source=cache | PASS |
| EX-N10 | Normal | Reschedule exam publishes exam.rescheduled to SNS -> SQS -> allocation worker | 200 and the worker logs event_handled for this exam | 200; worker handled exam.rescheduled: true | PASS |
| EX-I1 | Invalid input | Create exam with bad course code, past-format date, 10-min duration | 400 with field details | 400 VALIDATION_ERROR | PASS |
| EX-I2 | Invalid input | Create exam in the past | 400 DATE_IN_PAST | 400 DATE_IN_PAST | PASS |
| EX-I3 | Business rule | Book hall A for an overlapping exam (12:10, inside the 15-min turnover) | 409 HALL_BOOKED | 409 HALL_BOOKED | PASS |
| EX-I4 | Business rule | Import a student into a second exam at an overlapping time | 422, reason TIMETABLE_CLASH | 422 TIMETABLE_CLASH | PASS |
| EX-I5 | Business rule | Assign proctor1 to an overlapping exam | 409 PROCTOR_CLASH | 409 PROCTOR_CLASH | PASS |
| EX-I6 | Invalid input | Assign proctor to a hall the exam does not use | 400 | 400 VALIDATION_ERROR | PASS |
| EX-S1 | Unauthenticated | List exams with no token | 401 | 401 UNAUTHENTICATED | PASS |
| EX-S2 | Unauthenticated | Forged/tampered JWT | 401 | 401 UNAUTHENTICATED | PASS |
| EX-S3 | Unauthorized role | Student tries to create an exam | 403 | 403 FORBIDDEN | PASS |
| EX-S4 | Unauthorized role | Proctor tries to import a roster | 403 | 403 FORBIDDEN | PASS |
| EX-S5 | Ownership | Proctor2 opens an exam they are not assigned to | 403 (logged ACCESS_DENIED) | 403 FORBIDDEN | PASS |
| EX-S6 | Ownership | Import using an S3 upload key that belongs to another exam | 403 | 403 FORBIDDEN | PASS |
| EX-S7 | Injection | SQL injection in search: course=' OR 1=1 -- | 200 with 0 results (treated as text) | 200 | PASS |
| EX-S8 | Invalid input | Oversized request body (300 KB) | 413 | 413 PAYLOAD_TOO_LARGE | PASS |
| EX-S9 | Business rule | Delete an exam whose seating plan is published | 409 EXAM_PUBLISHED | 409 EXAM_PUBLISHED | PASS |
| EX-S10 | Least privilege | exams DB role tries to change allocation_status directly | permission denied (column grant) | permission denied for table exams | PASS |
| EX-N11 | Normal | Admin deletes the test exams | 204 | 204,204 | PASS |
