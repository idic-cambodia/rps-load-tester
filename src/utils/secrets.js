import crypto from "node:crypto";

const SECRET_KEYS = /authorization|password|token|api[-_]?key|secret|cookie/i;
const ENC_PREFIX = "enc:v1:";

function getCipherKey(config) {
  const raw = config?.secretsEncryptionKey;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

/**
 * Encrypts a plaintext secret for storage. Requires SECRETS_ENCRYPTION_KEY
 * (32 random bytes, base64). Returns the plaintext unchanged, with a
 * warning, if no key is configured and we're outside production — but
 * assertProductionSafety() refuses to boot a production instance with raw
 * secrets enabled and no key, so this fallback can't be reached there.
 */
export function encryptSecretValue(plaintext, config) {
  const key = getCipherKey(config);
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function isEncryptedSecretValue(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

export function decryptSecretValue(value, config) {
  if (!isEncryptedSecretValue(value)) return value;
  const key = getCipherKey(config);
  if (!key) throw new Error("Cannot decrypt a stored secret: SECRETS_ENCRYPTION_KEY is not configured");
  const buf = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Encrypts every literal secret in a validated test config before it is
 * persisted to SQLite: auth.secret, and any header value that isn't a
 * `$env:VAR` reference but matches a secret-like header name. Values that
 * are already `$env:` references are left untouched — they're never stored
 * at all, which is the preferred pattern.
 */
function hasLiteralSecret(config) {
  if (config.auth?.secret) return true;
  return Object.entries(config.headers || {}).some(
    ([name, value]) =>
      typeof value === "string" && !value.startsWith("$env:") && SECRET_KEYS.test(name),
  );
}

/**
 * Refuses to let a literal (non-referenced) secret reach the database in
 * production unless SECRETS_ENCRYPTION_KEY is configured to protect it at
 * rest. Outside production this is only a soft warning, matching the same
 * pattern used for the admin password fallback.
 */
export function assertSecretStoragePolicy(config, appConfig) {
  if (!hasLiteralSecret(config)) return;
  if (getCipherKey(appConfig)) return;
  if (appConfig.nodeEnv === "production") {
    throw new Error(
      "Storing a literal secret requires SECRETS_ENCRYPTION_KEY to be configured in production. " +
        "Use auth.secretEnv or a $env:VAR header reference instead, or set SECRETS_ENCRYPTION_KEY.",
    );
  }
  console.warn(
    "[rps-load-tester] Storing a literal request secret without SECRETS_ENCRYPTION_KEY configured. " +
      "This is only permitted outside production.",
  );
}

export function encryptTestSecrets(config, appConfig) {
  const out = { ...config };
  if (out.auth?.secret) {
    out.auth = { ...out.auth, secret: encryptSecretValue(out.auth.secret, appConfig) };
  }
  if (out.headers) {
    out.headers = Object.fromEntries(
      Object.entries(out.headers).map(([name, value]) => {
        if (typeof value === "string" && value.startsWith("$env:")) return [name, value];
        if (SECRET_KEYS.test(name)) return [name, encryptSecretValue(value, appConfig)];
        return [name, value];
      }),
    );
  }
  return out;
}

/** Inverse of encryptTestSecrets — used transiently by the runner right before generating a k6 script. Never write the result back to the database. */
export function decryptTestSecrets(config, appConfig) {
  const out = { ...config };
  if (isEncryptedSecretValue(out.auth?.secret)) {
    out.auth = { ...out.auth, secret: decryptSecretValue(out.auth.secret, appConfig) };
  }
  if (out.headers) {
    out.headers = Object.fromEntries(
      Object.entries(out.headers).map(([name, value]) => [name, decryptSecretValue(value, appConfig)]),
    );
  }
  return out;
}

export function maskSecret(value) {
  if (!value) return "";
  const s = String(value);
  return s.length < 8 ? "********" : `${s.slice(0, 3)}…${s.slice(-2)}`;
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) ? "********" : redact(v),
      ]),
    );
  return value;
}
export function authHeaders(auth = {}, env = process.env) {
  if (!auth.type || auth.type === "none") return {};
  const secret = auth.secretEnv ? env[auth.secretEnv] : auth.secret;
  if (!secret) throw new Error("Authentication secret is unavailable");
  if (auth.type === "basic") {
    if (!auth.username) throw new Error("Basic username is required");
    return {
      Authorization: `Basic ${Buffer.from(`${auth.username}:${secret}`).toString("base64")}`,
    };
  }
  if (auth.type === "bearer") return { Authorization: `Bearer ${secret}` };
  if (auth.type === "custom") {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(auth.headerName || ""))
      throw new Error("Invalid custom authentication header");
    return { [auth.headerName]: secret };
  }
  throw new Error("Unsupported authentication type");
}

export function resolveHeaderSecrets(headers = {}, env = process.env) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const match = /^\$env:([A-Z][A-Z0-9_]*)$/.exec(value);
      if (!match) return [name, value];
      const secret = env[match[1]];
      if (!secret)
        throw new Error(
          `Header secret environment variable ${match[1]} is unavailable`,
        );
      return [name, secret];
    }),
  );
}
