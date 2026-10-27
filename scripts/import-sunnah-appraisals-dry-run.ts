/**
 * Dry-run importer: fetch Critical Appraisals from fixed Sunnah.com narrator pages,
 * write review CSVs. Does NOT write to Supabase.
 *
 * Usage: npx tsx scripts/import-sunnah-appraisals-dry-run.ts
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);

const USER_AGENT =
  "HadithCollectionResearchBot/1.0 (+local dry-run importer; reads Critical Appraisals only; no write)";
const REQUEST_GAP_MS = 2000;
const RAW_DIR = path.join(process.cwd(), "data", "raw");
const DATA_DIR = path.join(process.cwd(), "data");

/** Fixed six pages only — no crawling. */
const NARRATORS: Array<{
  sunnahId: string;
  labelEn: string;
  /** Arabic name from our Sahih al-Bukhari #3 chain (for confirmation only). */
  bukhari3NameAr: string;
}> = [
  { sunnahId: "8297", labelEn: "Yahya ibn Bukayr", bukhari3NameAr: "يَحْيَى بْنُ بُكَيْرٍ" },
  { sunnahId: "6641", labelEn: "al-Layth ibn Sa'd", bukhari3NameAr: "اللَّيْث" },
  { sunnahId: "5688", labelEn: "'Uqayl ibn Khalid", bukhari3NameAr: "عُقَيْل" },
  { sunnahId: "7272", labelEn: "Ibn Shihab al-Zuhri", bukhari3NameAr: "ابْنُ شِهَابٍ" },
  { sunnahId: "5594", labelEn: "'Urwa ibn al-Zubayr", bukhari3NameAr: "عُرْوَةَ بْنِ الزُّبَيْر" },
  { sunnahId: "4049", labelEn: "'A'isha bint Abi Bakr", bukhari3NameAr: "عَائِشَةَ أُمِّ الْمُؤْمِنِينَ" },
];

type AppraisalRow = {
  narrator_sunnah_id: string;
  narrator_name_ar: string;
  scholar_name_ar: string;
  original_term_ar: string;
  citation_book: string;
  source_url: string;
  verified: string;
};

type IdentityRow = {
  narrator_sunnah_id: string;
  narrator_name_ar: string;
  full_name_ar: string;
  kunya_ar: string;
  generation_ar: string;
  lifespan_ah_ar: string;
  regions_ar: string;
  affiliations_ar: string;
  tradition_notes_ar: string;
  source_url: string;
};

type Polarity = "positive" | "negative" | "neutral" | "unclassified";

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

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Only fill citation_book when the Arabic wording itself names a book.
 * Copies the Arabic phrase as it appears — no English translation.
 */
