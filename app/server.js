// TymbleTime: password-gated gymnastics video coach.
// The gate is enforced on the server, so the app is never sent to a browser that hasn't logged in.
// Videos never reach this server: the browser extracts still frames and sends only those.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.SITE_PASSWORD;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const MOCK = process.env.TT_MOCK === "1";
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 40);
const COOKIE = "tt_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const MAX_BODY = 12 * 1024 * 1024;
const MAX_FRAMES = 30;

if (!PASSWORD) {
  console.error("SITE_PASSWORD is not set. Refusing to start without a password.");
  process.exit(1);
}
if (!MOCK && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (or set TT_MOCK=1 for a local demo).");
  process.exit(1);
}

const { analyze } = MOCK ? {} : await import("./coach.js");
const APP = fs.readFileSync(path.join(DIR, "public", "app.html"), "utf8");
const GATE = fs.readFileSync(path.join(DIR, "public", "gate.html"), "utf8");

/* ---------- session cookie: HMAC-signed, httpOnly ---------- */
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function issue() {
  const exp = Date.now() + MAX_AGE * 1000;
  return exp + "." + sign(String(exp));
}
function valid(token) {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const exp = token.slice(0, i);
  const mac = token.slice(i + 1);
  const want = sign(exp);
  if (mac.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  return Number(exp) > Date.now();
}
function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function passwordOk(supplied) {
  const a = crypto.createHash("sha256").update(String(supplied || "")).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------- throttles: failed logins per IP, reviews per day ---------- */
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
function throttled(ip) {
  const rec = fails.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.at > WINDOW) { fails.delete(ip); return 0; }
  return rec.n >= 8 ? Math.ceil((rec.at + WINDOW - Date.now()) / 60000) : 0;
}
function noteFail(ip) {
  const rec = fails.get(ip) || { n: 0, at: Date.now() };
  rec.n += 1; rec.at = Date.now();
  fails.set(ip, rec);
}
let usage = { day: "", count: 0 };
function takeReview() {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, count: 0 };
  if (usage.count >= DAILY_LIMIT) return false;
  usage.count += 1;
  return true;
}

/* ---------- helpers ---------- */
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
};
function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY, ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json");
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Upload too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const gatePage = (msg = "") => GATE.replace("<!--MSG-->", msg ? `<p class="err" role="alert">${msg}</p>` : "");
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;

function validFrames(frames) {
  if (!Array.isArray(frames) || frames.length < 4 || frames.length > MAX_FRAMES) return false;
  return frames.every((f) => f && typeof f.t === "number" && typeof f.data === "string"
    && f.data.length < 600_000 && /^[A-Za-z0-9+/=]+$/.test(f.data));
}
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const authed = valid(readCookie(req.headers.cookie, COOKIE));
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";

  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");

    if (url.pathname === "/login" && req.method === "POST") {
      const ip = clientIp(req);
      const wait = throttled(ip);
      if (wait) return send(res, 429, gatePage(`Too many tries. Please wait ${wait} min 💕`));
      const form = new URLSearchParams(await readBody(req));
      if (!passwordOk(form.get("password"))) {
        noteFail(ip);
        return send(res, 401, gatePage("Oops! That's not it. Try again 💕"));
      }
      fails.delete(ip);
      return send(res, 303, "", "text/plain", {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${encodeURIComponent(issue())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${secure}`,
      });
    }

    if (url.pathname === "/logout") {
      return send(res, 303, "", "text/plain", {
        Location: "/",
        "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
      });
    }

    if (url.pathname === "/api/analyze" && req.method === "POST") {
      if (!authed) return json(res, 401, { error: "Please log in again." });
      const body = JSON.parse(await readBody(req));
      if (!validFrames(body.frames)) return json(res, 400, { error: "Those frames didn't come through right. Please try again." });
      if (!takeReview()) return json(res, 429, { error: "The coach has done lots of reviews today! Please try again tomorrow." });
      const context = {
        start: Number(body.start) || 0,
        end: Number(body.end) || 0,
        event: clip(body.event, 40),
        level: clip(body.level, 40),
        name: clip(body.name, 30),
        audience: ["gymnast", "parent", "coach"].includes(body.audience) ? body.audience : "parent",
        notes: clip(body.notes, 300),
      };
      const started = Date.now();
      let result;
      if (MOCK) {
        await new Promise((r) => setTimeout(r, 1500));
        result = { review: JSON.parse(fs.readFileSync(path.join(DIR, "mock-review.json"), "utf8")) };
      } else {
        result = await analyze({ frames: body.frames, context });
      }
      console.log(`review ok: ${body.frames.length} frames, ${((Date.now() - started) / 1000).toFixed(1)}s`,
        result.usage ? `in=${result.usage.input_tokens} out=${result.usage.output_tokens}` : "(mock)");
      return json(res, 200, { review: result.review });
    }

    if (url.pathname === "/" && req.method === "GET") return send(res, 200, authed ? APP : gatePage());

    return send(res, 404, "Not found", "text/plain");
  } catch (err) {
    console.error("request failed:", err?.status || "", err?.message);
    if (url.pathname.startsWith("/api/")) {
      const status = err?.status && err.status < 600 ? err.status : 500;
      const msg = status === 413 || status === 422 || status === 502 ? err.message
        : "The coach had a hiccup. Please try again in a minute.";
      return json(res, status >= 400 ? status : 500, { error: msg });
    }
    return send(res, 500, "Something went wrong", "text/plain");
  }
});

server.requestTimeout = 5 * 60 * 1000; // reviews can take a couple of minutes
server.listen(PORT, () => console.log(`TymbleTime listening on :${PORT}${MOCK ? " (mock mode)" : ""}`));
