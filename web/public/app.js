const $ = (s) => document.querySelector(s),
  csrf = $("#csrf").value;
let testId;
const socket = io();
const numNames = [
  "targetRps",
  "startingRps",
  "rampUpSeconds",
  "steadySeconds",
  "rampDownSeconds",
  "requestTimeoutMs",
  "maxVus",
  "expectedStatus",
  "thinkTimeMs",
  "instances",
  "confirmRps",
];
const canvas = $("#chart"),
  ctx = canvas.getContext("2d"),
  series = [];
const presets = {
  smoke: {
    best: "First check after deployment or configuration changes.",
    shape: "Very small, short constant load.",
    note: "Start here. Intended for about 10 RPS, not capacity measurement.",
  },
  baseline: {
    best: "Establishing normal latency and resource usage.",
    shape: "Gradual rise from a small rate to the target.",
    note: "Use after Smoke passes; this is usually the next choice.",
  },
  load: {
    best: "Validating an expected production traffic level.",
    shape: "Controlled ramp, steady target, then recovery.",
    note: "Use when you already know a safe baseline.",
  },
  stress: {
    best: "Finding where performance begins to degrade.",
    shape: "Several increasing stages up to the limit.",
    note: "Higher risk; monitor every dependency and stop early.",
  },
  spike: {
    best: "Testing recovery from a brief traffic surge.",
    shape: "Fast controlled increase followed by a lower recovery rate.",
    note: "Use only after the target rate passed a normal Load test.",
  },
  soak: {
    best: "Finding slow leaks or degradation over time.",
    shape: "Long steady load at a previously proven safe rate.",
    note: "Keep the rate conservative; duration matters more than peak RPS.",
  },
  "reverse-proxy": {
    best: "Measuring proxy, TLS, CDN, or network overhead.",
    shape: "Calls a static health endpoint without database work.",
    note: "Best for separating edge/proxy capacity from application capacity.",
  },
  api: {
    best: "Measuring application/API processing without database work.",
    shape: "Calls a lightweight API endpoint with no database access.",
    note: "Use to isolate API-server capacity from storage dependencies.",
  },
  "database-api": {
    best: "Testing a realistic endpoint that reads or writes data.",
    shape: "Controlled load through the API and database path.",
    note: "Use unique bounded data and watch connections, locks, and query latency.",
  },
};
function rampFor(rps) {
  if (rps <= 100) return 30;
  if (rps <= 1000) return 60;
  if (rps <= 10000) return 180;
  return 600;
}
function calculatedConfig(preset, rps) {
  const ramp = rampFor(rps),
    start = (f) => Math.max(1, Math.min(rps, Math.ceil(rps * f)));
  const common = {
    startingRps: start(0.1),
    rampUpSeconds: ramp,
    steadySeconds: 120,
    rampDownSeconds: Math.max(30, Math.ceil(ramp / 2)),
  };
  const values =
    {
      smoke: {
        startingRps: Math.min(rps, 10),
        rampUpSeconds: 0,
        steadySeconds: 30,
        rampDownSeconds: 0,
      },
      baseline: {
        startingRps: Math.min(rps, 10),
        rampUpSeconds: ramp,
        steadySeconds: 60,
        rampDownSeconds: 30,
      },
      load: common,
      stress: {
        startingRps: start(0.05),
        rampUpSeconds: ramp,
        steadySeconds: 30,
        rampDownSeconds: 60,
      },
      spike: {
        startingRps: start(0.1),
        rampUpSeconds: 10,
        steadySeconds: 30,
        rampDownSeconds: 30,
      },
      soak: {
        startingRps: start(0.25),
        rampUpSeconds: ramp,
        steadySeconds: 900,
        rampDownSeconds: 60,
      },
      "reverse-proxy": {
        startingRps: start(0.1),
        rampUpSeconds: 30,
        steadySeconds: 60,
        rampDownSeconds: 30,
      },
      api: {
        startingRps: start(0.1),
        rampUpSeconds: 60,
        steadySeconds: 120,
        rampDownSeconds: 30,
      },
      "database-api": {
        startingRps: start(0.05),
        rampUpSeconds: 120,
        steadySeconds: 120,
        rampDownSeconds: 60,
      },
    }[preset] || common;
  return {
    ...values,
    maxVus: Math.min(1000000, Math.max(100, Math.ceil(rps * 1.5))),
  };
}
function updatePresetHelp() {
  const preset = $("[name=preset]").value,
    info = presets[preset];
  $("#preset-help").innerHTML =
    `<strong>${preset.replaceAll("-", " ").toUpperCase()}</strong><span>Best for:</span> ${info.best}<br><span>Shape:</span> ${info.shape}<br>${info.note}`;
}
function applyAutoConfig() {
  const enabled = $("#auto-config").checked,
    rps = Number($("[name=targetRps]").value),
    preset = $("[name=preset]").value;
  $("#high-load-confirmation").hidden = !(rps > 10000);
  document
    .querySelectorAll(".calculated-fields input")
    .forEach((x) => x.classList.toggle("auto-value", enabled));
  if (!enabled || !Number.isFinite(rps) || rps < 1) return;
  const values = calculatedConfig(preset, rps);
  for (const [name, value] of Object.entries(values))
    $(`[name=${name}]`).value = value;
  const smokeWarning =
    preset === "smoke" && rps > 10
      ? " Smoke is normally limited to 10 RPS; choose Baseline or Load for a larger target."
      : "";
  $("#calculation-note").textContent =
    `Estimated starting values only. Max VUs assumes up to about 1 second response time and must be checked against benchmark latency.${smokeWarning}`;
}
function drawChart() {
  const ratio = window.devicePixelRatio || 1,
    width = canvas.clientWidth || 800,
    height = canvas.clientHeight || 340;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#1c252a";
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = (i * height) / 5;
    ctx.beginPath();
    ctx.moveTo(42, y);
    ctx.lineTo(width - 10, y);
    ctx.stroke();
  }
  if (!series.length) {
    ctx.fillStyle = "#3d484d";
    ctx.fillText(
      "Start a safe test to see live throughput",
      Math.max(50, width / 2 - 130),
      height / 2,
    );
    return;
  }
  const maxRps = Math.max(
    1,
    ...series.map((x) => x.rps),
    ...series.map((x) => x.target),
  );
  const maxLatency = Math.max(1, ...series.map((x) => x.p95));
  const plot = (key, max, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((p, i) => {
      const x =
          42 + i * Math.max(1, (width - 55) / Math.max(series.length - 1, 1)),
        y = height - 24 - (p[key] / max) * (height - 40);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  plot("rps", maxRps, "#00d47b");
  plot("p95", maxLatency, "#f5a524");
}
new ResizeObserver(drawChart).observe(canvas);
function body() {
  const f = new FormData($("#test-form")),
    o = Object.fromEntries(f);
  for (const n of numNames)
    if (o[n] !== "") o[n] = Number(o[n]);
    else delete o[n];
  o.confirmDomain = o.confirmDomain?.trim().toLowerCase() || undefined;
  o.query = JSON.parse(o.query || "{}");
  o.headers = JSON.parse(o.headers || "{}");
  o.body = o.body ? JSON.parse(o.body) : undefined;
  o.auth = {
    type: o.authType,
    username: o.authUsername || undefined,
    secretEnv: o.secretEnv || undefined,
    headerName: o.headerName || undefined,
  };
  delete o.authType;
  delete o.authUsername;
  delete o.secretEnv;
  delete o.headerName;
  o.stopThresholds = {
    maxErrorRate: Number(o.maxErrorRate),
    maxP95Ms: Number(o.maxP95Ms),
    maxBadStatusRate: Number(o.maxBadStatusRate),
  };
  delete o.maxErrorRate;
  delete o.maxP95Ms;
  delete o.maxBadStatusRate;
  return o;
}
async function request(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "CSRF-Token": csrf,
      ...options.headers,
    },
  });
  const data = r.status === 204 ? {} : await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
