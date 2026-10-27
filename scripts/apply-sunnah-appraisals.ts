/**
 * Apply Sunnah.com appraisal CSV into narrator_assessments (verified=false).
 * Does not invent grades or scores.
 *
 * Usage:
 *   npx tsx scripts/apply-sunnah-appraisals.ts           # dry-run
 *   npx tsx scripts/apply-sunnah-appraisals.ts --apply --mapping-approved
 *
 * Requires data/narrator-appraisals-review.csv and data/scholar-aliases.csv.
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const VARIATION_ID = 275;
const MAPPING_METHOD = "sunnah_com_import";
const APPRAISALS_CSV = path.join(process.cwd(), "data", "narrator-appraisals-review.csv");
const ALIASES_CSV = path.join(process.cwd(), "data", "scholar-aliases.csv");

/** Fixed Sunnah ID → expected Bukhari #3 chain position (1-based, collector→…). */
const SUNNAH_TO_POSITION: Array<{ sunnahId: string; position: number; label: string }> = [
  { sunnahId: "8297", position: 1, label: "Yahya ibn Bukayr" },
  { sunnahId: "6641", position: 2, label: "al-Layth ibn Sa'd" },
  { sunnahId: "5688", position: 3, label: "'Uqayl ibn Khalid" },
  { sunnahId: "7272", position: 4, label: "Ibn Shihab al-Zuhri" },
  { sunnahId: "5594", position: 5, label: "'Urwa ibn al-Zubayr" },
  { sunnahId: "4049", position: 6, label: "'A'isha bint Abi Bakr" },
];

type AppraisalCsvRow = {
  narrator_sunnah_id: string;
  narrator_name_ar: string;
  scholar_name_ar: string;
  original_term_ar: string;
  citation_book: string;
  source_url: string;
  verified: string;
};

type NarratorMapping = {
  sunnahId: string;
  label: string;
  position: number;
  narratorId: number;
  rawName: string;
  arabicName: string;
  slug: string;
  sunnahPageNameAr: string;
};

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let i = 0;
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] ?? "";
    });
    return obj;
  });
}

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function loadAliases(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ALIASES_CSV)) {
    console.warn(`No alias file at ${ALIASES_CSV} — exact arabic_name match only.`);
    return map;
  }
  for (const row of parseCsv(readFileSync(ALIASES_CSV, "utf8"))) {
    const alias = normalizeWs(row.alias_ar ?? "");
    const canonical = normalizeWs(row.canonical_ar ?? "");
    if (!alias || !canonical) continue;
    map.set(alias, canonical);
  }
  return map;
}

function loadAppraisals(): AppraisalCsvRow[] {
  if (!existsSync(APPRAISALS_CSV)) throw new Error(`Missing ${APPRAISALS_CSV}`);
  return parseCsv(readFileSync(APPRAISALS_CSV, "utf8")).map((r) => ({
    narrator_sunnah_id: normalizeWs(r.narrator_sunnah_id),
    narrator_name_ar: normalizeWs(r.narrator_name_ar),
    scholar_name_ar: normalizeWs(r.scholar_name_ar),
    original_term_ar: normalizeWs(r.original_term_ar),
    citation_book: normalizeWs(r.citation_book),
    source_url: normalizeWs(r.source_url),
    verified: normalizeWs(r.verified),
  }));
}

function scholarSlug(arabicName: string): string {
  const hash = createHash("sha256").update(arabicName).digest("hex").slice(0, 10);
  return `sunnah-${hash}`;
}

async function loadChainMapping(supabase: SupabaseClient): Promise<NarratorMapping[]> {
  const { data: chains, error } = await supabase
    .from("chains")
    .select("id, chain_number, chain_narrators(position, narrator_id, raw_name, narrators(id, slug, name, arabic_name))")
    .eq("variation_id", VARIATION_ID)
    .order("chain_number");
  if (error) throw new Error(error.message);
  if (!chains?.length) throw new Error(`No chains for variation_id=${VARIATION_ID}`);

  type Node = {
    position: number;
    narrator_id: number | null;
    raw_name: string;
    narrators?:
      | { id: number; slug: string; name: string; arabic_name: string | null }
      | { id: number; slug: string; name: string; arabic_name: string | null }[]
      | null;
  };
  const chain = chains[0] as { chain_narrators?: Node[] };
  const nodes = [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position);
  if (nodes.length !== 6) {
    throw new Error(`Expected 6 chain nodes on variation ${VARIATION_ID}, found ${nodes.length}`);
  }

  const appraisals = loadAppraisals();
  const pageNameBySunnah = new Map<string, string>();
  for (const row of appraisals) {
    if (!pageNameBySunnah.has(row.narrator_sunnah_id)) {
      pageNameBySunnah.set(row.narrator_sunnah_id, row.narrator_name_ar);
    }
  }

  const mappings: NarratorMapping[] = [];
  for (const entry of SUNNAH_TO_POSITION) {
    const node = nodes.find((n) => n.position === entry.position);
    if (!node) throw new Error(`Missing position ${entry.position} on variation ${VARIATION_ID}`);
    if (node.narrator_id == null) {
      throw new Error(`Position ${entry.position} has null narrator_id — cannot map sunnah/${entry.sunnahId}`);
    }
    const narr = Array.isArray(node.narrators) ? node.narrators[0] : node.narrators;
    if (!narr || narr.id !== node.narrator_id) {
      throw new Error(`narrator_id mismatch at position ${entry.position}`);
    }
    mappings.push({
      sunnahId: entry.sunnahId,
      label: entry.label,
      position: entry.position,
      narratorId: node.narrator_id,
      rawName: node.raw_name,
      arabicName: narr.arabic_name ?? narr.name,
      slug: narr.slug,
      sunnahPageNameAr: pageNameBySunnah.get(entry.sunnahId) ?? "",
    });
  }
  return mappings;
}

