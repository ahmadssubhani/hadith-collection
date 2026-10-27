/**
 * Import data/raw/*.jsonl scrape output into Supabase tables:
 *   import_batches + raw_import_records  (audit trail)
 *   books                                 (collections)
 *   hadiths                               (draft inbox cluster per source — NOT published)
 *   source_variations                     (arabic/english/refs; verified=false)
 *   chains                                (narrator/isnad text when present)
 *
 * Usage:
 *   npx tsx scripts/scrapers/import-raw-jsonl.ts              # dry-run
 *   npx tsx scripts/scrapers/import-raw-jsonl.ts --apply      # write
 *   npx tsx scripts/scrapers/import-raw-jsonl.ts --apply --sources=sunnah,dorar
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();

import * as fs from "fs";
import * as path from "path";
import { createAdminSupabaseClient } from "../../lib/supabase/admin";
import type { Hadith } from "./hadith-scraper";

const RAW_DIR = path.join("data", "raw");
const APPLY = process.argv.includes("--apply");
const sourcesArg = process.argv.find((a) => a.startsWith("--sources="))?.slice(10);
const ONLY = sourcesArg
  ? new Set(sourcesArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
  : null;

type Scraped = Hadith;

const INBOX: Record<string, { slug: string; title: string; summary: string }> = {
  sunnah: {
    slug: "scraped-inbox-sunnah",
    title: "Scraped inbox — sunnah.com",
    summary: "Unreviewed Playwright scrape buffer. Not a thematic cluster; re-cluster before publish.",
  },
  dorar: {
    slug: "scraped-inbox-dorar",
    title: "Scraped inbox — dorar.net",
    summary: "Unreviewed Playwright scrape buffer. Not a thematic cluster; re-cluster before publish.",
  },
  hadeethenc: {
    slug: "scraped-inbox-hadeethenc",
    title: "Scraped inbox — hadeethenc.com",
    summary: "Unreviewed Playwright scrape buffer. Not a thematic cluster; re-cluster before publish.",
  },
  thaqalayn: {
    slug: "scraped-inbox-thaqalayn",
    title: "Scraped inbox — thaqalayn.com",
    summary: "Unreviewed Playwright scrape buffer. Not a thematic cluster; re-cluster before publish.",
  },
  alislam: {
    slug: "scraped-inbox-alislam",
    title: "Scraped inbox — al-islam.org",
    summary: "Unreviewed Playwright scrape buffer. Not a thematic cluster; re-cluster before publish.",
  },
};

function emptyToNull(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function loadJsonl(file: string): Scraped[] {
  const out: Scraped[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Scraped);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Infer book title + hadith number from scrape fields. */
function bookAndNumber(r: Scraped): { bookTitle: string; hadithNumber: string } {
  const ref = emptyToNull(r.reference);
  const bookField = emptyToNull(r.book);

  if (r.source === "sunnah" && ref) {
    // "Sahih al-Bukhari 7371" | "Sahih Muslim 160 a" | "Sunan Abi Dawud 4648"
    const m = ref.match(/^(.*?)\s+(\d+[a-zA-Z]?)\s*$/);
    if (m) return { bookTitle: m[1].trim(), hadithNumber: m[2] };
    return { bookTitle: "sunnah.com", hadithNumber: ref };
  }

  if (r.source === "dorar") {
    const fromMeta =
      (r.meta && (r.meta["المصدر"] || r.meta["المصدر "])) ||
      (r.narrator?.match(/المصدر\s*:\s*([^|]+)/)?.[1]?.trim() ?? null);
    const bookTitle = bookField || emptyToNull(fromMeta) || "Dorar (unspecified)";
    // Prefer page/number when clean; else scrape id prefix
    const num =
      (ref && /^\d/.test(ref) ? ref.split(/\s+/)[0] : null) ||
      r.id.slice(0, 12);
    return { bookTitle, hadithNumber: num };
  }

  if (r.source === "hadeethenc") {
    const bookTitle = bookField || "HadeethEnc Encyclopedia";
    const idFromUrl = r.url.match(/\/hadith\/(\d+)/)?.[1];
    return { bookTitle, hadithNumber: idFromUrl || r.id.slice(0, 12) };
  }

  return {
    bookTitle: bookField || r.source,
    hadithNumber: ref || r.id.slice(0, 12),
  };
}