function citationBookFromWording(term: string): string {
  const patterns = [
    /تقريب التهذيب/,
    /تحرير تقريب التهذيب/,
    /التقريب/,
    /الضعفاء والمتروكين/,
    /الضعفاء/,
    /الثقات/,
    /ميزان الاعتدال/,
    /الميزان/,
    /سير أعلام النبلاء/,
    /الجرح والتعديل/,
    /تهذيب التهذيب/,
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

/** Count-only heuristic for console summary. Not written to CSV. Unclassified is the default. */
function classifyPolarity(term: string): Polarity {
  const t = term;
  const negativeHints = ["ضعيف", "ليس بثقة", "ليس بشيء", "متروك", "كذاب", "وضاع", "مدلس", "تدليس", "أنقيه", "تكلموا", "تكلم فيه", "لا يحتج", "الضعفاء"];
  const positiveHints = ["ثقة", "صدوق", "ثبت", "حجة", "إمام", "أثبت", "احتج به", "صحيح الحديث", "الثقات"];
  const hasNeg = negativeHints.some((h) => t.includes(h));
  const hasPos = positiveHints.some((h) => t.includes(h));
  if (hasNeg && hasPos) return "unclassified";
  if (hasNeg) return "negative";
  if (hasPos) return "positive";
  return "unclassified";
}

async function ensureRobotsAllowed(): Promise<void> {
  const res = await fetch("https://sunnah.com/robots.txt", {
    headers: { "User-Agent": USER_AGENT },
  });
  const text = await res.text();
  // Disallow is only /selectiondata/* — narrator pages are allowed.
  if (/Disallow:\s*\/narrator/i.test(text)) {
    throw new Error("robots.txt disallows /narrator — aborting.");
  }
  console.log("robots.txt: Allow:/ ; Disallow:/selectiondata/* — narrator pages permitted.\n");
}

async function loadHtml(sunnahId: string): Promise<string> {
  const file = cachePath(sunnahId);
  if (existsSync(file)) {
    console.log(`  cache hit  ${file}`);
    return readFileSync(file, "utf8");
  }
  const url = narratorUrl(sunnahId);
  console.log(`  fetching   ${url}`);
  // Prefer curl.exe on Windows — node fetch is often blocked (403) by the CDN.
  try {
    await execFileAsync(
      "curl.exe",
      ["-sS", "-L", "-A", USER_AGENT, "-H", "Accept: text/html,application/xhtml+xml", "-o", file, url],
      { timeout: 60000 },
    );
  } catch (err) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en,ar;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url} (curl also failed: ${String(err)})`);
    writeFileSync(file, await res.text(), "utf8");
  }
  if (!existsSync(file) || readFileSync(file, "utf8").length < 500) {
    throw new Error(`Empty or missing download for ${url}`);
  }
  const html = readFileSync(file, "utf8");
  if (/just a moment|cf-browser-verification|access denied/i.test(html) && html.length < 5000) {
    throw new Error(`Blocked or challenge page for ${url}`);
  }
  await delay(REQUEST_GAP_MS);
  return html;
}

function extractFromHtml(sunnahId: string, html: string): {
  appraisals: AppraisalRow[];
  identity: IdentityRow;
  narratorNameAr: string;
} {
  const $ = cheerio.load(html);
  const source_url = narratorUrl(sunnahId);

  const narratorNameAr = normalizeWs($("h1.hero-title.arabic").first().text()) || "";

  const fieldByArabicLabel = (label: string): string => {
    let found = "";
    $(".fields .label.arabic-label, .bio-block .label.arabic-label").each((_, el) => {
      if (normalizeWs($(el).text()) === label) {
        const parent = $(el).parent();
        const field = normalizeWs(parent.find(".field.arabic, .lineage.arabic, .pill-secondary.arabic").first().text());
        const lineage = normalizeWs(parent.find("p.lineage.arabic").first().text());
        found = field || lineage || found;
      }
    });
    return found;
  };

  // Full name from bio lineage row
  let fullNameAr = "";
  $(".bio-row").each((_, row) => {
    const label = normalizeWs($(row).find(".label.arabic-label").first().text());
    if (label === "الاسم الكامل") {
      fullNameAr = normalizeWs($(row).find("p.lineage.arabic").first().text());
    }
  });

  let regionsAr = "";
  let affiliationsAr = "";
  let traditionNotesAr = "";
  $(".bio-row").each((_, row) => {
    const label = normalizeWs($(row).find(".label.arabic-label").first().text());
    const value = normalizeWs($(row).find("p.field.arabic").first().text());
    if (label === "بلد الإقامة") regionsAr = value;
    if (label === "النسب والنسبة") affiliationsAr = value;
  });
  const traditionPills: string[] = [];
  $(".bio-row .pills[dir='rtl'] .pill-outline.arabic").each((_, el) => {
    const t = normalizeWs($(el).text());
    if (t) traditionPills.push(t);
  });
  traditionNotesAr = traditionPills.join(" · ");

  const kunyaAr = fieldByArabicLabel("الكنية");
  const generationAr = (() => {
    let gen = "";
    $(".fields[dir='rtl'] .label.arabic-label, .hero .label.arabic-label").each((_, el) => {
      if (normalizeWs($(el).text()) === "الطبقة") {
        const line = $(el).closest("div").find(".field-line");
        gen = normalizeWs(line.find(".field.arabic").first().text());
      }
    });
    // fallback: rtl fields block
    $("div[dir='rtl'] .fields .label.arabic-label").each((_, el) => {
      if (normalizeWs($(el).text()) === "الطبقة") {
        gen = normalizeWs($(el).parent().find(".field.arabic").first().text()) || gen;
      }
    });
    return gen;
  })();

  let lifespanAhAr = "";
  $("div[dir='rtl'] .pill-secondary.arabic").each((_, el) => {
    const t = normalizeWs($(el).text());
    if (t.includes("هـ") || /[٠-٩0-9]/.test(t)) {
      lifespanAhAr = t;
      return false;
    }
  });

  const identity: IdentityRow = {
    narrator_sunnah_id: sunnahId,
    narrator_name_ar: narratorNameAr,
    full_name_ar: fullNameAr,
    kunya_ar: kunyaAr,
    generation_ar: generationAr,
    lifespan_ah_ar: lifespanAhAr,
    regions_ar: regionsAr,
    affiliations_ar: affiliationsAr,
    tradition_notes_ar: traditionNotesAr,
    source_url,
  };

  const appraisals: AppraisalRow[] = [];
  // Scope to Critical Appraisals section only (not teachers/students show-all).
  const section = $("section.mb-section")
    .filter((_, el) => {
      const titles = $(el).find(".section-title").map((__, t) => normalizeWs($(t).text())).get();
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

  return { appraisals, identity, narratorNameAr };
}

async function loadScholarArabicNames(): Promise<Set<string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn("No Supabase env — scholar match skipped (treating all as missing).");
    return new Set();
  }
  const s = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await s.from("scholars").select("arabic_name");
  if (error) {
    console.warn("Could not load scholars:", error.message);
    return new Set();
  }
  const set = new Set<string>();
  for (const row of data ?? []) {
    const ar = normalizeWs(row.arabic_name ?? "");
    if (ar) set.add(ar);
  }
  return set;
}

async function loadBukhari3ChainNames(): Promise<string[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  const s = createClient(url, key, { auth: { persistSession: false } });
  const { data: books } = await s.from("books").select("id, title").eq("title", "Sahih al-Bukhari");
  const bookIds = (books ?? []).map((b) => b.id);
  if (!bookIds.length) return [];
  const { data: vars } = await s
    .from("source_variations")
    .select("id")
    .eq("hadith_number", "3")
    .in("book_id", bookIds)
    .limit(1);
  const variationId = vars?.[0]?.id;
  if (!variationId) return [];
  const { data: chains } = await s
    .from("chains")
    .select("chain_narrators(position, raw_name, narrators(arabic_name, name))")
    .eq("variation_id", variationId)
    .order("chain_number")
    .limit(1);
  type NodeRow = {
    position: number;
    raw_name: string;
    narrators?: { arabic_name?: string | null; name?: string } | { arabic_name?: string | null; name?: string }[] | null;
  };
  const first = chains?.[0] as { chain_narrators?: NodeRow[] } | undefined;
  const nodes = [...(first?.chain_narrators ?? [])].sort((a, b) => a.position - b.position);
  return nodes.map((n) => {
    const narr = Array.isArray(n.narrators) ? n.narrators[0] : n.narrators;
    return normalizeWs(narr?.arabic_name || narr?.name || n.raw_name);
  });
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });

  console.log("Sunnah.com Critical Appraisals dry-run (6 pages, no Supabase writes)\n");
  await ensureRobotsAllowed();

  const scholarArabic = await loadScholarArabicNames();
  const bukhari3Names = await loadBukhari3ChainNames();

  console.log("Proposed Sunnah ID ↔ Bukhari #3 chain Arabic names (for your confirmation — not matched yet):\n");
  for (const n of NARRATORS) {
    console.log(`  sunnah/${n.sunnahId}  ${n.labelEn}`);
    console.log(`    expected check label: ${n.bukhari3NameAr}`);
  }
  if (bukhari3Names.length) {
    console.log("\n  Names currently on Sahih al-Bukhari #3 chain in DB (raw/arabic):");
    bukhari3Names.forEach((name, i) => console.log(`    ${i + 1}. ${name}`));
  } else {
    console.log("\n  (Could not load Bukhari #3 chain from DB — using labels above.)");
  }
  console.log("");

  const allAppraisals: AppraisalRow[] = [];
  const allIdentities: IdentityRow[] = [];
  const scholarSeen = new Map<string, number>();
  const zeroAppraisal: string[] = [];

  for (const n of NARRATORS) {
    console.log(`Narrator ${n.sunnahId} (${n.labelEn})`);
    const html = await loadHtml(n.sunnahId);
    const { appraisals, identity, narratorNameAr } = extractFromHtml(n.sunnahId, html);
    allAppraisals.push(...appraisals);
    allIdentities.push(identity);

    const counts = { positive: 0, negative: 0, neutral: 0, unclassified: 0 };
    for (const row of appraisals) {
      const p = classifyPolarity(row.original_term_ar);
      counts[p] += 1;
      scholarSeen.set(row.scholar_name_ar, (scholarSeen.get(row.scholar_name_ar) ?? 0) + 1);
    }

    console.log(`  page name (ar): ${narratorNameAr || "(missing)"}`);
    console.log(
      `  appraisals: ${appraisals.length}  (pos ${counts.positive} / neg ${counts.negative} / neu ${counts.neutral} / unclassified ${counts.unclassified})`,
    );
    if (appraisals.length === 0) {
      zeroAppraisal.push(`${n.sunnahId} ${narratorNameAr || n.labelEn}`);
      console.log("  WARNING: 0 appraisals");
    }
  }

  const appraisalsPath = path.join(DATA_DIR, "narrator-appraisals-review.csv");
  const identityPath = path.join(DATA_DIR, "narrator-identity-review.csv");

  writeCsv(
    appraisalsPath,
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
  writeCsv(
    identityPath,
    [
      "narrator_sunnah_id",
      "narrator_name_ar",
      "full_name_ar",
      "kunya_ar",
      "generation_ar",
      "lifespan_ah_ar",
      "regions_ar",
      "affiliations_ar",
      "tradition_notes_ar",
      "source_url",
    ],
    allIdentities,
  );

  const missingScholars = [...scholarSeen.keys()]
    .filter((name) => !scholarArabic.has(name))
    .sort((a, b) => a.localeCompare(b, "ar"));

  console.log("\n=== Summary ===");
  console.log(`Appraisal rows written: ${allAppraisals.length} → ${appraisalsPath}`);
  console.log(`Identity rows written:  ${allIdentities.length} → ${identityPath}`);
  console.log(`Unique scholars in extract: ${scholarSeen.size}`);
  console.log(`Scholars matching public.scholars.arabic_name (exact): ${scholarSeen.size - missingScholars.length}`);
  console.log(`Scholars NOT in DB (do not map to existing): ${missingScholars.length}`);
  for (const name of missingScholars) {
    console.log(`  - ${name} (${scholarSeen.get(name)} row(s))`);
  }
  if (zeroAppraisal.length) {
    console.log("\nNarrators with 0 appraisals:");
    for (const z of zeroAppraisal) console.log(`  - ${z}`);
  } else {
    console.log("\nNo narrators with 0 appraisals.");
  }
  console.log("\nStopped after CSV write. No Supabase writes.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
