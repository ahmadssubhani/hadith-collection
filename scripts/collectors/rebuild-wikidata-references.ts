/**
 * Rebuild scholars-reference.json + books-reference.json from Wikidata lookups.
 * Old files are untrusted (wrong QIDs) — quarantined under data/collectors/_untrusted/.
 *
 * Scholar accept rule (all required):
 *   1) wbsearchentities by label
 *   2) instance-of human (P31 = Q5)
 *   3) exact normalized label/alias match on search name (en or ar)
 *   4) death year on entity matches search constraint (AH → CE ±3 years)
 * Otherwise wikidata_qid = null and row is logged.
 *
 * Fields written to the rebuilt JSON come ONLY from the accepted entity (or null).
 * Tradition/madhhab/category are NOT invented from memory — left null unless on entity.
 *
 *   npx tsx scripts/collectors/rebuild-wikidata-references.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const UA = "HadithResearchDB/0.1 (research; rebuild-wikidata-references)";
const API = "https://www.wikidata.org/w/api.php";

/** Search constraints only — NOT written as provenance facts until entity confirms. */
const SCHOLAR_SEEDS: {
  slug: string;
  search_name: string;
  search_name_ar?: string;
  death_year_ah: number | null;
}[] = [
  { slug: "abu-hanifa", search_name: "Abu Hanifa", search_name_ar: "أبو حنيفة", death_year_ah: 150 },
  { slug: "malik-ibn-anas", search_name: "Malik ibn Anas", search_name_ar: "مالك بن أنس", death_year_ah: 179 },
  { slug: "al-shafii", search_name: "Al-Shafi'i", search_name_ar: "الشافعي", death_year_ah: 204 },
  { slug: "ahmad-ibn-hanbal", search_name: "Ahmad ibn Hanbal", search_name_ar: "أحمد بن حنبل", death_year_ah: 241 },
  { slug: "al-bukhari-compiler", search_name: "Muhammad al-Bukhari", search_name_ar: "البخاري", death_year_ah: 256 },
  { slug: "muslim-ibn-al-hajjaj", search_name: "Muslim ibn al-Hajjaj", search_name_ar: "مسلم بن الحجاج", death_year_ah: 261 },
  { slug: "abu-dawud-al-sijistani", search_name: "Abu Dawud", search_name_ar: "أبو داود", death_year_ah: 275 },
  { slug: "al-tirmidhi-compiler", search_name: "Al-Tirmidhi", search_name_ar: "الترمذي", death_year_ah: 279 },
  { slug: "al-nasai-compiler", search_name: "Al-Nasa'i", search_name_ar: "النسائي", death_year_ah: 303 },
  { slug: "ibn-majah-compiler", search_name: "Ibn Majah", search_name_ar: "ابن ماجه", death_year_ah: 273 },
  { slug: "al-kulayni", search_name: "Al-Kulayni", search_name_ar: "الكليني", death_year_ah: 329 },
  { slug: "al-saduq", search_name: "Ibn Babawayh", search_name_ar: "الشيخ الصدوق", death_year_ah: 381 },
  { slug: "ali-ibn-abi-talib", search_name: "Ali ibn Abi Talib", search_name_ar: "علي بن أبي طالب", death_year_ah: 40 },
  { slug: "al-hasan-ibn-ali", search_name: "Hasan ibn Ali", search_name_ar: "الحسن بن علي", death_year_ah: 50 },
  { slug: "al-husayn-ibn-ali", search_name: "Husayn ibn Ali", search_name_ar: "الحسين بن علي", death_year_ah: 61 },
  { slug: "ali-zayn-al-abidin", search_name: "Ali ibn Husayn Zayn al-Abidin", search_name_ar: "علي زين العابدين", death_year_ah: 95 },
  { slug: "muhammad-al-baqir", search_name: "Muhammad al-Baqir", search_name_ar: "محمد الباقر", death_year_ah: 114 },
  { slug: "jafar-al-sadiq", search_name: "Ja'far al-Sadiq", search_name_ar: "جعفر الصادق", death_year_ah: 148 },
  { slug: "musa-al-kazim", search_name: "Musa al-Kadhim", search_name_ar: "موسى الكاظم", death_year_ah: 183 },
  { slug: "ali-al-rida", search_name: "Ali al-Ridha", search_name_ar: "علي الرضا", death_year_ah: 203 },
  { slug: "muhammad-al-jawad", search_name: "Muhammad al-Jawad", search_name_ar: "محمد الجواد", death_year_ah: 220 },
  { slug: "ali-al-hadi", search_name: "Ali al-Hadi", search_name_ar: "علي الهادي", death_year_ah: 254 },
  { slug: "al-hasan-al-askari", search_name: "Hasan al-Askari", search_name_ar: "الحسن العسكري", death_year_ah: 260 },
  // No death year constraint → cannot accept QID under name+death rule
  { slug: "muhammad-al-mahdi", search_name: "Muhammad al-Mahdi", search_name_ar: "محمد المهدي", death_year_ah: null },
];

