/**
 * Snapshot table row counts before/after migrations.
 *   npx tsx scripts/record-migration-counts.ts --label before-006
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const TABLES = [
  "books",
  "hadiths",
  "source_variations",
  "narrators",
  "chains",
  "chain_narrators",
  "scholars",
  "hadith_assessments",
  "chain_assessments",
  "narrator_assessments",
  "import_batches",
  "raw_import_records",
  "daily_topics",
  "daily_hadith_logs",
  "daily_hadith_batch",
  "categories",
  "hadith_categories",
  "name_aliases",
  "narrator_relations",
  "grade_lookup",
];

async function main() {
  const label = process.argv.includes("--label")
    ? process.argv[process.argv.indexOf("--label") + 1]
    : new Date().toISOString().replace(/[:.]/g, "-");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const counts: Record<string, number | string> = {};
  for (const t of TABLES) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    counts[t] = error ? `ERR:${error.code ?? error.message}` : (count ?? 0);
  }

  const out = {
    label,
    generated_at: new Date().toISOString(),
    project_ref: "ggmqufghubpgsquldjdx",
    counts,
  };

  const dir = path.join("data", "migration-counts");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify(out, null, 2));
  console.log("Wrote", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