$("#test-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const t = await request("/api/tests", {
      method: "POST",
      body: JSON.stringify(body()),
    });
    testId = t.id;
    $("#start").disabled = false;
    $("#message").textContent =
      `Saved test #${testId}. Review it, then press Start.`;
    loadHistory();
  } catch (e) {
    $("#message").textContent = e.message;
  }
});
$("#start").onclick = async () => {
  try {
    socket.emit("test:subscribe", testId);
    await request(`/api/tests/${testId}/start`, { method: "POST", body: "{}" });
    series.length = 0;
    drawChart();
    $("#stop").disabled = $("#emergency").disabled = false;
    $("#target-rps").textContent = body().targetRps;
  } catch (e) {
    $("#message").textContent = e.message;
  }
};
async function stop(emergency) {
  if (!testId) return;
  await request(`/api/tests/${testId}/stop`, {
    method: "POST",
    body: JSON.stringify({ emergency }),
  });
}
$("#stop").onclick = () => stop(false);
$("#emergency").onclick = () =>
  confirm("Immediately terminate this test?") && stop(true);
socket.on("connect", () => {
  $("#connection").textContent = "Live";
  $("#connection").classList.add("connected");
});
socket.on("disconnect", () => {
  $("#connection").textContent = "Offline";
  $("#connection").classList.remove("connected");
});
socket.on("test:metrics", (m) => {
  $("#current-rps").textContent = m.currentRps.toFixed(1);
  $("#target-rps").textContent = m.targetRps;
  $("#p50").textContent = m.p50.toFixed(0);
  $("#p99").textContent = m.p99.toFixed(0);
  $("#error-rate").textContent = `${(m.errorRate * 100).toFixed(2)}%`;
  $("#failures").textContent = m.cumulative?.failed ?? m.failedRequests;
  $("#vus").textContent = m.activeVus;
  $("#dropped").textContent = m.cumulative?.dropped ?? m.droppedIterations;
  $("#successful").textContent =
    m.cumulative?.successful ?? m.successfulRequests;
  $("#elapsed").textContent = `${Math.floor(m.elapsedSeconds)}s`;
  series.push({ rps: m.currentRps, target: m.targetRps, p95: m.p95 });
  if (series.length > 60) series.shift();
  const entries = Object.entries(m.statuses || {});
  $("#status-bars").innerHTML = entries.length
    ? entries
        .map(
          ([status, count]) =>
            `<div class="status-bar ${Number(status) >= 400 ? "bad" : ""}"><span>HTTP ${status}</span><b>${count}</b></div>`,
        )
        .join("")
    : "<p>No response data in this window</p>";
  drawChart();
});
socket.on("test:status", (s) => {
  const running = s.status === "running";
  $("#run-state").textContent = s.status;
  $("#run-state").classList.toggle("running", running);
  if (!running) {
    $("#stop").disabled = $("#emergency").disabled = true;
  }
  loadHistory();
});
$("[name=preset]").addEventListener("change", () => {
  updatePresetHelp();
  applyAutoConfig();
});
$("[name=targetRps]").addEventListener("input", applyAutoConfig);
$("#auto-config").addEventListener("change", applyAutoConfig);
$("#preset-guide").innerHTML = Object.entries(presets)
  .map(
    ([name, p]) =>
      `<div class="guide-card"><b>${name.replaceAll("-", " ")}</b><br>${p.best}<br><span>${p.note}</span></div>`,
  )
  .join("");
