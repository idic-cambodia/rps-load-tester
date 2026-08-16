import "dotenv/config";
const csv = (v = "") =>
  v
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
const bool = (v, fallback = false) => (v == null ? fallback : v === "true");
const num = (v, fallback) =>
  Number.isFinite(Number(v)) ? Number(v) : fallback;
export function loadConfig(overrides = {}) {
  const e = { ...process.env, ...overrides };
  return {
    nodeEnv: e.NODE_ENV || "development",
    port: num(e.PORT, 3000),
    sessionSecret: e.SESSION_SECRET || "development-only-change-me-32-chars",
    adminUsername: e.ADMIN_USERNAME || "admin",
    // Prefer a bcrypt hash. Plaintext ADMIN_PASSWORD is a development-only
    // fallback and is refused outright in production (see assertProductionSafety).
    adminPasswordHash: e.ADMIN_PASSWORD_HASH || "",
    adminPassword: e.ADMIN_PASSWORD || "change-me",
    // Base64-encoded 32-byte key used to encrypt literal test secrets
    // (auth.secret / literal header values) at rest. Without this key, raw
    // secrets can only be used outside production (see assertProductionSafety).
    secretsEncryptionKey: e.SECRETS_ENCRYPTION_KEY || "",
    allowedTargets: csv(e.ALLOWED_TARGETS),
    verifiedTargets: csv(e.SERVER_ALLOWLIST_VERIFIED_TARGETS),
    allowedIpTargets: csv(e.ALLOWED_IP_TARGETS),
    allowPrivateTargets: bool(e.ALLOW_PRIVATE_TARGETS),
    allowHighLoad: bool(e.ALLOW_HIGH_LOAD),
    maxAllowedRps: num(e.MAX_ALLOWED_RPS, 1000),
    highLoadConfirmationThreshold: num(e.HIGH_LOAD_CONFIRMATION_THRESHOLD, 10000),
    distributedRequiredThreshold: num(e.DISTRIBUTED_REQUIRED_THRESHOLD, 1000000),
    maxDuration: num(e.MAX_TEST_DURATION_SECONDS, 3600),
    cooldownSeconds: num(e.COOLDOWN_SECONDS, 60),
    maxErrorRate: num(e.MAX_ERROR_RATE, 0.05),
    maxP95Ms: num(e.MAX_P95_MS, 1000),
    maxBadStatusRate: num(e.MAX_BAD_STATUS_RATE, 0.05),
    distributedProvider: e.DISTRIBUTED_PROVIDER || "",
    databasePath: e.DATABASE_PATH || "./data/rps-load-tester.sqlite",
    k6Binary: e.K6_BINARY || "k6",
    trustProxy: bool(e.TRUST_PROXY),
  };
}
export const config = loadConfig();

/** Returns a list of problems; caller decides whether to refuse to boot. */
export function assertProductionSafety(cfg = config) {
  const problems = [];
  if (cfg.nodeEnv === "production") {
    if (!cfg.adminPasswordHash) {
      problems.push(
        "ADMIN_PASSWORD_HASH must be set in production (generate with scripts/hash-password.js). Plaintext ADMIN_PASSWORD is refused.",
      );
    }
    if (cfg.sessionSecret === "development-only-change-me-32-chars") {
      problems.push("SESSION_SECRET must be set to a strong random value in production.");
    }
  }
  if (cfg.allowedTargets.length === 0) {
    problems.push("ALLOWED_TARGETS is empty — no domain can ever be tested until configured.");
  }
  if (cfg.maxAllowedRps >= cfg.distributedRequiredThreshold) {
    problems.push("MAX_ALLOWED_RPS must stay below DISTRIBUTED_REQUIRED_THRESHOLD.");
  }
  return problems;
}
