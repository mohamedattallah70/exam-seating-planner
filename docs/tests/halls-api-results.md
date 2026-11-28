# Hall & Seat Layout service — API test results (Floci)

Run: 2026-11-28T01:14:03.360Z against the running stack (gateway :8080 → services → Neon + Floci SNS/SQS/S3). **22/22 passed.**

| ID | Type | Scenario | Expected | Actual | Result |
|---|---|---|---|---|---|
| HA-N1 | Normal | Admin creates a disposable 2x3 hall through the gateway | 201, seats A1-A3, B1-B3 | 201; A1,A2,A3,B1,B2,B3 | PASS |
| HA-N2 | Normal | Reopen the hall (refresh) shows the same grid | 200, 6 seats | 200 | PASS |
| HA-N3 | Normal | Proctor reads the hall | 200 | 200 | PASS |
| HA-S1 | Unauthenticated | Anonymous request to /api/halls | 401 | 401 UNAUTHENTICATED | PASS |
| HA-S2 | Unauthorized role | Student lists halls | 403 | 403 FORBIDDEN | PASS |
| HA-S3 | Unauthorized role | Proctor tries to create / delete a hall | 403 / 403 | 403 FORBIDDEN / 403 FORBIDDEN | PASS |
| HA-S4 | Unauthenticated | Forged/tampered JWT | 401 | 401 UNAUTHENTICATED | PASS |
| HA-S5 | Security | Logout revokes the token: Halls (separate process, via gateway) rejects it afterwards | before 200; logout 204; after 401 TOKEN_REVOKED | 200; logout 204; after 401 TOKEN_REVOKED | PASS |
| HA-I1 | Invalid input | rows=0 / cols=41 / duplicate name | 400 / 400 / 409 HALL_NAME_TAKEN | 400 VALIDATION_ERROR / 400 VALIDATION_ERROR / 409 HALL_NAME_TAKEN | PASS |
| HA-N4 | Normal | Block B2 -> usable 5 and hall leaves a min-6 search; reopen -> 6 | 200/excluded/200 | 200 usable=5 excluded=true; 200 usable=6 | PASS |
| HA-N5 | Normal | Search with spacing=true uses odd columns (2x3 -> 4) | 200, spaced_seats=4 | 200 | PASS |
| HA-N6 | Normal | Resize 2x3 -> 3x4 keeps seat ids | 200, 12 seats, original ids kept | 200 | PASS |
| HA-O1 | Ownership | Block a seat id from another hall via this hall | 404 | 404 NOT_FOUND | PASS |
| HA-N7 | Normal | Export layout -> objects exist in S3 esp-hall-layouts and match the saved grid | 201; CSV rows = seats; JSON statuses match | 201; keys=halls/4/layout-2026-11-28T01-13-18-839Z.csv halls/4/layout-2026-11-28T01-13-18-839Z.json csvRows=12 match=true | PASS |
| HA-N8 | Business rule | Availability: free before booking, busy for overlap and adjacent slot | free / busy / busy | exam 201; 18:00 free=true; 18:30 free=false; 19:00 free=false; 19:15 free=true | PASS |
| HA-B1 | Business rule | Delete a hall used by an exam | 409 HALL_IN_USE | 409 HALL_IN_USE | PASS |
| HA-B2 | Integration | Roster S1001-S1004, run + publish allocation on the test hall | import 201, run 201, publish 200 | import 201 accepted=4; run 201; publish 200 | PASS |
| HA-B3 | Business rule | Seat impact preview names the seated student | 200, outcome student_relocated | 200; S1001 on A1 | PASS |
| HA-B4 | Integration | Block A1 -> hall.seat_blocked -> worker moves the student exactly once; plan stays published | 200; student moved off A1; 4 seated; DLQ empty | 200; S1001 now on B1; seated=4; status=published; dlq=0 | PASS |
| HA-B5 | Business rule | Shrink that removes a seat holding a published assignment | preview allowed=false; PUT 409 HALL_IN_USE_PUBLISHED | preview allowed=false; PUT 409 HALL_IN_USE_PUBLISHED | PASS |
| HA-B6 | Business rule | Block seats until no free seat is left -> NO_RELOCATION_CAPACITY | eventually 409 NO_RELOCATION_CAPACITY | 409 NO_RELOCATION_CAPACITY; blocked 7 free seats first | PASS |
| HA-N9 | Normal | Cleanup: remove test exams, then delete the test halls | exam 204, hall 204 each | exam 204, hall 204, hall 204 | PASS |
