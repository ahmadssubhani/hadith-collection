/**
 * Import Dorar.net hadith-level gradings from local saved API JSON.
 * NO network calls. Reads only data/dorar/*.json.
 *
 * Usage:
 *   npx tsx scripts/import-dorar-gradings.ts           # dry-run (default)
 *   npx tsx scripts/import-dorar-gradings.ts --apply   # one transaction
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import type { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";

const APPLY = process.argv.includes("--apply");
const DORAR_DIR = path.join(process.cwd(), "data", "dorar");
const ALIASES_CSV = path.join(process.cwd(), "data", "scholar-aliases.csv");
const UNMATCHED_CSV = path.join(process.cwd(), "data", "dorar-unmatched.csv");

/** Sahih al-Bukhari hadith_number → source_variations.id (Sunnah.com First Wahi set). */
const BUKHARI_VARIATION: Record<string, number> = {
  "1": 271,
  "2": 273,
  "3": 275,
  "4": 276,
  "5": 279,
  "6": 280,
  "7": 282,
};

const TARGET_BOOK = "صحيح البخاري";

type ParsedEntry = {
  file: string;
  entryNumber: number;
  hadithText: string;
  narrator: string;
  grader: string;
  book: string;
  pageOrNumber: string;
  verdict: string;
  searchUrl: string;
  rawHtmlChunk: string;
};

type ScholarPlan = {
  graderAr: string;
  lookupAr: string;
  scholarId: number | null;
  action: "reuse" | "create";
};

type InsertPlan = {
  entry: ParsedEntry;
  variationId: number;
  hadithNumber: string;
  scholar: ScholarPlan;
  skipDuplicate: boolean;
};

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function decodeBasicEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function loadAliases(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ALIASES_CSV)) return map;
  const text = readFileSync(ALIASES_CSV, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return map;
  const headers = lines[0].split(",").map((h) => h.trim());
  const aliasIdx = headers.indexOf("alias_ar");
  const canonIdx = headers.indexOf("canonical_ar");
  if (aliasIdx < 0 || canonIdx < 0) return map;
  for (const line of lines.slice(1)) {
    // simple CSV (aliases file has no quoted commas today)
    const cols = line.split(",");
    const alias = normalizeWs(cols[aliasIdx] ?? "");
    const canonical = normalizeWs(cols[canonIdx] ?? "");
    if (alias && canonical) map.set(alias, canonical);
  }
  return map;
}

function scholarSlug(arabicName: string): string {
  const hash = createHash("sha256").update(arabicName).digest("hex").slice(0, 10);
  return `dorar-${hash}`;
}

/** Strip HTML tags and search-keys spans; keep Arabic text as-is. */
function textFromHadith($el: Cheerio<AnyNode>): string {
  const clone = $el.clone();
  clone.find("span.search-keys, .search-keys").remove();
  return normalizeWs(clone.text());
}

