import bcrypt from "bcryptjs";
import crypto from "node:crypto";

export function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  return req.originalUrl.startsWith("/api/")
    ? res.status(401).json({ error: "Administrator authentication required" })
    : res.redirect("/login");
}

/**
 * Prefers a bcrypt hash (ADMIN_PASSWORD_HASH) over the legacy plaintext
 * ADMIN_PASSWORD. Plaintext comparison is only permitted outside production,
 * so a real deployment can never run on an unhashed password by accident —
 * see assertProductionSafety() in config/env.js, which refuses to boot
 * otherwise.
 */
export async function verifyAdminPassword(candidate, config) {
  if (config.adminPasswordHash) {
    try {
      return await bcrypt.compare(String(candidate ?? ""), config.adminPasswordHash);
    } catch {
      return false;
    }
  }
  if (config.nodeEnv === "production") return false;
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(String(config.adminPassword ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
