const path = require("path");
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");

const app = express();

const PORT = process.env.PORT || 3000;

// --- DB ---
const DISK_PATH = process.env.RENDER_DISK_PATH || process.env.DISK_PATH || "";
const DB_FILE = process.env.SQLITE_FILE || "dashboard.sqlite";
const dbPath = DISK_PATH ? path.join(DISK_PATH, DB_FILE) : DB_FILE;
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temperature REAL NOT NULL,
    humidity REAL NOT NULL,
    soil_moisture REAL NOT NULL,
    motion BOOLEAN DEFAULT 0,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Helpers ---
function nowISTString() {
  // returns: YYYY-MM-DD HH:mm:ss in Asia/Kolkata
  const dtf = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  return dtf.format(new Date()).replace("T", " ");
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function ok(res, data) {
  res.json(data);
}

function fail(res, message, status = 400) {
  res.status(status).json({ success: false, error: message });
}

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "multi-sensor-dashboard-2026-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true }
  })
);

// Simple CORS (useful if you later host frontend separately)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Static pages ---
app.get("/", (req, res) => res.redirect("/pages/login.html"));
app.use("/pages", express.static(path.join(__dirname, "pages")));
app.use("/public", express.static(path.join(__dirname, "public")));

// Render health check
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

// --- Auth APIs ---
app.post("/api/auth/register", (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email || !password) return fail(res, "All fields are required");

    const stmt = db.prepare("INSERT INTO users (name, email, password, created_at) VALUES (?, ?, ?, ?)");
    stmt.run(name, email, password, nowISTString());
    ok(res, { success: true });
  } catch (e) {
    if (String(e && e.message).includes("UNIQUE")) return fail(res, "Email already registered");
    fail(res, "Register failed");
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) return fail(res, "Email and password required");

    const user = db
      .prepare("SELECT id, name, email, password FROM users WHERE email = ? LIMIT 1")
      .get(email);

    if (!user) return fail(res, "Invalid email or password", 401);
    if (user.password !== password) return fail(res, "Invalid email or password", 401);

    req.session.user = { id: user.id, name: user.name, email: user.email };
    ok(res, { success: true, user: req.session.user });
  } catch (e) {
    fail(res, "Login failed");
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    ok(res, { success: true });
  });
});

// (extra helper for UI)
app.get("/api/auth/me", (req, res) => {
  ok(res, { success: true, user: req.session.user || null });
});

// --- Sensor APIs ---
function readSavePayload(req) {
  const src = req.method === "GET" ? req.query : req.body;
  const temperature = toNumber(src.temperature);
  const humidity = toNumber(src.humidity);
  const soil_moisture = toNumber(src.soil_moisture);
  const motionRaw = src.motion;
  const motion =
    motionRaw === true ||
    motionRaw === "true" ||
    motionRaw === 1 ||
    motionRaw === "1" ||
    motionRaw === "HIGH";

  if (temperature === null || humidity === null || soil_moisture === null) return null;
  return { temperature, humidity, soil_moisture, motion: motion ? 1 : 0 };
}

app.all("/api/sensors/save", (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "POST") return fail(res, "Method not allowed", 405);
    const payload = readSavePayload(req);
    if (!payload) return fail(res, "Invalid sensor data");

    const stmt = db.prepare(
      "INSERT INTO sensor_readings (temperature, humidity, soil_moisture, motion, recorded_at) VALUES (?, ?, ?, ?, ?)"
    );
    stmt.run(payload.temperature, payload.humidity, payload.soil_moisture, payload.motion, nowISTString());
    ok(res, { success: true });
  } catch (e) {
    fail(res, "Save failed");
  }
});

app.get("/api/sensors/latest", (req, res) => {
  try {
    const row = db
      .prepare(
        "SELECT temperature, humidity, soil_moisture, motion, recorded_at FROM sensor_readings ORDER BY id DESC LIMIT 1"
      )
      .get();
    if (!row) return ok(res, { temperature: 0, humidity: 0, soil_moisture: 0, motion: false, recorded_at: null });
    ok(res, {
      temperature: row.temperature,
      humidity: row.humidity,
      soil_moisture: row.soil_moisture,
      motion: !!row.motion,
      recorded_at: row.recorded_at
    });
  } catch (e) {
    fail(res, "Failed to fetch latest");
  }
});

