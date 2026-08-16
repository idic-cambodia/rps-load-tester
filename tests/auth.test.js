import { it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { verifyAdminPassword } from "../src/middleware/auth.js";

it("verifies against a bcrypt hash when ADMIN_PASSWORD_HASH is configured", async () => {
  const hash = bcrypt.hashSync("correct-horse", 10);
  const config = { adminPasswordHash: hash, nodeEnv: "production" };
  expect(await verifyAdminPassword("correct-horse", config)).toBe(true);
  expect(await verifyAdminPassword("wrong", config)).toBe(false);
});

it("falls back to plaintext comparison only outside production", async () => {
  const config = { adminPasswordHash: "", adminPassword: "dev-secret", nodeEnv: "development" };
  expect(await verifyAdminPassword("dev-secret", config)).toBe(true);
  expect(await verifyAdminPassword("wrong", config)).toBe(false);
});

it("refuses plaintext comparison in production even without a hash configured", async () => {
  const config = { adminPasswordHash: "", adminPassword: "dev-secret", nodeEnv: "production" };
  expect(await verifyAdminPassword("dev-secret", config)).toBe(false);
});
