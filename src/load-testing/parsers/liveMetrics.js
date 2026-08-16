export class LiveMetricAggregator {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.lifetime = {
      requests: 0,
      failures: 0,
      droppedIterations: 0,
      receivedBytes: 0,
      sentBytes: 0,
      maxActiveVus: 0,
      latencySamples: [],
      latencyCount: 0,
    };
    this.reset();
  }
  reset() {
    this.windowStarted = this.now();
    this.requests = 0;
    this.failures = 0;
    this.droppedIterations = 0;
    this.latencies = [];
    this.activeVus = 0;
    this.statuses = {};
  }
  add(point) {
    if (point?.type !== "Point") return;
    const value = Number(point.data?.value) || 0;
    if (point.metric === "http_reqs") {
      this.requests += value;
      this.lifetime.requests += value;
      const status = point.data?.tags?.status;
      if (status) this.statuses[status] = (this.statuses[status] || 0) + value;
    } else if (point.metric === "http_req_failed") {
      this.failures += value;
      this.lifetime.failures += value;
    } else if (point.metric === "http_req_duration") {
      this.latencies.push(value);
      const samples = this.lifetime.latencySamples;
      if (samples.length < 100000) samples.push(value);
      else samples[this.lifetime.latencyCount % samples.length] = value;
      this.lifetime.latencyCount += 1;
    } else if (point.metric === "vus") {
      this.activeVus = value;
      this.lifetime.maxActiveVus = Math.max(this.lifetime.maxActiveVus, value);
    } else if (point.metric === "dropped_iterations") {
      this.droppedIterations += value;
      this.lifetime.droppedIterations += value;
    } else if (point.metric === "data_received")
      this.lifetime.receivedBytes += value;
    else if (point.metric === "data_sent") this.lifetime.sentBytes += value;
  }
  snapshot(targetRps, elapsedSeconds) {
    const seconds = Math.max((this.now() - this.windowStarted) / 1000, 0.001);
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const percentile = (p) =>
      sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
        : 0;
    const result = {
      timestamp: new Date(this.now()).toISOString(),
      currentRps: this.requests / seconds,
      targetRps,
      successfulRequests: Math.max(0, this.requests - this.failures),
      failedRequests: this.failures,
      errorRate: this.requests ? this.failures / this.requests : 0,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      activeVus: this.activeVus,
      droppedIterations: this.droppedIterations,
      elapsedSeconds,
      statuses: { ...this.statuses },
    };
    this.reset();
    return result;
  }

  lifetimeSummary(elapsedSeconds) {
    const sorted = [...this.lifetime.latencySamples].sort((a, b) => a - b);
    const percentile = (p) =>
      sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
        : undefined;
    const total = this.lifetime.requests,
      failures = this.lifetime.failures;
    return {
      totalRequests: total,
      successfulRequests: Math.max(0, total - failures),
      achievedRps: elapsedSeconds ? total / elapsedSeconds : undefined,
      errorRate: total ? failures / total : 0,
      httpFailures: failures,
      p50: percentile(0.5),
      p90: percentile(0.9),
      p95: percentile(0.95),
      p99: percentile(0.99),
      min: sorted[0],
      max: sorted.at(-1),
      maxActiveVus: this.lifetime.maxActiveVus,
      droppedIterations: this.lifetime.droppedIterations,
      receivedBytes: this.lifetime.receivedBytes,
      sentBytes: this.lifetime.sentBytes,
      fallbackLatencySampleCount: sorted.length,
    };
  }
}
