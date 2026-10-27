/**
 * Corpus-wide eligibility check — same a–d rules as EligibleFirstWahiVariation,
 * applied to every hadith / topic (not only First Wahi).
 *
 * Usage:
 *   npx tsx scripts/check-eligible-hadiths.ts
 *   npx tsx scripts/check-eligible-hadiths.ts --all
 *   npx tsx scripts/check-eligible-hadiths.ts --topic="Fasting"
 *   npx tsx scripts/check-eligible-hadiths.ts --diagnostics
 *
 * Default: published hadiths only (matches public live bar).
 * --all: scan every variation regardless of review_status.
 * --diagnostics: write per-variation pass/fail rows to data/unmatched/
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  getEligibilityDiagnostics,
  getEligibleVariationStats,
  getEligibleVariations,
  getEligibleVariationsByTopic,
} from "../lib/eligible-variations";

const ALL = process.argv.includes("--all");
const DIAG = process.argv.includes("--diagnostics");
const FULL_ISNAD = process.argv.includes("--full-isnad");
const topicArg = process.argv.find((a) => a.startsWith("--topic="));
const TOPIC = topicArg ? topicArg.slice("--topic=".length).replace(/^"|"$/g, "") : undefined;
const minArg = process.argv.find((a) => a.startsWith("--min-nodes="));
const MIN_NODES = minArg
  ? Number(minArg.split("=")[1])
  : FULL_ISNAD
    ? 2
    : 1;
const OUT_DIR = path.join(process.cwd(), "data", "unmatched");

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and a Supabase key");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function main() {
  console.log("\n=== Eligible hadiths (corpus-wide, rules a–d) ===");
  console.log(`Scope: ${ALL ? "all variations" : "published hadiths only"}`);
  console.log(`minChainNodes: ${MIN_NODES}${FULL_ISNAD ? " (--full-isnad)" : ""}`);
  if (TOPIC) console.log(`Topic filter: ${TOPIC}`);

  const client = admin();
  const opts = {
    client,
    publishedOnly: !ALL,
    topic: TOPIC,
    minChainNodes: MIN_NODES,
  };

  const stats = await getEligibleVariationStats(opts);
  if (stats.error) throw stats.error;

  console.log("\n--- Totals ---");
  console.log(`Eligible hadiths:    ${stats.hadiths}`);
  console.log(`Eligible variations: ${stats.variations}`);
  console.log(`Complete chains:     ${stats.chains}`);
  console.log(`Narrators (cited):   ${stats.narrators}`);

  const { byTopic, uncategorized, error: tErr } = await getEligibleVariationsByTopic(opts);
  if (tErr) throw tErr;

  console.log("\n--- By topic ---");
  for (const row of byTopic.slice(0, 30)) {
    console.log(`  ${row.variationCount} vars / ${row.hadithCount} hadiths — ${row.topic}`);
  }
  if (byTopic.length > 30) console.log(`  … +${byTopic.length - 30} more topics`);
  if (uncategorized) {
    console.log(
      `  ${uncategorized.variationCount} vars / ${uncategorized.hadithCount} hadiths — ${uncategorized.topic}`
    );
  }

  const { variations, error: vErr } = await getEligibleVariations(opts);
  if (vErr) throw vErr;

  console.log("\n--- Sample eligible (up to 15) ---");
  for (const v of variations.slice(0, 15)) {
    const book = v.books?.title ?? "?";
    const topics = (v.hadith?.topics ?? []).join(", ") || "(no topic)";
    console.log(
      `  PASS var=${v.id} hadith=${v.hadith_id} ${book} #${v.hadith_number ?? "?"}  chains=${v.eligibleChains.length}  [${topics}]`
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const summaryPath = path.join(OUT_DIR, "eligible-hadiths-summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope: ALL ? "all" : "published_only",
        topic: TOPIC ?? null,
        stats,
        by_topic: byTopic.map((t) => ({
          topic: t.topic,
          variation_count: t.variationCount,
          hadith_count: t.hadithCount,
        })),
        uncategorized: uncategorized
          ? {
              variation_count: uncategorized.variationCount,
              hadith_count: uncategorized.hadithCount,
            }
          : null,
        eligible_variation_ids: variations.map((v) => v.id),
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\nWrote ${summaryPath}`);

  if (DIAG) {
    const { rows, error } = await getEligibilityDiagnostics({
      ...opts,
      publishedOnly: !ALL,
    });
    if (error) throw error;
    const failCounts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    let pass = 0;
    for (const row of rows) {
      if (row.eligible) {
        pass++;
        continue;
      }
      for (const f of row.failures) {
        failCounts[f.rule] = (failCounts[f.rule] ?? 0) + 1;
      }
    }
    const diagPath = path.join(OUT_DIR, "eligible-hadiths-diagnostics.json");
    writeFileSync(
      diagPath,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          scanned: rows.length,
          pass,
          fail_rule_hits: failCounts,
          rows,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`Diagnostics: scanned=${rows.length} pass=${pass} failHits=${JSON.stringify(failCounts)}`);
    console.log(`Wrote ${diagPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