const BOOK_SEEDS: {
  match_titles: string[];
  search_title: string;
  author_search_name?: string;
  author_death_year_ah?: number | null;
}[] = [
  { match_titles: ["Sahih al-Bukhari", "صحيح البخاري"], search_title: "Sahih al-Bukhari", author_search_name: "Muhammad al-Bukhari", author_death_year_ah: 256 },
  { match_titles: ["Sahih Muslim", "Sahīh Muslim", "صحيح مسلم"], search_title: "Sahih Muslim", author_search_name: "Muslim ibn al-Hajjaj", author_death_year_ah: 261 },
  { match_titles: ["Sunan Abu Dawud", "سنن أبي داود"], search_title: "Sunan Abu Dawud", author_search_name: "Abu Dawud", author_death_year_ah: 275 },
  { match_titles: ["Sunan Ibn Majah", "سنن ابن ماجه"], search_title: "Sunan Ibn Majah", author_search_name: "Ibn Majah", author_death_year_ah: 273 },
  { match_titles: ["Sunan al-Nasa'i", "سنن النسائي"], search_title: "Al-Sunan al-Sughra", author_search_name: "Al-Nasa'i", author_death_year_ah: 303 },
  { match_titles: ["Musnad Ahmad", "مسند أحمد"], search_title: "Musnad Ahmad ibn Hanbal", author_search_name: "Ahmad ibn Hanbal", author_death_year_ah: 241 },
  { match_titles: ["Sunan al-Darimi", "سنن الدارمي"], search_title: "Sunan al-Darimi", author_search_name: "Al-Darimi", author_death_year_ah: 255 },
  { match_titles: ["صحيح الترمذي"], search_title: "Jami' al-Tirmidhi", author_search_name: "Al-Tirmidhi", author_death_year_ah: 279 },
  { match_titles: ["Al-Kāfi", "الكافي"], search_title: "Kitab al-Kafi", author_search_name: "Al-Kulayni", author_death_year_ah: 329 },
  { match_titles: ["Man Lā Yaḥḍuruh al-Faqīh"], search_title: "Man La Yahduruhu al-Faqih", author_search_name: "Ibn Babawayh", author_death_year_ah: 381 },
  { match_titles: ["Nahj al-Balāgha"], search_title: "Nahj al-Balagha", author_search_name: "Al-Sharif al-Radi", author_death_year_ah: 406 },
  { match_titles: ["Sunan al-Kubra (al-Nasa'i)", "السنن الكبرى للنسائي"], search_title: "Al-Sunan al-Kubra", author_search_name: "Al-Nasa'i", author_death_year_ah: 303 },
  { match_titles: ["Sahih Ibn Khuzaymah", "صحيح ابن خزيمة"], search_title: "Sahih Ibn Khuzaymah", author_search_name: "Ibn Khuzaymah", author_death_year_ah: 311 },
  { match_titles: ["Sunan al-Daraqutni", "سنن الدارقطني"], search_title: "Sunan al-Daraqutni", author_search_name: "Al-Daraqutni", author_death_year_ah: 385 },
];

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`'’ʻʾʿʻ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Approximate Gregorian year from Hijri year (disambiguation only). */
function ahToCe(ah: number): number {
  return Math.round(622 + (ah * 32) / 33);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function wdGet(params: Record<string, string>, attempt = 1): Promise<any> {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ format: "json", origin: "*", ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 8) throw new Error(`Wikidata ${res.status} after ${attempt} attempts`);
    const wait = Math.min(60_000, 2000 * 2 ** (attempt - 1));
    console.warn(`  rate-limited (${res.status}), wait ${wait}ms…`);
    await sleep(wait);
    return wdGet(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Wikidata ${res.status}`);
  return res.json();
}

async function searchEntities(query: string, language = "en"): Promise<string[]> {
  const json = await wdGet({
    action: "wbsearchentities",
    search: query,
    language,
    uselang: language,
    type: "item",
    limit: "10",
  });
  return (json.search ?? []).map((s: any) => s.id as string);
}

