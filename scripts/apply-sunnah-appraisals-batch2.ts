/**
 * Batch 2: Bukhari 1,2,4,5,6,7 Sunnah appraisals + Ibn al-Mubarak (4716) create.
 *
 * Usage:
 *   npx tsx scripts/apply-sunnah-appraisals-batch2.ts                  # dry-run (fetch+parse only)
 *   npx tsx scripts/apply-sunnah-appraisals-batch2.ts --apply --mapping-approved
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as cheerio from "cheerio";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const USER_AGENT =
  "HadithCollectionResearchBot/1.0 (+local batch2 importer; Critical Appraisals; verified=false)";
const REQUEST_GAP_MS = 2000;
const RAW_DIR = path.join(process.cwd(), "data", "raw");
const DATA_DIR = path.join(process.cwd(), "data");
const MAPPING_JSON = path.join(DATA_DIR, "bukhari-batch2-mapping.json");
const ALIASES_CSV = path.join(DATA_DIR, "scholar-aliases.csv");
const APPRAISALS_CSV = path.join(DATA_DIR, "narrator-appraisals-review-batch2.csv");
const REVIEW_SHEET = path.join(DATA_DIR, "appraisal-review-sheet-batch2.md");
const MAPPING_METHOD = "sunnah_com_import";

/** Approved: link أبيه → 968 */
const APPROVED_UPDATES: Array<{ chainNarratorId: number; narratorId: number }> = [
  { chainNarratorId: 1256, narratorId: 968 },
];

/** Sunnah 4716 — create NEW narrator, then link these NULL nodes */
const MUBARAK_SUNNAH_ID = "4716";
const MUBARAK_CHAIN_NARRATOR_IDS = [1273, 1277, 1281];

type ToImport = { sunnahId: string; name: string; narratorIds: number[] };

type AppraisalRow = {
  narrator_sunnah_id: string;
  narrator_name_ar: string;
  scholar_name_ar: string;
  original_term_ar: string;
  citation_book: string;
  source_url: string;
  verified: string;
};

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function narratorUrl(id: string) {
  return `https://sunnah.com/narrator/${id}`;
}

function cachePath(id: string) {
  return path.join(RAW_DIR, `sunnah-narrator-${id}.html`);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, string>[]) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? "")).join(","));
  }
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
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

function citationBookFromWording(term: string): string {
  const patterns = [
    /تذهيب التهذيب/,
    /تحرير تقريب التهذيب/,
    /تقريب التهذيب/,
    /تهذيب التهذيب/,
    /التقريب/,
    /الضعفاء والمتروكين/,
    /الضعفاء/,
    /الثقات/,
    /ميزان الاعتدال/,
    /الميزان/,
    /سير أعلام النبلاء/,
    /الجرح والتعديل/,
    /التهذيب/,
    /التاريخ الكبير/,
    /تاريخ بغداد/,
  ];
  for (const re of patterns) {
    const m = term.match(re);
    if (m) return m[0];
  }
  return "";
}

function looksGarbled(term: string): boolean {
  if (/؟؟/.test(term)) return true;
  if (/�|\uFFFD/.test(term)) return true;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(term)) return true;
  // Broken Latin/mojibake mixed into Arabic appraisal
  if (/[A-Za-z]{4,}/.test(term) && /[\u0600-\u06FF]/.test(term) && /Ã.|Â.|Ø.|Ù./.test(term)) {
    return true;
  }
  return false;
}

/** Honorific / identity-only language (Companions etc.) — flag separately, do not drop. */
function looksHonorificOnly(term: string): boolean {
  const t = term;
  const honorificHints = [
    "أم المؤمنين",
    "رضي الله عنه",
    "رضي الله عنها",
    "رضى الله عنه",
    "رضى الله عنها",
    "صحابي",
    "من الصحابة",
    "أحد الصحابة",
    "حبر الأمة",
    "ترجمان القرآن",
    "ابن عم رسول الله",
    "زوج النبي",
    "زوجة رسول الله",
    "حبيبة رسول الله",
  ];
  const gradeHints = [
    "ثقة",
    "صدوق",
    "ضعيف",
    "ثبت",
    "حجة",
    "متروك",
    "كذاب",
    "مدلس",
    "احتج",
    "صحيح الحديث",
    "ليس بثقة",
    "يكتب حديثه",
  ];
  const hasHonor = honorificHints.some((h) => t.includes(h));
  const hasGrade = gradeHints.some((h) => t.includes(h));
  if (hasHonor && !hasGrade) return true;
  // Short identity-only lines
  if (/^(أم المؤمنين|صحابي|من كبار الصحابة)/.test(t) && t.length < 80) return true;
  return false;
}

