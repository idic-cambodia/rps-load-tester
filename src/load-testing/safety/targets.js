import dns from "node:dns/promises";
import net from "node:net";
const PRIVATE = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
  /^fe80:/i,
];
export function normalizeTarget(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error("Invalid target URL");
  }
  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("Only HTTP and HTTPS are supported");
  if (u.username || u.password)
    throw new Error("URLs containing credentials are forbidden");
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  return u;
}
export function isPrivateIp(ip) {
  return PRIVATE.some((r) => r.test(ip));
}
/**
 * Re-resolves an allowlisted hostname and rejects it if DNS currently points
 * at a private/reserved/loopback address. Passing string-based allowlist
 * validation only proves the *name* was approved; it says nothing about
 * where that name currently resolves. Without this check, a domain that was
 * safe when added to ALLOWED_TARGETS could later be pointed (by DNS
 * rebinding, a lapsed domain, or admin error elsewhere in the DNS chain) at
 * an internal address, and the tool would happily generate load against it.
 * Must be called fresh, immediately before a test actually starts — not just
 * once at creation time, since DNS can change between those two moments.
 */
export async function assertPublicResolution(hostname, cfg) {
  if (cfg.allowPrivateTargets) return;
  if (net.isIP(hostname)) return; // literal IPs are already checked in validateTarget
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`DNS resolution failed for ${hostname}: ${e.message}`);
  }
  if (!addresses.length) throw new Error(`DNS resolution returned no addresses for ${hostname}`);
  for (const { address } of addresses) {
    if (isPrivateIp(address) || address === "::1") {
      throw new Error(
        `${hostname} currently resolves to a private/reserved address (${address}); refusing to test. ` +
          "This may indicate DNS rebinding, a lapsed domain, or misconfiguration.",
      );
    }
  }
}
export function validateTarget(input, cfg) {
  const u = normalizeTarget(input);
  const host = u.hostname;
  if (host === "localhost" || host.endsWith(".localhost"))
    throw new Error("localhost is forbidden");
  if (net.isIP(host)) {
    if (!cfg.allowedIpTargets.includes(host))
      throw new Error("IP target is not explicitly allowlisted");
    if (isPrivateIp(host) && !cfg.allowPrivateTargets)
      throw new Error("Private targets are disabled");
  } else if (!cfg.allowedTargets.includes(host))
    throw new Error("Target domain is not allowlisted");
  return u;
}
export function validateRedirect(from, to, cfg) {
  const a = validateTarget(from, cfg),
    b = validateTarget(new URL(to, a).href, cfg);
  if (a.hostname !== b.hostname && !cfg.allowedTargets.includes(b.hostname))
    throw new Error("Redirect target is not allowlisted");
  return b;
}
export async function verifyOwnership(
  host,
  cfg,
  { resolveTxt = dns.resolveTxt, fetchFn = fetch, token } = {},
) {
  if (cfg.verifiedTargets.includes(host))
    return { verified: true, method: "server-allowlist" };
  if (!token) throw new Error("Verification token is required");
  try {
    const rows = await resolveTxt(`_load-test-verification.${host}`);
    if (rows.flat().join("").includes(token))
      return { verified: true, method: "dns-txt" };
  } catch {
    /* try HTTP */
  }
  try {
    const r = await fetchFn(
      `https://${host}/.well-known/load-test-verification.txt`,
      { redirect: "manual", signal: AbortSignal.timeout(5000) },
    );
    if (r.ok && (await r.text()).trim() === token)
      return { verified: true, method: "well-known" };
  } catch {
    /* fail below */
  }
  throw new Error("Target ownership could not be verified");
}
