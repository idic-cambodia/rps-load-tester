import { describe, it, expect, vi } from "vitest";
import { TestRunner } from "../src/services/testRunner.js";

function makeRunner() {
  const repo = { update: vi.fn(), get: vi.fn() };
  const io = { to: () => ({ emit: vi.fn() }) };
  const config = {
    maxDuration: 3600,
    maxErrorRate: 0.05,
    maxP95Ms: 1000,
    maxBadStatusRate: 0.05,
  };
  const runner = new TestRunner({ repo, targetRepo: null, io, config });
  return { runner, repo };
}

function activeState(overrides = {}) {
  return {
    child: { kill: vi.fn() },
    config: { targetRps: 100, stopThresholds: { maxErrorRate: 0.05, maxP95Ms: 1000, maxBadStatusRate: 0.05 } },
    manual: false,
    autoStopReasons: null,
    consecutiveEmptyWindows: 0,
    ...overrides,
  };
}

describe("TestRunner auto-stop wiring", () => {
  it("stops the test and records reasons when the error rate breaches the threshold", () => {
    const { runner } = makeRunner();
    runner.active.set(1, activeState());
    runner._evaluateAutoStop(1, { successfulRequests: 1, failedRequests: 20, errorRate: 0.95, p95: 50, statuses: {} }, 5);
    const state = runner.active.get(1);
    expect(state.manual).toBe(true); // stop() was invoked
    expect(state.autoStopReasons).toContain("error-rate");
  });

  it("computes bad-status-rate from 429/502/503/504 responses in the window", () => {
    const { runner } = makeRunner();
    runner.active.set(1, activeState());
    runner._evaluateAutoStop(
      1,
      {
        successfulRequests: 5,
        failedRequests: 0,
        errorRate: 0,
        p95: 50,
        statuses: { "200": 5, "503": 10 },
      },
      5,
    );
    const state = runner.active.get(1);
    expect(state.autoStopReasons).toContain("upstream-status");
  });

  it("flags the target unavailable only after several consecutive empty windows, not a single blip", () => {
    const { runner } = makeRunner();
    // Disable the error-rate/p95/bad-status triggers so only the
    // "unavailable" condition is under test in isolation.
    const relaxed = { maxErrorRate: 1.1, maxP95Ms: 1e9, maxBadStatusRate: 1.1 };
    runner.active.set(1, activeState({ config: { targetRps: 100, stopThresholds: relaxed } }));
    // Two failing windows: not yet "unavailable".
    runner._evaluateAutoStop(1, { successfulRequests: 0, failedRequests: 2, errorRate: 1, p95: 10, statuses: {} }, 1);
    runner._evaluateAutoStop(1, { successfulRequests: 0, failedRequests: 2, errorRate: 1, p95: 10, statuses: {} }, 2);
    expect(runner.active.get(1).manual).toBe(false);
    // Third consecutive failing window trips it.
    runner._evaluateAutoStop(1, { successfulRequests: 0, failedRequests: 2, errorRate: 1, p95: 10, statuses: {} }, 3);
    const state = runner.active.get(1);
    expect(state.manual).toBe(true);
    expect(state.autoStopReasons).toContain("target-unavailable");
  });

  it("resets the consecutive-empty-window counter as soon as a request succeeds", () => {
    const { runner } = makeRunner();
    const relaxed = { maxErrorRate: 1.1, maxP95Ms: 1e9, maxBadStatusRate: 1.1 };
    runner.active.set(1, activeState({ config: { targetRps: 100, stopThresholds: relaxed } }));
    runner._evaluateAutoStop(1, { successfulRequests: 0, failedRequests: 2, errorRate: 1, p95: 10, statuses: {} }, 1);
    runner._evaluateAutoStop(1, { successfulRequests: 5, failedRequests: 0, errorRate: 0, p95: 10, statuses: {} }, 2);
    expect(runner.active.get(1).consecutiveEmptyWindows).toBe(0);
  });

  it("does nothing once the test has already been manually stopped", () => {
    const { runner } = makeRunner();
    runner.active.set(1, activeState({ manual: true }));
    runner._evaluateAutoStop(1, { successfulRequests: 0, failedRequests: 20, errorRate: 1, p95: 50, statuses: {} }, 5);
    expect(runner.active.get(1).autoStopReasons).toBeNull(); // untouched, evaluate() never ran
  });

  it("stopAll stops every currently-running test", () => {
    const { runner } = makeRunner();
    runner.active.set(1, activeState());
    runner.active.set(2, activeState());
    const ids = runner.stopAll(true);
    expect(ids.sort()).toEqual([1, 2]);
    expect(runner.active.get(1).child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(runner.active.get(2).child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
