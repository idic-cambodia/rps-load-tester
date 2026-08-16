export function metricValue(m, name, key = "value") {
  return m?.[name]?.values?.[key];
}
export function parseSummary(raw) {
  const m = typeof raw === "string" ? JSON.parse(raw).metrics : raw.metrics,
    total = metricValue(m, "http_reqs", "count"),
    errorRate = metricValue(m, "http_req_failed", "rate"),
    failures =
      total == null || errorRate == null
        ? undefined
        : Math.round(total * errorRate);
  const result = {
    totalRequests: total,
    successfulRequests:
      total == null || failures == null
        ? undefined
        : Math.max(0, total - failures),
    achievedRps: metricValue(m, "http_reqs", "rate"),
    errorRate,
    httpFailures: failures,
    p50: metricValue(m, "http_req_duration", "med"),
    p90: metricValue(m, "http_req_duration", "p(90)"),
    p95: metricValue(m, "http_req_duration", "p(95)"),
    p99: metricValue(m, "http_req_duration", "p(99)"),
    min: metricValue(m, "http_req_duration", "min"),
    max: metricValue(m, "http_req_duration", "max"),
    maxActiveVus: metricValue(m, "vus_max", "max"),
    droppedIterations: metricValue(m, "dropped_iterations", "count"),
    receivedBytes: metricValue(m, "data_received", "count"),
    sentBytes: metricValue(m, "data_sent", "count"),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value != null),
  );
}

export function reconcileResult(primary, fallback = {}) {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback))
    if ((merged[key] == null || merged[key] === 0) && value > 0)
      merged[key] = value;
  return merged;
}
