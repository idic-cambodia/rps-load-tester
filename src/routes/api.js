import { Router } from "express";
import crypto from "node:crypto";
import { parseTest } from "../validators/test.js";
import {
  validateTarget,
  verifyOwnership,
  assertPublicResolution,
} from "../load-testing/safety/targets.js";
import { enforceLimits } from "../load-testing/safety/limits.js";
import { redact, encryptTestSecrets, assertSecretStoragePolicy } from "../utils/secrets.js";
import { calculateCapacity } from "../services/capacity.js";
import { verifyAdminPassword } from "../middleware/auth.js";
const equal = (a, b) => {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export function apiRoutes({ config, repo, targetRepo, runner, requireAuth }) {
  const r = Router();
  r.post("/auth/login", async (req, res) => {
    const ok = await verifyAdminPassword(req.body.password, config);
    if (!equal(req.body.username, config.adminUsername) || !ok)
      return res.status(401).json({ error: "Invalid credentials" });
    req.session.regenerate((e) => {
      if (e) return res.status(500).json({ error: "Session error" });
      req.session.admin = config.adminUsername;
      repo.audit(config.adminUsername, "login");
      res.json({ ok: true });
    });
  });
  r.use(requireAuth);
  r.get("/targets", (_q, res) =>
    res.json({
      targets: config.allowedTargets,
      verified: [...new Set([...config.verifiedTargets, ...targetRepo.list().map((t) => t.domain)])],
      verifications: targetRepo.list(),
    }),
  );
  r.post("/targets/verify", async (req, res, next) => {
    try {
      const u = validateTarget(req.body.url, config);
      const result = await verifyOwnership(u.hostname, config, { token: req.body.token });
      if (result.verified && result.method !== "server-allowlist") {
        targetRepo.markVerified(u.hostname, result.method);
        repo.audit(req.session.admin, "target.verify", { domain: u.hostname, method: result.method });
      }
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  const isTargetVerified = (hostname) =>
    config.verifiedTargets.includes(hostname) || targetRepo.isVerified(hostname);
  const validated = async (body) => {
    const t = parseTest(body);
    const u = validateTarget(new URL(t.endpoint, t.baseUrl).href, config);
    const full = { ...t, hostname: u.hostname };
    enforceLimits(full, config);
    if (!isTargetVerified(u.hostname))
      throw new Error(
        "Target must be ownership-verified before creating a test",
      );
    // Re-resolve DNS now, not just trust the hostname string: a domain that
    // was safe when allowlisted can be repointed at a private address later.
    await assertPublicResolution(u.hostname, config);
    return full;
  };
  r.post("/tests/validate", async (req, res, next) => {
    try {
      res.json({ valid: true, config: redact(await validated(req.body)) });
    } catch (e) {
      next(e);
    }
  });
  r.post("/tests", async (req, res, next) => {
    try {
      const full = await validated(req.body);
      assertSecretStoragePolicy(full, config);
      const t = repo.create(encryptTestSecrets(full, config));
      repo.audit(req.session.admin, "test.create", {
        id: t.id,
        target: t.config.hostname,
        rps: t.config.targetRps,
      });
      res.status(201).json({ ...t, config: redact(t.config) });
    } catch (e) {
      next(e);
    }
  });
  r.post("/tests/:id/start", async (req, res, next) => {
    try {
      const t = repo.get(req.params.id);
      if (!t) return res.status(404).json({ error: "Not found" });
      await runner.start(t);
      repo.audit(req.session.admin, "test.start", { id: t.id });
      res.status(202).json({ started: true });
    } catch (e) {
      next(e);
    }
  });
  r.post("/tests/:id/stop", (req, res) => {
    const ok = runner.stop(Number(req.params.id), Boolean(req.body.emergency));
    repo.audit(
      req.session.admin,
      req.body.emergency ? "test.emergency-stop" : "test.stop",
      { id: req.params.id },
    );
    res.status(ok ? 202 : 409).json({ stopping: ok });
  });
  r.post("/tests/emergency-stop", (req, res) => {
    const ids = runner.stopAll(true);
    repo.audit(req.session.admin, "test.emergency-stop-all", { ids });
    res.status(202).json({ stopping: ids });
  });
  r.get("/tests/:id/status", (req, res) => {
    const t = repo.get(req.params.id);
    res
      .status(t ? 200 : 404)
      .json(t ? { id: t.id, status: t.status } : { error: "Not found" });
  });
  r.get("/tests/:id/results", (req, res) => {
    const t = repo.get(req.params.id);
    res.status(t ? 200 : 404).json(
      t
        ? {
            id: t.id,
            name: t.name,
            status: t.status,
            createdAt: t.created_at,
            startedAt: t.started_at,
            finishedAt: t.finished_at,
            config: redact(t.config),
            result: t.result,
          }
        : { error: "Not found" },
    );
  });
  r.get("/tests", (_q, res) => res.json(repo.list()));
  r.delete("/tests/:id", (req, res) =>
    res.status(repo.delete(req.params.id) ? 204 : 409).end(),
  );
  r.get("/system/capacity", (req, res, next) => {
    try {
      res.json({
        warning:
          "Specifications cannot be calculated from RPS alone; benchmark measurements are required.",
        ...calculateCapacity(
          Object.fromEntries(
            Object.entries(req.query).map(([k, v]) => [k, Number(v)]),
          ),
        ),
      });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
