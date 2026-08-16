import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export function createDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS tests(id INTEGER PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,config TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT);CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,details TEXT,created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS targets(domain TEXT PRIMARY KEY,method TEXT NOT NULL,verified_at TEXT NOT NULL);`,
  );
  return db;
}
export class TargetRepository {
  constructor(db) {
    this.db = db;
  }
  markVerified(domain, method) {
    this.db
      .prepare(
        "INSERT INTO targets(domain,method,verified_at) VALUES(?,?,?) ON CONFLICT(domain) DO UPDATE SET method=excluded.method,verified_at=excluded.verified_at",
      )
      .run(domain, method, new Date().toISOString());
  }
  isVerified(domain) {
    return Boolean(this.db.prepare("SELECT 1 FROM targets WHERE domain=?").get(domain));
  }
  list() {
    return this.db.prepare("SELECT domain,method,verified_at FROM targets ORDER BY domain").all();
  }
}
export class TestRepository {
  constructor(db) {
    this.db = db;
  }
  create(config) {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        "INSERT INTO tests(name,status,config,created_at) VALUES(?,?,?,?)",
      )
      .run(config.name, "draft", JSON.stringify(config), now);
    return this.get(r.lastInsertRowid);
  }
  get(id) {
    const r = this.db.prepare("SELECT * FROM tests WHERE id=?").get(id);
    return r
      ? {
          ...r,
          config: JSON.parse(r.config),
          result: r.result ? JSON.parse(r.result) : null,
        }
      : null;
  }
  list() {
    return this.db
      .prepare("SELECT * FROM tests ORDER BY id DESC")
      .all()
      .map((r) => {
        const c = JSON.parse(r.config),
          result = r.result ? JSON.parse(r.result) : null;
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          created_at: r.created_at,
          started_at: r.started_at,
          finished_at: r.finished_at,
          preset: c.preset,
          method: c.method,
          target: c.hostname || new URL(c.baseUrl).hostname,
          endpoint: c.endpoint,
          targetRps: c.targetRps,
          achievedRps: result?.achievedRps ?? null,
          totalRequests: result?.totalRequests ?? null,
          p95: result?.p95 ?? null,
          error: result?.error ?? null,
        };
      });
  }
  update(id, fields) {
    const allowed = ["status", "result", "started_at", "finished_at"];
    const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
    if (entries.length)
      this.db
        .prepare(
          `UPDATE tests SET ${entries.map(([k]) => `${k}=?`).join(",")} WHERE id=?`,
        )
        .run(
          ...entries.map(([k, v]) => (k === "result" ? JSON.stringify(v) : v)),
          id,
        );
    return this.get(id);
  }
  reconcileInterrupted() {
    const now = new Date().toISOString(),
      result = JSON.stringify({
        error:
          "Application restarted while this test was marked active. The local k6 process is no longer supervised.",
      });
    return this.db
      .prepare(
        "UPDATE tests SET status='interrupted',finished_at=COALESCE(finished_at,?),result=COALESCE(result,?) WHERE status IN ('running','stopping')",
      )
      .run(now, result).changes;
  }
  delete(id) {
    return this.db
      .prepare(
        "DELETE FROM tests WHERE id=? AND status NOT IN ('running','stopping')",
      )
      .run(id).changes;
  }
  audit(actor, action, details = {}) {
    this.db
      .prepare(
        "INSERT INTO audit(actor,action,details,created_at) VALUES(?,?,?,?)",
      )
      .run(actor, action, JSON.stringify(details), new Date().toISOString());
  }
}
