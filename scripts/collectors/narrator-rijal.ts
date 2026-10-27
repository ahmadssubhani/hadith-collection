/**
 * Collector A — Narrator jarh wa taʿdīl + bio fields from local sourced CSVs / open datasets.
 * Never invents rulings. Dry-run by default.
 *
 * Looks for (first match wins per narrator):
 *   data/collectors/rijal/*.csv
 *   data/narrator-appraisals-review.csv
 *   data/narrator-appraisals-review-batch2.csv
 *   data/rijal-assessments.csv
 *
 * CSV columns (flexible):
 *   narrator_slug|narrator_name|narrator_arabic_name,
 *   scholar_slug|scholar|scholar_name_ar,
 *   original_term|original_term_ar, explanation?,
 *   reference_book|citation_book, volume?, page?, source_url?,
 *   kunya?, nisba?, tabaqah?, tradition?, birth_year_ah?, death_year_ah?
 *
 *   npx tsx scripts/collectors/narrator-rijal.ts
 *   npx tsx scripts/collectors/narrator-rijal.ts --apply
 */
import {
  APPLY,
  adminClient,
  ensureImportBatch,
  fetchAll,
  insertRawRecord,
  logMode,
  writeUnmatchedCsv,
} from "./_shared";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((x) => x.trim())) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => {
      o[h] = (r[idx] ?? "").trim();
    });
    return o;
  });
}

function loadSourceFiles(): { file: string; rows: Record<string, string>[] }[] {
  const out: { file: string; rows: Record<string, string>[] }[] = [];
  const candidates = [
    path.join("data", "narrator-appraisals-review.csv"),
    path.join("data", "narrator-appraisals-review-batch2.csv"),
    path.join("data", "rijal-assessments.csv"),
  ];
  const dir = path.join("data", "collectors", "rijal");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".csv"))) {
      candidates.push(path.join(dir, f));
    }
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!text.trim() || text.trim().split(/\r?\n/).length < 2) continue;
    out.push({ file, rows: parseCsv(text) });
  }
  return out;
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v) return v;
  }
  return "";
}

