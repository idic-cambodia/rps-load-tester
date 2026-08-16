import fs from "node:fs";
import os from "node:os";

function read(path) {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function cpuUsageUsec() {
  const v2 = read("/sys/fs/cgroup/cpu.stat")?.match(/^usage_usec\s+(\d+)/m);
  if (v2) return Number(v2[1]);
  const v1 = read("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  if (v1) return Number(v1) / 1000;
  const usage = process.cpuUsage();
  return usage.user + usage.system;
}

function memory() {
  const current = Number(
    read("/sys/fs/cgroup/memory.current") ||
      read("/sys/fs/cgroup/memory/memory.usage_in_bytes") ||
      process.memoryUsage().rss,
  );
  const rawLimit =
    read("/sys/fs/cgroup/memory.max") ||
    read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const parsedLimit = Number(rawLimit);
  const limit =
    rawLimit && rawLimit !== "max" && Number.isFinite(parsedLimit)
      ? Math.min(parsedLimit, os.totalmem())
      : os.totalmem();
  return { current, limit };
}

function network() {
  const contents = read("/proc/net/dev");
  if (!contents) return { receivedBytes: 0, sentBytes: 0 };
  return contents
    .split("\n")
    .slice(2)
    .reduce(
      (total, line) => {
        const [name, values] = line.trim().split(":");
        if (!values || name === "lo") return total;
        const fields = values.trim().split(/\s+/).map(Number);
        total.receivedBytes += fields[0] || 0;
        total.sentBytes += fields[8] || 0;
        return total;
      },
      { receivedBytes: 0, sentBytes: 0 },
    );
}

export function calculateInfrastructureSample(previous, current) {
  if (!previous) return { ...current, cpuPercent: 0 };
  const elapsedUsec = Math.max(1, (current.atMs - previous.atMs) * 1000);
  return {
    ...current,
    cpuPercent: Math.max(
      0,
      ((current.cpuUsageUsec - previous.cpuUsageUsec) / elapsedUsec) * 100,
    ),
  };
}

export class InfrastructureMetricCollector {
  constructor(
    reader = () => ({
      atMs: Date.now(),
      cpuUsageUsec: cpuUsageUsec(),
      ...memory(),
      ...network(),
    }),
  ) {
    this.reader = reader;
    this.previous = null;
    this.first = null;
    this.last = null;
    this.samples = 0;
    this.cpuTotal = 0;
    this.peakCpuPercent = 0;
    this.peakMemoryBytes = 0;
    this.peakMemoryPercent = 0;
  }

  sample() {
    const raw = this.reader();
    const point = calculateInfrastructureSample(this.previous, raw);
    if (!this.first) this.first = raw;
    this.previous = raw;
    this.last = raw;
    if (this.samples || point.cpuPercent > 0) {
      this.samples += 1;
      this.cpuTotal += point.cpuPercent;
      this.peakCpuPercent = Math.max(this.peakCpuPercent, point.cpuPercent);
    }
    const memoryPercent = raw.limit ? (raw.current / raw.limit) * 100 : 0;
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, raw.current);
    this.peakMemoryPercent = Math.max(this.peakMemoryPercent, memoryPercent);
    return point;
  }

  summary() {
    return {
      scope: "load-generator-container",
      averageCpuPercent: this.samples ? this.cpuTotal / this.samples : null,
      peakCpuPercent: this.samples ? this.peakCpuPercent : null,
      peakMemoryBytes: this.peakMemoryBytes || null,
      peakMemoryPercent: this.peakMemoryPercent || null,
      memoryLimitBytes: this.last?.limit || null,
      networkReceivedBytes:
        this.first && this.last
          ? Math.max(0, this.last.receivedBytes - this.first.receivedBytes)
          : null,
      networkSentBytes:
        this.first && this.last
          ? Math.max(0, this.last.sentBytes - this.first.sentBytes)
          : null,
      sampleCount: this.samples,
    };
  }
}
