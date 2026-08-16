# API

All routes except login require an authenticated administrator session and a valid `CSRF-Token` header. JSON errors have the form `{ "error": "message" }`.

| Method | Route                        | Purpose                                                              |
| ------ | ----------------------------- | ---------------------------------------------------------------------|
| POST   | `/api/auth/login`             | Create the admin session                                             |
| POST   | `/api/targets/verify`         | Verify an allowlisted target; DNS-TXT and well-known results persist and unlock the domain for future test creation |
| GET    | `/api/targets`                | List approved and verified targets                                   |
| POST   | `/api/tests/validate`         | Validate without saving                                              |
| POST   | `/api/tests`                  | Validate and save a test                                             |
| POST   | `/api/tests/:id/start`        | Start supervised k6 execution                                        |
| POST   | `/api/tests/:id/stop`         | Stop; body may contain `emergency: true`                             |
| POST   | `/api/tests/emergency-stop`   | Immediately stop every currently-running test on this instance       |
| GET    | `/api/tests/:id/status`       | Read status                                                          |
| GET    | `/api/tests/:id/results`      | Read redacted results                                                |
| GET    | `/api/tests`                  | List history                                                         |
| DELETE | `/api/tests/:id`              | Delete a non-running test                                            |
| GET    | `/api/system/capacity`        | Calculate capacity from benchmark inputs                             |

Test creation accepts the fields displayed by the dashboard. Unknown fields are rejected. Secrets should normally use `auth.secretEnv` or a `$env:VAR` header value — these are never persisted at all. A literal `auth.secret` or literal secret-like header value is encrypted at rest with `SECRETS_ENCRYPTION_KEY` (AES-256-GCM) and decrypted only transiently, in memory, right before a mode-0600 k6 script is generated; it is redacted from all API output and audit details. In production, a literal secret is refused outright unless `SECRETS_ENCRYPTION_KEY` is configured.

A test can only be created or started against a target that is both allowlisted (`ALLOWED_TARGETS`) and ownership-verified — either statically (`SERVER_ALLOWLIST_VERIFIED_TARGETS`) or via a persisted `POST /api/targets/verify` result. The target's DNS is also re-resolved and re-checked against private/reserved address ranges at both creation and start time, independent of ownership verification, to guard against a previously-safe hostname being repointed at an internal address later.

While a test runs, error rate, p95 latency, the ratio of 429/502/503/504 responses, and target unavailability are evaluated every second against the configured thresholds; any breach automatically stops the k6 process. An absolute duration watchdog (`MAX_TEST_DURATION_SECONDS`) applies independently of the test's own ramp/steady/ramp-down schedule.