async function main() {
  logMode("collect:narrator-rijal (A)");
  const sb = adminClient();
  const sources = loadSourceFiles();
  if (!sources.length) {
    console.log("No rijal CSV sources found under data/collectors/rijal/ or known appraisal CSVs.");
    console.log("Place sourced CSVs there, then re-run. Logging gap for all narrators without assessments.");
  }

  const narrators = await fetchAll<{
    id: number;
    slug: string;
    name: string;
    arabic_name: string | null;
  }>(sb, "narrators", "id,slug,name,arabic_name");

  const { data: assessedRows } = await sb.from("narrator_assessments").select("narrator_id");
  const assessed = new Set((assessedRows ?? []).map((r) => r.narrator_id as number));
  const without = narrators.filter((n) => !assessed.has(n.id));
  console.log(`Narrators total=${narrators.length} with_assessment=${assessed.size} without=${without.length}`);

  const scholars = await fetchAll<{ id: number; slug: string; name: string; arabic_name: string | null }>(
    sb,
    "scholars",
    "id,slug,name,arabic_name"
  );
  const scholarBySlug = new Map(scholars.map((s) => [s.slug, s]));
  const scholarByName = new Map(
    scholars.flatMap((s) => {
      const keys = [s.name, s.arabic_name].filter(Boolean).map((x) => String(x).toLowerCase());
      return keys.map((k) => [k, s] as const);
    })
  );
  const narratorBySlug = new Map(narrators.map((n) => [n.slug, n]));
  const narratorByName = new Map(
    narrators.flatMap((n) => {
      const keys = [n.name, n.arabic_name].filter(Boolean).map((x) => String(x).toLowerCase());
      return keys.map((k) => [k, n] as const);
    })
  );

  type Plan = {
    file: string;
    narratorId: number;
    scholarId: number;
    originalTerm: string;
    explanation: string | null;
    referenceBook: string | null;
    volume: string | null;
    page: string | null;
    sourceUrl: string | null;
    bio?: Partial<{
      kunya: string;
      nisba: string;
      tabaqah: string;
      tradition: string;
      birth_year_ah: number;
      death_year_ah: number;
    }>;
  };

  const plans: Plan[] = [];
  const unmatched: (string | number | null)[][] = [];

  for (const src of sources) {
    for (const row of src.rows) {
      const narrKey = pick(row, "narrator_slug", "narrator_name", "narrator_arabic_name", "narrator_name_ar");
      const scholarKey = pick(row, "scholar_slug", "scholar", "scholar_name_ar", "scholar_name");
      const term = pick(row, "original_term", "original_term_ar");
      if (!narrKey || !scholarKey || !term) {
        unmatched.push([src.file, narrKey, scholarKey, term, "missing_required_fields"]);
        continue;
      }
      const narrator =
        narratorBySlug.get(narrKey) || narratorByName.get(narrKey.toLowerCase()) || null;
      const scholar =
        scholarBySlug.get(scholarKey) || scholarByName.get(scholarKey.toLowerCase()) || null;

      if (!narrator || !scholar) {
        unmatched.push([
          src.file,
          narrKey,
          scholarKey,
          term,
          !narrator ? "narrator_unmatched" : "scholar_unmatched",
        ]);
        continue;
      }

      const bio: Plan["bio"] = {};
      if (pick(row, "kunya")) bio.kunya = pick(row, "kunya");
      if (pick(row, "nisba")) bio.nisba = pick(row, "nisba");
      if (pick(row, "tabaqah", "generation")) bio.tabaqah = pick(row, "tabaqah", "generation");
      if (pick(row, "tradition")) bio.tradition = pick(row, "tradition");
      const by = pick(row, "birth_year_ah");
      const dy = pick(row, "death_year_ah");
      if (by && /^\d+$/.test(by)) bio.birth_year_ah = Number(by);
      if (dy && /^\d+$/.test(dy)) bio.death_year_ah = Number(dy);

      plans.push({
        file: src.file,
        narratorId: narrator.id,
        scholarId: scholar.id,
        originalTerm: term,
        explanation: pick(row, "explanation") || null,
        referenceBook: pick(row, "reference_book", "citation_book") || null,
        volume: pick(row, "volume") || null,
        page: pick(row, "page") || null,
        sourceUrl: pick(row, "source_url") || null,
        bio: Object.keys(bio).length ? bio : undefined,
      });
    }
  }

  console.log(`Planned assessment upserts: ${plans.length}; unmatched rows: ${unmatched.length}`);

  // Also log narrators still without any assessment and no plan
  const plannedNarratorIds = new Set(plans.map((p) => p.narratorId));
  for (const n of without) {
    if (!plannedNarratorIds.has(n.id)) {
      unmatched.push(["(gap)", n.slug, n.name, n.arabic_name, "no_source_ruling"]);
    }
  }
  writeUnmatchedCsv(
    "narrator-rijal.csv",
    ["file", "narrator_key", "scholar_key", "term_or_name", "reason"],
    unmatched
  );

  if (!plans.length) {
    console.log("Nothing to apply.");
    return;
  }

  const batchId = await ensureImportBatch(
    sb,
    "collector:narrator-rijal",
    null,
    `Jarh wa ta'dil from ${sources.map((s) => s.file).join("; ")} (${plans.length} plans)`,
    "mixed-local-csv",
    "unknown"
  );

  let written = 0;
  for (const p of plans) {
    await insertRawRecord(sb, batchId, `na-${p.narratorId}-${p.scholarId}-${p.originalTerm.slice(0, 40)}`, p);
    if (!APPLY) continue;

    const { data: existing } = await sb
      .from("narrator_assessments")
      .select("id")
      .eq("narrator_id", p.narratorId)
      .eq("scholar_id", p.scholarId)
      .eq("original_term", p.originalTerm)
      .maybeSingle();

    if (!existing) {
      const { error } = await sb.from("narrator_assessments").insert({
        narrator_id: p.narratorId,
        scholar_id: p.scholarId,
        original_term: p.originalTerm,
        explanation: p.explanation,
        reference_book: p.referenceBook,
        volume: p.volume,
        page: p.page,
        source_url: p.sourceUrl,
        verified: false,
        mapping_method: "collector:narrator-rijal",
      });
      if (error) throw new Error(error.message);
      written++;
    }

    if (p.bio) {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.bio)) {
        if (v != null && v !== "") patch[k] = v;
      }
      if (Object.keys(patch).length) {
        await sb.from("narrators").update(patch).eq("id", p.narratorId);
      }
    }
  }

  console.log(APPLY ? `Wrote ${written} new narrator_assessments` : `Dry-run: ${plans.length} plans ready`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