async function getEntities(ids: string[]): Promise<Record<string, any>> {
  if (!ids.length) return {};
  const json = await wdGet({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels|aliases|claims",
    languages: "en|ar",
  });
  return json.entities ?? {};
}

function claimTimes(entity: any, prop: string): number[] {
  const claims = entity?.claims?.[prop] ?? [];
  const years: number[] = [];
  for (const c of claims) {
    const t = c?.mainsnak?.datavalue?.value?.time as string | undefined;
    if (!t) continue;
    // +0767-06-14T00:00:00Z
    const m = t.match(/^[+-]?(\d{1,8})-/);
    if (m) years.push(Number(m[1]));
  }
  return years;
}

function claimEntityIds(entity: any, prop: string): string[] {
  const claims = entity?.claims?.[prop] ?? [];
  const out: string[] = [];
  for (const c of claims) {
    const id = c?.mainsnak?.datavalue?.value?.id;
    if (id) out.push(id);
  }
  return out;
}

function isHuman(entity: any): boolean {
  return claimEntityIds(entity, "P31").includes("Q5");
}

function labelsAndAliases(entity: any): string[] {
  const out: string[] = [];
  for (const lang of ["en", "ar"]) {
    if (entity.labels?.[lang]?.value) out.push(entity.labels[lang].value);
    for (const a of entity.aliases?.[lang] ?? []) out.push(a.value);
  }
  return out;
}

function nameMatches(entity: any, searchName: string, searchAr?: string): boolean {
  const candidates = labelsAndAliases(entity).map(norm);
  const targets = [searchName, searchAr].filter(Boolean).map((s) => norm(s!));
  return targets.some((t) => candidates.some((c) => c === t || c.includes(t) || t.includes(c)));
}

function deathYearMatches(entity: any, deathYearAh: number): boolean {
  const deaths = claimTimes(entity, "P570");
  if (!deaths.length) return false;
  const expectedCe = ahToCe(deathYearAh);
  return deaths.some((y) => Math.abs(y - expectedCe) <= 3);
}

function ceToAhApprox(ce: number): number {
  return Math.round(((ce - 622) * 33) / 32);
}

type ScholarOut = {
  slug: string;
  name: string | null;
  arabic_name: string | null;
  birth_year_ah: number | null;
  death_year_ah: number | null;
  wikidata_qid: string | null;
  source_url: string | null;
  source_name: "Wikidata" | null;
  tradition: null;
  madhhab: null;
  region: null;
  kunya: null;
  laqab: null;
  verification: {
    status: "accepted" | "rejected";
    reason: string;
    search_name: string;
    search_death_year_ah: number | null;
    candidate_qids_tried: string[];
  };
};

async function resolveScholar(seed: (typeof SCHOLAR_SEEDS)[0]): Promise<ScholarOut> {
  const base: ScholarOut = {
    slug: seed.slug,
    name: null,
    arabic_name: null,
    birth_year_ah: null,
    death_year_ah: null,
    wikidata_qid: null,
    source_url: null,
    source_name: null,
    tradition: null,
    madhhab: null,
    region: null,
    kunya: null,
    laqab: null,
    verification: {
      status: "rejected",
      reason: "pending",
      search_name: seed.search_name,
      search_death_year_ah: seed.death_year_ah,
      candidate_qids_tried: [],
    },
  };

  if (seed.death_year_ah == null) {
    base.verification.reason = "no_death_year_constraint_cannot_verify";
    return base;
  }

  const ids = [
    ...new Set([
      ...(await searchEntities(seed.search_name, "en")),
      ...(seed.search_name_ar ? await searchEntities(seed.search_name_ar, "ar") : []),
    ]),
  ].slice(0, 12);
  base.verification.candidate_qids_tried = ids;
  await sleep(1200);
  const entities = await getEntities(ids);
  await sleep(1200);

  for (const qid of ids) {
    const ent = entities[qid];
    if (!ent || ent.missing) continue;
    if (!isHuman(ent)) continue;
    if (!nameMatches(ent, seed.search_name, seed.search_name_ar)) continue;
    if (!deathYearMatches(ent, seed.death_year_ah)) continue;

    const deaths = claimTimes(ent, "P570");
    const births = claimTimes(ent, "P569");
    base.wikidata_qid = qid;
    base.source_url = `https://www.wikidata.org/wiki/${qid}`;
    base.source_name = "Wikidata";
    base.name = ent.labels?.en?.value ?? seed.search_name;
    base.arabic_name = ent.labels?.ar?.value ?? null;
    base.death_year_ah = deaths.length ? ceToAhApprox(deaths[0]) : seed.death_year_ah;
    base.birth_year_ah = births.length ? ceToAhApprox(births[0]) : null;
    base.verification.status = "accepted";
    base.verification.reason = "human_exact_or_near_label_and_death_year";
    return base;
  }

  base.verification.reason = ids.length
    ? "no_candidate_passed_human_name_death_filters"
    : "search_returned_no_candidates";
  return base;
}

