# rps-load-tester

A safety-first administrator dashboard for **authorized** performance testing of websites and APIs you own. Express validates and supervises tests; Grafana k6 generates load with `ramping-arrival-rate`. It intentionally contains no Axios traffic loops, evasion, WAF/rate-limit bypass, CAPTCHA handling, or uncontrolled remote execution.

## Architecture

- Express/EJS: authenticated control plane and responsive dashboard
- k6: separate load-generation process, dynamically generated from a controlled template
- Socket.IO: authenticated, room-scoped progress events
- SQLite: test history, results, sessions, and audit events
- Safety layer: URL normalization, allowlist, ownership verification, redirect denial, caps, cooldown configuration, confirmation, and stop thresholds
- Distributed provider abstraction: planning fields only until an approved provider is configured

Frontend assets, APIs, Socket.IO/WebSockets, streams, reverse-proxy health checks, and database-backed endpoints must be separate test records. Do not combine them into one scenario.

## Install and local development

Requirements: Node.js 22+, npm, and k6 on `PATH`.

```sh
cp .env.example .env
npm install
npm run check
npm run dev
```

Open `http://localhost:3000`. Replace every sample secret before production use. Generate a hashed
admin password with `node scripts/hash-password.js '<password>'` and paste the result into
`ADMIN_PASSWORD_HASH` — the plaintext `ADMIN_PASSWORD` fallback only works outside production, and the
app refuses to boot in production without a hash configured. If you plan to store any literal request
secret (rather than referencing it with `auth.secretEnv` / a `$env:VAR` header), also generate an
encryption key with `node scripts/generate-secrets-key.js` and set `SECRETS_ENCRYPTION_KEY` — literal
secrets are encrypted at rest (AES-256-GCM) and only decrypted in memory, transiently, right before a
k6 script is generated.

## Docker

```sh
cp .env.example .env
docker compose build
docker compose up -d
docker compose logs -f app
```

The image runs as the non-root `node` user, includes k6, has a health check, and persists SQLite in a named volume. Keep this load generator separate from target servers.

### Docker resource modes

The default `docker-compose.yml` has no per-container CPU or RAM cap. The app and its k6 child process may use all resources assigned to Docker Engine. On Docker Desktop, this means the CPU and memory configured in **Docker Desktop → Settings → Resources**, not necessarily every physical host resource.

Check Docker's available capacity before a run:

```bash
docker info --format 'Docker CPUs: {{.NCPU}} | Docker memory bytes: {{.MemTotal}}'
docker compose exec app sh -c 'ulimit -n && nproc && cat /sys/fs/cgroup/memory.max 2>/dev/null || true'
```

To restore explicit safety limits, use the optional override:

```bash
LOADGEN_CPU_LIMIT=2.0 LOADGEN_MEMORY_LIMIT=2G \
docker compose -f docker-compose.yml -f docker-compose.limits.yml up -d --build
```

The higher file-descriptor limit supports more concurrent sockets, but it does not guarantee a target RPS. Generator CPU, Docker Desktop network throughput, target latency, and available bandwidth still determine achieved load. Increase load gradually and retain emergency thresholds.

## Environment

See `.env.example`. `ALLOWED_TARGETS` is mandatory operational policy. `SERVER_ALLOWLIST_VERIFIED_TARGETS` is the explicit server-side ownership method. Private targets and literal IPs are off unless separately allowed. The default maximum is 1,000 RPS. Above that requires both `ALLOW_HIGH_LOAD=true` and `MAX_ALLOWED_RPS`; above 10,000 also requires exact domain and RPS confirmation in the API request. One million RPS and above remains distributed planning-only unless `DISTRIBUTED_PROVIDER` names an approved integration.

