import { z } from "zod";
export const testSchema = z
  .object({
    name: z.string().min(1).max(100),
    preset: z.enum([
      "smoke",
      "baseline",
      "load",
      "stress",
      "spike",
      "soak",
      "reverse-proxy",
      "api",
      "database-api",
    ]),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    baseUrl: z.string().url(),
    endpoint: z.string().startsWith("/").max(2048),
    query: z.record(z.string(), z.string()).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    auth: z
      .object({
        type: z.enum(["none", "basic", "bearer", "custom"]).default("none"),
        username: z.string().max(200).optional(),
        secret: z.string().max(4096).optional(),
        secretEnv: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .optional(),
        headerName: z.string().optional(),
      })
      .default({ type: "none" }),
    body: z.unknown().optional(),
    targetRps: z.number().int().min(1),
    startingRps: z.number().int().min(1),
    rampUpSeconds: z.number().int().min(0),
    steadySeconds: z.number().int().min(1),
    rampDownSeconds: z.number().int().min(0),
    requestTimeoutMs: z.number().int().min(100).max(120000),
    maxVus: z.number().int().min(1).max(20000),
    expectedStatus: z.number().int().min(100).max(599),
    thinkTimeMs: z.number().int().min(0).max(60000),
    instances: z.number().int().min(1).max(1000),
    stopThresholds: z.object({
      maxErrorRate: z.number().min(0).max(1),
      maxP95Ms: z.number().positive(),
      maxBadStatusRate: z.number().min(0).max(1),
    }),
    confirmDomain: z.string().optional(),
    confirmRps: z.number().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.preset === "smoke" && value.targetRps > 10)
      context.addIssue({
        code: "custom",
        path: ["targetRps"],
        message:
          "Smoke tests are limited to 10 RPS. Choose Load, Stress, or Spike for a larger authorized target.",
      });
  });
export function parseTest(input) {
  const v = testSchema.parse(input);
  return {
    ...v,
    totalDurationSeconds: v.rampUpSeconds + v.steadySeconds + v.rampDownSeconds,
  };
}
