import session from "express-session";
export class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL)",
    );
  }
  get(sid, cb) {
    try {
      const r = this.db
        .prepare("SELECT data FROM sessions WHERE sid=? AND expires>?")
        .get(sid, Date.now());
      cb(null, r ? JSON.parse(r.data) : null);
    } catch (e) {
      cb(e);
    }
  }
  set(sid, value, cb = () => {}) {
    try {
      const expires = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 3600000;
      this.db
        .prepare(
          "INSERT INTO sessions(sid,data,expires) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires=excluded.expires",
        )
        .run(sid, JSON.stringify(value), expires);
      cb();
    } catch (e) {
      cb(e);
    }
  }
  destroy(sid, cb = () => {}) {
    try {
      this.db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);
      cb();
    } catch (e) {
      cb(e);
    }
  }
  touch(sid, value, cb = () => {}) {
    this.set(sid, value, cb);
  }
}
