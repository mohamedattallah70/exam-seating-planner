# Hall & Seat Layout service — isolated test results

Run: 2026-11-27T23:41:35.400Z on **disposable storage**: in-memory PGlite Postgres loaded with `backend/db/schema.sql`, the real halls service, the real allocation worker (`reconcile.js`) and jsdom for the page. SNS, S3 and audit were in-memory recorders. **Not** run on Neon or Floci (see `halls-api-results.md` for that). **42/42 passed.**

| ID | Type | Scenario | Expected | Actual | Result |
|---|---|---|---|---|---|
| HL-N1 | Normal | Admin creates a 2x3 hall | 201, seats A1-A3, B1-B3 | 201; A1,A2,A3,B1,B2,B3 | PASS |
| HL-N2 | Normal | Reopen the saved grid (refresh) | 200, same 6 seat ids | 200 | PASS |
| HL-N3 | Normal | Proctor reads the hall list and the grid | 200 and 200 | 200 / 200 | PASS |
| HL-S1 | Unauthenticated | List halls with no token | 401 | 401 UNAUTHENTICATED | PASS |
| HL-S2 | Unauthenticated | Tampered JWT (signature changed) | 401 | 401 UNAUTHENTICATED | PASS |
| HL-S3 | Unauthorized role | Student lists halls / creates a hall | 403 and 403 | 403 FORBIDDEN / 403 FORBIDDEN | PASS |
| HL-S4 | Unauthorized role | Proctor tries create, block, delete and impact preview | 403 x4 | 403,403,403,403 | PASS |
| HL-I1 | Invalid input | Rows 0, cols 41, rows 1.5, blank name, missing building | 400 x5 with field details | 400 VALIDATION_ERROR,400 VALIDATION_ERROR,400 VALIDATION_ERROR,400 VALIDATION_ERROR,400 VALIDATION_ERROR | PASS |
| HL-I2 | Invalid input | Unknown field in body (strict schema) | 400 | 400 VALIDATION_ERROR | PASS |
| HL-I3 | Business rule | Duplicate hall name | 409 HALL_NAME_TAKEN | 409 HALL_NAME_TAKEN | PASS |
| HL-I4 | Invalid input | Non-numeric hall id / missing hall | 400 and 404 | 400 VALIDATION_ERROR / 404 NOT_FOUND | PASS |
| HL-S5 | Injection | Search name=' OR 1=1 -- | 200 with 0 results (treated as text) | 200; 0 results | PASS |
| HL-N4 | Normal | Search by building + min capacity 6; spacing capacity of 2x3 | found; spaced_seats=4 | 200; usable=6 spaced=4; spacing>=5 excludes it | PASS |
| HL-N5 | Normal | Block B2 -> capacity 5, drops out of min-6 search; reopen -> 6 | 200, 5, excluded, 200, 6 | 200 usable=5 excluded=true; 200 usable=6 | PASS |
| HL-N6 | Normal | Blocking an unused seat publishes hall.seat_blocked {hallId, seatId} | one event with exact payload | 1 event(s) {"hallId":1,"seatId":5} | PASS |
| HL-O1 | Ownership | Block a seat id that belongs to another hall | 404, other hall seat unchanged | 404 NOT_FOUND / impact 404 NOT_FOUND; seat available | PASS |
| HL-N7 | Normal | Resize 2x3 -> 3x4 keeps seat ids and blocked status | 200, 12 seats, old ids kept, blocked kept | 200; seats=12 added=6 B2=blocked | PASS |
| HL-N8 | Normal | Resize-impact preview for 3x4 -> 2x2 | 200, removes 8, usable after 3 | 200; removed=8 usableAfter=3 | PASS |
| HL-N9 | Normal | Shrink back to 2x3 publishes hall.resized with removed seat ids | 200 + event payload {hallId, removedSeatIds[6]} | 200; event {"hallId":1,"removedSeatIds":[9,10,11,12,13,14]} | PASS |
| HL-I5 | Invalid input | Resize-impact with cols=0 / PUT with empty body | 400 and 400 | 400 VALIDATION_ERROR / 400 VALIDATION_ERROR | PASS |
| HL-N10 | Normal | Export layout to S3 (CSV + JSON) matches saved grid incl. blocked B2 | 201, 2 objects, 6 rows, B2 blocked | 201; bucket=esp-hall-layouts csvRows=6 jsonMatchesGrid=true readBack=200 | PASS |
| HL-O2 | Ownership | Read another hall's export key through this hall | 403 | 403 FORBIDDEN | PASS |
| HL-S6 | Injection | CSV export neutralises a formula-looking block reason | cell starts with ' | 1,Disposable Hall 1,Test Block,1,1,A1,blocked,"'=HYPERLINK(""http://x"")" | PASS |
| HL-N11 | Business rule | Available halls: overlap, adjacent (11:00 start, inside 15-min turnover), and 11:15 | h2 busy, busy, free | 10:00 false, 11:00 false, 11:15 true, 07:00-08:45 true; booked=TST100 09:00 | PASS |
| HL-I6 | Invalid input | Available with bad date / 25:00 / duration 10 | 400 x3 | 400 VALIDATION_ERROR,400 VALIDATION_ERROR,400 VALIDATION_ERROR | PASS |
| HL-N12 | Normal | Route order: /halls/available is not treated as /halls/:id | 400 VALIDATION_ERROR on missing query (not 404 hall) | 400 VALIDATION_ERROR | PASS |
| HL-B1 | Business rule | Delete a hall that an exam uses | 409 HALL_IN_USE, hall kept | 409 HALL_IN_USE | PASS |
| HL-B2 | Business rule | Seat impact preview of A1 (published, 2 free seats) | 200, allowed, PUB200 student S9001 relocated | 200; PUB200 student_relocated free=2 | PASS |
| HL-B3 | Business rule | Block A1 (published): halls does NOT move the student; worker relocates once | PATCH 200 seat still assigned; after event S9001 on B2; replay = no change | 200; before worker=A1; events=1; after worker=B2; after replay=B2; assignments=4; status=published | PASS |
| HL-B4 | Business rule | Pending relocations count: block A2 (PUB200 has 1 free seat, B3) then A3 before the worker runs | A2 200, A3 409 NO_RELOCATION_CAPACITY, A3 unchanged, no event | A2 200; A3 409 NO_RELOCATION_CAPACITY details=[{"examId":2,"courseCode":"PUB200","freeSeats":1,"studentsNeedingSeat":2}]; A3 available; new events=0 | PASS |
| HL-B5 | Business rule | Worker processes A2 event: S9002 moves to B3; then A3 block still refused (no free seat) | S9002 on B3; 409 | S9002 on B3; A3 409 NO_RELOCATION_CAPACITY | PASS |
| HL-B6 | Business rule | Retry of an already-blocked seat (A1) | 200 changed=false, no duplicate SEAT_BLOCKED audit | 200; changed=false | PASS |
| HL-B7 | Business rule | Block B3, shared by a draft plan and a published plan with no free seat left | 409 NO_RELOCATION_CAPACITY (published rule wins) | 409 NO_RELOCATION_CAPACITY | PASS |
| HL-B8 | Business rule | Block a seat used by a draft plan only | 200; worker removes assignment, exam needs_reallocation | 200; assignments left=0 status=needs_reallocation | PASS |
| HL-B9 | Business rule | Resize-impact + shrink that removes a seat with a published assignment (2x3 -> 1x3) | preview allowed=false; PUT 409 HALL_IN_USE_PUBLISHED; grid unchanged | preview allowed=false blockedBy=PUB200; PUT 409 HALL_IN_USE_PUBLISHED; seats=6 | PASS |
| HL-B10 | Business rule | Grow a hall used by a published plan (2x3 -> 2x4) is allowed (no blanket lock) | 200, 8 seats, hall.resized with removedSeatIds [] | 200; seats=8 | PASS |
| HL-B11 | Business rule | Now A3 can be blocked (new free seats A4/B4) | 200; worker moves S9003 to a free seat | 200; S9003 now on A4 | PASS |
| HL-N13 | Normal | Delete an unused hall, then it is gone | 204 then 404, seats removed | 204 / GET 404 / DELETE again 404; seats=0 | PASS |
| HL-F1 | Frontend | Admin opens halls.html?id=<2x3 hall>: grid A1-B3, blocked B2 shown, admin controls visible | labels + blocked + controls | A1,A2,A3,B1,B2,B3; blocked=B2; controls=true | PASS |
| HL-F2 | Frontend | Admin clicks A1 -> impact panel, then blocks it via the UI | panel shows "Block seat A1?", seat becomes blocked | DB A1=blocked | PASS |
| HL-F3 | Frontend | Proctor page is read-only (no create/edit/delete, seats not clickable) | no admin controls, 0 seat buttons | adminHidden=true seatButtons=0 | PASS |
| HL-F4 | Frontend | XSS: hall named <img src=x onerror=...> renders as text | no <img> element created | title="<img src=x onerror=alert(1)> — XSS" imgs=0 | PASS |
