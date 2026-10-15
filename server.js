// Altstadt-Weihnachtsmarkt – kleiner Server für eigenes Hosting (z. B. Render)
// - liefert die Seite aus (public/index.html)
// - speichert Teams und Termine (Postgres, wenn DATABASE_URL gesetzt ist, sonst JSON-Datei)
// - verteilt jede Änderung sofort an alle offenen Seiten (Server-Sent Events)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "XY";
const ADMIN_PASS = process.env.ADMIN_PASS || "XY";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("wm|" + ADMIN_USER + "|" + ADMIN_PASS).digest("hex");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
// index.html darf in public/ oder direkt neben server.js liegen (einfacher Upload vom Handy)
const PUBLIC = fs.existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : __dirname;
const SERVE_STATIC = PUBLIC !== __dirname;
const MAX_TERMINE = 5000;
const PAUSED = /^(1|true|ja|yes)$/i.test(process.env.PAUSED || "");

const SEED_TEAMS = [
  { id: "aarau", name: "Aarau", color: "#d64545", order: 1, logo: "aarau" },
  { id: "olten", name: "Olten", color: "#2f8f5b", order: 2, logo: "olten" },
  { id: "basel-clara", name: "Basel Clara", color: "#3a7bd5", order: 3, logo: "faehri" },
  { id: "basel-steinenberg", name: "Basel Steinenberg", color: "#7d5ce0", order: 4, logo: "muenster" },
  { id: "biel", name: "Biel/Bienne", color: "#e0a526", order: 5, logo: "uhr" },
  { id: "burgdorf", name: "Burgdorf", color: "#e2742e", order: 6, logo: "burg" },
  { id: "thun", name: "Thun", color: "#1fa5b0", order: 7, logo: "niesen" },
  { id: "bern-hochhaus", name: "Bern Postpark Hochhaus", color: "#d65a9a", order: 8, logo: "hochhaus" },
  { id: "bern-postpark", name: "Bern Postpark", color: "#a8743f", order: 9, logo: "baer" }
];

/* ---------------- Speicher ---------------- */
const state = { teams: new Map(), termine: new Map() };

function fileStore() {
  const file = path.join(DATA_DIR, "data.json");
  let timer = null, writing = Promise.resolve();
  const flush = () => {
    const data = JSON.stringify({ teams: [...state.teams.values()], termine: [...state.termine.values()] });
    writing = writing.then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const tmp = file + ".tmp";
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
    }).catch(e => console.error("Speichern fehlgeschlagen:", e.message));
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 150); };
  return {
    kind: "Datei " + file,
    async load() {
      try {
        const d = JSON.parse(await fs.promises.readFile(file, "utf8"));
        for (const t of d.teams || []) state.teams.set(t.id, t);
        for (const t of d.termine || []) state.termine.set(t.id, t);
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    },
    async addTermin() { schedule(); }, async delTermin() { schedule(); }, async clearTermine() { schedule(); },
    async saveTeam() { schedule(); }, async delTeam() { schedule(); },
    async close() { clearTimeout(timer); flush(); await writing; }
  };
}

function pgStore(url) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 5 });
  return {
    kind: "Postgres",
    async load() {
      await pool.query(`CREATE TABLE IF NOT EXISTS wm_teams (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS wm_termine (id TEXT PRIMARY KEY, team TEXT NOT NULL, at BIGINT NOT NULL, by_client TEXT)`);
      for (const r of (await pool.query("SELECT id, data FROM wm_teams")).rows) state.teams.set(r.id, { ...r.data, id: r.id });
      for (const r of (await pool.query("SELECT id, team, at, by_client FROM wm_termine")).rows) state.termine.set(r.id, { id: r.id, team: r.team, at: Number(r.at), by: r.by_client });
    },
    addTermin: t => pool.query("INSERT INTO wm_termine (id, team, at, by_client) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [t.id, t.team, t.at, t.by]),
    delTermin: id => pool.query("DELETE FROM wm_termine WHERE id=$1", [id]),
    clearTermine: () => pool.query("DELETE FROM wm_termine"),
    saveTeam: t => pool.query("INSERT INTO wm_teams (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data", [t.id, JSON.stringify(t)]),
    delTeam: id => pool.query("DELETE FROM wm_teams WHERE id=$1", [id]),
    close: () => pool.end()
  };
}

const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore();

/* ---------------- Live-Verteilung ---------------- */
const clients = new Set();
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
}
setInterval(() => { for (const res of clients) { try { res.write(": ping\n\n"); } catch (e) { clients.delete(res); } } }, 20000).unref();

