# Auth hardening — isolated test results

Run: 2026-11-28T00:35:13.844Z on **disposable storage**: real auth + halls services on in-memory PGlite (`backend/db/schema.sql`), DynamoDB/EventBridge/CloudWatch replaced by in-memory fakes. **Not** run on Neon or Floci; the revoked-token check through the real gateway is case HA-S5 in `halls-api-results.md`. **18/18 passed.**

| ID | Type | Scenario | Expected | Actual | Result |
|---|---|---|---|---|---|
| AU-N1 | Normal | Admin logs in by email; student logs in by student code | 200 + token / 200 | 200 / 200 role=student | PASS |
| AU-I1 | Invalid input | Login with missing password / 2-char identifier | 400 / 400 | 400 VALIDATION_ERROR / 400 VALIDATION_ERROR | PASS |
| AU-S1 | Enumeration | Unknown account and wrong password give the same 401 message | identical 401 bodies | 401 INVALID_CREDENTIALS / 401 INVALID_CREDENTIALS | PASS |
| AU-N2 | Normal | Successful login resets the failure counter | failed_logins 1 -> 0, last_login_at set | before=1 after=0 last_login_at=true | PASS |
| AU-B1 | Business rule | 4 wrong passwords -> 401 each, counter 4, not locked | 401 x4 | 401,401,401,401; failed_logins=4 locked_until=null | PASS |
| AU-B2 | Business rule | 5th wrong password locks the account for 15 minutes | 423 ACCOUNT_LOCKED, Retry-After ~900s | 423 ACCOUNT_LOCKED; Retry-After=900; locked ~15.0 min | PASS |
| AU-B3 | Business rule | Correct password while locked is still refused | 423, no token | 423 ACCOUNT_LOCKED | PASS |
| AU-B4 | Business rule | After the lock expires: counter restarts at 1, then a correct login works | 401 (failed_logins=1) then 200 (0) | 401 INVALID_CREDENTIALS failed_logins=1; 200 failed_logins=0 locked_until=null | PASS |
| AU-B5 | Business rule | Concurrent wrong passwords cannot skip the lock (6 in parallel) | account locked; every response is 401 or 423, none 200 | 401,401,401,401,423,423; failed_logins=6 locked=true | PASS |
| AU-M1 | Monitoring | Failures emit login_failed log lines (FailedLogins metric filter) and account_locked / ACCOUNT_LOCKED audit | logs + audit present, no password in logs | login_failed=14 account_locked=3 ACCOUNT_LOCKED audits=3 passwordInLogs=false | PASS |
| AU-R1 | Normal | Logout stores the jti in EspRevokedTokens with expiresAt = token exp | 204, item with matching TTL | 204; expiresAt=1795829711 exp=1795829711 | PASS |
| AU-R2 | Security | Revoked token is rejected by /auth/me and by the Halls API (cache cleared, read from DynamoDB) | 401 TOKEN_REVOKED x2 | 401 TOKEN_REVOKED / 401 TOKEN_REVOKED | PASS |
| AU-R3 | Security | A different (new) token of the same user still works | 200 on /halls | 200 | PASS |
| AU-R4 | Security | Revocation store down: protected request fails closed; logout reports 503 | 401 / 503 REVOCATION_UNAVAILABLE | 401 UNAUTHENTICATED / 503 REVOCATION_UNAVAILABLE | PASS |
| AU-S2 | Security | Token signed with another secret / without jti | 401 / 401 | 401 UNAUTHENTICATED / 401 TOKEN_REVOKED | PASS |
| AU-L1 | Security | 10 failed logins from one IP, then the 11th is rate limited | 401 x10 then 429 TOO_MANY_ATTEMPTS | 401,401,401,401,401,401,401,401,401,401 then 429 TOO_MANY_ATTEMPTS | PASS |
| AU-L2 | Security | Limited IP is blocked even with the right password; another IP is not | 429 / 200 | 429 TOO_MANY_ATTEMPTS / 200 | PASS |
| AU-L3 | Normal | 15 successful logins from one IP are not limited (shared lab IP) | 200 x15 | 200,200,200,200,200,200,200,200,200,200,200,200,200,200,200 | PASS |
