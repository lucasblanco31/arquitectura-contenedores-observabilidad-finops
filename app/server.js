// demo-app · "panel de caos" para la charla de observabilidad y FinOps en EKS.
// Una sola imagen: frontend estático con botones + API que genera tráfico,
// errores, latencia, CPU, memoria, logs y reinicios. Expone /metrics (Prometheus)
// y escribe logs JSON a stdout (los recoge Alloy y los manda a Loki).

import express from "express";
import client from "prom-client";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const POD = process.env.HOSTNAME || "local";
// URL del Service: el generador de carga le pega acá para repartir entre réplicas
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- logs JSON ----------
function log(level, msg, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, pod: POD, msg, ...extra }) + "\n"
  );
}

// ---------- métricas ----------
const registry = new client.Registry();
registry.setDefaultLabels({ pod: POD });
client.collectDefaultMetrics({ register: registry });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Requests HTTP atendidas",
  labelNames: ["route", "method", "status"],
  registers: [registry],
});
const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Latencia de las requests HTTP",
  labelNames: ["route", "method"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
const appErrors = new client.Counter({
  name: "app_errors_total",
  help: "Errores generados a propósito",
  labelNames: ["tipo"],
  registers: [registry],
});
const loadActive = new client.Gauge({
  name: "demo_load_active",
  help: "1 si esta réplica tiene un generador de carga corriendo",
  registers: [registry],
});
const memHeld = new client.Gauge({
  name: "demo_memory_held_bytes",
  help: "Bytes retenidos a propósito por la fuga simulada",
  registers: [registry],
});

// ---------- app ----------
const app = express();
app.disable("x-powered-by");

// instrumentación de toda request (menos /metrics y /healthz, que son ruido)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path ? req.baseUrl + req.route.path : req.path;
    if (route === "/metrics" || route === "/healthz") return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequests.inc({ route, method: req.method, status: String(res.statusCode) });
    httpDuration.observe({ route, method: req.method }, seconds);
    log(res.statusCode >= 500 ? "error" : "info", "request", {
      route,
      method: req.method,
      status: res.statusCode,
      latency_ms: Math.round(seconds * 1000),
    });
  });
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.json({ ok: true, pod: POD }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
});
app.get("/api/whoami", (_req, res) => res.json({ pod: POD, selfUrl: SELF_URL }));

// --- respuestas básicas ---
app.get("/api/ok", (_req, res) => res.json({ ok: true, pod: POD }));

app.get("/api/error", (_req, res) => {
  appErrors.inc({ tipo: "5xx" });
  res.status(500).json({ ok: false, pod: POD, error: "fallo simulado" });
});

app.get("/api/slow", async (_req, res) => {
  const ms = 1000 + Math.floor(Math.random() * 2000); // 1 a 3 s
  await new Promise((r) => setTimeout(r, ms));
  res.json({ ok: true, pod: POD, waited_ms: ms });
});

// --- CPU: quema ~80 % de cada 100 ms durante N segundos, sin bloquear del todo el event loop ---
let cpuUntil = 0;
function burnSlice() {
  if (Date.now() >= cpuUntil) return;
  const end = Date.now() + 80;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  setTimeout(burnSlice, 20);
}
app.post("/api/cpu", (req, res) => {
  const seconds = Math.min(Number(req.query.seconds) || 60, 600);
  const was = cpuUntil > Date.now();
  cpuUntil = Date.now() + seconds * 1000;
  if (!was) burnSlice();
  log("warn", "quemando cpu", { seconds });
  res.json({ ok: true, pod: POD, seconds });
});

