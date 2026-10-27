/**
 * Apply database/migrations/*.sql via DATABASE_URL.
 * Dry-run by default. Write only with --apply.
 * Each file runs as its own transaction (file begin/commit, or wrapped).
 * Stops at the first failure and prints which file failed.
 *
 *   npx tsx scripts/apply-migrations.ts --from 006 --to 010
 *   npx tsx scripts/apply-migrations.ts --from 006 --to 010 --apply
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const skipBackupCheck = args.includes("--skip-backup-check");
  const fileIdx = args.indexOf("--file");
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");
  return {
    apply,
    skipBackupCheck,
    file: fileIdx >= 0 ? args[fileIdx + 1] : null,
    from: fromIdx >= 0 ? args[fromIdx + 1] : "006",
    to: toIdx >= 0 ? args[toIdx + 1] : "010",
  };
}

function listMigrationFiles(from: string, to: string): string[] {
  const dir = path.join("database", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => {
      const num = f.slice(0, 3);
      return num >= from && num <= to;
    })
    .sort()
    .map((f) => path.join(dir, f));
}

function findBackupEvidence(): { ok: boolean; found: string[] } {
  const found: string[] = [];
  const candidates = [path.join("data", "backups"), path.join("backups"), path.join("data", "pg_dump")];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (/\.(sql|dump|backup|gz|tar)$/i.test(f) || f.endsWith(".sql.gz") || f === "BACKUP_OK.txt") {
        found.push(path.join(dir, f));
      }
    }
  }
  return { ok: found.length > 0, found };
}

async function main() {
  const opts = parseArgs();
  const files = opts.file ? [opts.file] : listMigrationFiles(opts.from, opts.to);

  console.log(opts.apply ? "MODE: APPLY" : "MODE: dry-run (pass --apply to execute)");
  for (const f of files) {
    console.log(`  - ${f} (${readFileSync(f, "utf8").length} chars)`);
  }

  if (!opts.apply) {
    console.log("\nDry-run only. No changes made.");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for --apply");

  if (!opts.skipBackupCheck) {
    const backup = findBackupEvidence();
    if (!backup.ok) {
      throw new Error(
        "No backup evidence found under data/backups/ or backups/.\n" +
          "Take a Supabase branch or pg_dump first, then place a dump in data/backups/\n" +
          "or write data/backups/BACKUP_OK.txt naming the branch/dump,\n" +
          "or re-run with --skip-backup-check (not recommended)."
      );
    }
    console.log("Backup evidence:", backup.found);
  } else {
    console.log("WARNING: --skip-backup-check set.");
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  for (const f of files) {
    let sql = readFileSync(f, "utf8").trim();
    const hasOwnTx = /^\s*begin\s*;/i.test(sql);
    console.log(`\nApplying ${f} (transaction: ${hasOwnTx ? "file-owned" : "wrapper"})…`);
    try {
      if (!hasOwnTx) {
        await client.query("begin");
        await client.query(sql);
        await client.query("commit");
      } else {
        // File contains begin/commit — run as one script; rollback if it aborts mid-way
        await client.query(sql);
      }
      console.log(`OK ${f}`);
    } catch (err) {
      try {
        await client.query("rollback");
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nFAILED FILE: ${f}`);
      console.error(message);
      console.error("Stopped. Earlier files in this run (if any) already committed.");
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log("\nAll requested migrations applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