Authentication secrets should be environment variables referenced with `auth.secretEnv`. Basic, Bearer, and custom token headers are supported. Plain secrets are redacted from API output and audit details; generated scripts are mode 0600 and temporary. If a literal secret is stored anyway (no `secretEnv`/`$env:` reference), it is encrypted at rest with `SECRETS_ENCRYPTION_KEY` and decrypted only transiently, in memory, when a test starts — never written back to the database in plaintext. In production, literal secrets are refused outright unless that key is configured. Use OS/container secret injection where possible in production.

Additional secret request headers can safely reference environment variables in Headers JSON. For example, `{"xtoken":"$env:STUDENT_API_TOKEN"}` resolves only when the temporary k6 script is generated; the stored test configuration contains the reference rather than the token value.

Each new test also records load-generator container metrics from Linux cgroups: average and peak CPU, peak memory usage versus the container limit, and per-test network byte deltas. These describe the complete application container (Node.js plus its k6 child process). Remote API VM, proxy, database, and Redis metrics require a separately configured monitoring integration and are not inferred from local container data. Older history records cannot be backfilled.

## Target verification

First add the exact hostname to `ALLOWED_TARGETS`, then use one method:

1. Add it to `SERVER_ALLOWLIST_VERIFIED_TARGETS` after written authorization is reviewed.
2. Publish TXT `_load-test-verification.example.com` containing the generated verification token.
3. Serve the exact token at `https://example.com/.well-known/load-test-verification.txt`.

Redirects are disabled in k6. Any destination must be separately allowlisted and verified. URLs with credentials, unsupported protocols, localhost, unlisted IPs, and arbitrary domains are rejected.

## Results and interpretation

k6 summary parsing captures achieved rate, total requests, failures, dropped iterations, latency percentiles/min/max, and bytes. Status/endpoint time series arrive over Socket.IO. Optional proxy, API, database, Redis, network, disk, and event-loop measurements should be correlated separately. Bottleneck labels are estimates, never guaranteed diagnoses.

Capacity formulas are exposed by `/api/system/capacity`: concurrency is RPS × response time; bandwidth is RPS × response bytes × 8; CPU/request derives from measured cores, utilization, and successful RPS; required cores uses target utilization; server count uses measured safe RPS, 1.3–2.0 headroom, plus one unavailable server. Hardware specifications cannot be inferred from RPS alone.

## Distributed limitations

The dashboard only plans generator count, per-generator RPS, bandwidth, network port capacity, concurrency, and expected VUs. Kubernetes, Grafana Cloud k6, and private workers require a reviewed provider adapter; this project does not execute remote commands. One Node.js process or one k6 machine should never be represented as capable of 10 million RPS. Large plans require written authorization, owner confirmation, adequate generators, and verified network capacity.

## Troubleshooting

- `spawn k6 ENOENT`: install k6 or set `K6_BINARY`.
- Target rejected: check exact hostname allowlist and ownership status; subdomains are not implied.
- Dropped iterations: generator VUs/CPU/network may be saturated; lower rate before raising resources.
- CSRF error: reload the page and retry with a fresh authenticated session.
- SQLite locked: run one app instance or move persistence to a production database adapter.

## Production safety checklist

- Obtain written authorization defining targets, dates, rates, and emergency contacts.
- Use development first; separate health, API, database, WebSocket, asset, and streaming tests.
- Set `ADMIN_PASSWORD_HASH` (via `scripts/hash-password.js`), a strong `SESSION_SECRET`, TLS, a trusted reverse proxy, secret injection, backups, and log retention.
- If any test will store a literal secret rather than referencing an environment variable, set `SECRETS_ENCRYPTION_KEY` (via `scripts/generate-secrets-key.js`) — production refuses literal secrets without it.
- Keep default caps low; configure error, latency, upstream-status, duration, and cooldown stops.
- Confirm monitoring and an infrastructure-owner stop contact before every run.
- Never bypass provider controls; notify hosting/CDN vendors when their terms require it.
- Benchmark generator CPU/network and target bandwidth before interpreting results.

See [docs/API.md](docs/API.md) for the route reference.
# rps-load-tester
