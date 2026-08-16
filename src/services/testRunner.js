import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { generateK6 } from "../load-testing/generators/k6.js";
import {
  parseSummary,
  reconcileResult,
} from "../load-testing/parsers/results.js";
import { emergencyStop } from "../load-testing/safety/limits.js";
import { validateTarget, assertPublicResolution } from "../load-testing/safety/targets.js";
import { decryptTestSecrets } from "../utils/secrets.js";
import { LiveMetricAggregator } from "../load-testing/parsers/liveMetrics.js";
import { InfrastructureMetricCollector } from "./systemMetrics.js";
const BAD_STATUSES = new Set(["429", "502", "503", "504"]);
export class TestRunner {
  constructor({ repo, targetRepo, io, config, dir = "generated" }) {
    this.repo = repo;
    this.targetRepo = targetRepo;
    this.io = io;
    this.config = config;
    this.dir = dir;
    this.active = new Map();
  }
  hasHighLoad() {
    return [...this.active.values()].some((x) => x.config.targetRps > 1000);
  }
  async start(record) {
    if (record.config.targetRps > 1000 && this.hasHighLoad())
      throw new Error("Only one local high-load test may run at a time");

    // Defense-in-depth: re-validate the target immediately before execution,
    // not just at test-creation time. Allowlist membership, ownership
    // verification, and DNS can all change in the time between "create" and
    // "start" (which may be minutes, hours, or days apart).
    const u = validateTarget(new URL(record.config.endpoint, record.config.baseUrl).href, this.config);
    const isVerified =
      this.config.verifiedTargets.includes(u.hostname) ||
      (this.targetRepo?.isVerified(u.hostname) ?? false);
    if (!isVerified) throw new Error(`Target "${u.hostname}" is no longer ownership-verified`);
    await assertPublicResolution(u.hostname, this.config);

    fs.mkdirSync(this.dir, { recursive: true });
    const script = path.resolve(this.dir, `test-${record.id}.js`),
      summary = path.resolve(this.dir, `summary-${record.id}.json`);
    // Secrets are only ever decrypted in-memory, right here, to build the
    // k6 script — never written back to the database in plaintext.
    const runtimeConfig = decryptTestSecrets(record.config, this.config);
    fs.writeFileSync(script, generateK6(runtimeConfig), { mode: 0o600 });
    const child = spawn(
        this.config.k6Binary,
        ["run", "--summary-export", summary, "--out", "json=-", script],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, K6_NO_USAGE_REPORT: "true" },
        },
      ),
      metrics = new LiveMetricAggregator();
    const infrastructure = new InfrastructureMetricCollector();
    infrastructure.sample();
    const state = {
      child,
      config: record.config,
      started: Date.now(),
      manual: false,
      autoStopReasons: null,
      metrics,
      stderr: "",
      statusCounts: {},
      totals: { requests: 0, successful: 0, failed: 0, dropped: 0 },
      peakWindowRps: 0,
      peakVus: 0,
      steadyRequests: 0,
      steadyObservedSeconds: 0,
      consecutiveEmptyWindows: 0,
      infrastructure,
    };
    child.stderr.on("data", (chunk) => {
      state.stderr = (state.stderr + chunk.toString()).slice(-8192);
    });
    state.metricTimer = setInterval(() => {
      const elapsed = (Date.now() - state.started) / 1000,
        snapshot = metrics.snapshot(record.config.targetRps, elapsed);
      state.totals.requests +=
        snapshot.successfulRequests + snapshot.failedRequests;
      state.totals.successful += snapshot.successfulRequests;
      state.totals.failed += snapshot.failedRequests;
      state.totals.dropped += snapshot.droppedIterations;
      state.peakWindowRps = Math.max(state.peakWindowRps, snapshot.currentRps);
      state.peakVus = Math.max(state.peakVus, snapshot.activeVus);
      const generator = state.infrastructure.sample();
      const steadyStart = 1 + record.config.rampUpSeconds,
        steadyEnd = steadyStart + record.config.steadySeconds,
        hasSimpleSteadyStage = !["stress", "spike"].includes(
          record.config.preset,
        );
      if (
        hasSimpleSteadyStage &&
        elapsed >= steadyStart &&
        elapsed <= steadyEnd
      ) {
        state.steadyRequests +=
          snapshot.successfulRequests + snapshot.failedRequests;
        state.steadyObservedSeconds += 1;
      }
      this.io.to(`test:${record.id}`).emit("test:metrics", {
        ...snapshot,
        cumulative: { ...state.totals },
        peakVus: state.peakVus,
        generator: {
          cpuPercent: generator.cpuPercent,
          memoryBytes: generator.current,
          memoryLimitBytes: generator.limit,
        },
      });
      this._evaluateAutoStop(record.id, snapshot, elapsed);
    }, 1000);
    this.active.set(record.id, state);
    this.repo.update(record.id, {
      status: "running",
      started_at: new Date().toISOString(),
    });
    this.io.to(`test:${record.id}`).emit("test:status", { status: "running" });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const point = JSON.parse(line);
        metrics.add(point);
        if (
          point.type === "Point" &&
          point.metric === "http_reqs" &&
          point.data?.tags?.status
        ) {
          const status = point.data.tags.status;
          state.statusCounts[status] =
            (state.statusCounts[status] || 0) + (Number(point.data.value) || 0);
        }
      } catch {
        /* ignore non-JSON */
      }
    });
    child.on("error", (e) => this.finish(record.id, summary, 1, e.message));
    child.on("close", (code) => this.finish(record.id, summary, code));
    return { started: true };
  }
  /**
   * Runs the automatic emergency-stop conditions against the latest 1s
   * metrics window. This is what actually enforces error-rate, p95-latency,
   * bad-status-ratio, target-unavailability, and the absolute duration
   * watchdog while a test is running — enforceLimits() at creation time only
   * bounds what was *requested*, not what actually happens once k6 is live.
   */
  _evaluateAutoStop(id, snapshot, elapsedSeconds) {
    const s = this.active.get(id);
    if (!s || s.manual) return;
    const windowTotal = snapshot.successfulRequests + snapshot.failedRequests;
    const badStatusInWindow = Object.entries(snapshot.statuses || {}).reduce(
      (sum, [status, count]) => sum + (BAD_STATUSES.has(status) ? count : 0),
      0,
    );
    if (windowTotal >= 1 && snapshot.successfulRequests === 0) {
      s.consecutiveEmptyWindows += 1;
    } else {
      s.consecutiveEmptyWindows = 0;
    }
    const sample = {
      errorRate: snapshot.errorRate,
      p95: snapshot.p95,
      badStatusRate: windowTotal ? badStatusInWindow / windowTotal : 0,
      // Only declare the target "unavailable" after several consecutive
      // all-failing windows, to avoid tripping on a single blip during
      // ramp-up when only one or two requests have been attempted.
      unavailable: s.consecutiveEmptyWindows >= 3,
      elapsedSeconds,
    };
    const decision = this.evaluate(id, sample, {
      // Absolute watchdog independent of this test's own ramp/steady/down
      // schedule, in case the k6 process hangs past the server-wide ceiling.
      maxDuration: this.config.maxDuration,
    });
    if (decision.stop) {
      s.autoStopReasons = decision.reasons;
      this.io.to(`test:${id}`).emit("test:autostop", { id, reasons: decision.reasons, sample });
    }
  }
  stop(id, emergency = false) {
    const s = this.active.get(id);
    if (!s) return false;
    s.manual = true;
    s.child.kill(emergency ? "SIGKILL" : "SIGINT");
    this.repo.update(id, { status: "stopping" });
    return true;
  }
  /** Stops every currently-running test on this instance. */
  stopAll(emergency = true) {
    const ids = [...this.active.keys()];
    for (const id of ids) this.stop(id, emergency);
    return ids;
  }
  evaluate(id, sample, limitOverrides = {}) {
    const s = this.active.get(id);
    if (!s) return { stop: false, reasons: [] };
    const decision = emergencyStop(sample, {
      ...s.config.stopThresholds,
      maxDuration: s.config.totalDurationSeconds,
      ...limitOverrides,
    });
    if (decision.stop) this.stop(id, true);
    return decision;
  }
  finish(id, summary, code, error) {
    const s = this.active.get(id);
    if (!s) return;
    clearInterval(s.metricTimer);
    this.active.delete(id);
    const stderr = s.stderr
      .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi, "$1********")
      .replace(/((?:x-api-key|token):\s*)\S+/gi, "$1********")
      .trim();
    const thresholdFailures = [
      ...stderr.matchAll(
        /thresholds on metrics ['"]([^'"]+)['"] have been crossed/gi,
      ),
    ].map((match) => match[1]);
    const elapsedSeconds = Math.max(0.001, (Date.now() - s.started) / 1000);
    const statusTotal = Object.values(s.statusCounts).reduce(
      (sum, value) => sum + Number(value || 0),
      0,
    );
    const expectedStatusTotal = Number(
      s.statusCounts[String(s.config.expectedStatus)] || 0,
    );
    let result = {
      resultSchemaVersion: 2,
      exitCode: code,
      error: error || (code !== 0 && stderr) || undefined,
      httpStatusCounts: s.statusCounts,
      peakWindowRps: s.peakWindowRps,
      peakActiveVusObserved: s.peakVus,
      steadyStageRps: s.steadyObservedSeconds
        ? s.steadyRequests / s.steadyObservedSeconds
        : null,
      steadyObservedSeconds: s.steadyObservedSeconds,
      liveCumulative: s.totals,
      generatorMetrics: s.infrastructure.summary(),
      thresholdFailures,
      autoStopReasons: s.autoStopReasons || null,
    };
    try {
      result = { ...result, ...parseSummary(fs.readFileSync(summary, "utf8")) };
    } catch {
      /* summary may not exist */
    }
    const lifetime = s.metrics.lifetimeSummary(elapsedSeconds);
    result = reconcileResult(result, {
      ...lifetime,
      totalRequests: statusTotal,
      successfulRequests: expectedStatusTotal,
      httpFailures: statusTotal
        ? Math.max(0, statusTotal - expectedStatusTotal)
        : lifetime.httpFailures,
      errorRate: statusTotal
        ? Math.max(0, statusTotal - expectedStatusTotal) / statusTotal
        : lifetime.errorRate,
    });
    if (
      thresholdFailures.includes("dropped_iterations") &&
      !result.droppedIterations
    )
      result.droppedIterationsCountUnavailable = true;
    const status = s.manual ? "stopped" : code === 0 ? "completed" : "failed";
    this.repo.update(id, {
      status,
      result,
      finished_at: new Date().toISOString(),
    });
    this.io.to(`test:${id}`).emit("test:status", { status, result });
  }
}
