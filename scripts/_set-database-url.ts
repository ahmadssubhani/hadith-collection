/**
 * Write DATABASE_URL into .env.local without logging secrets.
 *
 *   $env:SET_DB_PASSWORD='...'; npx tsx scripts/_set-database-url.ts
 *   $env:SET_DB_PASSWORD='...'; npx tsx scripts/_set-database-url.ts --pooler ap-southeast-1
 *   $env:SET_DB_PASSWORD='...'; npx tsx scripts/_set-database-url.ts --direct
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const password = process.env.SET_DB_PASSWORD || argValue("--password");
if (!password) throw new Error("SET_DB_PASSWORD or --password required");

const encoded = encodeURIComponent(password);
const projectRef = "ggmqufghubpgsquldjdx";
const useDirect = process.argv.includes("--direct");
const poolerRegion = argValue("--pooler") || (useDirect ? null : "ap-southeast-1");

let user: string;
let host: string;
let port: string;

if (useDirect) {
  user = "postgres";
  host = `db.${projectRef}.supabase.co`;
  port = "5432";
} else {
  user = `postgres.${projectRef}`;
  host = `aws-0-${poolerRegion}.pooler.supabase.com`;
  // Session mode (5432) required for migrations / pg_dump
  port = argValue("--port") || "5432";
}

// uselibpqcompat so sslmode=require does not force verify-full (pg v8+)
const url = `postgresql://${user}:${encoded}@${host}:${port}/postgres?sslmode=require&uselibpqcompat=true`;

const envPath = path.join(process.cwd(), ".env.local");
let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const lines = text.split(/\r?\n/);
let found = false;
const out = lines.map((line) => {
  if (/^\s*DATABASE_URL\s*=/.test(line)) {
    found = true;
    return `DATABASE_URL=${url}`;
  }
  return line;
});
if (!found) {
  if (out.length && out[out.length - 1] !== "") out.push("");
  out.push(`DATABASE_URL=${url}`);
}
while (out.length && out[out.length - 1] === "") out.pop();
writeFileSync(envPath, out.join("\n") + "\n", "utf8");

console.log("wrote_DATABASE_URL=true");
console.log(`mode=${useDirect ? "direct" : "pooler"}`);
console.log(`host=${host}`);
console.log(`user=${user}`);
console.log(`port=${port}`);
console.log("url_printed=false");