async function resolveScholarId(
  supabase: SupabaseClient,
  scholarNameAr: string,
  aliases: Map<string, string>,
  scholarCache: Map<string, number>,
  apply: boolean,
  created: string[],
  reused: string[],
): Promise<number | null> {
  const lookupName = aliases.get(scholarNameAr) ?? scholarNameAr;
  if (scholarCache.has(lookupName)) {
    reused.push(`${scholarNameAr} → id ${scholarCache.get(lookupName)} (${lookupName})`);
    return scholarCache.get(lookupName)!;
  }

  const { data: byArabic } = await supabase
    .from("scholars")
    .select("id, arabic_name")
    .eq("arabic_name", lookupName)
    .maybeSingle();

  if (byArabic) {
    scholarCache.set(lookupName, byArabic.id);
    reused.push(`${scholarNameAr} → existing #${byArabic.id} (${lookupName})`);
    return byArabic.id;
  }

  // Also try exact Sunnah name if alias pointed elsewhere and missed
  if (lookupName !== scholarNameAr) {
    const { data: byAliasSource } = await supabase
      .from("scholars")
      .select("id, arabic_name")
      .eq("arabic_name", scholarNameAr)
      .maybeSingle();
    if (byAliasSource) {
      scholarCache.set(scholarNameAr, byAliasSource.id);
      reused.push(`${scholarNameAr} → existing #${byAliasSource.id}`);
      return byAliasSource.id;
    }
  }

  const slug = scholarSlug(lookupName);
  const { data: bySlug } = await supabase.from("scholars").select("id").eq("slug", slug).maybeSingle();
  if (bySlug) {
    scholarCache.set(lookupName, bySlug.id);
    reused.push(`${scholarNameAr} → existing slug ${slug} #${bySlug.id}`);
    return bySlug.id;
  }

  created.push(`${scholarNameAr}${lookupName !== scholarNameAr ? ` (as ${lookupName})` : ""} → new slug ${slug}`);
  if (!apply) return -1; // placeholder for dry-run

  const { data: inserted, error } = await supabase
    .from("scholars")
    .insert({
      slug,
      name: lookupName,
      arabic_name: lookupName,
      tradition: null,
      birth_year_ah: null,
      death_year_ah: null,
      credentials: null,
      methodology: null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Insert scholar ${lookupName}: ${error.message}`);
  scholarCache.set(lookupName, inserted.id);
  return inserted.id;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const mappingApproved = args.includes("--mapping-approved");

  if (apply && !mappingApproved) {
    console.error("Refusing --apply without --mapping-approved (print mapping first, then re-run with both flags).");
    process.exit(1);
  }

  const supabase = adminClient();
  const aliases = loadAliases();
  const appraisals = loadAppraisals();
  const mappings = await loadChainMapping(supabase);
  const bySunnah = new Map(mappings.map((m) => [m.sunnahId, m]));

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Variation ${VARIATION_ID} ↔ Sunnah ID mapping (exact narrator_id from chain positions):\n`);
  console.log(
    "sunnah_id | pos | narrator_id | chain raw_name | DB arabic_name | Sunnah page name | label",
  );
  console.log("-".repeat(100));
  for (const m of mappings) {
    console.log(
      `${m.sunnahId} | ${m.position} | ${m.narratorId} | ${m.rawName} | ${m.arabicName} | ${m.sunnahPageNameAr} | ${m.label}`,
    );
  }
  console.log("");
  console.log(`Aliases loaded from ${ALIASES_CSV}: ${aliases.size}`);
  for (const [alias, canonical] of aliases) {
    console.log(`  ${alias}  →  ${canonical}`);
  }
  console.log("");

  if (!apply) {
    console.log("Review the mapping and aliases above. To write:");
    console.log("  npx tsx scripts/apply-sunnah-appraisals.ts --apply --mapping-approved\n");
  }

  const scholarCache = new Map<string, number>();
  // Prefill cache with all scholars
  const { data: allScholars } = await supabase.from("scholars").select("id, arabic_name, slug");
  for (const s of allScholars ?? []) {
    const ar = normalizeWs(s.arabic_name ?? "");
    if (ar) scholarCache.set(ar, s.id);
  }

  const created: string[] = [];
  const reused: string[] = [];
  const perNarrator = new Map<string, { would: number; inserted: number; skipped: number }>();
  for (const m of mappings) {
    perNarrator.set(m.sunnahId, { would: 0, inserted: 0, skipped: 0 });
  }

  let wouldInsert = 0;
  let inserted = 0;
  let skippedDup = 0;
  let skippedUnmapped = 0;

  // Resolve unique scholars first (stable order)
  const uniqueScholars = [...new Set(appraisals.map((r) => r.scholar_name_ar))];
  const scholarIdBySunnahName = new Map<string, number>();
  for (const name of uniqueScholars) {
    const id = await resolveScholarId(supabase, name, aliases, scholarCache, apply, created, reused);
    if (id != null && id !== -1) scholarIdBySunnahName.set(name, id);
    else if (!apply) scholarIdBySunnahName.set(name, -1);
  }

  for (const row of appraisals) {
    const map = bySunnah.get(row.narrator_sunnah_id);
    if (!map) {
      skippedUnmapped += 1;
      console.warn(`SKIP unmapped sunnah id ${row.narrator_sunnah_id}`);
      continue;
    }
    const stats = perNarrator.get(row.narrator_sunnah_id)!;
    const scholarId = scholarIdBySunnahName.get(row.scholar_name_ar);
    if (scholarId == null) {
      console.warn(`SKIP no scholar for ${row.scholar_name_ar}`);
      continue;
    }

    const payload = {
      narrator_id: map.narratorId,
      scholar_id: scholarId === -1 ? null : scholarId,
      original_term: row.original_term_ar,
      normalized_term: null as string | null,
      explanation: null as string | null,
      display_score: null as number | null,
      mapping_method: MAPPING_METHOD,
      reference_book: row.citation_book || null,
      edition: null as string | null,
      volume: null as string | null,
      page: null as string | null,
      source_url: row.source_url,
      verified: false,
    };

    if (!apply || scholarId === -1) {
      wouldInsert += 1;
      stats.would += 1;
      continue;
    }

    const { data: existing } = await supabase
      .from("narrator_assessments")
      .select("id")
      .eq("narrator_id", payload.narrator_id)
      .eq("scholar_id", scholarId)
      .eq("original_term", payload.original_term)
      .eq("source_url", payload.source_url)
      .maybeSingle();

    if (existing) {
      skippedDup += 1;
      stats.skipped += 1;
      continue;
    }

    const { error } = await supabase.from("narrator_assessments").insert({
      ...payload,
      scholar_id: scholarId,
    });
    if (error) throw new Error(`Insert assessment: ${error.message}`);
    inserted += 1;
    stats.inserted += 1;
  }

  console.log("=== Scholar resolution ===");
  console.log(`Would create / created new scholars: ${created.length}`);
  for (const line of created) console.log(`  NEW  ${line}`);
  console.log(`Matched existing (sample up to 15 unique):`);
  const uniqueReuse = [...new Set(reused)].slice(0, 15);
  for (const line of uniqueReuse) console.log(`  HIT  ${line}`);

  console.log("\n=== Rows per narrator ===");
  for (const m of mappings) {
    const s = perNarrator.get(m.sunnahId)!;
    if (apply) {
      console.log(
        `  sunnah/${m.sunnahId} narrator_id=${m.narratorId}: inserted ${s.inserted}, skipped_dup ${s.skipped}`,
      );
    } else {
      console.log(`  sunnah/${m.sunnahId} narrator_id=${m.narratorId}: would insert ${s.would}`);
    }
  }

  console.log("\n=== Totals ===");
  if (apply) {
    console.log(`Inserted: ${inserted}`);
    console.log(`Skipped duplicates: ${skippedDup}`);
    console.log(`Skipped unmapped: ${skippedUnmapped}`);
  } else {
    console.log(`Would insert assessments: ${wouldInsert}`);
    console.log(`Skipped unmapped: ${skippedUnmapped}`);
    console.log("No database writes in dry-run (except read).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
