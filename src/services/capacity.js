export function calculateCapacity({
  rps,
  averageResponseTimeSeconds,
  averageResponseBytes,
  cpuCores,
  cpuUtilization,
  successfulRps,
  targetRps,
  targetUtilization = 0.7,
  measuredSafeRpsPerServer,
  headroom = 1.5,
  instances = 1,
}) {
  if (headroom < 1.3 || headroom > 2)
    throw new Error("Headroom must be between 1.3 and 2.0");
  const cpuMs = successfulRps
    ? (cpuCores * cpuUtilization * 1000) / successfulRps
    : 0;
  return {
    concurrency: rps * averageResponseTimeSeconds,
    bandwidthBitsPerSecond: rps * averageResponseBytes * 8,
    cpuMillisecondsPerRequest: cpuMs,
    requiredCpuCores: (targetRps * cpuMs) / 1000 / targetUtilization,
    requiredServerCount: measuredSafeRpsPerServer
      ? Math.ceil((targetRps / measuredSafeRpsPerServer) * headroom) + 1
      : 0,
    requiredLoadGenerators: Math.ceil(targetRps / Math.max(rps, 1)),
    rpsPerGenerator: targetRps / Math.max(instances, 1),
  };
}