$("#preset-guide-button").addEventListener("click", () => {
  const guide = $("#preset-guide"),
    showing = !guide.hidden;
  guide.hidden = showing;
  $("#preset-guide-button").textContent = showing
    ? "View all preset guidance"
    : "Hide preset guidance";
});
updatePresetHelp();
applyAutoConfig();
document.querySelectorAll("[data-panel]").forEach((button) =>
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-panel]")
      .forEach((x) => x.classList.toggle("active", x === button));
    document
      .querySelectorAll(".panel")
      .forEach((x) =>
        x.classList.toggle("active", x.id === button.dataset.panel),
      );
    if (button.dataset.panel === "metrics-panel") drawChart();
  }),
);
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const formatNumber = (value) =>
  value == null
    ? "—"
    : Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const formatBytes = (value) => {
  if (value == null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = Number(value),
    unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[unit]}`;
};
function outcomeReason(status, c, r) {
  if (status === "completed") {
    const notes = ["k6 finished normally with exit code 0."];
    if (r.droppedIterations > 0)
      notes.push(
        `${formatNumber(r.droppedIterations)} iterations were dropped, so the generator did not achieve every scheduled request.`,
      );
    if (
      r.steadyStageRps != null &&
      c.targetRps &&
      r.steadyStageRps < c.targetRps * 0.9
    )
      notes.push(
        "Steady-stage RPS was below 90% of Target RPS; check VUs, generator CPU/network, and target latency.",
      );
    else if (r.steadyStageRps != null)
      notes.push(
        "Steady-stage RPS was recorded successfully; compare it with Target RPS and your latency objective.",
      );
    else if (r.achievedRps != null)
      notes.push(
        "Only whole-test average RPS is available. It includes ramp-up and ramp-down and must not be compared directly with Target RPS.",
      );
    return notes.join(" ");
  }
  if (status === "failed") {
    const storedThresholds = r.thresholdFailures || [],
      errorThreshold = r.error?.match(
        /thresholds on metrics ['"]([^'"]+)['"] have been crossed/i,
      )?.[1],
      thresholds = storedThresholds.length
        ? storedThresholds
        : errorThreshold
          ? [errorThreshold]
          : [];
    if (thresholds.length)
      return `Request execution finished, but k6 marked the run failed because these strict thresholds were crossed: ${thresholds.join(", ")}. This is different from the test process crashing. Review the threshold, achieved load, response statuses, generator utilization, and the exact count when available.`;
  }
  if (status === "failed")
    return r.error
      ? `k6 failed: ${r.error}`
      : `k6 exited with code ${r.exitCode ?? "unknown"}. Common causes are a failed threshold/check, connection or timeout error, invalid script/configuration, or unavailable target.`;
  if (status === "stopped")
    return "An administrator pressed Stop or Emergency Stop before the planned stages finished.";
  if (status === "interrupted")
    return (
      r.error ||
      "The application/container restarted while this record was active, so the previous process could no longer be supervised."
    );
  if (status === "draft")
    return "The configuration was saved but has not been started.";
  if (status === "running")
    return "The k6 process is currently active. Use live metrics and automatic stop thresholds to monitor it.";
  if (status === "stopping")
    return "A stop signal was sent and the application is waiting for k6 to exit.";
  return "No additional explanation is available.";
}
function bottleneckEstimate(c, r) {
  const clues = [];
  const expectedResponses = Number(
      r.httpStatusCounts?.[String(c.expectedStatus)] || 0,
    ),
    responseTotal = Object.values(r.httpStatusCounts || {}).reduce(
      (sum, value) => sum + Number(value || 0),
      0,
    ),
    targetRatio = c.targetRps ? r.steadyStageRps / c.targetRps : 0;
  if (
    responseTotal > 0 &&
    expectedResponses / responseTotal >= 0.99 &&
    targetRatio >= 0.95 &&
    r.generatorMetrics?.peakCpuPercent >= 90
  )
    clues.push(
      `Primary estimate: load-generator constrained. ${((expectedResponses / responseTotal) * 100).toFixed(2)}% of recorded HTTP responses matched the expected status and steady-stage throughput reached ${(targetRatio * 100).toFixed(2)}% of target, while generator CPU peaked at ${formatNumber(r.generatorMetrics.peakCpuPercent)}%. The target handled the requests it received; remote server headroom is still unknown without VM metrics.`,
    );
  if (r.generatorMetrics?.peakCpuPercent >= 90)
    clues.push(
      `Load-generator container CPU peaked at ${formatNumber(r.generatorMetrics.peakCpuPercent)}%; generator saturation may have limited achieved RPS.`,
    );
  if (r.generatorMetrics?.peakMemoryPercent >= 90)
    clues.push(
      `Load-generator container memory peaked at ${formatNumber(r.generatorMetrics.peakMemoryPercent)}% of its limit; memory pressure may have affected the run.`,
    );
  if (r.droppedIterations > 0)
    clues.push(
      "Dropped iterations indicate the load generator could not schedule all planned requests. This may be insufficient Max VUs or generator CPU/network capacity; slow target responses can contribute by keeping VUs busy.",
    );
  const peakVus = r.peakActiveVusObserved ?? r.maxActiveVus;
  if (peakVus && c.maxVus && peakVus >= c.maxVus * 0.95)
    clues.push(
      "Active VUs reached the configured Max VUs, so the VU ceiling is a likely contributor.",
    );
  if (
    r.steadyStageRps != null &&
    c.targetRps &&
    r.steadyStageRps < c.targetRps * 0.9
  )
    clues.push(
      "Steady-stage RPS was below 90% of requested RPS, so this run did not demonstrate the requested rate.",
    );
  if (r.errorRate > c.stopThresholds?.maxErrorRate)
    clues.push(
      "Error rate exceeded the configured stop threshold; inspect HTTP statuses and the raw result note.",
    );
  if (r.p95 > c.stopThresholds?.maxP95Ms)
    clues.push(
      "p95 exceeded the configured latency threshold, which suggests target or downstream slowdown, though generator saturation must still be ruled out.",
    );
  return clues.length
    ? `Estimate: ${clues.join(" ")}`
    : "Estimate: no clear bottleneck indicator was recorded. Compare achieved RPS, latency, status codes, and external infrastructure metrics before concluding.";
}
function statusSummary(counts) {
  const entries = Object.entries(counts || {});
  return entries.length
    ? entries
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(
          ([status, count]) =>
            `HTTP ${escapeHtml(status)}: ${formatNumber(count)}`,
        )
        .join(" · ")
    : "Not recorded for older tests. New tests collect status counts.";
}
async function historyStop(id, emergency) {
  try {
    if (emergency && !confirm(`Emergency stop test #${id}?`)) return;
    await request(`/api/tests/${id}/stop`, {
      method: "POST",
      body: JSON.stringify({ emergency }),
    });
    await loadHistory();
  } catch (e) {
    $("#message").textContent = e.message;
    await loadHistory();
  }
}
async function toggleDetails(id, button) {
  const existing = $(`#history-detail-${id}`);
  if (existing) {
    existing.remove();
    button.textContent = "Details";
    return;
  }
  try {
    const data = await request(`/api/tests/${id}/results`),
      c = data.config || {},
      r = data.result || {},
      row = button.closest("tr"),
      detail = document.createElement("tr");
    detail.id = `history-detail-${id}`;
    detail.className = "history-detail";
    detail.innerHTML = `<td colspan="8"><div class="outcome-reason"><span>Why this result?</span><b>${escapeHtml(outcomeReason(data.status, c, r))}</b></div><div class="bottleneck-estimate"><span>Likely bottleneck indicators</span><b>${escapeHtml(bottleneckEstimate(c, r))}</b></div><div class="detail-grid"><div><span>Request</span><b>${escapeHtml(c.method)} https://${escapeHtml(c.hostname)}${escapeHtml(c.endpoint)}</b><small>Expected HTTP ${formatNumber(c.expectedStatus)}</small></div><div><span>Requested load</span><b>${formatNumber(c.startingRps)} → ${formatNumber(c.targetRps)} RPS</b><small>${formatNumber(c.rampUpSeconds)}s up · ${formatNumber(c.steadySeconds)}s steady · ${formatNumber(c.rampDownSeconds)}s down</small></div><div><span>Generator/VUs</span><b>Configured Max VUs: ${formatNumber(c.maxVus)}</b><small>Peak active VUs: ${formatNumber(r.maxActiveVus)} · instances: ${formatNumber(c.instances)}</small></div><div><span>Timing</span><b>${data.startedAt ? new Date(data.startedAt).toLocaleString() : "Not started"}</b><small>Finished: ${data.finishedAt ? new Date(data.finishedAt).toLocaleString() : "—"}</small></div><div><span>Throughput</span><b>${formatNumber(r.achievedRps)} achieved / ${formatNumber(c.targetRps)} requested RPS</b><small>Total ${formatNumber(r.totalRequests)} · successful ${formatNumber(r.successfulRequests)}</small></div><div><span>Failures</span><b>${formatNumber(r.httpFailures)} HTTP/check failures</b><small>Error rate: ${r.errorRate == null ? "—" : `${(r.errorRate * 100).toFixed(2)}%`} · exit code ${formatNumber(r.exitCode)}</small></div><div><span>Dropped iterations</span><b>${formatNumber(r.droppedIterations)}</b><small>Above zero means k6 could not start every scheduled iteration.</small></div><div><span>Latency</span><b>p95 ${formatNumber(r.p95)} ms</b><small>min ${formatNumber(r.min)} · p50 ${formatNumber(r.p50)} · p90 ${formatNumber(r.p90)} · p99 ${formatNumber(r.p99)} · max ${formatNumber(r.max)} ms</small></div><div><span>Transfer</span><b>↓ ${formatNumber(r.receivedBytes)} bytes</b><small>↑ ${formatNumber(r.sentBytes)} bytes</small></div><div class="wide-detail"><span>HTTP status distribution</span><b>${statusSummary(r.httpStatusCounts)}</b></div><div class="wide-detail missing-metrics"><span>Infrastructure metrics</span><b>Generator CPU/RAM: not collected · Server CPU/RAM: not collected · Network utilization: not collected</b><small>Import or observe these externally before deciding whether the generator, network, proxy, API, or database was the bottleneck.</small></div>${r.error ? `<div class="detail-error"><span>Raw result note</span><b>${escapeHtml(r.error)}</b></div>` : ""}</div></td>`;
    const peakVus = r.peakActiveVusObserved ?? r.maxActiveVus;
    const steadyRps =
      r.steadyStageRps == null
        ? "Not recorded"
        : formatNumber(r.steadyStageRps);
    const measurementNote = r.resultSchemaVersion
      ? "Steady-stage RPS uses live samples during the configured steady stage. Average RPS covers the complete run, including ramps."
      : "Older record: steady-stage RPS, observed peak VUs, and status distribution may not have been collected and cannot be reconstructed reliably.";
    const gm = r.generatorMetrics;
    const responseTotal = Object.values(r.httpStatusCounts || {}).reduce(
        (sum, value) => sum + Number(value || 0),
        0,
      ),
      expectedResponseTotal = Number(
        r.httpStatusCounts?.[String(c.expectedStatus)] || 0,
      ),
      safeTotal = r.totalRequests || responseTotal || null,
      safeSuccessful = r.successfulRequests || expectedResponseTotal || null,
      elapsedSeconds =
        data.startedAt && data.finishedAt
          ? Math.max(
              0.001,
              (new Date(data.finishedAt) - new Date(data.startedAt)) / 1000,
            )
          : null,
      safeAverageRps =
        r.achievedRps ||
        (safeTotal && elapsedSeconds ? safeTotal / elapsedSeconds : null),
      safeReceivedBytes = r.receivedBytes || gm?.networkReceivedBytes || null,
      safeSentBytes = r.sentBytes || gm?.networkSentBytes || null,
      droppedUnavailable =
        r.droppedIterationsCountUnavailable ||
        (!r.droppedIterations &&
          /thresholds on metrics ['"]dropped_iterations['"] have been crossed/i.test(
            r.error || "",
          ));
    const generatorMetrics = gm
      ? `CPU avg ${formatNumber(gm.averageCpuPercent)}% · peak ${formatNumber(gm.peakCpuPercent)}% · Memory peak ${formatBytes(gm.peakMemoryBytes)} / ${formatBytes(gm.memoryLimitBytes)} (${formatNumber(gm.peakMemoryPercent)}%)`
      : "Not collected for this test";
    const generatorNetwork = gm
      ? `Per-test container network: received ${formatBytes(gm.networkReceivedBytes)} · sent ${formatBytes(gm.networkSentBytes)} · ${formatNumber(gm.sampleCount)} samples`
      : "Run a new test with the updated application to collect generator metrics.";
    detail.innerHTML = `<td colspan="8">
      <div class="outcome-reason"><span>Why this result?</span><b>${escapeHtml(outcomeReason(data.status, c, r))}</b></div>
      <div class="bottleneck-estimate"><span>Likely bottleneck indicators</span><b>${escapeHtml(bottleneckEstimate(c, r))}</b></div>
      <div class="outcome-reason"><span>How to read this record</span><b>${escapeHtml(measurementNote)}</b></div>
      <div class="detail-grid">
        <div><span>Request</span><b>${escapeHtml(c.method)} https://${escapeHtml(c.hostname)}${escapeHtml(c.endpoint)}</b><small>Expected HTTP ${formatNumber(c.expectedStatus)}</small></div>
        <div><span>Requested load</span><b>${formatNumber(c.startingRps)} → ${formatNumber(c.targetRps)} RPS</b><small>${formatNumber(c.rampUpSeconds)}s up · ${formatNumber(c.steadySeconds)}s steady · ${formatNumber(c.rampDownSeconds)}s down</small></div>
        <div><span>Generator/VUs</span><b>Configured Max VUs: ${formatNumber(c.maxVus)}</b><small>Observed peak active VUs: ${formatNumber(peakVus)} · instances: ${formatNumber(c.instances)}</small></div>
        <div><span>Timing</span><b>${data.startedAt ? new Date(data.startedAt).toLocaleString() : "Not started"}</b><small>Finished: ${data.finishedAt ? new Date(data.finishedAt).toLocaleString() : "—"}</small></div>
        <div><span>Steady-stage throughput</span><b>${steadyRps} RPS</b><small>Target: ${formatNumber(c.targetRps)} RPS · observed for ${formatNumber(r.steadyObservedSeconds)} seconds</small></div>
        <div><span>Whole-test average</span><b>${formatNumber(safeAverageRps)} RPS</b><small>${r.achievedRps ? "From k6 summary." : safeAverageRps ? "Reconstructed from recorded HTTP responses and test timestamps." : "Unavailable."} Includes ramp-up and ramp-down.</small></div>
        <div><span>Request totals</span><b>${formatNumber(safeTotal)} total · ${formatNumber(safeSuccessful)} expected-status responses</b><small>${r.httpFailures ? `${formatNumber(r.httpFailures)} HTTP/check failures` : responseTotal ? "Reconstructed from HTTP status distribution." : "Unavailable."}</small></div>
        <div><span>Dropped iterations</span><b>${droppedUnavailable ? "Threshold crossed; exact count unavailable" : formatNumber(r.droppedIterations)}</b><small>${droppedUnavailable ? "k6 reported at least one dropped iteration, but its saved summary did not provide a usable count." : "Above zero means k6 could not start every scheduled iteration."}</small></div>
        <div><span>Latency</span><b>p95 ${formatNumber(r.p95)} ms</b><small>min ${formatNumber(r.min)} · p50 ${formatNumber(r.p50)} · p90 ${formatNumber(r.p90)} · p99 ${formatNumber(r.p99)} · max ${formatNumber(r.max)} ms</small></div>
        <div><span>Transfer</span><b>↓ ${formatBytes(safeReceivedBytes)}</b><small>↑ ${formatBytes(safeSentBytes)} · ${r.receivedBytes ? "k6 measurement" : gm ? "container network fallback" : "unavailable"} · exit code ${formatNumber(r.exitCode)}</small></div>
        <div class="wide-detail"><span>HTTP status distribution</span><b>${statusSummary(r.httpStatusCounts)}</b></div>
        <div class="wide-detail"><span>Load-generator container metrics</span><b>${escapeHtml(generatorMetrics)}</b><small>${escapeHtml(generatorNetwork)}</small></div>
        <div class="wide-detail missing-metrics"><span>Remote target infrastructure</span><b>API VM, reverse proxy, database, Redis, and physical network: not collected</b><small>The local load-generator container cannot measure the remote Proxmox VM. A configured metrics integration is required before attributing a server-side bottleneck.</small></div>
        ${r.error ? `<div class="detail-error"><span>Raw result note</span><b>${escapeHtml(r.error)}</b></div>` : ""}
      </div>
    </td>`;
    row.after(detail);
    button.textContent = "Hide";
  } catch (e) {
    $("#message").textContent = e.message;
  }
}
$("#history-body").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-history-action]");
  if (!button) return;
  const id = Number(button.dataset.id),
    action = button.dataset.historyAction;
  if (action === "details") toggleDetails(id, button);
  if (action === "stop") historyStop(id, false);
  if (action === "emergency") historyStop(id, true);
});
async function loadHistory() {
  try {
    const rows = await request("/api/tests");
    for (const x of rows)
      if (["running", "stopping"].includes(x.status))
        socket.emit("test:subscribe", x.id);
    $("#history-body").innerHTML = rows.length
      ? rows
          .map((x) => {
            const active = ["running", "stopping"].includes(x.status);
            return `<tr><td><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.method)} ${escapeHtml(x.target)}${escapeHtml(x.endpoint)}</small></td><td>${escapeHtml(x.preset)}</td><td><span class="status status-${escapeHtml(x.status)}">${escapeHtml(x.status)}</span></td><td>${formatNumber(x.targetRps)} RPS</td><td>${formatNumber(x.achievedRps)} RPS</td><td>${formatNumber(x.p95)} ms</td><td>${x.started_at ? new Date(x.started_at).toLocaleString() : "—"}</td><td class="history-actions"><button data-history-action="details" data-id="${x.id}">Details</button>${active ? `<button data-history-action="stop" data-id="${x.id}">Stop</button><button class="danger" data-history-action="emergency" data-id="${x.id}">Emergency</button>` : ""}</td></tr>`;
          })
          .join("")
      : '<tr><td colspan="8">No tests saved yet</td></tr>';
  } catch {
    /* login redirect handles auth */
  }
}
loadHistory();
drawChart();

async function refreshTargetVerification() {
  try {
    const data = await request("/api/targets");
    const verified = new Set(data.verified || []);
    document.querySelectorAll("#target-list li[data-domain]").forEach((li) => {
      const state = li.querySelector(".verify-state");
      const isVerified = verified.has(li.dataset.domain);
      state.textContent = isVerified ? "✓ verified" : "not verified";
      state.className = `verify-state ${isVerified ? "ok" : "pending"}`;
    });
  } catch {
    /* not authenticated yet */
  }
}
$("#verify-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const result = $("#verify-result");
  result.textContent = "Checking…";
  try {
    const data = await request("/api/targets/verify", {
      method: "POST",
      body: JSON.stringify({ url: form.get("url"), token: form.get("token") }),
    });
    result.textContent = `Verified via ${data.method}.`;
    refreshTargetVerification();
  } catch (err) {
    result.textContent = err.message || "Verification failed.";
  }
});
refreshTargetVerification();