function extractLabeledField(blockText: string, label: string, nextLabels: string[]): string {
  const next = nextLabels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+?)(?=${next}|$)`, "s");
  const m = blockText.match(re);
  return m ? normalizeWs(m[1].replace(/المزيد\s*$/u, "").trim()) : "";
}

function parseHtmlResult(html: string, file: string): ParsedEntry[] {
  const decoded = decodeBasicEntities(html);
  const chunks = decoded
    .split(/--------------+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 20 && /hadith|المحدث|المصدر/i.test(c));

  const entries: ParsedEntry[] = [];
  let entryNumber = 0;

  for (const chunk of chunks) {
    const $ = cheerio.load(`<div class="dorar-wrap">${chunk}</div>`);
    const hadithEl = $(".hadith").first();
    if (!hadithEl.length) continue;

    entryNumber += 1;
    const hadithText = textFromHadith(hadithEl);

    // Prefer structured info region; fall back to whole chunk text
    const infoEl = $(".hadith-info").first();
    const infoText = normalizeWs(infoEl.length ? infoEl.text() : $.root().text());

    const narrator = extractLabeledField(infoText, "الراوي", ["المحدث", "المصدر", "الصفحة", "خلاصة"]);
    const grader = extractLabeledField(infoText, "المحدث", ["المصدر", "الصفحة", "خلاصة", "الراوي"]);
    const book = extractLabeledField(infoText, "المصدر", ["الصفحة", "خلاصة", "المحدث", "الراوي"]);
    const pageOrNumber = extractLabeledField(infoText, "الصفحة أو الرقم", ["خلاصة", "المحدث", "المصدر", "الراوي"]);
    let verdict = extractLabeledField(infoText, "خلاصة حكم المحدث", ["المزيد", "الراوي", "المحدث"]);
    if (!verdict) {
      verdict = extractLabeledField(infoText, "درجة الحديث", ["المزيد", "الراوي", "المحدث"]);
    }

    // Also try strong-label HTML patterns used by some Dorar payloads
    const pickAfterStrong = (label: string): string => {
      let found = "";
      $("strong, b").each((_, el) => {
        const t = normalizeWs($(el).text());
        if (t.includes(label) && !found) {
          const parentText = normalizeWs($(el).parent().text());
          const after = parentText.split(label)[1] ?? "";
          found = normalizeWs(after.replace(/^[:：]\s*/, "").split(/(?=الراوي|المحدث|المصدر|الصفحة|خلاصة|المزيد)/)[0]);
        }
      });
      return found;
    };

    const book2 = book || pickAfterStrong("المصدر");
    const page2 = pageOrNumber || pickAfterStrong("الصفحة أو الرقم");
    const grader2 = grader || pickAfterStrong("المحدث");
    const verdict2 = verdict || pickAfterStrong("خلاصة حكم المحدث") || pickAfterStrong("درجة الحديث");
    const narrator2 = narrator || pickAfterStrong("الراوي");

    let searchUrl = "";
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const label = normalizeWs($(el).text());
      if (/dorar\.net/i.test(href) && (label.includes("المزيد") || /hadith\/search/i.test(href))) {
        searchUrl = href.startsWith("http") ? href : `https://dorar.net${href.startsWith("/") ? "" : "/"}${href}`;
      }
    });
    if (!searchUrl) {
      $("a[href*='hadith/search']").each((_, el) => {
        if (searchUrl) return;
        const href = $(el).attr("href") ?? "";
        searchUrl = href.startsWith("http") ? href : `https://dorar.net${href.startsWith("/") ? "" : "/"}${href}`;
      });
    }

    entries.push({
      file,
      entryNumber,
      hadithText,
      narrator: narrator2,
      grader: grader2,
      book: book2,
      pageOrNumber: page2,
      verdict: verdict2,
      searchUrl,
      rawHtmlChunk: chunk,
    });
  }

  // Fallback: some payloads wrap cards without -------------- separators
  if (!entries.length) {
    const $ = cheerio.load(decoded);
    $(".hadith").each((i, el) => {
      const card = $(el).closest(".border, .hadith-info").parent();
      const scope = card.length ? card : $(el).parent();
      const chunkHtml = $.html(scope) || $.html(el) || "";
      const sub = parseHtmlResult(`${chunkHtml}--------------`, file);
      for (const e of sub) {
        entries.push({ ...e, entryNumber: i + 1 });
      }
    });
  }

  return entries;
}

function parseDorarFile(filePath: string): ParsedEntry[] {
  const file = path.basename(filePath);
  const raw = readFileSync(filePath, "utf8");
  let json: { ahadith?: { result?: string } };
  try {
    json = JSON.parse(raw) as { ahadith?: { result?: string } };
  } catch {
    throw new Error(`${file}: not valid JSON`);
  }
  if (typeof json.ahadith?.result !== "string") {
    throw new Error(`${file}: missing ahadith.result string`);
  }
  return parseHtmlResult(json.ahadith.result, file);
}

function normalizeHadithNumber(pageOrNumber: string): string | null {
  const cleaned = normalizeWs(pageOrNumber).replace(/[^\d]/g, "");
  if (!cleaned) return null;
  // Dorar sometimes shows "1" or "1 / 1" — take leading integer
  const m = normalizeWs(pageOrNumber).match(/(\d+)/);
  return m ? String(Number(m[1])) : null;
}