type BookOut = {
  match_titles: string[];
  search_title: string;
  wikidata_qid: string | null;
  source_url: string | null;
  source_name: "Wikidata" | null;
  arabic_title: string | null;
  author: string | null;
  author_wikidata_qid: string | null;
  author_death_year_ah: number | null;
  tradition: null;
  category: null;
  verification: {
    status: "accepted" | "partial" | "rejected";
    reason: string;
    candidate_qids_tried: string[];
  };
};

async function resolveAuthor(
  name: string,
  deathAh: number | null | undefined
): Promise<{ qid: string | null; label: string | null; death_ah: number | null; reason: string }> {
  if (deathAh == null) {
    return { qid: null, label: null, death_ah: null, reason: "author_no_death_year_constraint" };
  }
  const ids = (await searchEntities(name, "en")).slice(0, 8);
  await sleep(1000);
  const ents = await getEntities(ids);
  await sleep(1000);
  for (const qid of ids) {
    const ent = ents[qid];
    if (!ent || ent.missing) continue;
    if (!isHuman(ent)) continue;
    if (!nameMatches(ent, name)) continue;
    if (!deathYearMatches(ent, deathAh)) continue;
    const deaths = claimTimes(ent, "P570");
    return {
      qid,
      label: ent.labels?.en?.value ?? name,
      death_ah: deaths.length ? ceToAhApprox(deaths[0]) : deathAh,
      reason: "accepted",
    };
  }
  return { qid: null, label: null, death_ah: null, reason: "author_not_verified" };
}

async function resolveBook(seed: (typeof BOOK_SEEDS)[0]): Promise<BookOut> {
  const out: BookOut = {
    match_titles: seed.match_titles,
    search_title: seed.search_title,
    wikidata_qid: null,
    source_url: null,
    source_name: null,
    arabic_title: null,
    author: null,
    author_wikidata_qid: null,
    author_death_year_ah: null,
    tradition: null,
    category: null,
    verification: { status: "rejected", reason: "pending", candidate_qids_tried: [] },
  };

  const ids = (await searchEntities(seed.search_title, "en")).slice(0, 8);
  out.verification.candidate_qids_tried = ids;
  await sleep(1200);
  const ents = await getEntities(ids);
  await sleep(1200);

  // Prefer a work/book-like item whose label matches title
  let bookEnt: any = null;
  let bookQid: string | null = null;
  for (const qid of ids) {
    const ent = ents[qid];
    if (!ent || ent.missing) continue;
    if (isHuman(ent)) continue; // skip people when searching books
    if (!nameMatches(ent, seed.search_title) && !nameMatches(ent, seed.match_titles[0])) continue;
    bookEnt = ent;
    bookQid = qid;
    break;
  }

  const author = seed.author_search_name
    ? await resolveAuthor(seed.author_search_name, seed.author_death_year_ah)
    : { qid: null, label: null, death_ah: null, reason: "no_author_seed" };

  if (bookQid && bookEnt) {
    out.wikidata_qid = bookQid;
    out.source_url = `https://www.wikidata.org/wiki/${bookQid}`;
    out.source_name = "Wikidata";
    out.arabic_title = bookEnt.labels?.ar?.value ?? null;
    // If work has P50 author, prefer that label only after verifying human+death when seed has death
    const p50 = claimEntityIds(bookEnt, "P50");
    if (author.qid && author.label) {
      out.author = author.label;
      out.author_wikidata_qid = author.qid;
      out.author_death_year_ah = author.death_ah;
      out.verification.status = "accepted";
      out.verification.reason = `book_and_author_verified; p50=${p50.join("|") || "none"}`;
    } else if (author.qid == null && seed.author_search_name) {
      out.verification.status = "partial";
      out.verification.reason = `book_verified_author_failed:${author.reason}`;
    } else {
      out.verification.status = "partial";
      out.verification.reason = "book_verified_no_author_seed";
    }
    return out;
  }

  // Book title not found — still record verified author if any
  if (author.qid && author.label) {
    out.author = author.label;
    out.author_wikidata_qid = author.qid;
    out.author_death_year_ah = author.death_ah;
    out.verification.status = "partial";
    out.verification.reason = `author_only:${author.reason}; book_title_not_found`;
    return out;
  }

  out.verification.reason = "book_and_author_unverified";
  return out;
}

