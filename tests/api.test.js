import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import { createApp } from "../src/app.js";
import {
  createDatabase,
  TestRepository,
  TargetRepository,
} from "../src/repositories/database.js";
import { cfg } from "./helpers.js";
describe("API authorization", () => {
  let db, app, file, targetRepo;
  beforeEach(() => {
    file = `/tmp/rps-test-${process.pid}-${Date.now()}.sqlite`;
    db = createDatabase(file);
    targetRepo = new TargetRepository(db);
    app = createApp({
      config: {
        ...cfg,
        nodeEnv: "test",
        sessionSecret: "x".repeat(32),
        adminUsername: "admin",
        adminPassword: "secret",
        databasePath: file,
        trustProxy: false,
      },
      repo: new TestRepository(db),
      targetRepo,
      runner: {
        start() {},
        stop() {
          return true;
        },
        stopAll() {
          return [];
        },
      },
    });
  });
  afterEach(() => {
    db.close();
    for (const x of [
      file,
      `${file}-wal`,
      `${file}-shm`,
      `${file.replace(/[^/]+$/, "")}sessions.sqlite`,
    ])
      try {
        fs.unlinkSync(x);
      } catch {
        /* absent */
      }
  });
  it("rejects unauthenticated API requests", async () =>
    expect((await request(app).get("/api/tests")).status).toBe(401));
  it("rejects login without CSRF", async () =>
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ username: "admin", password: "secret" })
      ).status,
    ).toBe(403));

  async function login() {
    const agent = request.agent(app);
    const loginPage = await agent.get("/login");
    const loginToken = /id="csrf" value="([^"]+)"/.exec(loginPage.text)[1];
    await agent
      .post("/api/auth/login")
      .set("CSRF-Token", loginToken)
      .send({ username: "admin", password: "secret" });
    // Logging in regenerates the session (correct anti-fixation practice),
    // which rotates the CSRF secret too — fetch a fresh token from the
    // dashboard afterwards, exactly like the real client does.
    const dashboard = await agent.get("/");
    const token = /id="csrf" value="([^"]+)"/.exec(dashboard.text)[1];
    return { agent, token };
  }

  it("rejects test creation for a target that has never been verified", async () => {
    const { agent, token } = await login();
    const res = await agent
      .post("/api/tests")
      .set("CSRF-Token", token)
      .send({
        name: "unverified",
        preset: "smoke",
        method: "GET",
        baseUrl: "https://idic.edu.kh",
        endpoint: "/healthz",
        auth: { type: "none" },
        targetRps: 10,
        startingRps: 10,
        rampUpSeconds: 0,
        steadySeconds: 30,
        rampDownSeconds: 0,
        requestTimeoutMs: 5000,
        maxVus: 100,
        expectedStatus: 200,
        thinkTimeMs: 0,
        instances: 1,
        stopThresholds: { maxErrorRate: 0.05, maxP95Ms: 1000, maxBadStatusRate: 0.05 },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ownership-verified/);
  });

  it("verifies an already-listed domain via the static allowlist method (no token needed)", async () => {
    const { agent, token } = await login();
    // idiccambodia.com is in cfg.verifiedTargets already, so this exercises
    // the trivial "server-allowlist" path and confirms it isn't persisted
    // to the targets table (it's re-derived from config every call).
    const verify = await agent
      .post("/api/targets/verify")
      .set("CSRF-Token", token)
      .send({ url: "https://idiccambodia.com" });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ verified: true, method: "server-allowlist" });
    expect(targetRepo.isVerified("idiccambodia.com")).toBe(false);
  });

  it("a DNS-TXT verification for a not-yet-verified allowlisted domain persists and then actually unlocks test creation", async () => {
    const { agent, token } = await login();
    const dnsModule = await import("node:dns/promises");
    const originalResolveTxt = dnsModule.default.resolveTxt;
    dnsModule.default.resolveTxt = async () => [["proof-of-ownership-xyz"]];
    try {
      // idic.edu.kh is allowlisted but NOT in the static verified list.
      const verify = await agent
        .post("/api/targets/verify")
        .set("CSRF-Token", token)
        .send({ url: "https://idic.edu.kh", token: "proof-of-ownership-xyz" });
      expect(verify.status).toBe(200);
      expect(verify.body).toMatchObject({ verified: true, method: "dns-txt" });
      expect(targetRepo.isVerified("idic.edu.kh")).toBe(true);
    } finally {
      dnsModule.default.resolveTxt = originalResolveTxt;
    }

    // Now that verification is persisted, test creation for this domain
    // should succeed instead of being rejected as unverified — this is the
    // exact gap that made the DNS-TXT/well-known methods decorative before.
    const create = await agent
      .post("/api/tests/validate")
      .set("CSRF-Token", token)
      .send({
        name: "now unlocked",
        preset: "smoke",
        method: "GET",
        baseUrl: "https://idic.edu.kh",
        endpoint: "/healthz",
        auth: { type: "none" },
        targetRps: 10,
        startingRps: 10,
        rampUpSeconds: 0,
        steadySeconds: 30,
        rampDownSeconds: 0,
        requestTimeoutMs: 5000,
        maxVus: 100,
        expectedStatus: 200,
        thinkTimeMs: 0,
        instances: 1,
        stopThresholds: { maxErrorRate: 0.05, maxP95Ms: 1000, maxBadStatusRate: 0.05 },
      });
    // DNS public-resolution check will still run against the real network
    // for idic.edu.kh; accept either a pass-through (200) or a DNS-related
    // rejection (400), but never the "ownership-verified" rejection that
    // would indicate the persistence fix didn't work.
    if (create.status !== 200) {
      expect(create.body.error).not.toMatch(/ownership-verified/);
    }
  });
});