// --- memoria: retiene N MiB por segundo durante N segundos y después libera ---
let held = [];
app.post("/api/mem", (req, res) => {
  const mbPerSec = Math.min(Number(req.query.mb) || 20, 200);
  const seconds = Math.min(Number(req.query.seconds) || 30, 600);
  let n = 0;
  const t = setInterval(() => {
    held.push(Buffer.alloc(mbPerSec * 1024 * 1024, 1));
    memHeld.set(held.reduce((a, b) => a + b.length, 0));
    if (++n >= seconds) clearInterval(t);
  }, 1000);
  log("warn", "fuga de memoria simulada", { mbPerSec, seconds });
  res.json({ ok: true, pod: POD, mbPerSec, seconds });
});
app.post("/api/mem/release", (_req, res) => {
  held = [];
  memHeld.set(0);
  if (global.gc) global.gc();
  log("info", "memoria liberada");
  res.json({ ok: true, pod: POD });
});

// --- ráfaga de logs: N líneas repartidas en 10 s ---
app.post("/api/logs", (req, res) => {
  const lines = Math.min(Number(req.query.lines) || 5000, 100000);
  const perTick = Math.ceil(lines / 100);
  let sent = 0;
  const t = setInterval(() => {
    for (let i = 0; i < perTick && sent < lines; i++, sent++) {
      const level = sent % 50 === 0 ? "error" : sent % 10 === 0 ? "warn" : "info";
      log(level, "ráfaga de logs", { i: sent, cliente: `c-${sent % 7}` });
    }
    if (sent >= lines) clearInterval(t);
  }, 100);
  res.json({ ok: true, pod: POD, lines });
});

// --- crash: responde y se muere; Kubernetes lo reinicia ---
app.post("/api/crash", (_req, res) => {
  appErrors.inc({ tipo: "crash" });
  log("error", "crash a pedido: saliendo con código 1");
  res.json({ ok: true, pod: POD, bye: true });
  setTimeout(() => process.exit(1), 200);
});

// --- generador de carga: cada segundo lanza `rps` requests contra el Service ---
let load = null;
app.post("/api/load", (req, res) => {
  const mode = ["ok", "error", "slow", "mixto"].includes(req.query.mode) ? req.query.mode : "ok";
  const rps = Math.min(Number(req.query.rps) || 50, 500);
  const seconds = Math.min(Number(req.query.seconds) || 60, 900);
  if (load) clearInterval(load.timer);
  const until = Date.now() + seconds * 1000;
  const stats = { sent: 0, ok: 0, failed: 0 };
  const pick = () => {
    if (mode === "ok") return "ok";
    if (mode === "slow") return "slow";
    if (mode === "error") return Math.random() < 0.3 ? "error" : "ok";
    const r = Math.random(); // mixto: 70 % ok, 20 % error, 10 % lento
    return r < 0.7 ? "ok" : r < 0.9 ? "error" : "slow";
  };
  const timer = setInterval(() => {
    if (Date.now() >= until) {
      clearInterval(timer);
      load = null;
      loadActive.set(0);
      log("info", "carga terminada", stats);
      return;
    }
    for (let i = 0; i < rps; i++) {
      stats.sent++;
      fetch(`${SELF_URL}/api/${pick()}`)
        .then((r) => (r.ok ? stats.ok++ : stats.failed++))
        .catch(() => stats.failed++);
    }
  }, 1000);
  load = { timer, mode, rps, until, stats };
  loadActive.set(1);
  log("info", "carga iniciada", { mode, rps, seconds });
  res.json({ ok: true, pod: POD, mode, rps, seconds });
});
app.post("/api/load/stop", (_req, res) => {
  if (load) {
    clearInterval(load.timer);
    load = null;
    loadActive.set(0);
    log("info", "carga detenida a pedido");
  }
  res.json({ ok: true, pod: POD });
});
app.get("/api/load/status", (_req, res) =>
  res.json(load ? { active: true, mode: load.mode, rps: load.rps, remaining_s: Math.max(0, Math.round((load.until - Date.now()) / 1000)), ...load.stats } : { active: false })
);

app.listen(PORT, () => log("info", "demo-app escuchando", { port: PORT, selfUrl: SELF_URL }));

process.on("SIGTERM", () => {
  log("info", "SIGTERM: cerrando");
  process.exit(0);
});
