import express from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import csrf from "csurf";
import path from "node:path";
import { requireAuth } from "./middleware/auth.js";
import { apiRoutes } from "./routes/api.js";
import { SqliteSessionStore } from "./repositories/sessionStore.js";
export function createApp(deps) {
  const app = express();
  if (deps.config.trustProxy) app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.resolve("web/views"));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", "cdn.jsdelivr.net"],
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(express.static(path.resolve("web/public")));
  const sessionMiddleware = session({
    store: new SqliteSessionStore(deps.repo.db),
    secret: deps.config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: deps.config.nodeEnv === "production",
      maxAge: 3600000,
    },
  });
  app.locals.sessionMiddleware = sessionMiddleware;
  app.use(sessionMiddleware);
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true }));
  const csrfProtection = csrf();
  app.get("/healthz", (_q, res) => res.json({ ok: true }));
  app.get("/login", csrfProtection, (req, res) =>
    res.render("login", { csrfToken: req.csrfToken() }),
  );
  app.get("/", requireAuth, csrfProtection, (req, res) =>
    res.render("dashboard", {
      csrfToken: req.csrfToken(),
      targets: deps.config.allowedTargets,
      maxRps: deps.config.maxAllowedRps,
      distributed: Boolean(deps.config.distributedProvider),
    }),
  );
  app.use("/api", csrfProtection, apiRoutes({ ...deps, requireAuth }));
  app.use((err, _req, res, _next) =>
    res
      .status(
        err.name === "ZodError"
          ? 400
          : err.code === "EBADCSRFTOKEN"
            ? 403
            : 400,
      )
      .json({ error: err.message || "Request rejected" }),
  );
  return app;
}