function matchReason(entry: ParsedEntry): { ok: true; variationId: number; num: string } | { ok: false; reason: string } {
  if (normalizeWs(entry.book) !== TARGET_BOOK) {
    return { ok: false, reason: `book_not_sahih_bukhari:${entry.book || "(empty)"}` };
  }
  const num = normalizeHadithNumber(entry.pageOrNumber);
  if (!num) return { ok: false, reason: "missing_or_unparseable_number" };
  const variationId = BUKHARI_VARIATION[num];
  if (!variationId) return { ok: false, reason: `bukhari_number_out_of_range:${num}` };
  return { ok: true, variationId, num };
}

function printSchemaReport() {
  console.log("STEP 1 — schema (relevant columns)");
  console.log(
    "  hadith_assessments: id, variation_id→source_variations, scholar_id→scholars,",
  );
  console.log(
    "    original_grade, normalized_grade, explanation, reference_book, edition, volume, page, source_url, verified",
  );
  console.log(
    "  scholars: id, slug UNIQUE, name, arabic_name, tradition, birth_year_ah, death_year_ah, credentials, methodology",
  );
  console.log(
    "  import_batches: id, provider, source_url, license, permission_status, retrieved_at, checksum, notes",
  );
  console.log(
    "  raw_import_records: id, batch_id→import_batches, external_id, raw_payload jsonb,",
  );
  console.log("    processing_status, processing_error, created_at; UNIQUE(batch_id, external_id)");
  console.log("");
}

async function loadExistingAssessments(sb: SupabaseClient): Promise<{
  count: number;
  keys: Set<string>;
}> {
  const variationIds = Object.values(BUKHARI_VARIATION);
  const { data, error } = await sb
    .from("hadith_assessments")
    .select("id, variation_id, scholar_id, reference_book, page");
  if (error) throw error;
  const rows = data ?? [];
  const keys = new Set<string>();
  for (const r of rows) {
    keys.add(
      `${r.variation_id}|${r.scholar_id}|${normalizeWs(r.reference_book ?? "")}|${normalizeWs(r.page ?? "")}`,
    );
  }
  const onTarget = rows.filter((r) => variationIds.includes(r.variation_id)).length;
  void onTarget;
  return { count: rows.length, keys };
}

async function resolveScholars(
  sb: SupabaseClient,
  graders: string[],
  aliases: Map<string, string>,
): Promise<Map<string, ScholarPlan>> {
  const { data: allScholars, error } = await sb.from("scholars").select("id, arabic_name, name, slug");
  if (error) throw error;
  const byArabic = new Map<string, number>();
  for (const s of allScholars ?? []) {
    const ar = normalizeWs(s.arabic_name ?? "");
    if (ar) byArabic.set(ar, s.id);
  }

  const out = new Map<string, ScholarPlan>();
  for (const grader of graders) {
    const g = normalizeWs(grader);
    if (!g) continue;
    if (out.has(g)) continue;
    const lookup = aliases.get(g) ?? g;
    const existingId = byArabic.get(lookup) ?? byArabic.get(g) ?? null;
    out.set(g, {
      graderAr: g,
      lookupAr: lookup,
      scholarId: existingId,
      action: existingId != null ? "reuse" : "create",
    });
  }
  return out;
}