/* ---------------- Hilfen ---------------- */
const snapshot = () => ({ teams: [...state.teams.values()].sort((a, b) => (a.order || 0) - (b.order || 0)), termine: [...state.termine.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) });
const newId = () => Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function makeToken() { const exp = Date.now() + 1000 * 60 * 60 * 12; const v = "admin." + exp; return v + "." + sign(v); }
function isAdmin(req) {
  const h = req.headers.authorization || ""; const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const parts = tok.split("."); if (parts.length !== 3) return false;
  const v = parts[0] + "." + parts[1]; if (+parts[1] < Date.now()) return false;
  const a = Buffer.from(sign(v)), b = Buffer.from(parts[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const safeEq = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
function send(res, code, obj, headers = {}) {
  const body = obj === undefined ? "" : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > 20000) { reject(new Error("zu gross")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);
const isColor = c => /^#[0-9a-fA-F]{6}$/.test(c);
// Schutz gegen versehentliches Dauerklicken: pro Gerät höchstens 1 Termin pro 0.5 s
const lastAdd = new Map();
const loginFails = new Map();

/* ---------------- Routen ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/health") return send(res, 200, { ok: true, paused: PAUSED, termine: state.termine.size, teams: state.teams.size, live: clients.size, store: store.kind });

  // Pausenschalter: Umgebungsvariable PAUSED=1 → nur ein Hinweis, keine Daten, keine Klicks
  if (PAUSED) {
    if (p.startsWith("/api/")) return send(res, 503, { error: "Der Weihnachtsmarkt ist zurzeit pausiert." });
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "86400" });
    return res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Altstadt-Weihnachtsmarkt</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c1529;color:#eef3fa;font:17px/1.5 system-ui,sans-serif;padding:24px;text-align:center}h1{color:#f2b544;font:700 34px Georgia,serif;margin:0 0 8px}p{color:#9fb0cf;margin:0}</style></head>
<body><div><h1>Altstadt-Weihnachtsmarkt</h1><p>Der Markt ist zurzeit pausiert und öffnet bald wieder.</p></div></body></html>`);
  }

  if (p === "/api/state" && req.method === "GET") return send(res, 200, snapshot());

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n");
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (p === "/api/termine" && req.method === "POST") {
    const b = await readBody(req);
    const team = clean(b.team, 80), by = clean(b.by, 60) || null;
    if (!state.teams.has(team)) return send(res, 400, { error: "Unbekanntes Team" });
    if (state.termine.size >= MAX_TERMINE) return send(res, 507, { error: "Speicher voll" });
    const key = by || req.socket.remoteAddress, now = Date.now();
    if (lastAdd.has(key) && now - lastAdd.get(key) < 500) return send(res, 429, { error: "Bitte kurz warten" });
    lastAdd.set(key, now);
    const t = { id: newId(), team, at: now, by };
    await store.addTermin(t);
    state.termine.set(t.id, t);
    broadcast("add", t);
    return send(res, 201, t);
  }

  let m = p.match(/^\/api\/termine\/([\w-]{1,80})$/);
  if (m && req.method === "DELETE") {
    const t = state.termine.get(m[1]);
    if (!t) return send(res, 404, { error: "Nicht gefunden" });
    const own = t.by && req.headers["x-client"] === t.by && Date.now() - t.at < 20000;
    if (!own && !isAdmin(req)) return send(res, 403, { error: "Nur in der Verwaltung möglich" });
    await store.delTermin(t.id);
    state.termine.delete(t.id);
    broadcast("del", { id: t.id });
    return send(res, 200, { ok: true });
  }

  if (p === "/api/reset" && req.method === "POST") {
    if (!isAdmin(req)) return send(res, 401, { error: "Bitte in der Verwaltung anmelden" });
    await store.clearTermine();
    state.termine.clear();
    broadcast("state", snapshot());
    console.log("Alle Termine zurückgesetzt");
    return send(res, 200, { ok: true });
  }

  if (p === "/api/login" && req.method === "POST") {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const f = loginFails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return send(res, 429, { error: "Zu viele Versuche. Bitte eine Minute warten." });
    const b = await readBody(req);
    if (safeEq(clean(b.user, 100), ADMIN_USER) && safeEq(String(b.pass || ""), ADMIN_PASS)) { loginFails.delete(ip); return send(res, 200, { token: makeToken() }); }
    f.n++; if (f.n >= 8) { f.until = Date.now() + 60000; f.n = 0; } loginFails.set(ip, f);
    return send(res, 401, { error: "Benutzer oder Passwort stimmt nicht." });
  }

  m = p.match(/^\/api\/teams\/([\w-]{1,80})$/);
  if (m && (req.method === "PUT" || req.method === "DELETE")) {
    if (!isAdmin(req)) return send(res, 401, { error: "Bitte in der Verwaltung anmelden" });
    if (req.method === "DELETE") { await store.delTeam(m[1]); state.teams.delete(m[1]); broadcast("teams", snapshot().teams); return send(res, 200, { ok: true }); }
    const b = await readBody(req);
    const t = { id: m[1], name: clean(b.name, 40) || "Team", color: isColor(b.color) ? b.color : "#c9d3de", order: Number(b.order) || Date.now(), logo: clean(b.logo, 20) || "stern" };
    await store.saveTeam(t); state.teams.set(t.id, t); broadcast("teams", snapshot().teams);
    return send(res, 200, t);
  }

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    const html = await fs.promises.readFile(path.join(PUBLIC, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }
  // weitere Dateien aus public/ (z. B. Icons), ohne Verzeichniswechsel
  const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };
  const ext = path.extname(p);
  if (SERVE_STATIC && req.method === "GET" && TYPES[ext] && /^\/[\w./-]+$/.test(p) && !p.includes("..")) {
    try { const f = await fs.promises.readFile(path.join(PUBLIC, p)); res.writeHead(200, { "Content-Type": TYPES[ext], "Cache-Control": "public, max-age=86400" }); return res.end(f); } catch (e) {}
  }
  send(res, 404, { error: "Nicht gefunden" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: "Serverfehler" }); else res.end(); });
});
server.keepAliveTimeout = 65000;

(async () => {
  await store.load();
  if (state.teams.size === 0) for (const t of SEED_TEAMS) { state.teams.set(t.id, t); await store.saveTeam(t); }
  server.listen(PORT, () => console.log(`Weihnachtsmarkt läuft auf Port ${PORT} · Speicher: ${store.kind} · ${state.teams.size} Teams, ${state.termine.size} Termine`));
})().catch(e => { console.error("Start fehlgeschlagen:", e); process.exit(1); });

async function shutdown() { server.close(); for (const r of clients) r.end(); try { await store.close(); } catch (e) {} process.exit(0); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
