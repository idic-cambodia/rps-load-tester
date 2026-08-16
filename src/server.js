import http from "node:http";
import { Server } from "socket.io";
import { config, assertProductionSafety } from "./config/env.js";
import { createDatabase, TestRepository, TargetRepository } from "./repositories/database.js";
import { TestRunner } from "./services/testRunner.js";
import { createApp } from "./app.js";

const problems = assertProductionSafety(config);
if (problems.length) {
  console.warn("Startup safety warnings:");
  for (const p of problems) console.warn(`  - ${p}`);
  if (config.nodeEnv === "production") {
    console.error("Refusing to start in production with unresolved safety warnings.");
    process.exit(1);
  }
}

const db = createDatabase(config.databasePath),
  repo = new TestRepository(db),
  targetRepo = new TargetRepository(db);
repo.reconcileInterrupted();
let runner;
const runnerProxy = {
  start: (...a) => runner.start(...a),
  stop: (...a) => runner.stop(...a),
  stopAll: (...a) => runner.stopAll(...a),
};
const app = createApp({ config, repo, targetRepo, runner: runnerProxy });
const server = http.createServer(app);
const io = new Server(server, { cors: false });
io.engine.use(app.locals.sessionMiddleware);
runner = new TestRunner({ repo, targetRepo, io, config });
io.use((socket, next) =>
  socket.request.session?.admin ? next() : next(new Error("unauthorized")),
);
io.on("connection", (s) =>
  s.on("test:subscribe", (id) => s.join(`test:${Number(id)}`)),
);
server.listen(config.port, () =>
  console.log(`rps-load-tester listening on http://localhost:${config.port}`),
);
