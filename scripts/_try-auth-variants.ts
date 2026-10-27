/**
 * Try password/host variants against known-good region. Never prints secrets.
 */
import pg from "pg";

const passwords = [
  process.env.SET_DB_PASSWORD_1,
  process.env.SET_DB_PASSWORD_2,
  process.env.SET_DB_PASSWORD_3,
].filter(Boolean) as string[];

async function tryUrl(label: string, url: string) {
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 12000,
  });
  try {
    await client.connect();
    const r = await client.query("select 1 as ok, current_user as u");
    await client.end();
    console.log(`${label} => OK user=${r.rows[0].u}`);
    return true;
  } catch (e) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${label} => FAIL ${msg.slice(0, 100)}`);
    return false;
  }
}

async function main() {
  const region = "ap-south-1";
  const ref = "ggmqufghubpgsquldjdx";

  for (let i = 0; i < passwords.length; i++) {
    const pw = passwords[i];
    const enc = encodeURIComponent(pw);
    console.log(`\nvariant_password_${i + 1} len=${pw.length}`);

    const urls: [string, string][] = [
      [
        "pooler_session",
        `postgresql://postgres.${ref}:${enc}@aws-0-${region}.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true`,
      ],
      [
        "pooler_transaction",
        `postgresql://postgres.${ref}:${enc}@aws-0-${region}.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true`,
      ],
      [
        "direct_hostname",
        `postgresql://postgres:${enc}@db.${ref}.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=true`,
      ],
    ];

    for (const [label, url] of urls) {
      const ok = await tryUrl(label, url);
      if (ok) {
        // write winner
        process.env.SET_DB_PASSWORD = pw;
        const { spawnSync } = await import("node:child_process");
        if (label.startsWith("pooler")) {
          const port = label.includes("transaction") ? "6543" : "5432";
          spawnSync(
            "npx",
            ["tsx", "scripts/_set-database-url.ts", "--pooler", region, "--port", port],
            { env: { ...process.env, SET_DB_PASSWORD: pw }, stdio: "inherit", shell: true }
          );
        } else {
          spawnSync("npx", ["tsx", "scripts/_set-database-url.ts", "--direct"], {
            env: { ...process.env, SET_DB_PASSWORD: pw },
            stdio: "inherit",
            shell: true,
          });
        }
        console.log("WINNER_SAVED");
        return;
      }
    }
  }

  // IPv6 literal direct
  console.log("\nTrying IPv6 literal host…");
  const dns = await import("node:dns/promises");
  let v6: string | null = null;
  try {
    const addrs = await dns.resolve6(`db.${ref}.supabase.co`);
    v6 = addrs[0] ?? null;
    console.log("ipv6_resolved=true");
  } catch {
    console.log("ipv6_resolved=false");
  }
  if (v6 && passwords[0]) {
    const enc = encodeURIComponent(passwords[0]);
    const url = `postgresql://postgres:${enc}@[${v6}]:5432/postgres?sslmode=require&uselibpqcompat=true`;
    await tryUrl("direct_ipv6", url);
  }

  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
