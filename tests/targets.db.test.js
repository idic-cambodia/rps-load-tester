import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import { createDatabase, TargetRepository } from "../src/repositories/database.js";
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
it("persists ownership verification so it actually unlocks a domain later", () => {
  const file = `/tmp/rps-targets-${process.pid}-${Date.now()}.sqlite`;
  files.push(file);
  const db = createDatabase(file),
    repo = new TargetRepository(db);
  expect(repo.isVerified("api.idiccambodia.com")).toBe(false);
  repo.markVerified("api.idiccambodia.com", "dns-txt");
  expect(repo.isVerified("api.idiccambodia.com")).toBe(true);
  expect(repo.list()).toEqual([
    expect.objectContaining({ domain: "api.idiccambodia.com", method: "dns-txt" }),
  ]);
  db.close();
});
it("re-verifying a domain updates the method rather than duplicating the row", () => {
  const file = `/tmp/rps-targets-${process.pid}-${Date.now()}-2.sqlite`;
  files.push(file);
  const db = createDatabase(file),
    repo = new TargetRepository(db);
  repo.markVerified("idiccambodia.com", "dns-txt");
  repo.markVerified("idiccambodia.com", "well-known");
  expect(repo.list()).toHaveLength(1);
  expect(repo.list()[0].method).toBe("well-known");
  db.close();
});
