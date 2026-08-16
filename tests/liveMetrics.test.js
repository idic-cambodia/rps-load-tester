import { it, expect } from "vitest";
import { LiveMetricAggregator } from "../src/load-testing/parsers/liveMetrics.js";
it("aggregates k6 points into a one-second dashboard snapshot", () => {
  let now = 0;
  const a = new LiveMetricAggregator(() => now);
  a.add({
    type: "Point",
    metric: "http_reqs",
    data: { value: 1, tags: { status: "200" } },
  });
  a.add({
    type: "Point",
    metric: "http_reqs",
    data: { value: 1, tags: { status: "500" } },
  });
  a.add({ type: "Point", metric: "http_req_failed", data: { value: 1 } });
  a.add({ type: "Point", metric: "http_req_duration", data: { value: 100 } });
  a.add({ type: "Point", metric: "http_req_duration", data: { value: 250 } });
  a.add({ type: "Point", metric: "vus", data: { value: 7 } });
  now = 1000;
  expect(a.snapshot(10, 1)).toMatchObject({
    currentRps: 2,
    successfulRequests: 1,
    failedRequests: 1,
    errorRate: 0.5,
    p50: 100,
    p95: 250,
    p99: 250,
    activeVus: 7,
    statuses: { 200: 1, 500: 1 },
  });
});
it("keeps lifetime fallbacks after live windows reset", () => {
  let now = 0;
  const a = new LiveMetricAggregator(() => now);
  a.add({ type: "Point", metric: "http_reqs", data: { value: 1 } });
  a.add({ type: "Point", metric: "http_req_duration", data: { value: 25 } });
  a.add({ type: "Point", metric: "data_received", data: { value: 1000 } });
  a.add({ type: "Point", metric: "dropped_iterations", data: { value: 2 } });
  now = 1000;
  a.snapshot(10, 1);
  expect(a.lifetimeSummary(1)).toMatchObject({
    totalRequests: 1,
    successfulRequests: 1,
    achievedRps: 1,
    p95: 25,
    droppedIterations: 2,
    receivedBytes: 1000,
  });
});