function mapHadithStatus(grade: string | null): string {
  if (!grade) return "not_graded";
  const g = grade.toLowerCase();
  if (/صحيح|sahih|authentic|muttafaq|متفق/.test(g)) return "sahih";
  if (/حسن|hasan/.test(g)) return "hasan";
  if (/ضعيف|da[ʿ'`]?if|weak/.test(g)) return "daif";
  if (/موضوع|fabricat|mawdu/.test(g)) return "mawdu";
  if (/منكر|munkar/.test(g)) return "munkar";
  return "not_graded";
}

function traditionFor(bookTitle: string, source: string): string {
  if (/kafi|kāfi|nahj|thaqalayn/i.test(bookTitle) || source === "thaqalayn") return "Twelver Shia";
  if (source === "alislam") return "unclassified";
  return "Sunni";
}

async function ensureInbox(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  source: string
): Promise<number> {
  const cfg = INBOX[source] ?? {
    slug: `scraped-inbox-${source}`,
    title: `Scraped inbox — ${source}`,
    summary: "Unreviewed scrape buffer.",
  };
  const { data: existing } = await admin.from("hadiths").select("id").eq("slug", cfg.slug).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("hadiths")
    .insert({
      slug: cfg.slug,
      title: cfg.title,
      summary: cfg.summary,
      topics: ["scraped", "inbox", source],
      review_status: "draft",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function ensureBook(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  title: string,
  source: string,
  cache: Map<string, number>
): Promise<number> {
  if (cache.has(title)) return cache.get(title)!;
  const { data: existing } = await admin.from("books").select("id").eq("title", title).maybeSingle();
  if (existing) {
    cache.set(title, existing.id);
    return existing.id;
  }
  const { data, error } = await admin
    .from("books")
    .insert({
      title,
      tradition: traditionFor(title, source),
      book_type: "hadith_collection",
      source_url: null,
    })
    .select("id")
    .single();
  if (error) throw error;
  cache.set(title, data.id);
  return data.id;
}

async function upsertVariation(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  payload: Record<string, unknown>,
  scrapeId: string
): Promise<{ id: number; created: boolean }> {
  // Prefer match by source_url + hadith_number under same hadith/book when possible
  const { data: byUrl } = await admin
    .from("source_variations")
    .select("id")
    .eq("hadith_id", payload.hadith_id as number)
    .eq("book_id", payload.book_id as number)
    .eq("hadith_number", payload.hadith_number as string)
    .maybeSingle();

  if (byUrl) {
    const { error } = await admin.from("source_variations").update(payload).eq("id", byUrl.id);
    if (error) throw error;
    return { id: byUrl.id, created: false };
  }

  // Fallback: status_notes tag with scrape id
  const { data: byTag } = await admin
    .from("source_variations")
    .select("id")
    .eq("hadith_id", payload.hadith_id as number)
    .ilike("status_notes", `%scrape:${scrapeId}%`)
    .maybeSingle();

  if (byTag) {
    const { error } = await admin.from("source_variations").update(payload).eq("id", byTag.id);
    if (error) throw error;
    return { id: byTag.id, created: false };
  }

  const { data, error } = await admin.from("source_variations").insert(payload).select("id").single();
  if (error) throw error;
  return { id: data.id, created: true };
}

async function ensureChain(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  variationId: number,
  narrator: string | null
) {
  if (!narrator) return;
  const { data: existing } = await admin
    .from("chains")
    .select("id")
    .eq("variation_id", variationId)
    .eq("chain_number", 1)
    .maybeSingle();

  const payload = {
    variation_id: variationId,
    chain_number: 1,
    raw_chain_text: narrator,
    continuity_status: "unverified",
    quality_status: "unverified",
    verified: false,
    notes: "Imported from scrape narrator/isnad field",
  };

  if (existing) {
    await admin.from("chains").update(payload).eq("id", existing.id);
  } else {
    await admin.from("chains").insert(payload);
  }
}

async function importSource(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  source: string,
  rows: Scraped[],
  bookCache: Map<string, number>
) {
  console.log(`\n===== ${source}: ${rows.length} records =====`);
  if (!rows.length) return { inserted: 0, updated: 0, skipped: 0 };

  if (!APPLY) {
    const sample = rows.slice(0, 2).map((r) => {
      const bn = bookAndNumber(r);
      return {
        id: r.id,
        book: bn.bookTitle,
        number: bn.hadithNumber,
        hasArabic: !!r.arabic,
        hasEnglish: !!r.english,
        grade: r.grade,
      };
    });
    console.log("[dry-run] would import → tables: import_batches, raw_import_records, books, hadiths(draft inbox), source_variations(verified=false), chains");
    console.log("[dry-run] samples:", JSON.stringify(sample, null, 2));
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  const inboxId = await ensureInbox(admin, source);

  const { data: batch, error: batchErr } = await admin
    .from("import_batches")
    .insert({
      provider: `playwright-scrape:${source}`,
      source_url: rows[0]?.url ?? null,
      license: "unknown",
      permission_status: "unknown",
      retrieved_at: new Date().toISOString(),
      notes: `Imported ${rows.length} records from data/raw/${source}.jsonl (verified=false, review_status=draft inbox)`,
    })
    .select("id")
    .single();
  if (batchErr) throw batchErr;
  const batchId = batch.id;

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    if (!r.arabic && !r.english) {
      skipped++;
      continue;
    }
    const { bookTitle, hadithNumber } = bookAndNumber(r);
    const bookId = await ensureBook(admin, bookTitle, source, bookCache);
    const grade = emptyToNull(r.grade);
    const statusNotes = [
      `scrape:${r.id}`,
      grade ? `grade:${grade}` : null,
      r.title ? `title:${r.title}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    // raw audit row
    await admin.from("raw_import_records").upsert(
      {
        batch_id: batchId,
        external_id: r.id,
        raw_payload: r as unknown as Record<string, unknown>,
        processing_status: "imported",
      },
      { onConflict: "batch_id,external_id" }
    );

    const payload = {
      hadith_id: inboxId,
      book_id: bookId,
      hadith_number: hadithNumber,
      chapter: emptyToNull(r.chapter),
      volume: null,
      page: null,
      arabic_text: emptyToNull(r.arabic),
      english_text: emptyToNull(r.english),
      translator: null,
      source_url: emptyToNull(r.url),
      hadith_status: mapHadithStatus(grade),
      chain_status: "unverified",
      narration_status: [] as string[],
      status_notes: statusNotes,
      verified: false, // keep hidden by RLS until reviewed
    };

    const { id: variationId, created } = await upsertVariation(admin, payload, r.id);
    if (created) inserted++;
    else updated++;

    await ensureChain(admin, variationId, emptyToNull(r.narrator));
  }

  console.log(`  batch=${batchId} inbox_hadith_id=${inboxId} inserted=${inserted} updated=${updated} skipped=${skipped}`);
  return { inserted, updated, skipped };
}

async function main() {
  const files = fs
    .readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".jsonl") && f !== "all.jsonl")
    .filter((f) => !ONLY || ONLY.has(f.replace(/\.jsonl$/, "")));

  if (!files.length) {
    console.error(`No matching jsonl in ${RAW_DIR}`);
    process.exit(1);
  }

  console.log(`Mode: ${APPLY ? "APPLY (writing to Supabase)" : "DRY-RUN (no DB writes)"}`);
  console.log(`Files: ${files.join(", ")}`);

  const admin = createAdminSupabaseClient();
  const bookCache = new Map<string, number>();
  const totals = { inserted: 0, updated: 0, skipped: 0 };

  for (const file of files.sort()) {
    const source = file.replace(/\.jsonl$/, "");
    const rows = loadJsonl(path.join(RAW_DIR, file));
    const r = await importSource(admin, source, rows, bookCache);
    totals.inserted += r.inserted;
    totals.updated += r.updated;
    totals.skipped += r.skipped;
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to write. Rows stay draft/unverified (hidden by RLS).");
    return;
  }

  console.log("\n===== DONE =====");
  console.log(totals);

  // post counts
  for (const t of ["hadiths", "books", "source_variations", "import_batches", "raw_import_records", "chains"]) {
    const { count } = await admin.from(t).select("*", { count: "exact", head: true });
    console.log(`${t}: ${count}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