async function loadHtml(sunnahId: string): Promise<string> {
  const file = cachePath(sunnahId);
  if (existsSync(file) && readFileSync(file, "utf8").length > 1000) {
    console.log(`  cache hit  ${file}`);
    return readFileSync(file, "utf8");
  }
  const url = narratorUrl(sunnahId);
  console.log(`  fetching   ${url}`);
  mkdirSync(RAW_DIR, { recursive: true });
  await execFileAsync(
    "curl.exe",
    ["-sS", "-L", "-A", USER_AGENT, "-H", "Accept: text/html,application/xhtml+xml", "-o", file, url],
    { timeout: 60000 },
  );
  if (!existsSync(file) || readFileSync(file, "utf8").length < 500) {
    throw new Error(`Empty download for ${url}`);
  }
  await delay(REQUEST_GAP_MS);
  return readFileSync(file, "utf8");
}

function extractAppraisals(sunnahId: string, html: string): {
  appraisals: AppraisalRow[];
  narratorNameAr: string;
} {
  const $ = cheerio.load(html);
  const source_url = narratorUrl(sunnahId);
  const narratorNameAr = normalizeWs($("h1.hero-title.arabic").first().text()) || "";

  const appraisals: AppraisalRow[] = [];
  const section = $("section.mb-section")
    .filter((_, el) => {
      const titles = $(el)
        .find(".section-title")
        .map((__, t) => normalizeWs($(t).text()))
        .get();
      return titles.some((t) => t === "Critical Appraisals" || t === "الجرح والتعديل");
    })
    .first();

  section.find("div.verdict.verdict--ar").each((_, el) => {
    const scholar = normalizeWs($(el).find(".verdict-scholar").first().text());
    const term = normalizeWs($(el).find(".critic-quote").first().text());
    if (!scholar || !term) return;
    appraisals.push({
      narrator_sunnah_id: sunnahId,
      narrator_name_ar: narratorNameAr,
      scholar_name_ar: scholar,
      original_term_ar: term,
      citation_book: citationBookFromWording(term),
      source_url,
      verified: "false",
    });
  });

  return { appraisals, narratorNameAr };
}

const AR_MAP: Record<string, string> = {
  ا: "a",
  أ: "a",
  إ: "i",
  آ: "a",
  ب: "b",
  ت: "t",
  ث: "th",
  ج: "j",
  ح: "h",
  خ: "kh",
  د: "d",
  ذ: "dh",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "q",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  و: "w",
  ي: "y",
  ى: "y",
  ة: "h",
  ء: "",
  ئ: "y",
  ؤ: "w",
};

function slugifyArabic(name: string): string {
  const n = name
    .normalize("NFD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/ال/g, "al-");
  let out = "";
  for (const ch of n) {
    if (ch === " " || ch === "-") out += "-";
    else if (AR_MAP[ch]) out += AR_MAP[ch];
    else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
  }
  out = out.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (out.length >= 3) return out.slice(0, 60);
  return `ar-${Buffer.from(n).toString("hex").slice(0, 16)}`;
}

function scholarSlug(arabicName: string): string {
  const hash = createHash("sha256").update(arabicName).digest("hex").slice(0, 10);
  return `sunnah-${hash}`;
}

function loadAliases(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ALIASES_CSV)) return map;
  for (const row of parseCsv(readFileSync(ALIASES_CSV, "utf8"))) {
    const alias = normalizeWs(row.alias_ar ?? "");
    const canonical = normalizeWs(row.canonical_ar ?? "");
    if (!alias || !canonical) continue;
    map.set(alias, canonical);
  }
  return map;
}

