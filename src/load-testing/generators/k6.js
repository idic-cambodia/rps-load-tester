import { authHeaders, resolveHeaderSecrets } from "../../utils/secrets.js";
function stages(t) {
  if (t.preset === "spike")
    return [
      { target: t.startingRps, duration: "5s" },
      { target: t.targetRps, duration: `${t.rampUpSeconds}s` },
      { target: t.startingRps, duration: `${t.steadySeconds}s` },
      { target: 0, duration: `${t.rampDownSeconds}s` },
    ];
  if (t.preset === "stress")
    return [0.25, 0.5, 0.75, 1]
      .map((x, i) => ({
        target: Math.max(1, Math.round(t.targetRps * x)),
        duration: `${i ? t.steadySeconds : t.rampUpSeconds}s`,
      }))
      .concat({ target: 0, duration: `${t.rampDownSeconds}s` });
  return [
    { target: t.startingRps, duration: "1s" },
    { target: t.targetRps, duration: `${t.rampUpSeconds}s` },
    { target: t.targetRps, duration: `${t.steadySeconds}s` },
    { target: 0, duration: `${t.rampDownSeconds}s` },
  ].filter((x) => x.duration !== "0s");
}
export function generateK6(t, env = process.env) {
  const target = new URL(t.endpoint, t.baseUrl);
  for (const [k, v] of Object.entries(t.query || {}))
    target.searchParams.set(k, v);
  const headers = {
    ...resolveHeaderSecrets(t.headers, env),
    ...authHeaders(t.auth, env),
    "Content-Type": "application/json",
  };
  const safe = {
    method: t.method,
    url: target.href,
    body: t.body == null ? null : JSON.stringify(t.body),
    headers,
    timeout: `${t.requestTimeoutMs}ms`,
    expected: t.expectedStatus,
    think: t.thinkTimeMs,
  };
  const options = {
    scenarios: {
      main: {
        executor: "ramping-arrival-rate",
        startRate: t.startingRps,
        timeUnit: "1s",
        preAllocatedVUs: Math.min(t.maxVus, 100),
        maxVUs: t.maxVus,
        stages: stages(t),
      },
    },
    thresholds: {
      http_req_failed: [`rate<${t.stopThresholds.maxErrorRate}`],
      http_req_duration: [`p(95)<${t.stopThresholds.maxP95Ms}`],
      dropped_iterations: ["count==0"],
    },
  };
  return `import http from 'k6/http';\nimport { check, sleep } from 'k6';\nimport exec from 'k6/execution';\nexport const options=${JSON.stringify(options)};\nconst request=${JSON.stringify(safe)};\nexport default function(){ const r=http.request(request.method,request.url,request.body,{headers:request.headers,timeout:request.timeout,redirects:0,tags:{endpoint:request.url}}); check(r,{'expected status':x=>x.status===request.expected}); if(r.status>=300&&r.status<400) exec.test.abort('Redirects are disabled; validate destination separately'); if(request.think) sleep(request.think/1000); }\n`;
}
