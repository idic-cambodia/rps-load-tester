import { it, expect } from "vitest";
import { generateK6 } from "../src/load-testing/generators/k6.js";
import {
  parseSummary,
  reconcileResult,
} from "../src/load-testing/parsers/results.js";
import { sample } from "./helpers.js";
it("generates arrival-rate script with redirects disabled", () => {
  const s = generateK6(sample);
  expect(s).toContain("ramping-arrival-rate");
  expect(s).toContain("redirects:0");
  expect(s).toContain("dropped_iterations");
});
it("parses summary metrics", () =>
  expect(
    parseSummary({
      metrics: {
        http_reqs: { values: { count: 30, rate: 10 } },
        http_req_failed: { values: { rate: 0.1 } },
        http_req_duration: { values: { med: 10, "p(95)": 20 } },
        vus_max: { values: { max: 25 } },
      },
    }),
  ).toMatchObject({
    totalRequests: 30,
    successfulRequests: 27,
    httpFailures: 3,
    errorRate: 0.1,
    achievedRps: 10,
    p50: 10,
    p95: 20,
    maxActiveVus: 25,
  }));
it("does not replace live measurements with absent summary metrics", () => {
  expect(parseSummary({ metrics: {} })).toEqual({});
  expect(
    reconcileResult(
      { totalRequests: 0, p95: 0 },
      { totalRequests: 521563, p95: 12.5 },
    ),
  ).toMatchObject({ totalRequests: 521563, p95: 12.5 });
});