async function resolveScholarId(
  supabase: SupabaseClient,
  scholarNameAr: string,
  aliases: Map<string, string>,
  scholarCache: Map<string, number>,
  apply: boolean,
  created: string[],
  createdScholarIds: number[],
): Promise<number | null> {
  const lookupName = aliases.get(scholarNameAr) ?? scholarNameAr;
  if (scholarCache.has(lookupName)) return scholarCache.get(lookupName)!;

  const { data: byArabic } = await supabase
    .from("scholars")
    .select("id, arabic_name")
    .eq("arabic_name", lookupName)
    .maybeSingle();
  if (byArabic) {
    scholarCache.set(lookupName, byArabic.id);
    return byArabic.id;
  }
  if (lookupName !== scholarNameAr) {
    const { data: bySource } = await supabase
      .from("scholars")
      .select("id")
      .eq("arabic_name", scholarNameAr)
      .maybeSingle();
    if (bySource) {
      scholarCache.set(scholarNameAr, bySource.id);
      return bySource.id;
    }
  }

  const slug = scholarSlug(lookupName);
  const { data: bySlug } = await supabase.from("scholars").select("id").eq("slug", slug).maybeSingle();
  if (bySlug) {
    scholarCache.set(lookupName, bySlug.id);
    return bySlug.id;
  }

  created.push(`${scholarNameAr}${lookupName !== scholarNameAr ? ` (as ${lookupName})` : ""} → ${slug}`);
  if (!apply) return -1;

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
  createdScholarIds.push(inserted.id);
  return inserted.id;
}

