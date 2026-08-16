import { it, expect } from "vitest";
import crypto from "node:crypto";
import {
  authHeaders,
  maskSecret,
  redact,
  resolveHeaderSecrets,
  encryptTestSecrets,
  decryptTestSecrets,
  isEncryptedSecretValue,
  assertSecretStoragePolicy,
} from "../src/utils/secrets.js";
it("creates basic, bearer and custom auth", () => {
  expect(
    authHeaders({ type: "basic", username: "u", secret: "p" }).Authorization,
  ).toBe("Basic dTpw");
  expect(authHeaders({ type: "bearer", secret: "t" }).Authorization).toBe(
    "Bearer t",
  );
  expect(
    authHeaders({ type: "custom", headerName: "x-api-key", secret: "k" }),
  ).toEqual({ "x-api-key": "k" });
});
it("resolves secret header environment references", () => {
  expect(
    resolveHeaderSecrets(
      { xtoken: "$env:STUDENT_API_TOKEN", accept: "application/json" },
      { STUDENT_API_TOKEN: "temporary-token" },
    ),
  ).toEqual({ xtoken: "temporary-token", accept: "application/json" });
  expect(() =>
    resolveHeaderSecrets({ xtoken: "$env:MISSING_TOKEN" }, {}),
  ).toThrow("MISSING_TOKEN");
});
it("masks and redacts secrets", () => {
  expect(maskSecret("abcdefghijkl")).toBe("abc…kl");
  expect(redact({ password: "x", nested: { token: "y" } })).toEqual({
    password: "********",
    nested: { token: "********" },
  });
});
it("encrypts and decrypts secrets at rest when a key is configured", () => {
  const cfg = { secretsEncryptionKey: crypto.randomBytes(32).toString("base64") };
  const config = {
    name: "t",
    auth: { type: "bearer", secret: "super-secret-token" },
    headers: { "x-api-key": "another-secret", accept: "application/json" },
  };
  const stored = encryptTestSecrets(config, cfg);
  expect(stored.auth.secret).not.toBe("super-secret-token");
  expect(isEncryptedSecretValue(stored.auth.secret)).toBe(true);
  expect(stored.headers["x-api-key"]).not.toBe("another-secret");
  expect(stored.headers.accept).toBe("application/json"); // non-secret header untouched
  expect(JSON.stringify(stored)).not.toContain("super-secret-token");

  const restored = decryptTestSecrets(stored, cfg);
  expect(restored.auth.secret).toBe("super-secret-token");
  expect(restored.headers["x-api-key"]).toBe("another-secret");
});
it("leaves $env: header references untouched by encryption", () => {
  const cfg = { secretsEncryptionKey: crypto.randomBytes(32).toString("base64") };
  const config = { headers: { "x-api-key": "$env:STUDENT_API_TOKEN" } };
  const stored = encryptTestSecrets(config, cfg);
  expect(stored.headers["x-api-key"]).toBe("$env:STUDENT_API_TOKEN");
});
it("passes secrets through unencrypted (with no key configured) rather than crashing", () => {
  const config = { auth: { type: "bearer", secret: "plain" } };
  const stored = encryptTestSecrets(config, {});
  expect(stored.auth.secret).toBe("plain");
});
it("refuses a literal secret in production without an encryption key configured", () => {
  const config = { auth: { type: "bearer", secret: "plain" } };
  expect(() => assertSecretStoragePolicy(config, { nodeEnv: "production", secretsEncryptionKey: "" })).toThrow(
    /SECRETS_ENCRYPTION_KEY/,
  );
});
it("allows a literal secret in production once an encryption key is configured", () => {
  const config = { auth: { type: "bearer", secret: "plain" } };
  const key = crypto.randomBytes(32).toString("base64");
  expect(() =>
    assertSecretStoragePolicy(config, { nodeEnv: "production", secretsEncryptionKey: key }),
  ).not.toThrow();
});
it("allows a literal secret outside production even without a key (warns instead of throwing)", () => {
  const config = { auth: { type: "bearer", secret: "plain" } };
  expect(() =>
    assertSecretStoragePolicy(config, { nodeEnv: "development", secretsEncryptionKey: "" }),
  ).not.toThrow();
});
it("never flags $env: header references or auth.secretEnv as literal secrets", () => {
  const config = { headers: { "x-api-key": "$env:TOKEN" }, auth: { type: "bearer", secretEnv: "TOKEN" } };
  expect(() =>
    assertSecretStoragePolicy(config, { nodeEnv: "production", secretsEncryptionKey: "" }),
  ).not.toThrow();
});
