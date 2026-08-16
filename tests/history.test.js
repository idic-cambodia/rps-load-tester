import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import {
  createDatabase,
  TestRepository,
} from "../src/repositories/database.js";
import { sample } from "./helpers.js";
const files = [];
afterEach(() => {
  for (const file of files.splice(0))
    for (const suffix of ["", "-wal", "-shm"])
      try {
        fs.unlinkSync(file + suffix);
      } catch {
        /* absent */
      }
});
it("returns detailed history and reconciles stale active records", () => {
  const file = `/tmp/rps-history-${process.pid}-${Date.now()}.sqlite`;
  files.push(file);
  const db = createDatabase(file),
    repo = new TestRepository(db),
    test = repo.create(sample);
  repo.update(test.id, {
    status: "running",
    started_at: new Date().toISOString(),
  });
  expect(repo.list()[0]).toMatchObject({
    target: "idiccambodia.com",
    endpoint: "/healthz",
    targetRps: 10,
    preset: "smoke",
  });
  expect(repo.reconcileInterrupted()).toBe(1);
  expect(repo.get(test.id)).toMatchObject({
    status: "interrupted",
    result: { error: expect.stringContaining("restarted") },
  });
  db.close();
});
