import { describe, expect, it } from "vitest";
import {
  calculateInfrastructureSample,
  InfrastructureMetricCollector,
} from "../src/services/systemMetrics.js";

describe("infrastructure metrics", () => {
  it("calculates container-style CPU percentage", () => {
    const point = calculateInfrastructureSample(
      { atMs: 1000, cpuUsageUsec: 100000 },
      { atMs: 2000, cpuUsageUsec: 1350000 },
    );
    expect(point.cpuPercent).toBe(125);
  });

  it("summarizes peaks and per-test network deltas", () => {
    const readings = [
      {
        atMs: 0,
        cpuUsageUsec: 0,
        current: 100,
        limit: 1000,
        receivedBytes: 10,
        sentBytes: 20,
      },
      {
        atMs: 1000,
        cpuUsageUsec: 500000,
        current: 300,
        limit: 1000,
        receivedBytes: 1010,
        sentBytes: 520,
      },
      {
        atMs: 2000,
        cpuUsageUsec: 1500000,
        current: 250,
        limit: 1000,
        receivedBytes: 2010,
        sentBytes: 1020,
      },
    ];
    const collector = new InfrastructureMetricCollector(() => readings.shift());
    collector.sample();
    collector.sample();
    collector.sample();
    expect(collector.summary()).toMatchObject({
      averageCpuPercent: 75,
      peakCpuPercent: 100,
      peakMemoryBytes: 300,
      peakMemoryPercent: 30,
      networkReceivedBytes: 2000,
      networkSentBytes: 1000,
      sampleCount: 2,
    });
  });
});
