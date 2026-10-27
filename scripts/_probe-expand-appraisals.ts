import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  // Narrators already covered by assessments
  const { data: assess } = await sb
    .from("narrator_assessments")
    .select("narrator_id,source_url")
    .eq("mapping_method", "sunnah_com_import");
  const coveredNarrators = new Set((assess || []).map((a) => a.narrator_id));
  const coveredSunnah = new Set<string>();
  for (const a of assess || []) {
    const m = (a.source_url || "").match(/narrator\/(\d+)/);
    if (m) coveredSunnah.add(m[1]);
  }

  // Raw HTML sunnah ids
  const rawIds = readdirSync(path.join("data", "raw"))
    .filter((f) => /^sunnah-narrator-\d+\.html$/.test(f))
    .map((f) => f.replace(/\D/g, ""));

  // Extract more narrator IDs from cached bukhari HTML pages
  const fromHadithPages = new Set<string>();
  for (const f of readdirSync(path.join("data", "raw"))) {
    if (!/^sunnah-bukhari-/.test(f) && !/sunnah.*\.html$/i.test(f)) continue;
    if (/sunnah-narrator-/.test(f)) continue;
    const html = readFileSync(path.join("data", "raw", f), "utf8");
    for (const m of html.matchAll(/\/narrator\/(\d+)/g)) fromHadithPages.add(m[1]);
  }
  // also scraped folders
  const scrapedRoots = [
    path.join("data", "scraped"),
    path.join("data", "debug"),
  ];
  for (const root of scrapedRoots) {
    if (!existsSync(root)) continue;
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.html?$/i.test(ent.name)) {
          const html = readFileSync(p, "utf8");
          for (const m of html.matchAll(/\/narrator\/(\d+)/g)) fromHadithPages.add(m[1]);
        }
      }
    };
    walk(root);
  }

  const missingCache = [...fromHadithPages].filter((id) => !rawIds.includes(id));
  const uncachedNeeded = missingCache.filter((id) => !coveredSunnah.has(id));

  // Chain narrators without any assessment
  const { data: nodes } = await sb
    .from("chain_narrators")
    .select("narrator_id")
    .not("narrator_id", "is", null)
    .limit(5000);
  const inChains = new Set((nodes || []).map((n) => n.narrator_id as number));
  let withoutAssess = 0;
  for (const id of inChains) if (!coveredNarrators.has(id)) withoutAssess++;

  console.log(
    JSON.stringify(
      {
        covered_narrators: coveredNarrators.size,
        covered_sunnah_ids: coveredSunnah.size,
        raw_html_cached: rawIds.length,
        sunnah_ids_in_cached_hadith_html: fromHadithPages.size,
        sunnah_ids_linked_but_no_narrator_html: missingCache.length,
        of_those_not_yet_imported: uncachedNeeded.length,
        sample_uncached: uncachedNeeded.slice(0, 40),
        chain_narrators_distinct: inChains.size,
        chain_narrators_without_assessment: withoutAssess,
      },
      null,
      2
    )
  );
}

main().catch(console.error);