async function main() {
  console.log("Rebuilding Wikidata-verified reference files…");
  const scholarLogs: ScholarOut[] = [];
  for (const seed of SCHOLAR_SEEDS) {
    process.stdout.write(`  scholar ${seed.slug}… `);
    const row = await resolveScholar(seed);
    scholarLogs.push(row);
    console.log(row.verification.status, row.wikidata_qid ?? row.verification.reason);
  }

  const bookLogs: BookOut[] = [];
  for (const seed of BOOK_SEEDS) {
    process.stdout.write(`  book ${seed.search_title}… `);
    const row = await resolveBook(seed);
    bookLogs.push(row);
    console.log(row.verification.status, row.wikidata_qid ?? row.verification.reason);
  }

  const scholarsDoc = {
    provenance: {
      source_name: "Wikidata",
      license: "CC0 1.0",
      verified_via: "wikidata_search_human_death_year",
      generated_at: new Date().toISOString(),
      notes:
        "Rebuilt via wbsearchentities + wbgetentities. QID accepted only if P31=human, label/alias matches search name, and P570 matches search death_year_ah (±3 CE years). Unmatched fields are null. Old wrong-QID file quarantined under _untrusted/.",
    },
    scholars: scholarLogs.map((s) => ({
      slug: s.slug,
      name: s.name,
      arabic_name: s.arabic_name,
      birth_year_ah: s.birth_year_ah,
      death_year_ah: s.death_year_ah,
      tradition: s.tradition,
      madhhab: s.madhhab,
      region: s.region,
      kunya: s.kunya,
      laqab: s.laqab,
      wikidata_qid: s.wikidata_qid,
      source_url: s.source_url,
      source_name: s.source_name,
    })),
    null_tradition_candidates: [], // not invented; leave empty until sourced
  };

  const booksDoc = {
    provenance: {
      source_name: "Wikidata",
      license: "CC0 1.0",
      verified_via: "wikidata_search_work_and_author_human_death_year",
      generated_at: new Date().toISOString(),
      notes:
        "Book title searched on Wikidata; author accepted only as human with matching death year. tradition/category left null (not on entity). Quarantined prior file under _untrusted/.",
    },
    books: bookLogs.map((b) => ({
      match_titles: b.match_titles,
      tradition: b.tradition,
      category: b.category,
      author: b.author,
      arabic_title: b.arabic_title,
      wikidata_qid: b.wikidata_qid,
      author_wikidata_qid: b.author_wikidata_qid,
      author_death_year_ah: b.author_death_year_ah,
      source_name: b.source_name,
      source_url: b.source_url,
    })),
  };

  const dir = path.join("data", "collectors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "scholars-reference.json"), JSON.stringify(scholarsDoc, null, 2), "utf8");
  writeFileSync(path.join(dir, "books-reference.json"), JSON.stringify(booksDoc, null, 2), "utf8");

  const unmatchedDir = path.join("data", "unmatched");
  mkdirSync(unmatchedDir, { recursive: true });
  writeFileSync(
    path.join(unmatchedDir, "wikidata-reference-rebuild-log.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scholars: {
          accepted: scholarLogs.filter((s) => s.verification.status === "accepted").length,
          rejected: scholarLogs.filter((s) => s.verification.status === "rejected").length,
          rows: scholarLogs.map((s) => ({ slug: s.slug, ...s.verification, qid: s.wikidata_qid })),
        },
        books: {
          accepted: bookLogs.filter((b) => b.verification.status === "accepted").length,
          partial: bookLogs.filter((b) => b.verification.status === "partial").length,
          rejected: bookLogs.filter((b) => b.verification.status === "rejected").length,
          rows: bookLogs.map((b) => ({
            search_title: b.search_title,
            ...b.verification,
            qid: b.wikidata_qid,
            author_qid: b.author_wikidata_qid,
          })),
        },
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        scholars_accepted: scholarLogs.filter((s) => s.verification.status === "accepted").length,
        scholars_rejected: scholarLogs.filter((s) => s.verification.status === "rejected").length,
        books_accepted: bookLogs.filter((b) => b.verification.status === "accepted").length,
        books_partial: bookLogs.filter((b) => b.verification.status === "partial").length,
        books_rejected: bookLogs.filter((b) => b.verification.status === "rejected").length,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