function writeReviewSheet(
  appraisals: AppraisalRow[],
  sunnahToNarrator: Map<string, { narratorId: number; nameAr: string }>,
  garbled: AppraisalRow[],
): void {
  const bySunnah = new Map<string, AppraisalRow[]>();
  for (const row of appraisals) {
    const list = bySunnah.get(row.narrator_sunnah_id) ?? [];
    list.push(row);
    bySunnah.set(row.narrator_sunnah_id, list);
  }

  const lines: string[] = [
    "# Appraisal review sheet — batch 2 (Bukhari 1,2,4,5,6,7 + Ibn al-Mubarak)",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Total appraisal rows: ${appraisals.length}`,
    `Narrators: ${bySunnah.size}`,
    "verified=false · mapping_method=sunnah_com_import · no display_score",
    "",
  ];

  const honorificSection: string[] = [];
  const jarhFlags: string[] = [];

  for (const [sid, rows] of [...bySunnah.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const meta = sunnahToNarrator.get(sid);
    const name = rows[0]?.narrator_name_ar || meta?.nameAr || "";
    const nid = meta?.narratorId ?? "?";
    lines.push(`## ${sid} — ${name} (DB narrator_id=${nid}, ${rows.length} rows)`);
    lines.push("");

    const honorificRows: AppraisalRow[] = [];
    const mainRows: AppraisalRow[] = [];
    for (const r of rows) {
      if (looksHonorificOnly(r.original_term_ar)) honorificRows.push(r);
      else mainRows.push(r);
    }

    let i = 1;
    for (const r of mainRows) {
      lines.push(`${i}. **${r.scholar_name_ar}**`);
      lines.push(`   ${r.original_term_ar}`);
      if (r.citation_book) lines.push(`   citation_book: ${r.citation_book}`);
      if (looksGarbled(r.original_term_ar)) {
        lines.push(`   ⚠ GARBLED (kept — decide)`);
        jarhFlags.push(`[${sid}] ${r.scholar_name_ar}: garbled characters`);
      }
      i += 1;
    }

    if (honorificRows.length) {
      lines.push("");
      lines.push("### Honorific / identity-only (kept as-is — decide how to label)");
      for (const r of honorificRows) {
        lines.push(`- **${r.scholar_name_ar}**: ${r.original_term_ar}`);
        honorificSection.push(`[${sid} / narrator_id=${nid}] ${r.scholar_name_ar}: ${r.original_term_ar}`);
      }
    }
    lines.push("");
  }

  lines.push("## Garbled rows (flagged, not dropped)");
  if (!garbled.length) {
    lines.push("None.");
  } else {
    for (const r of garbled) {
      lines.push(`- [${r.narrator_sunnah_id}] ${r.scholar_name_ar}: ${r.original_term_ar}`);
    }
  }
  lines.push("");

  lines.push("## Honorific-only rows summary (Companions etc.)");
  if (!honorificSection.length) {
    lines.push("None detected by heuristic.");
  } else {
    for (const h of honorificSection) lines.push(`- ${h}`);
  }
  lines.push("");

  lines.push("## Other flags");
  for (const f of jarhFlags) lines.push(`- ${f}`);
  if (!jarhFlags.length) lines.push("None beyond honorific/garbled lists above.");
  lines.push("");

  writeFileSync(REVIEW_SHEET, lines.join("\n"), "utf8");
  console.log(`Review sheet → ${REVIEW_SHEET}`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const mappingApproved = args.includes("--mapping-approved");
  if (apply && !mappingApproved) {
    console.error("Refusing --apply without --mapping-approved");
    process.exit(1);
  }

  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });

  if (!existsSync(MAPPING_JSON)) throw new Error(`Missing ${MAPPING_JSON}`);
  const mapping = JSON.parse(readFileSync(MAPPING_JSON, "utf8")) as { toImport: ToImport[] };
  const toImport = [...mapping.toImport];
  // Ensure 4716 is present for fetch/apply (new narrator)
  if (!toImport.some((t) => t.sunnahId === MUBARAK_SUNNAH_ID)) {
    toImport.push({ sunnahId: MUBARAK_SUNNAH_ID, name: "عبد الله بن المبارك الحنظلي", narratorIds: [] });
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN (fetch+parse only)"}`);
  console.log(`Narrator pages: ${toImport.length}\n`);

  const supabase = adminClient();
  const allAppraisals: AppraisalRow[] = [];
  const pageNameBySunnah = new Map<string, string>();
  const garbled: AppraisalRow[] = [];

  for (const entry of toImport.sort((a, b) => Number(a.sunnahId) - Number(b.sunnahId))) {
    console.log(`Narrator sunnah/${entry.sunnahId}`);
    const html = await loadHtml(entry.sunnahId);
    const { appraisals, narratorNameAr } = extractAppraisals(entry.sunnahId, html);
    pageNameBySunnah.set(entry.sunnahId, narratorNameAr || entry.name);
    console.log(`  page name: ${narratorNameAr || entry.name}`);
    console.log(`  appraisals: ${appraisals.length}`);
    for (const row of appraisals) {
      if (looksGarbled(row.original_term_ar)) garbled.push(row);
      allAppraisals.push(row);
    }
  }

  writeCsv(
    APPRAISALS_CSV,
    [
      "narrator_sunnah_id",
      "narrator_name_ar",
      "scholar_name_ar",
      "original_term_ar",
      "citation_book",
      "source_url",
      "verified",
    ],
    allAppraisals,
  );
  console.log(`\nCSV → ${APPRAISALS_CSV} (${allAppraisals.length} rows)`);
  console.log(`Garbled flagged: ${garbled.length}`);

  if (!apply) {
    console.log("\nDry-run complete. No DB writes.");
    console.log("To apply:");
    console.log("  npx tsx scripts/apply-sunnah-appraisals-batch2.ts --apply --mapping-approved");
    return;
  }

  // ——— APPLY (logical transaction: track IDs for rollback) ———
  const insertedAssessmentIds: number[] = [];
  const createdScholarIds: number[] = [];
  let newMubarakId: number | null = null;

  try {
    // 1) Approved UPDATE: أبيه → 968
    for (const u of APPROVED_UPDATES) {
      const { data, error } = await supabase
        .from("chain_narrators")
        .update({ narrator_id: u.narratorId })
        .eq("id", u.chainNarratorId)
        .is("narrator_id", null)
        .select("id, narrator_id");
      if (error) throw new Error(`UPDATE cn ${u.chainNarratorId}: ${error.message}`);
      console.log(`UPDATE chain_narrators id=${u.chainNarratorId} → narrator_id=${u.narratorId} (rows=${data?.length ?? 0})`);
    }

    // 2) Create Ibn al-Mubarak narrator
    const mubarakNameAr =
      pageNameBySunnah.get(MUBARAK_SUNNAH_ID) || "عبد الله بن المبارك الحنظلي";
    // Prefer a stable Latin slug; fall back to arabic slugify if taken.
    let slug = "abdullah-ibn-al-mubarak-al-hanzali-isnad-repair";
    {
      const { data: taken } = await supabase.from("narrators").select("slug").eq("slug", slug).maybeSingle();
      if (taken) {
        const baseSlug = slugifyArabic(mubarakNameAr);
        slug = `${baseSlug}-isnad-repair`;
        const { data: taken2 } = await supabase.from("narrators").select("slug").like("slug", `${baseSlug}%`);
        const takenSet = new Set((taken2 ?? []).map((r) => r.slug));
        let n = 2;
        while (takenSet.has(slug)) {
          slug = `${baseSlug}-isnad-repair-${n}`;
          n += 1;
        }
      }
    }

    const { data: createdNarr, error: narrErr } = await supabase
      .from("narrators")
      .insert({
        slug,
        name: mubarakNameAr,
        arabic_name: mubarakNameAr,
        identity_status: "unverified",
        summary_score: null,
      })
      .select("id, slug, arabic_name")
      .single();
    if (narrErr) throw new Error(`Create Ibn al-Mubarak: ${narrErr.message}`);
    newMubarakId = createdNarr.id;
    console.log(`\nNEW narrator id=${newMubarakId} slug=${createdNarr.slug} arabic_name=${createdNarr.arabic_name}`);

    // 3) Link NULL عبد الله nodes
    for (const cnId of MUBARAK_CHAIN_NARRATOR_IDS) {
      const { data, error } = await supabase
        .from("chain_narrators")
        .update({ narrator_id: newMubarakId })
        .eq("id", cnId)
        .is("narrator_id", null)
        .select("id, narrator_id");
      if (error) throw new Error(`UPDATE cn ${cnId}: ${error.message}`);
      console.log(`UPDATE chain_narrators id=${cnId} → narrator_id=${newMubarakId} (rows=${data?.length ?? 0})`);
    }

    // Build sunnah → narrator_id map
    const sunnahToNarrator = new Map<string, { narratorId: number; nameAr: string }>();
    for (const entry of toImport) {
      if (entry.sunnahId === MUBARAK_SUNNAH_ID) {
        sunnahToNarrator.set(entry.sunnahId, {
          narratorId: newMubarakId!,
          nameAr: pageNameBySunnah.get(entry.sunnahId) || entry.name,
        });
        continue;
      }
      const nid = entry.narratorIds[0];
      if (nid == null) throw new Error(`No narratorIds for sunnah/${entry.sunnahId}`);
      sunnahToNarrator.set(entry.sunnahId, {
        narratorId: nid,
        nameAr: pageNameBySunnah.get(entry.sunnahId) || entry.name,
      });
    }

    // Scholars
    const aliases = loadAliases();
    const scholarCache = new Map<string, number>();
    const { data: allScholars } = await supabase.from("scholars").select("id, arabic_name");
    for (const s of allScholars ?? []) {
      const ar = normalizeWs(s.arabic_name ?? "");
      if (ar) scholarCache.set(ar, s.id);
    }
    const createdScholarNotes: string[] = [];
    const uniqueScholars = [...new Set(allAppraisals.map((r) => r.scholar_name_ar))];
    const scholarIdByName = new Map<string, number>();
    for (const name of uniqueScholars) {
      const id = await resolveScholarId(
        supabase,
        name,
        aliases,
        scholarCache,
        true,
        createdScholarNotes,
        createdScholarIds,
      );
      if (id != null && id !== -1) scholarIdByName.set(name, id);
    }
    console.log(`\nNew scholars created: ${createdScholarIds.length}`);
    for (const line of createdScholarNotes) console.log(`  NEW  ${line}`);

    // Insert assessments
    const perNarrator = new Map<string, { inserted: number; skipped: number }>();
    for (const sid of sunnahToNarrator.keys()) {
      perNarrator.set(sid, { inserted: 0, skipped: 0 });
    }

    let inserted = 0;
    let skippedDup = 0;

    for (const row of allAppraisals) {
      const map = sunnahToNarrator.get(row.narrator_sunnah_id);
      if (!map) {
        console.warn(`SKIP unmapped ${row.narrator_sunnah_id}`);
        continue;
      }
      const scholarId = scholarIdByName.get(row.scholar_name_ar);
      if (scholarId == null) {
        console.warn(`SKIP no scholar ${row.scholar_name_ar}`);
        continue;
      }
      const stats = perNarrator.get(row.narrator_sunnah_id)!;

      const { data: existing } = await supabase
        .from("narrator_assessments")
        .select("id")
        .eq("narrator_id", map.narratorId)
        .eq("scholar_id", scholarId)
        .eq("original_term", row.original_term_ar)
        .eq("source_url", row.source_url)
        .maybeSingle();
      if (existing) {
        skippedDup += 1;
        stats.skipped += 1;
        continue;
      }

      const { data: ins, error } = await supabase
        .from("narrator_assessments")
        .insert({
          narrator_id: map.narratorId,
          scholar_id: scholarId,
          original_term: row.original_term_ar,
          normalized_term: null,
          explanation: null,
          display_score: null,
          mapping_method: MAPPING_METHOD,
          reference_book: row.citation_book || null,
          edition: null,
          volume: null,
          page: null,
          source_url: row.source_url,
          verified: false,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Insert assessment: ${error.message}`);
      insertedAssessmentIds.push(ins.id);
      inserted += 1;
      stats.inserted += 1;
    }

    console.log("\n=== Rows per narrator ===");
    for (const [sid, meta] of [...sunnahToNarrator.entries()].sort(
      (a, b) => Number(a[0]) - Number(b[0]),
    )) {
      const s = perNarrator.get(sid)!;
      console.log(
        `  sunnah/${sid} narrator_id=${meta.narratorId}: inserted ${s.inserted}, skipped_dup ${s.skipped}`,
      );
    }

    console.log("\n=== Totals ===");
    console.log(`Inserted assessments: ${inserted}`);
    console.log(`Skipped duplicates: ${skippedDup}`);
    console.log(`NEW Ibn al-Mubarak narrator_id: ${newMubarakId}`);

    const assessIdList =
      insertedAssessmentIds.length > 0
        ? insertedAssessmentIds.join(", ")
        : "/* none */";
    const scholarIdList =
      createdScholarIds.length > 0 ? createdScholarIds.join(", ") : "/* none */";
    console.log("\n=== ROLLBACK (if needed) ===");
    console.log(`DELETE FROM narrator_assessments WHERE id IN (${assessIdList});`);
    console.log(`DELETE FROM scholars WHERE id IN (${scholarIdList});`);
    console.log(
      `UPDATE chain_narrators SET narrator_id = NULL WHERE id IN (${MUBARAK_CHAIN_NARRATOR_IDS.join(", ")});`,
    );
    console.log(`UPDATE chain_narrators SET narrator_id = NULL WHERE id = 1256; -- only if rolling back أبيه link`);
    console.log(`DELETE FROM narrators WHERE id = ${newMubarakId};`);

    writeReviewSheet(allAppraisals, sunnahToNarrator, garbled);
    console.log("\nDone. Nothing marked verified.");
  } catch (err) {
    console.error("\nAPPLY FAILED — attempting compensating deletes…");
    if (insertedAssessmentIds.length) {
      await supabase.from("narrator_assessments").delete().in("id", insertedAssessmentIds);
      console.error(`  deleted ${insertedAssessmentIds.length} assessments`);
    }
    if (createdScholarIds.length) {
      await supabase.from("scholars").delete().in("id", createdScholarIds);
      console.error(`  deleted ${createdScholarIds.length} scholars`);
    }
    if (newMubarakId != null) {
      await supabase
        .from("chain_narrators")
        .update({ narrator_id: null })
        .in("id", MUBARAK_CHAIN_NARRATOR_IDS)
        .eq("narrator_id", newMubarakId);
      await supabase.from("narrators").delete().eq("id", newMubarakId);
      console.error(`  deleted narrator ${newMubarakId} and unlinked chain nodes`);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