app.get("/api/sensors/last24h", (req, res) => {
  try {
    const now = new Date();
    const ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dtf = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const start = dtf.format(ago).replace("T", " ");

    const rows = db
      .prepare(
        "SELECT temperature, humidity, soil_moisture, recorded_at FROM sensor_readings WHERE recorded_at >= ? ORDER BY recorded_at ASC"
      )
      .all(start);
    ok(res, rows);
  } catch (e) {
    fail(res, "Failed to fetch last24h");
  }
});

app.get("/api/sensors/all", (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as c FROM sensor_readings").get().c;
    const pages = Math.max(1, Math.ceil(total / limit));

    const data = db
      .prepare(
        "SELECT id, temperature, humidity, soil_moisture, motion, recorded_at FROM sensor_readings ORDER BY id DESC LIMIT ? OFFSET ?"
      )
      .all(limit, offset);

    ok(res, { data, total, page, pages });
  } catch (e) {
    fail(res, "Failed to fetch all");
  }
});

app.delete("/api/sensors/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id || "0", 10);
    if (!id) return fail(res, "Invalid id");
    db.prepare("DELETE FROM sensor_readings WHERE id = ?").run(id);
    ok(res, { success: true });
  } catch (e) {
    fail(res, "Delete failed");
  }
});

app.get("/api/sensors/export", (req, res) => {
  try {
    const start_date = String(req.query.start_date || "").trim(); // YYYY-MM-DD
    const end_date = String(req.query.end_date || "").trim(); // YYYY-MM-DD

    let rows = [];
    if (start_date && end_date) {
      rows = db
        .prepare(
          "SELECT id, temperature, humidity, soil_moisture, motion, recorded_at FROM sensor_readings WHERE date(recorded_at) BETWEEN ? AND ? ORDER BY recorded_at ASC"
        )
        .all(start_date, end_date);
    } else {
      rows = db
        .prepare("SELECT id, temperature, humidity, soil_moisture, motion, recorded_at FROM sensor_readings ORDER BY recorded_at ASC")
        .all();
    }

    const header = ["id", "temperature", "humidity", "soil_moisture", "motion", "recorded_at"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.id),
          csvEscape(r.temperature),
          csvEscape(r.humidity),
          csvEscape(r.soil_moisture),
          csvEscape(r.motion ? 1 : 0),
          csvEscape(r.recorded_at)
        ].join(",")
      );
    }

    const filename = `sensor_export_${nowISTString().replace(/[: ]/g, "-")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(lines.join("\n"));
  } catch (e) {
    fail(res, "Export failed");
  }
});

app.get("/api/sensors/search", (req, res) => {
  try {
    const date = String(req.query.date || "").trim(); // YYYY-MM-DD
    const time_range = String(req.query.time_range || "").trim(); // today|week|month

    if (date) {
      const rows = db
        .prepare(
          "SELECT id, temperature, humidity, soil_moisture, motion, recorded_at FROM sensor_readings WHERE date(recorded_at) = ? ORDER BY recorded_at DESC"
        )
        .all(date);
      return ok(res, rows);
    }

    const now = new Date();
    let startMs = null;

    if (time_range === "today") {
      const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      ist.setHours(0, 0, 0, 0);
      startMs = ist.getTime();
    } else if (time_range === "week") {
      startMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    } else if (time_range === "month") {
      startMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    }

    if (startMs === null) return fail(res, "Provide date=YYYY-MM-DD or time_range=today|week|month");

    const dtf = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const start = dtf.format(new Date(startMs)).replace("T", " ");

    const rows = db
      .prepare(
        "SELECT id, temperature, humidity, soil_moisture, motion, recorded_at FROM sensor_readings WHERE recorded_at >= ? ORDER BY recorded_at DESC"
      )
      .all(start);
    ok(res, rows);
  } catch (e) {
    fail(res, "Search failed");
  }
});

// --- Basic error handler ---
app.use((err, req, res, next) => {
  console.error(err);
  fail(res, "Server error", 500);
});

const server = app.listen(PORT, () => {
  const actualPort = server.address() && server.address().port ? server.address().port : PORT;
  console.log("Server running on port", actualPort);
  console.log("Open:", `http://localhost:${actualPort}/pages/login.html`);
});

// Keep Node alive (some environments auto-exit otherwise)
setInterval(() => {}, 1000);

