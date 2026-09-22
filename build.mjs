// Encrypts private/report.html (with its images inlined) into index.html.
// Usage: TT_PASSWORD='...' node build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const password = process.env.TT_PASSWORD;
if (!password) throw new Error("Set TT_PASSWORD");

let report = readFileSync("private/report.html", "utf8");
report = report.replace(/\{\{(k\d)\}\}/g, (_, name) =>
  "data:image/jpeg;base64," + readFileSync(`private/img/${name}.jpg`).toString("base64"));

const iter = 600000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
  base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
);
const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(report));

const b64 = u => Buffer.from(u).toString("base64");
const payload = JSON.stringify({ iter, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) });

const shell = readFileSync("shell.html", "utf8");
writeFileSync("index.html", shell.replace("/*PAYLOAD*/null", payload));
console.log(`index.html written (${(payload.length / 1024).toFixed(0)} KB encrypted payload)`);
