/**
 * Enrich existing DB variations into more complete hadith records.
 *
 * Allow-listed only:
 * - sunnah.com rows → fawazahmed0/hadith-api (Unlicense) for section/chapter + grades
 * - thaqalayn.net rows → Playwright on existing URLs (CC BY) for grade + sanad text
 * - hadeethenc.com → official API (already mostly filled)
 * - dorar.net / sunnah.com HTML → SKIPPED (needs_permission)
 *
 * Then maps chapters → categories and reports completeness.
 *
 *   npx tsx scripts/collectors/enrich-complete-hadith.ts
 *   npx tsx scripts/collectors/enrich-complete-hadith.ts --apply
 *   npx tsx scripts/collectors/enrich-complete-hadith.ts --apply --skip-playwright
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const SKIP_PW = process.argv.includes("--skip-playwright");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mapGrade(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === "unspecified") return "not_graded";
  if (/صحيح|sahih|authentic|muttafaq/.test(s)) return "sahih";
  if (/حسن\s*صحيح|hasan[-\s]?sahih/.test(s)) return "hasan_sahih";
  if (/حسن|hasan/.test(s)) return "hasan";
  if (/ضعيف|da[ʿ'`]?if|weak/.test(s)) return "daif";
  if (/موضوع|fabricat|mawdu/.test(s)) return "mawdu";
  if (/منكر|munkar/.test(s)) return "munkar";
  if (/موثق|muwaththaq/.test(s)) return "muwaththaq";
  if (/قوي|qawi|strong/.test(s)) return "qawi";
  return null;
}

function mapTopicTextToSlugs(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  if (/revelation|first\s*wahi|hira|iqra|بدء الوحي|وحي/.test(t)) out.add("first-wahi");
  if (/creed|belief|aqidah|faith|tawhid|عقيد/.test(t)) out.add("aqidah");
  if (/imamate|wilayah|twelve imams|imam|أئم|ولاية|ridha|rida|ghayba|mahdi/.test(t)) out.add("imamate");
  if (/prayer|salat|salah|صلاة/.test(t)) out.add("prayer");
  if (/fast|sawm|ramadan|صيام/.test(t)) out.add("fasting");
  if (/zakat|charity|زكاة/.test(t)) out.add("zakat");
  if (/hajj|umrah|pilgrim|حج/.test(t)) out.add("hajj");
  if (/marriage|nikah|wives|نكاح/.test(t)) out.add("marriage");
  if (/tafsir|qur.?an|تفسير/.test(t)) out.add("tafsir");
  if (/akhlaq|ethics|adab|manners|أخلاق/.test(t)) out.add("akhlaq");
  if (/virtue|fada.?il|فضائل/.test(t)) out.add("virtues");
  if (/seerah|maghazi|battle|migration|hijra|prophet|سيرة/.test(t)) out.add("seerah");
  if (/fiqh|ibadat|worship|ruling/.test(t)) out.add("fiqh-ibadat");
  if (/knowledge|scholarship|علم/.test(t)) out.add("tafsir");
  if (/judgments|judiciary|claims|witnesses/.test(t)) out.add("fiqh-muamalat");
  return [...out];
}

const FAWAZ_COLLECTION: Record<string, string> = {
  bukhari: "eng-bukhari",
  muslim: "eng-muslim",
  nasai: "eng-nasai",
  abudawud: "eng-abudawud",
  tirmidhi: "eng-tirmidhi",
  ibnmajah: "eng-ibnmajah",
  malik: "eng-malik",
};

const SAHIH_COLLECTIONS = new Set(["bukhari", "muslim"]);

async function pageFetch<T>(sb: any, table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

type FawazEdition = {
  metadata: { section?: Record<string, string>; sections?: Record<string, string> };
  hadiths: Array<{
    hadithnumber: number;
    arabicnumber?: number;
    text?: string;
    grades?: Array<{ name: string; grade: string }>;
    reference?: { book: number; hadith: number };
  }>;
};

const fawazCache = new Map<string, FawazEdition>();

async function loadFawaz(edition: string): Promise<FawazEdition | null> {
  if (fawazCache.has(edition)) return fawazCache.get(edition)!;
  const url = `https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/${edition}.min.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as FawazEdition;
    fawazCache.set(edition, j);
    return j;
  } catch {
    return null;
  }
}

function sectionForHadith(ed: FawazEdition, hadithNumber: number): string | null {
  const sections = ed.metadata.section || ed.metadata.sections || {};
  // Prefer per-hadith reference.book if present
  const h = ed.hadiths.find((x) => x.hadithnumber === hadithNumber);
  if (h?.reference?.book != null) {
    const name = sections[String(h.reference.book)];
    if (name) return name;
  }
  return null;
}

async function main() {
  console.log("\n=== enrich-complete-hadith ===");
  console.log(APPLY ? "MODE: APPLY" : "MODE: dry-run");
  if (SKIP_PW) console.log("Playwright: skipped");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const categories = await pageFetch<{ id: number; slug: string }>(sb, "categories", "id,slug");
  const catBySlug = new Map(categories.map((c) => [c.slug, c.id]));
  const existingLinks = await pageFetch<{ hadith_id: number; category_id: number }>(
    sb,
    "hadith_categories",
    "hadith_id,category_id"
  );
  const linkSet = new Set(existingLinks.map((l) => `${l.hadith_id}:${l.category_id}`));

  const variations = await pageFetch<{
    id: number;
    hadith_id: number;
    book_id: number;
    hadith_number: string | null;
    chapter: string | null;
    grade_code: string | null;
    source_url: string | null;
    arabic_text: string | null;
    english_text: string | null;
  }>(
    sb,
    "source_variations",
    "id,hadith_id,book_id,hadith_number,chapter,grade_code,source_url,arabic_text,english_text"
  );

  const chains = await pageFetch<{ id: number; variation_id: number; raw_chain_text: string | null }>(
    sb,
    "chains",
    "id,variation_id,raw_chain_text"
  );
  const chainByVar = new Map(chains.map((c) => [c.variation_id, c]));

  const summary = {
    skipped_dorar: 0,
    skipped_sunnah_html: 0,
    fawaz_chapter: 0,
    fawaz_grade: 0,
    fawaz_miss: 0,
    thaq_grade: 0,
    thaq_chain: 0,
    thaq_fail: 0,
    category_links: 0,
    titles_updated: 0,
  };

  const catInserts: { hadith_id: number; category_id: number }[] = [];
  const addCats = (hadithId: number, text: string) => {
    for (const slug of mapTopicTextToSlugs(text)) {
      const cid = catBySlug.get(slug);
      if (!cid) continue;
      const key = `${hadithId}:${cid}`;
      if (linkSet.has(key)) continue;
      linkSet.add(key);
      catInserts.push({ hadith_id: hadithId, category_id: cid });
      summary.category_links++;
    }
  };

  // ---- 1) Fawaz for sunnah.com ----
  const sunnahVars = variations.filter((v) => /sunnah\.com/i.test(v.source_url || ""));
  console.log(`Sunnah rows (fawaz API, not HTML): ${sunnahVars.length}`);

  for (const v of sunnahVars) {
    summary.skipped_sunnah_html++; // we intentionally do not Playwright sunnah
    const m = (v.source_url || "").match(/sunnah\.com\/([a-z0-9]+)/i);
    if (!m) {
      summary.fawaz_miss++;
      continue;
    }
    const coll = m[1].toLowerCase();
    const edition = FAWAZ_COLLECTION[coll];
    if (!edition) {
      summary.fawaz_miss++;
      continue;
    }
    const num = Number(String(v.hadith_number || "").replace(/[^\d]/g, ""));
    if (!Number.isFinite(num) || num <= 0) {
      summary.fawaz_miss++;
      continue;
    }
    const ed = await loadFawaz(edition);
    if (!ed) {
      summary.fawaz_miss++;
      continue;
    }
    const hit = ed.hadiths.find((h) => h.hadithnumber === num);
    const patch: Record<string, unknown> = {};

    const section = sectionForHadith(ed, num);
    if (section && (!v.chapter || !v.chapter.trim())) {
      patch.chapter = section;
      summary.fawaz_chapter++;
      addCats(v.hadith_id, section);
    } else if (v.chapter) {
      addCats(v.hadith_id, v.chapter);
    }

    let grade: string | null = null;
    if (hit?.grades?.length) {
      grade = mapGrade(hit.grades.map((g) => g.grade).join(" | "));
    } else if (SAHIH_COLLECTIONS.has(coll) && (!v.grade_code || v.grade_code === "not_graded")) {
      // Book-level: Sahih al-Bukhari / Muslim → sahih (sourced from collection identity)
      grade = "sahih";
    }
    if (grade && (!v.grade_code || v.grade_code === "not_graded")) {
      patch.grade_code = grade;
      summary.fawaz_grade++;
    }

    if (Object.keys(patch).length && APPLY) {
      await sb.from("source_variations").update(patch).eq("id", v.id);
      if (patch.chapter) v.chapter = String(patch.chapter);
      if (patch.grade_code) v.grade_code = String(patch.grade_code);
    }
  }
  console.log(
    `Fawaz: chapter=${summary.fawaz_chapter} grade=${summary.fawaz_grade} miss=${summary.fawaz_miss}`
  );

  // ---- 2) Dorar: skip ----
  summary.skipped_dorar = variations.filter((v) => /dorar\.net/i.test(v.source_url || "")).length;
  console.log(`Dorar rows skipped (needs_permission HTML): ${summary.skipped_dorar}`);

  // ---- 3) Thaqalayn Playwright on existing URLs ----
  const thaqVars = variations.filter(
    (v) =>
      /thaqalayn\.(net|com)/i.test(v.source_url || "") &&
      ((!v.grade_code || v.grade_code === "not_graded") || !chainByVar.has(v.id))
  );
  console.log(`Thaqalayn rows needing grade/chain: ${thaqVars.length}`);

  if (!SKIP_PW && thaqVars.length) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (let i = 0; i < thaqVars.length; i++) {
      const v = thaqVars[i];
      try {
        await page.goto(v.source_url!, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(800);
        const scraped = await page.evaluate(() => {
          const gradeEls = Array.from(document.querySelectorAll(".grading-row, [class*='grading']"));
          const grades = gradeEls
            .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          const isnad =
            (
              document.querySelector('div[data-hl="ar"] span.text-slate-400') ||
              document.querySelector('[class*="tracking-arabic"] span.text-slate-400')
            )?.textContent?.replace(/\s+/g, " ").trim() || null;
          const chapter =
            document.querySelector("main h1")?.textContent?.replace(/\s+/g, " ").trim() || null;
          return { grades, isnad, chapter };
        });

        const patch: Record<string, unknown> = {};
        const grade = mapGrade(scraped.grades.join(" | "));
        if (grade && (!v.grade_code || v.grade_code === "not_graded")) {
          patch.grade_code = grade;
          summary.thaq_grade++;
        }
        if (scraped.chapter && (!v.chapter || !v.chapter.trim())) {
          patch.chapter = scraped.chapter;
          addCats(v.hadith_id, scraped.chapter);
        } else if (v.chapter) {
          addCats(v.hadith_id, v.chapter);
        } else if (scraped.chapter) {
          addCats(v.hadith_id, scraped.chapter);
        }

        if (APPLY && Object.keys(patch).length) {
          await sb.from("source_variations").update(patch).eq("id", v.id);
        }

        // Create/update chain from isnad text if missing
        if (scraped.isnad && scraped.isnad.length > 10 && !chainByVar.has(v.id)) {
          summary.thaq_chain++;
          if (APPLY) {
            const { data: ch, error } = await sb
              .from("chains")
              .upsert(
                {
                  variation_id: v.id,
                  chain_number: 1,
                  raw_chain_text: scraped.isnad,
                  continuity_status: "unverified",
                  quality_status: "unverified",
                  verified: false,
                  notes: "Playwright enrich from thaqalayn.net existing URL",
                },
                { onConflict: "variation_id,chain_number" }
              )
              .select("id")
              .single();
            if (!error && ch) {
              chainByVar.set(v.id, { id: ch.id, variation_id: v.id, raw_chain_text: scraped.isnad });
              // Single primary node from leading name if present
              const nameMatch = scraped.isnad.match(/^(?:عن\s+)?([^،,:\n]{3,80})/);
              if (nameMatch) {
                const rawName = nameMatch[1].trim();
                const slug =
                  createHash("sha1").update(rawName).digest("hex").slice(0, 12) +
                  "-" +
                  rawName
                    .toLowerCase()
                    .replace(/[^\p{L}\p{N}]+/gu, "-")
                    .slice(0, 40);
                let narratorId: number | null = null;
                const { data: existingN } = await sb
                  .from("narrators")
                  .select("id")
                  .eq("name", rawName)
                  .maybeSingle();
                if (existingN) narratorId = existingN.id;
                else {
                  const { data: created } = await sb
                    .from("narrators")
                    .insert({
                      slug: `thaq-${slug}`,
                      name: rawName,
                      identity_status: "unverified",
                      alternative_names: [],
                    })
                    .select("id")
                    .maybeSingle();
                  narratorId = created?.id ?? null;
                }
                if (narratorId) {
                  await sb.from("chain_narrators").upsert(
                    {
                      chain_id: ch.id,
                      position: 1,
                      narrator_id: narratorId,
                      raw_name: rawName,
                      transmission_word: "an",
                      match_confidence: 0.4,
                    },
                    { onConflict: "chain_id,position" }
                  );
                }
              }
            }
          }
        }
      } catch {
        summary.thaq_fail++;
      }
      if (i % 20 === 0) console.log(`  thaqalayn ${i}/${thaqVars.length}`);
      await sleep(400);
    }
    await browser.close();
  } else if (SKIP_PW) {
    console.log("Thaqalayn Playwright skipped by flag");
  }

  // ---- 4) Existing chapters → categories for everyone ----
  for (const v of variations) {
    if (v.chapter?.trim()) addCats(v.hadith_id, v.chapter);
  }

  console.log(`Category link plans: ${catInserts.length}`);
  if (APPLY && catInserts.length) {
    for (let i = 0; i < catInserts.length; i += 100) {
      const { error } = await sb.from("hadith_categories").upsert(catInserts.slice(i, i + 100), {
        onConflict: "hadith_id,category_id",
      });
      if (error) console.warn("hadith_categories", error.message);
    }
  }

  // ---- 5) Completeness snapshot ----
  const { count: hadiths } = await sb.from("hadiths").select("*", { count: "exact", head: true });
  const { data: linksNow } = await sb.from("hadith_categories").select("hadith_id");
  const withCat = new Set((linksNow || []).map((l) => l.hadith_id)).size;
  const { count: graded } = await sb
    .from("source_variations")
    .select("*", { count: "exact", head: true })
    .not("grade_code", "is", null)
    .neq("grade_code", "not_graded");
  const { count: chained } = await sb.from("chains").select("*", { count: "exact", head: true });

  mkdirSync(path.join("data", "unmatched"), { recursive: true });
  const out = {
    apply: APPLY,
    ...summary,
    after: {
      hadiths,
      hadiths_with_category: withCat,
      variations_with_real_grade: graded,
      chains: chained,
    },
    note:
      "Dorar + Sunnah HTML not scraped (needs_permission). Sunnah filled via fawaz API. Thaqalayn via Playwright on existing URLs.",
  };
  writeFileSync(
    path.join("data", "unmatched", "enrich-complete-hadith-summary.json"),
    JSON.stringify(out, null, 2),
    "utf8"
  );
  console.log(JSON.stringify(out, null, 2));
  if (!APPLY) console.log("\nDry-run done. Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
