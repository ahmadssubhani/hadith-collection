/**
 * Try Supabase pooler regions until auth gets past "tenant not found".
 * Does not print DATABASE_URL or password.
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REGIONS = [
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "sa-east-1",
  "ca-central-1",
];

async function tryRegion(password: string, region: string, port: string): Promise<string> {
  const user = "postgres.ggmqufghubpgsquldjdx";
  const host = `aws-0-${region}.pooler.supabase.com`;
  const url =
    `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/postgres` +
    `?sslmode=require&uselibpqcompat=true`;
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    const r = await client.query("select 1 as ok");
    await client.end();
    if (r.rows[0].ok === 1) return "ok";
    return "unexpected";
  } catch (e) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return e instanceof Error ? e.message : String(e);
  }
}

async function main() {
  const password = process.env.SET_DB_PASSWORD;
  if (!password) throw new Error("SET_DB_PASSWORD required");

  for (const region of REGIONS) {
    for (const port of ["5432", "6543"]) {
      const result = await tryRegion(password, region, port);
      const short = result.slice(0, 120).replace(/\s+/g, " ");
      console.log(`${region}:${port} => ${short}`);
      if (result === "ok") {
        // persist winning URL into .env.local
        process.env.SET_DB_PASSWORD = password;
        const { spawnSync } = await import("node:child_process");
        spawnSync(
          "npx",
          ["tsx", "scripts/_set-database-url.ts", "--pooler", region, "--port", port],
          {
            env: { ...process.env, SET_DB_PASSWORD: password },
            stdio: "inherit",
            shell: true,
          }
        );
        console.log(`WINNER=${region}:${port}`);
        return;
      }
    }
  }
  console.log("NO_WINNER");
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
