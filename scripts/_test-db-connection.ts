import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import pg from "pg";

async function main() {
  let databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL missing");

  // Ensure pooler-friendly SSL (avoid verify-full alias on sslmode=require)
  if (!/[?&]uselibpqcompat=/i.test(databaseUrl)) {
    databaseUrl += (databaseUrl.includes("?") ? "&" : "?") + "uselibpqcompat=true";
  }
  if (!/[?&]sslmode=/i.test(databaseUrl)) {
    databaseUrl += (databaseUrl.includes("?") ? "&" : "?") + "sslmode=require";
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });

  try {
    await client.connect();
    const one = await client.query("select 1 as ok");
    const ver = await client.query("select version() as version");
    console.log("select_1=" + one.rows[0].ok);
    console.log("version=" + String(ver.rows[0].version).slice(0, 100));
    console.log("connection_ok=true");
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error("connection_ok=false");
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
