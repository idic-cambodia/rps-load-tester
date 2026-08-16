import { describe, it, expect, vi } from "vitest";
import {
  normalizeTarget,
  validateTarget,
  validateRedirect,
  verifyOwnership,
  assertPublicResolution,
} from "../src/load-testing/safety/targets.js";
import {
  enforceLimits,
  emergencyStop,
} from "../src/load-testing/safety/limits.js";
import { cfg, sample } from "./helpers.js";
import { parseTest } from "../src/validators/test.js";
describe("target safety", () => {
  it("normalizes URL", () =>
    expect(normalizeTarget("HTTPS://IDICCAMBODIA.COM/a#x").href).toBe(
      "https://idiccambodia.com/a",
    ));
  it("allows only configured domains", () => {
    expect(validateTarget(sample.baseUrl, cfg).hostname).toBe(
      "idiccambodia.com",
    );
    expect(() => validateTarget("https://example.com", cfg)).toThrow(
      /allowlisted/,
    );
  });
  it.each([
    "http://localhost",
    "http://127.0.0.1",
    "ftp://idiccambodia.com",
    "https://u:p@idiccambodia.com",
  ])(`rejects %s`, (u) => expect(() => validateTarget(u, cfg)).toThrow());
  it("rejects unsafe redirect", () =>
    expect(() =>
      validateRedirect(sample.baseUrl, "https://evil.example", cfg),
    ).toThrow());
  it("verifies server allowlist", async () =>
    expect(await verifyOwnership("idiccambodia.com", cfg)).toMatchObject({
      verified: true,
    }));
  it("verifies DNS token", async () =>
    expect(
      await verifyOwnership("api.idiccambodia.com", cfg, {
        token: "abc",
        resolveTxt: vi.fn().mockResolvedValue([["abc"]]),
      }),
    ).toMatchObject({ method: "dns-txt" }));
});
describe("assertPublicResolution", () => {
  it("passes when DNS resolves to a public address", async () => {
    const dnsModule = await import("node:dns/promises");
    const original = dnsModule.lookup;
    dnsModule.default.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    try {
      await expect(assertPublicResolution("idiccambodia.com", cfg)).resolves.toBeUndefined();
    } finally {
      dnsModule.default.lookup = original;
    }
  });
  it("rejects when an allowlisted domain currently resolves to a private address", async () => {
    const dnsModule = await import("node:dns/promises");
    const original = dnsModule.lookup;
    dnsModule.default.lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    try {
      await expect(assertPublicResolution("idiccambodia.com", cfg)).rejects.toThrow(/private\/reserved/);
    } finally {
      dnsModule.default.lookup = original;
    }
  });
  it("rejects when DNS resolution fails outright", async () => {
    const dnsModule = await import("node:dns/promises");
    const original = dnsModule.lookup;
    dnsModule.default.lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    try {
      await expect(assertPublicResolution("idiccambodia.com", cfg)).rejects.toThrow(/DNS resolution failed/);
    } finally {
      dnsModule.default.lookup = original;
    }
  });
  it("skips the check entirely when private targets are explicitly allowed", async () => {
    await expect(
      assertPublicResolution("internal.example", { ...cfg, allowPrivateTargets: true }),
    ).resolves.toBeUndefined();
  });
});
describe("limits", () => {
  it("prevents a high-load run from being mislabeled as smoke", () => {
    const { totalDurationSeconds, hostname, ...input } = sample;
    expect(totalDurationSeconds).toBe(30);
    expect(hostname).toBe("idiccambodia.com");
    expect(() => parseTest({ ...input, targetRps: 5000 })).toThrow(
      /Smoke tests are limited to 10 RPS/,
    );
  });
  it("enforces default cap", () =>
    expect(() => enforceLimits({ ...sample, targetRps: 1001 }, cfg)).toThrow(
      /ALLOW_HIGH_LOAD/,
    ));
  it("requires exact high confirmation", () =>
    expect(() =>
      enforceLimits(
        {
          ...sample,
          targetRps: 20000,
          confirmDomain: "wrong",
          confirmRps: 20000,
        },
        { ...cfg, allowHighLoad: true, maxAllowedRps: 100000 },
      ),
    ).toThrow(/confirmation/));
  it("stops on thresholds", () =>
    expect(
      emergencyStop(
        {
          errorRate: 0.1,
          p95: 20,
          badStatusRate: 0,
          unavailable: false,
          elapsedSeconds: 1,
        },
        {
          maxErrorRate: 0.05,
          maxP95Ms: 1000,
          maxBadStatusRate: 0.05,
          maxDuration: 30,
        },
      ),
    ).toEqual({ stop: true, reasons: ["error-rate"] }));
});