async function dryRunAndMaybeApply() {
  printSchemaReport();

  mkdirSync(DORAR_DIR, { recursive: true });
  const files = readdirSync(DORAR_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort()
    .map((f) => path.join(DORAR_DIR, f));

  if (!files.length) {
    console.error(`No JSON files in ${DORAR_DIR}`);
    console.error("Place saved dorar_api.json responses there ({\"ahadith\":{\"result\":\"<html>\"}}), then re-run.");
    process.exit(1);
  }

  console.log(`Files: ${files.map((f) => path.basename(f)).join(", ")}\n`);

  const allEntries: ParsedEntry[] = [];
  for (const fp of files) {
    const parsed = parseDorarFile(fp);
    allEntries.push(...parsed);
  }

  console.log("STEP 2 — parsed entries");
  console.log("file | # | book | number | grader | verdict");
  console.log("-".repeat(100));
  for (const e of allEntries) {
    const verdictPreview = (e.verdict || "").slice(0, 60);
    console.log(
      `${e.file} | ${e.entryNumber} | ${e.book || "—"} | ${e.pageOrNumber || "—"} | ${e.grader || "—"} | ${verdictPreview}`,
    );
  }
  console.log("");

  const unmatched: Array<ParsedEntry & { reason: string }> = [];
  const matched: Array<{ entry: ParsedEntry; variationId: number; num: string }> = [];
  for (const e of allEntries) {
    const m = matchReason(e);
    if (m.ok) matched.push({ entry: e, variationId: m.variationId, num: m.num });
    else unmatched.push({ ...e, reason: m.reason });
  }

  const unmatchedLines = [
    "file,entry_number,book,page_or_number,grader,verdict_preview,reason,search_url",
  ];
  for (const u of unmatched) {
    unmatchedLines.push(
      [
        u.file,
        u.entryNumber,
        u.book,
        u.pageOrNumber,
        u.grader,
        (u.verdict || "").slice(0, 80),
        u.reason,
        u.searchUrl,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  writeFileSync(UNMATCHED_CSV, unmatchedLines.join("\n") + "\n", "utf8");
  console.log(`STEP 3 — matched ${matched.length}; unmatched ${unmatched.length} → ${UNMATCHED_CSV}`);

  const matchedPerVar = new Map<number, number>();
  for (const m of matched) {
    matchedPerVar.set(m.variationId, (matchedPerVar.get(m.variationId) ?? 0) + 1);
  }
  for (const [num, vid] of Object.entries(BUKHARI_VARIATION)) {
    console.log(`  Bukhari #${num} → variation ${vid}: ${matchedPerVar.get(vid) ?? 0} matched grading(s)`);
  }
  console.log("");

  const sb = adminClient();
  const aliases = loadAliases();
  const graders = [...new Set(matched.map((m) => normalizeWs(m.entry.grader)).filter(Boolean))];
  const scholarPlans = await resolveScholars(sb, graders, aliases);

  console.log("STEP 4 — scholars");
  const toCreate = [...scholarPlans.values()].filter((s) => s.action === "create");
  const toReuse = [...scholarPlans.values()].filter((s) => s.action === "reuse");
  for (const s of toReuse) {
    console.log(`  REUSE  ${s.graderAr}${s.lookupAr !== s.graderAr ? ` (alias→${s.lookupAr})` : ""} → id=${s.scholarId}`);
  }
  if (toCreate.length) {
    console.log("  Unknown graders (will create with arabic_name only, no tradition/dates):");
    for (const s of toCreate) {
      console.log(`  CREATE ${s.graderAr} → slug ${scholarSlug(s.lookupAr)}`);
    }
  } else {
    console.log("  No new scholars needed.");
  }
  console.log("");

  const { count: existingCount, keys: existingKeys } = await loadExistingAssessments(sb);
  console.log(`Existing hadith_assessments rows (all): ${existingCount} (will not modify them)`);

  // Assign temporary negative ids for dry-run creates so duplicate-key logic works within this run
  let tempScholarId = -1;
  const resolvedScholarId = new Map<string, number>();
  for (const [g, plan] of scholarPlans) {
    if (plan.scholarId != null) resolvedScholarId.set(g, plan.scholarId);
    else resolvedScholarId.set(g, tempScholarId--);
  }

  const insertPlans: InsertPlan[] = [];
  const runKeys = new Set<string>();
  for (const m of matched) {
    const grader = normalizeWs(m.entry.grader);
    const scholar = scholarPlans.get(grader);
    if (!scholar) {
      unmatched.push({ ...m.entry, reason: "missing_grader" });
      continue;
    }
    const scholarId = resolvedScholarId.get(grader)!;
    const key = `${m.variationId}|${scholarId}|${normalizeWs(m.entry.book)}|${normalizeWs(m.entry.pageOrNumber)}`;
    // For create scholars, also check against existing by looking up after create — dry-run uses temp ids
    let skipDuplicate = false;
    if (scholar.action === "reuse" && scholar.scholarId != null) {
      const realKey = `${m.variationId}|${scholar.scholarId}|${normalizeWs(m.entry.book)}|${normalizeWs(m.entry.pageOrNumber)}`;
      if (existingKeys.has(realKey) || runKeys.has(realKey)) skipDuplicate = true;
      runKeys.add(realKey);
    } else {
      if (runKeys.has(key)) skipDuplicate = true;
      runKeys.add(key);
    }
    insertPlans.push({
      entry: m.entry,
      variationId: m.variationId,
      hadithNumber: m.num,
      scholar,
      skipDuplicate,
    });
  }

  const toInsert = insertPlans.filter((p) => !p.skipDuplicate);
  const skippedDup = insertPlans.filter((p) => p.skipDuplicate);

  console.log("\nSTEP 5–6 — import plan (raw batch + hadith_assessments)");
  console.log(`  import_batches: provider=dorar.net, notes=files: ${files.map((f) => path.basename(f)).join(", ")}`);
  console.log(`  raw_import_records: ${allEntries.length} (every parsed entry, status=parsed)`);
  console.log(`  hadith_assessments to insert: ${toInsert.length} (skip duplicates: ${skippedDup.length})`);
  console.log(`  verified=false; normalized_grade=NULL; explanation=NULL; no scores`);

  const perVarInsert = new Map<number, number>();
  for (const p of toInsert) {
    perVarInsert.set(p.variationId, (perVarInsert.get(p.variationId) ?? 0) + 1);
  }
  for (const [num, vid] of Object.entries(BUKHARI_VARIATION)) {
    console.log(`  insert → variation ${vid} (Bukhari #${num}): ${perVarInsert.get(vid) ?? 0}`);
  }

  console.log("\n--- SUMMARY ---");
  console.log(`  entries parsed: ${allEntries.length}`);
  console.log(`  matched (Bukhari 1–7): ${matched.length}`);
  console.log(`  unmatched: ${unmatched.length}`);
  console.log(`  new scholars: ${toCreate.length}`);
  console.log(`  rows to insert: ${toInsert.length}`);
  console.log(`  duplicates skipped: ${skippedDup.length}`);

  if (!APPLY) {
    console.log("\nDRY-RUN only. No database writes.");
    console.log("Rollback SQL (after apply) would look like:");
    console.log("  BEGIN;");
    console.log("  DELETE FROM public.hadith_assessments WHERE id IN (<new_ids>);");
    console.log("  DELETE FROM public.raw_import_records WHERE batch_id = <batch_id>;");
    console.log("  DELETE FROM public.import_batches WHERE id = <batch_id>;");
    console.log("  -- optional: DELETE FROM public.scholars WHERE id IN (<new_scholar_ids>);");
    console.log("  COMMIT;");
    console.log("Re-run with --apply to write.");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for --apply (single transaction)");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const insertedAssessmentIds: number[] = [];
  const createdScholarIds: number[] = [];
  let batchId = 0;

  try {
    await client.query("BEGIN");

    const fileNames = files.map((f) => path.basename(f)).join(", ");
    const checksum = createHash("sha256")
      .update(files.map((f) => readFileSync(f)).join("|"))
      .digest("hex");

    const batchRes = await client.query<{ id: number }>(
      `INSERT INTO public.import_batches (provider, source_url, permission_status, checksum, notes)
       VALUES ('dorar.net', 'https://dorar.net/hadith', 'local_files', $1, $2)
       RETURNING id`,
      [checksum, `Local dorar_api.json files: ${fileNames}`],
    );
    batchId = batchRes.rows[0].id;

    for (const e of allEntries) {
      const externalId = `${e.book || "unknown"}|${e.pageOrNumber || "?"}|${e.grader || "?"}|${e.file}#${e.entryNumber}`;
      await client.query(
        `INSERT INTO public.raw_import_records (batch_id, external_id, raw_payload, processing_status)
         VALUES ($1, $2, $3::jsonb, 'parsed')
         ON CONFLICT (batch_id, external_id) DO UPDATE
           SET raw_payload = EXCLUDED.raw_payload, processing_status = 'parsed'`,
        [
          batchId,
          externalId.slice(0, 500),
          JSON.stringify({
            file: e.file,
            entry_number: e.entryNumber,
            narrator: e.narrator,
            grader: e.grader,
            book: e.book,
            page_or_number: e.pageOrNumber,
            verdict: e.verdict,
            search_url: e.searchUrl,
            hadith_text: e.hadithText,
            html: e.rawHtmlChunk,
          }),
        ],
      );
    }

    const scholarIdByGrader = new Map<string, number>();
    for (const [g, plan] of scholarPlans) {
      if (plan.action === "reuse" && plan.scholarId != null) {
        scholarIdByGrader.set(g, plan.scholarId);
        continue;
      }
      const slug = scholarSlug(plan.lookupAr);
      const existing = await client.query<{ id: number }>(
        `SELECT id FROM public.scholars WHERE arabic_name = $1 OR slug = $2 LIMIT 1`,
        [plan.lookupAr, slug],
      );
      if (existing.rows[0]) {
        scholarIdByGrader.set(g, existing.rows[0].id);
        continue;
      }
      const ins = await client.query<{ id: number }>(
        `INSERT INTO public.scholars (slug, name, arabic_name, tradition, birth_year_ah, death_year_ah, credentials, methodology)
         VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL)
         RETURNING id`,
        [slug, plan.lookupAr, plan.lookupAr],
      );
      createdScholarIds.push(ins.rows[0].id);
      scholarIdByGrader.set(g, ins.rows[0].id);
    }

    for (const p of toInsert) {
      const grader = normalizeWs(p.entry.grader);
      const scholarId = scholarIdByGrader.get(grader);
      if (scholarId == null) continue;

      const dup = await client.query<{ id: number }>(
        `SELECT id FROM public.hadith_assessments
         WHERE variation_id = $1 AND scholar_id = $2
           AND COALESCE(reference_book,'') = $3 AND COALESCE(page,'') = $4
         LIMIT 1`,
        [p.variationId, scholarId, p.entry.book, p.entry.pageOrNumber],
      );
      if (dup.rows[0]) continue;

      const ins = await client.query<{ id: number }>(
        `INSERT INTO public.hadith_assessments
           (variation_id, scholar_id, original_grade, normalized_grade, explanation,
            reference_book, page, source_url, verified)
         VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, false)
         RETURNING id`,
        [
          p.variationId,
          scholarId,
          p.entry.verdict,
          p.entry.book,
          p.entry.pageOrNumber,
          p.entry.searchUrl || null,
        ],
      );
      insertedAssessmentIds.push(ins.rows[0].id);
    }

    await client.query("COMMIT");

    console.log("\nAPPLY complete.");
    console.log(`  import_batches.id = ${batchId}`);
    console.log(`  new scholars: ${createdScholarIds.length} ids=[${createdScholarIds.join(",")}]`);
    console.log(`  hadith_assessments inserted: ${insertedAssessmentIds.length} ids=[${insertedAssessmentIds.join(",")}]`);
    console.log("\nRollback SQL:");
    console.log("  BEGIN;");
    if (insertedAssessmentIds.length) {
      console.log(`  DELETE FROM public.hadith_assessments WHERE id IN (${insertedAssessmentIds.join(",")});`);
    } else {
      console.log("  -- no hadith_assessments inserted");
    }
    console.log(`  DELETE FROM public.raw_import_records WHERE batch_id = ${batchId};`);
    console.log(`  DELETE FROM public.import_batches WHERE id = ${batchId};`);
    if (createdScholarIds.length) {
      console.log(`  DELETE FROM public.scholars WHERE id IN (${createdScholarIds.join(",")});`);
    }
    console.log("  COMMIT;");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

dryRunAndMaybeApply().catch((err) => {
  console.error(err);
  process.exit(1);
});
