/**
 * Read-only live DB audit for docs/db-audit.md
 *   npx tsx scripts/_db-audit.ts
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function sample(table: string, select: string, limit = 20, order = "id") {
  const { data, error } = await sb.from(table).select(select).order(order).limit(limit);
  if (error) throw new Error(`${table} sample: ${error.message}`);
  return data ?? [];
}

async function nullRate(table: string, col: string, total: number): Promise<{ nulls: number; pct: string }> {
  if (!total) return { nulls: 0, pct: "0%" };
  const { count, error } = await sb.from(table).select("*", { count: "exact", head: true }).is(col, null);
  if (error) {
    // some cols may not allow .is — try empty string separately
    return { nulls: -1, pct: `err:${error.message}` };
  }
  const nulls = count ?? 0;
  return { nulls, pct: `${((100 * nulls) / total).toFixed(1)}%` };
}

async function emptyOrNullText(table: string, col: string, total: number) {
  if (!total) return { empty: 0, pct: "0%" };
  const { count: n1 } = await sb.from(table).select("*", { count: "exact", head: true }).is(col, null);
  // PostgREST: or for empty
  const { count: n2 } = await sb.from(table).select("*", { count: "exact", head: true }).eq(col, "");
  const empty = (n1 ?? 0) + (n2 ?? 0);
  return { empty, pct: `${((100 * empty) / total).toFixed(1)}%` };
}

async function main() {
  const tables = [
    "books",
    "hadiths",
    "source_variations",
    "narrators",
    "chains",
    "chain_narrators",
    "scholars",
    "hadith_assessments",
    "chain_assessments",
    "narrator_assessments",
    "import_batches",
    "raw_import_records",
    "daily_topics",
    "daily_hadith_logs",
    "daily_hadith_batch",
    "profiles",
    "hadith_merge_backup",
  ];

  const counts: Record<string, number | string> = {};
  for (const t of tables) {
    try {
      counts[t] = await count(t);
    } catch (e: any) {
      counts[t] = `MISSING/ERR: ${e.message}`;
    }
  }

  // books by tradition
  const traditions = ["Sunni", "Twelver Shia", "unclassified", "sunni", "shia"];
  const bookTradition: Record<string, number> = {};
  for (const t of traditions) {
    bookTradition[t] = await count("books", (q) => q.eq("tradition", t));
  }
  // all distinct traditions via sample of all books
  const allBooks = await sample("books", "id, title, arabic_title, author, tradition, book_type, source_url", 500);
  const traditionBuckets = new Map<string, number>();
  for (const b of allBooks) {
    const t = (b.tradition as string) || "(null)";
    traditionBuckets.set(t, (traditionBuckets.get(t) ?? 0) + 1);
  }

  // suspect HadeethEnc attribution strings as books
  const suspectBooks = allBooks.filter((b) => {
    const title = String(b.title ?? "");
    return (
      /^Narrated by /i.test(title) ||
      /Agreed upon/i.test(title) ||
      /^Narrated by/i.test(title) ||
      title.includes(" - Narrated") ||
      title.length > 80
    );
  });

  // Thaqalayn / Shia books wrongly tagged
  const shiaTitleHints = /kafi|kāfi|الكافي|nahj|نهج|thaqalayn|faqih|tusi|saduq|kulayni|majlisi|amali|amālī|ghayba|khisal|khisāl/i;
  const mislabeledShia = allBooks.filter(
    (b) => shiaTitleHints.test(String(b.title)) && !/shia|twelver/i.test(String(b.tradition ?? ""))
  );

  // sunni books tagged unclassified
  const sunniHints = /bukhari|muslim|tirmidhi|nasa'?i|abu\s*dawud|ibn\s*majah|malik|ahmad|dorar/i;
  const unclassifiedSunniLooking = allBooks.filter(
    (b) => sunniHints.test(String(b.title)) && /unclassified/i.test(String(b.tradition ?? ""))
  );

  // hadiths
  const hadiths = await sample("hadiths", "id, slug, title, arabic_title, summary, topics, review_status", 50);
  const hadithByStatus: Record<string, number> = {};
  for (const s of ["draft", "in_review", "published", "rejected"]) {
    hadithByStatus[s] = await count("hadiths", (q) => q.eq("review_status", s));
  }

  // source_variations null rates
  const svTotal = counts.source_variations as number;
  const svCols = [
    "hadith_number",
    "chapter",
    "volume",
    "page",
    "arabic_text",
    "english_text",
    "translator",
    "source_url",
    "status_notes",
  ];
  const svNulls: Record<string, unknown> = {};
  for (const c of svCols) svNulls[c] = await emptyOrNullText("source_variations", c, svTotal);
  const svVerified = await count("source_variations", (q) => q.eq("verified", true));
  const svByStatus: Record<string, number> = {};
  for (const s of ["not_graded", "sahih", "hasan", "daif", "mawdu", "munkar"]) {
    svByStatus[s] = await count("source_variations", (q) => q.eq("hadith_status", s));
  }

  // duplicate variations by (book_id, hadith_number) — fetch and aggregate client-side
  const { data: svKeys } = await sb
    .from("source_variations")
    .select("id, book_id, hadith_number, source_url")
    .not("hadith_number", "is", null)
    .limit(5000);
  const dupKey = new Map<string, number[]>();
  for (const r of svKeys ?? []) {
    const k = `${r.book_id}|${String(r.hadith_number).trim()}`;
    const list = dupKey.get(k) ?? [];
    list.push(r.id);
    dupKey.set(k, list);
  }
  const dupGroups = [...dupKey.entries()].filter(([, ids]) => ids.length > 1);
  const dupByUrl = new Map<string, number>();
  for (const r of svKeys ?? []) {
    const u = (r.source_url ?? "").trim();
    if (!u) continue;
    dupByUrl.set(u, (dupByUrl.get(u) ?? 0) + 1);
  }
  const dupUrls = [...dupByUrl.entries()].filter(([, n]) => n > 1);

  // orphans
  const chainTotal = counts.chains as number;
  const { data: allChains } = await sb.from("chains").select("id, variation_id").limit(5000);
  const { data: allVars } = await sb.from("source_variations").select("id, hadith_id, book_id").limit(5000);
  const varIds = new Set((allVars ?? []).map((v) => v.id));
  const orphanChains = (allChains ?? []).filter((c) => !varIds.has(c.variation_id));

  const { data: cnRows } = await sb.from("chain_narrators").select("id, chain_id, narrator_id, raw_name").limit(8000);
  const chainIds = new Set((allChains ?? []).map((c) => c.id));
  const orphanCn = (cnRows ?? []).filter((c) => !chainIds.has(c.chain_id));
  const unresolvedNodes = (cnRows ?? []).filter((c) => c.narrator_id == null);

  const { data: narrIds } = await sb.from("narrators").select("id").limit(5000);
  const narrSet = new Set((narrIds ?? []).map((n) => n.id));
  const danglingNarratorRefs = (cnRows ?? []).filter(
    (c) => c.narrator_id != null && !narrSet.has(c.narrator_id)
  );

  // chains with zero nodes
  const nodesByChain = new Map<number, number>();
  for (const c of cnRows ?? []) {
    nodesByChain.set(c.chain_id, (nodesByChain.get(c.chain_id) ?? 0) + 1);
  }
  const chainsWithNoNodes = (allChains ?? []).filter((c) => !nodesByChain.has(c.id)).length;

  // narrators null rates
  const nTotal = counts.narrators as number;
  const narrNulls: Record<string, unknown> = {};
  for (const c of ["arabic_name", "birth_year_ah", "death_year_ah", "region", "generation", "biography"]) {
    narrNulls[c] = await nullRate("narrators", c, nTotal);
  }
  const narrVerified = await count("narrators", (q) => q.eq("identity_status", "verified"));
  const narrWithAssess = new Set(
    ((await sb.from("narrator_assessments").select("narrator_id").limit(10000)).data ?? []).map(
      (r) => r.narrator_id
    )
  );
  const narratorsWithoutAuth = nTotal - narrWithAssess.size;

  // scholars
  const scholars = await sample("scholars", "id, slug, name, arabic_name, tradition, birth_year_ah, death_year_ah", 200);
  const scholarTradition = new Map<string, number>();
  for (const s of scholars) {
    const t = (s.tradition as string) || "(null)";
    scholarTradition.set(t, (scholarTradition.get(t) ?? 0) + 1);
  }

  // assessments
  const haTotal = counts.hadith_assessments as number;
  const caTotal = counts.chain_assessments as number;
  const naTotal = counts.narrator_assessments as number;
  const naVerified = await count("narrator_assessments", (q) => q.eq("verified", true));
  const haVerified = await count("hadith_assessments", (q) => q.eq("verified", true));

  // variations without chains
  const varsWithChains = new Set((allChains ?? []).map((c) => c.variation_id));
  const varsWithoutChains = (allVars ?? []).filter((v) => !varsWithChains.has(v.id)).length;

  // chains without assessments
  const { data: caRows } = await sb.from("chain_assessments").select("chain_id").limit(5000);
  const assessedChains = new Set((caRows ?? []).map((r) => r.chain_id));
  const chainsWithoutAssessment = chainTotal - assessedChains.size;

  // hadiths without topics
  const hadithsEmptyTopics = hadiths.filter((h) => !h.topics || (h.topics as string[]).length === 0);

  // import tracking
  const batches = await sample("import_batches", "id, provider, source_url, permission_status, retrieved_at, notes", 50);

  // extensions / missing category tables (probe)
  const missingLookups = [
    "categories",
    "hadith_categories",
    "topics",
    "hadith_topics",
    "name_aliases",
    "narrator_teachers",
    "narrator_students",
    "grade_lookup",
  ];
  const lookupProbe: Record<string, string> = {};
  for (const t of missingLookups) {
    try {
      await count(t);
      lookupProbe[t] = "EXISTS";
    } catch (e: any) {
      lookupProbe[t] = "MISSING";
    }
  }

  // arabic_search_text column probe
  let hasArabicSearch = false;
  try {
    const { error } = await sb.from("source_variations").select("arabic_search_text").limit(1);
    hasArabicSearch = !error;
  } catch {
    hasArabicSearch = false;
  }

  const report = {
    generated_at: new Date().toISOString(),
    project_ref: "ggmqufghubpgsquldjdx",
    counts,
    books: {
      traditionBuckets: Object.fromEntries(traditionBuckets),
      bookTraditionExplicit: bookTradition,
      suspectAttributionTitles: suspectBooks.map((b) => ({ id: b.id, title: b.title, tradition: b.tradition })),
      mislabeledLikelyShia: mislabeledShia.map((b) => ({ id: b.id, title: b.title, tradition: b.tradition })),
      unclassifiedLookingSunni: unclassifiedSunniLooking.map((b) => ({
        id: b.id,
        title: b.title,
        tradition: b.tradition,
      })),
      missingArabicTitle: allBooks.filter((b) => !b.arabic_title).length,
      missingAuthor: allBooks.filter((b) => !b.author).length,
    },
    hadiths: {
      byStatus: hadithByStatus,
      rows: hadiths,
      emptyTopicsInSample: hadithsEmptyTopics.map((h) => h.slug),
    },
    source_variations: {
      total: svTotal,
      verified: svVerified,
      unverified: typeof svTotal === "number" ? svTotal - svVerified : null,
      nullRates: svNulls,
      hadithStatusCounts: svByStatus,
      duplicateBookNumberGroups: dupGroups.length,
      duplicateBookNumberExamples: dupGroups.slice(0, 15).map(([k, ids]) => ({ key: k, ids, n: ids.length })),
      duplicateSourceUrlGroups: dupUrls.length,
      duplicateSourceUrlExamples: dupUrls.slice(0, 10).map(([u, n]) => ({ url: u, n })),
      variationsWithoutChains: varsWithoutChains,
    },
    chains: {
      total: chainTotal,
      verified: await count("chains", (q) => q.eq("verified", true)),
      orphanChains: orphanChains.length,
      chainsWithNoNodes,
      chainsWithoutAssessment,
      unresolvedNarratorNodes: unresolvedNodes.length,
      danglingNarratorRefs: danglingNarratorRefs.length,
      orphanChainNarrators: orphanCn.length,
    },
    narrators: {
      total: nTotal,
      verified: narrVerified,
      nullRates: narrNulls,
      withoutAnyAssessment: narratorsWithoutAuth,
      withAssessment: narrWithAssess.size,
    },
    scholars: {
      total: counts.scholars,
      traditionBuckets: Object.fromEntries(scholarTradition),
      sample: scholars.slice(0, 30),
    },
    assessments: {
      hadith_assessments: haTotal,
      hadith_assessments_verified: haVerified,
      chain_assessments: caTotal,
      narrator_assessments: naTotal,
      narrator_assessments_verified: naVerified,
    },
    import: {
      batches: counts.import_batches,
      raw_records: counts.raw_import_records,
      recentBatches: batches,
    },
    daily: {
      daily_topics: counts.daily_topics,
      daily_hadith_logs: counts.daily_hadith_logs,
      daily_hadith_batch: counts.daily_hadith_batch,
    },
    schemaProbes: {
      lookupTables: lookupProbe,
      source_variations_arabic_search_text: hasArabicSearch,
      profiles: counts.profiles,
      hadith_merge_backup: counts.hadith_merge_backup,
    },
  };

  mkdirSync(path.join("data"), { recursive: true });
  writeFileSync(path.join("data", "db-audit-raw.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote data/db-audit-raw.json");
  console.log(JSON.stringify({ counts, suspectBooks: suspectBooks.length, mislabeledShia: mislabeledShia.length, dupGroups: dupGroups.length, chainsWithoutAssessment, narratorsWithoutAuth }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
