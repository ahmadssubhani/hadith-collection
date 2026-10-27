/**
 * Deliverable A — read-only gap report for the complete knowledge-graph goal.
 * Writes:
 *   data/unmatched/gap-report-a.json
 *   docs/gap-report-a.md
 *
 *   npx tsx scripts/collectors/gap-report-a.ts
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adminClient, fetchAll } from "./_shared";

type ColFill = {
  column: string;
  total: number;
  filled: number;
  empty: number;
  fill_pct: number;
};

function pct(filled: number, total: number): number {
  if (!total) return 0;
  return Number(((100 * filled) / total).toFixed(1));
}

function colStats(rows: Record<string, unknown>[], columns: string[]): ColFill[] {
  const total = rows.length;
  return columns.map((column) => {
    let filled = 0;
    for (const r of rows) {
      const v = r[column];
      if (v == null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      filled++;
    }
    return {
      column,
      total,
      filled,
      empty: total - filled,
      fill_pct: pct(filled, total),
    };
  });
}

async function countExact(
  sb: ReturnType<typeof adminClient>,
  table: string,
  filter?: (q: any) => any
): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log("Gap report A (read-only)…");
  const sb = adminClient();

  // ---- load core tables ----
  const hadiths = await fetchAll<Record<string, unknown>>(
    sb,
    "hadiths",
    "id,slug,title,arabic_title,summary,topics,review_status,data_origin,normalized_name"
  );
  const variations = await fetchAll<Record<string, unknown>>(
    sb,
    "source_variations",
    "id,hadith_id,book_id,hadith_number,chapter,volume,page,arabic_text,english_text,translator,source_url,hadith_status,chain_status,narration_status,status_notes,verified,data_origin,review_status,attribution_text,attribution_book_id,hadith_type,transmission_scope,grade_code"
  );
  const narrators = await fetchAll<Record<string, unknown>>(
    sb,
    "narrators",
    "id,slug,name,arabic_name,alternative_names,birth_year_ah,death_year_ah,region,generation,biography,summary_score,identity_status,normalized_name,name_quality,kunya,nisba,laqab,gender,tradition,birth_year_ce,death_year_ce,biography_source,biography_source_url,tabaqah"
  );
  const chains = await fetchAll<Record<string, unknown>>(
    sb,
    "chains",
    "id,variation_id,chain_number,raw_chain_text,continuity_status,quality_status,notes,verified"
  );
  const chainNarrators = await fetchAll<Record<string, unknown>>(
    sb,
    "chain_narrators",
    "id,chain_id,narrator_id,position,raw_name,transmission_word,match_confidence,match_notes,is_weak_link,weak_link_reason"
  );
  const scholars = await fetchAll<Record<string, unknown>>(
    sb,
    "scholars",
    "id,slug,name,arabic_name,tradition,birth_year_ah,death_year_ah,credentials,methodology,normalized_name,kunya,laqab,madhhab,region,birth_year_ce,death_year_ce,works,teachers,students,canonical_scholar_id"
  );
  const books = await fetchAll<Record<string, unknown>>(
    sb,
    "books",
    "id,title,arabic_title,author,tradition,book_type,source_url,license,book_kind,category,publisher,edition,volumes,hadith_count,canonical_book_id"
  );
  const hadithAssessments = await fetchAll<Record<string, unknown>>(
    sb,
    "hadith_assessments",
    "id,variation_id,scholar_id,original_grade,normalized_grade,explanation,reference_book,edition,volume,page,source_url,verified"
  );
  const chainAssessments = await fetchAll<Record<string, unknown>>(
    sb,
    "chain_assessments",
    "id,chain_id,scholar_id,continuity_status,quality_status,explanation,reference_book,edition,volume,page,source_url,verified"
  );
  const narratorAssessments = await fetchAll<Record<string, unknown>>(
    sb,
    "narrator_assessments",
    "id,narrator_id,scholar_id,original_term,normalized_term,explanation,display_score,mapping_method,reference_book,edition,volume,page,source_url,verified,computed_summary,computed_summary_method"
  );
  const nameAliases = await fetchAll<Record<string, unknown>>(
    sb,
    "name_aliases",
    "id,entity_type,entity_id,alias,alias_normalized,script,source_name,source_url"
  );
  const narratorRelations = await fetchAll<Record<string, unknown>>(
    sb,
    "narrator_relations",
    "id,from_narrator_id,to_narrator_id,relation_type,source_name,source_url,verified"
  );
  const categories = await fetchAll<Record<string, unknown>>(
    sb,
    "categories",
    "id,slug,title,arabic_title,description,keywords,parent_id,tradition,sort_order"
  );
  const hadithCategories = await fetchAll<Record<string, unknown>>(
    sb,
    "hadith_categories",
    "hadith_id,category_id"
  );
  const gradeLookup = await fetchAll<Record<string, unknown>>(sb, "grade_lookup", "code,title,arabic_title,description,sort_order");
  const hadithTypeLookup = await fetchAll<Record<string, unknown>>(sb, "hadith_type_lookup", "code,title,arabic_title,description");
  const chainStatusLookup = await fetchAll<Record<string, unknown>>(sb, "chain_status_lookup", "code,title,arabic_title,description");
  const transmissionLookup = await fetchAll<Record<string, unknown>>(
    sb,
    "transmission_scope_lookup",
    "code,title,arabic_title,description"
  );
  const batches = await fetchAll<Record<string, unknown>>(
    sb,
    "import_batches",
    "id,provider,source_url,license,permission_status,retrieved_at,notes,is_superseded"
  );

  // ---- table row counts ----
  const tableCounts = {
    hadiths: hadiths.length,
    source_variations: variations.length,
    narrators: narrators.length,
    chains: chains.length,
    chain_narrators: chainNarrators.length,
    scholars: scholars.length,
    books: books.length,
    hadith_assessments: hadithAssessments.length,
    chain_assessments: chainAssessments.length,
    narrator_assessments: narratorAssessments.length,
    name_aliases: nameAliases.length,
    narrator_relations: narratorRelations.length,
    categories: categories.length,
    hadith_categories: hadithCategories.length,
    grade_lookup: gradeLookup.length,
    hadith_type_lookup: hadithTypeLookup.length,
    chain_status_lookup: chainStatusLookup.length,
    transmission_scope_lookup: transmissionLookup.length,
    import_batches: batches.length,
    raw_import_records: await countExact(sb, "raw_import_records"),
  };

  // ---- column fill ----
  const column_fill = {
    hadiths: colStats(hadiths, [
      "slug",
      "title",
      "arabic_title",
      "summary",
      "topics",
      "review_status",
      "data_origin",
      "normalized_name",
    ]),
    source_variations: colStats(variations, [
      "hadith_id",
      "book_id",
      "hadith_number",
      "chapter",
      "volume",
      "page",
      "arabic_text",
      "english_text",
      "translator",
      "source_url",
      "hadith_status",
      "chain_status",
      "verified",
      "data_origin",
      "review_status",
      "attribution_text",
      "attribution_book_id",
      "hadith_type",
      "transmission_scope",
      "grade_code",
    ]),
    narrators: colStats(narrators, [
      "name",
      "arabic_name",
      "alternative_names",
      "birth_year_ah",
      "death_year_ah",
      "region",
      "generation",
      "biography",
      "identity_status",
      "normalized_name",
      "name_quality",
      "kunya",
      "nisba",
      "laqab",
      "gender",
      "tradition",
      "birth_year_ce",
      "death_year_ce",
      "biography_source",
      "biography_source_url",
      "tabaqah",
    ]),
    chains: colStats(chains, [
      "raw_chain_text",
      "continuity_status",
      "quality_status",
      "notes",
      "verified",
    ]),
    chain_narrators: colStats(chainNarrators, [
      "narrator_id",
      "raw_name",
      "transmission_word",
      "match_confidence",
      "is_weak_link",
      "weak_link_reason",
    ]),
    scholars: colStats(scholars, [
      "name",
      "arabic_name",
      "tradition",
      "birth_year_ah",
      "death_year_ah",
      "credentials",
      "methodology",
      "kunya",
      "laqab",
      "madhhab",
      "region",
      "birth_year_ce",
      "death_year_ce",
      "works",
      "teachers",
      "students",
      "canonical_scholar_id",
    ]),
    books: colStats(books, [
      "title",
      "arabic_title",
      "author",
      "tradition",
      "book_type",
      "source_url",
      "license",
      "book_kind",
      "category",
      "publisher",
      "edition",
      "volumes",
      "hadith_count",
      "canonical_book_id",
    ]),
    hadith_assessments: colStats(hadithAssessments, [
      "original_grade",
      "normalized_grade",
      "explanation",
      "reference_book",
      "edition",
      "volume",
      "page",
      "source_url",
      "verified",
    ]),
    narrator_assessments: colStats(narratorAssessments, [
      "original_term",
      "normalized_term",
      "explanation",
      "display_score",
      "mapping_method",
      "reference_book",
      "volume",
      "page",
      "source_url",
      "verified",
      "computed_summary",
      "computed_summary_method",
    ]),
    name_aliases: colStats(nameAliases, ["alias", "source_name", "source_url", "script"]),
    narrator_relations: colStats(narratorRelations, [
      "relation_type",
      "source_name",
      "source_url",
      "verified",
    ]),
    categories: colStats(categories, [
      "title",
      "arabic_title",
      "description",
      "parent_id",
      "tradition",
      "keywords",
    ]),
  };

  // ---- coverage aggregates for "complete" entities ----
  const varsWithArabic = variations.filter((v) => v.arabic_text && String(v.arabic_text).trim()).length;
  const varsWithEnglish = variations.filter((v) => v.english_text && String(v.english_text).trim()).length;
  const varsWithUrl = variations.filter((v) => v.source_url && String(v.source_url).trim()).length;
  const varsWithAssessment = new Set(hadithAssessments.map((a) => a.variation_id as number));
  const varsWithChain = new Set(chains.map((c) => c.variation_id as number));
  const chainsWithNodes = new Set(chainNarrators.map((n) => n.chain_id as number));
  const narrWithAssessment = new Set(narratorAssessments.map((a) => a.narrator_id as number));
  const cnLinked = chainNarrators.filter((n) => n.narrator_id != null).length;
  const cnOrphan = chainNarrators.filter((n) => n.narrator_id == null).length;

  const entity_coverage = {
    hadith_canonical: {
      total: hadiths.length,
      published: hadiths.filter((h) => h.review_status === "published").length,
      with_variations: new Set(variations.map((v) => v.hadith_id as number)).size,
      note: "Canonical hadith rows are few; most content lives on source_variations.",
    },
    hadith_variation: {
      total: variations.length,
      with_arabic_text: varsWithArabic,
      with_english_text: varsWithEnglish,
      with_source_url: varsWithUrl,
      with_chain: [...varsWithChain].filter((id) => variations.some((v) => v.id === id)).length,
      with_hadith_assessment: [...varsWithAssessment].filter((id) =>
        variations.some((v) => v.id === id)
      ).length,
      verified_true: variations.filter((v) => v.verified === true).length,
      review_published: variations.filter((v) => v.review_status === "published").length,
      needs_permission_batch_hosts: "see import_batches; sunnah/dorar = needs_permission",
    },
    narrator: {
      total: narrators.length,
      clean: narrators.filter((n) => n.name_quality === "clean").length,
      fragment: narrators.filter((n) => n.name_quality === "fragment").length,
      needs_review: narrators.filter((n) => n.name_quality === "needs_review").length,
      with_arabic_script_name: narrators.filter(
        (n) => n.arabic_name && /[\u0600-\u06FF]/.test(String(n.arabic_name))
      ).length,
      with_assessment: narrWithAssessment.size,
      with_biography: narrators.filter((n) => n.biography && String(n.biography).trim()).length,
      with_biography_source_url: narrators.filter(
        (n) => n.biography_source_url && String(n.biography_source_url).trim()
      ).length,
      with_death_year_ah: narrators.filter((n) => n.death_year_ah != null).length,
      with_generation: narrators.filter((n) => n.generation && String(n.generation).trim()).length,
      identity_verified: narrators.filter((n) => n.identity_status === "verified").length,
    },
    chain: {
      total: chains.length,
      with_raw_text: chains.filter((c) => c.raw_chain_text && String(c.raw_chain_text).trim()).length,
      with_nodes: chainsWithNodes.size,
      empty_nodes: chains.length - chainsWithNodes.size,
      assessments: chainAssessments.length,
      nodes_total: chainNarrators.length,
      nodes_linked_to_narrator: cnLinked,
      nodes_orphan_narrator_id: cnOrphan,
      with_transmission_word: chainNarrators.filter(
        (n) => n.transmission_word && String(n.transmission_word).trim()
      ).length,
      weak_links_flagged: chainNarrators.filter((n) => n.is_weak_link === true).length,
    },
    scholar: {
      total: scholars.length,
      with_tradition: scholars.filter((s) => s.tradition && String(s.tradition).trim()).length,
      with_death_year_ah: scholars.filter((s) => s.death_year_ah != null).length,
      with_arabic_name: scholars.filter((s) => s.arabic_name && String(s.arabic_name).trim()).length,
      with_madhhab: scholars.filter((s) => s.madhhab && String(s.madhhab).trim()).length,
    },
    book: {
      total: books.length,
      by_kind: Object.fromEntries(
        [...new Set(books.map((b) => String(b.book_kind ?? "null")))].map((k) => [
          k,
          books.filter((b) => String(b.book_kind ?? "null") === k).length,
        ])
      ),
      with_author: books.filter((b) => b.author && String(b.author).trim() && b.author !== "-").length,
      with_source_url: books.filter((b) => b.source_url && String(b.source_url).trim()).length,
      with_canonical: books.filter((b) => b.canonical_book_id != null).length,
      tradition_unclassified: books.filter((b) => b.tradition === "unclassified" || !b.tradition)
        .length,
    },
    lookups: {
      categories: categories.length,
      hadith_category_links: hadithCategories.length,
      grade_lookup: gradeLookup.map((g) => g.code),
      hadith_type_lookup: hadithTypeLookup.map((g) => g.code),
      chain_status_lookup: chainStatusLookup.map((g) => g.code),
      transmission_scope_lookup: transmissionLookup.map((g) => g.code),
    },
    graph_edges: {
      name_aliases: nameAliases.length,
      narrator_relations: narratorRelations.length,
      narrator_relations_by_type: Object.fromEntries(
        [...new Set(narratorRelations.map((r) => String(r.relation_type)))].map((t) => [
          t,
          narratorRelations.filter((r) => String(r.relation_type) === t).length,
        ])
      ),
    },
  };

  // ---- suspicious narrators with bio/death/generation ----
  const suspicious = narrators.filter((n) => {
    const hasBio = !!(n.biography && String(n.biography).trim());
    const hasDeath = n.death_year_ah != null;
    const hasGen = !!(n.generation && String(n.generation).trim());
    return hasBio || hasDeath || hasGen;
  });

  const suspiciousBreakdown = {
    total_with_any_bio_death_or_generation: suspicious.length,
    with_biography: suspicious.filter((n) => n.biography && String(n.biography).trim()).length,
    with_death_year_ah: suspicious.filter((n) => n.death_year_ah != null).length,
    with_generation: suspicious.filter((n) => n.generation && String(n.generation).trim()).length,
    with_biography_source: suspicious.filter(
      (n) => n.biography_source && String(n.biography_source).trim()
    ).length,
    with_biography_source_url: suspicious.filter(
      (n) => n.biography_source_url && String(n.biography_source_url).trim()
    ).length,
    missing_both_bio_provenance_fields: suspicious.filter((n) => {
      const hasBio = !!(n.biography && String(n.biography).trim());
      if (!hasBio) return false;
      return !(n.biography_source && String(n.biography_source).trim()) &&
        !(n.biography_source_url && String(n.biography_source_url).trim());
    }).length,
    death_without_source_url: suspicious.filter(
      (n) => n.death_year_ah != null && !(n.biography_source_url && String(n.biography_source_url).trim())
    ).length,
    generation_without_source_url: suspicious.filter(
      (n) =>
        n.generation &&
        String(n.generation).trim() &&
        !(n.biography_source_url && String(n.biography_source_url).trim())
    ).length,
    name_quality_among_suspicious: {
      clean: suspicious.filter((n) => n.name_quality === "clean").length,
      fragment: suspicious.filter((n) => n.name_quality === "fragment").length,
      needs_review: suspicious.filter((n) => n.name_quality === "needs_review").length,
      null: suspicious.filter((n) => n.name_quality == null).length,
    },
    // Sample of bio source values
    biography_source_value_counts: (() => {
      const m = new Map<string, number>();
      for (const n of suspicious) {
        const s = String(n.biography_source ?? "(null)");
        m.set(s, (m.get(s) ?? 0) + 1);
      }
      return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
    })(),
    sample_unsourced_bio: suspicious
      .filter(
        (n) =>
          n.biography &&
          String(n.biography).trim() &&
          !(n.biography_source_url && String(n.biography_source_url).trim())
      )
      .slice(0, 15)
      .map((n) => ({
        id: n.id,
        name: n.name,
        death_year_ah: n.death_year_ah,
        generation: n.generation,
        biography_preview: String(n.biography).slice(0, 120),
        biography_source: n.biography_source,
        biography_source_url: n.biography_source_url,
        name_quality: n.name_quality,
      })),
    sample_sourced_bio: suspicious
      .filter((n) => n.biography_source_url && String(n.biography_source_url).trim())
      .slice(0, 10)
      .map((n) => ({
        id: n.id,
        name: n.name,
        biography_source: n.biography_source,
        biography_source_url: n.biography_source_url,
        death_year_ah: n.death_year_ah,
      })),
    verdict:
      "If biography_source_url is empty for rows with biography/death/generation, treat as UNSOURCED placeholders until a collector attaches provenance. Do not treat identity_status=verified alone as source-backed bio.",
  };

  // ---- variation → hadith grouping ----
  const byHadith = new Map<number, typeof variations>();
  for (const v of variations) {
    const hid = v.hadith_id as number;
    if (!byHadith.has(hid)) byHadith.set(hid, []);
    byHadith.get(hid)!.push(v);
  }

  const hadithSummaries = [...byHadith.entries()]
    .map(([hid, vars]) => {
      const h = hadiths.find((x) => x.id === hid);
      const bookIds = [...new Set(vars.map((v) => v.book_id as number))];
      const traditions = bookIds.map((bid) => {
        const b = books.find((x) => x.id === bid);
        return b?.tradition ?? "unknown";
      });
      return {
        hadith_id: hid,
        slug: h?.slug ?? null,
        title: h?.title ?? null,
        review_status: h?.review_status ?? null,
        variation_count: vars.length,
        distinct_books: bookIds.length,
        traditions: [...new Set(traditions)],
        with_arabic: vars.filter((v) => v.arabic_text && String(v.arabic_text).trim()).length,
        with_english: vars.filter((v) => v.english_text && String(v.english_text).trim()).length,
        sample_numbers: vars
          .map((v) => v.hadith_number)
          .filter(Boolean)
          .slice(0, 8),
      };
    })
    .sort((a, b) => b.variation_count - a.variation_count);

  // Propose grouping: variations that look like distinct matns vs parallels of same matn
  // Heuristic: same hadith_id today means "bucketed under one topic" not true parallel grouping.
  const grouping_proposal = {
    current_state: {
      canonical_hadiths: hadiths.length,
      variations: variations.length,
      ratio: variations.length / Math.max(hadiths.length, 1),
      per_hadith: hadithSummaries,
    },
    problem:
      "Nearly all variations (~1067) hang off ~5 canonical hadiths. That collapses distinct matns into topic buckets (e.g. first-wahi), so get_hadith_full cannot mean 'this narration and its true parallels'.",
    proposed_model: {
      step1_text_fingerprint:
        "Compute normalized Arabic fingerprint (unaccent, strip honorifics/tashkeel) per variation; cluster near-duplicates as parallel narrations of one matn.",
      step2_cross_book_parallels:
        "Within a fingerprint cluster, keep one canonical_hadith row; link all book occurrences as source_variations of that hadith.",
      step3_topic_vs_matn:
        "Move current topic buckets to categories/hadith_categories (e.g. first-wahi). Do not use hadiths.id as a topic folder.",
      step4_manual_review:
        "Ambiguous clusters (shared only short phrases) go to data/unmatched/hadith-grouping-review.csv — never auto-merge across Shia/Sunni without shared Arabic core.",
      migration_hint:
        "017+: add source_variations.matn_fingerprint + hadiths.grouping_method; backfill fingerprints; create new hadith rows for distinct clusters; re-point variation.hadith_id; preserve old topic via hadith_categories.",
    },
  };

  // ---- permission / publish gates ----
  const permission = {
    batches: batches.map((b) => ({
      id: b.id,
      provider: b.provider,
      permission_status: b.permission_status,
      is_superseded: b.is_superseded,
    })),
    needs_permission_batch_ids: batches
      .filter((b) => b.permission_status === "needs_permission")
      .map((b) => b.id),
    note: "Variations imported via sunnah/dorar scrapes must stay unpublished until API permission; store raw only.",
  };

  // ---- source candidates per gap family ----
  const source_candidates = {
    hadith_text_and_numbering: [
      { source: "fawazahmed0/hadith-api", license: "allow_with_conditions (Unlicense)", fills: "Sunni editions, numbers, grades in API" },
      { source: "thaqalayn-api / thaqalayn.net", license: "allow_with_conditions (CC BY 4.0)", fills: "Shia Four Books texts/grades" },
      { source: "hadeethenc.com", license: "allow_with_conditions", fills: "multi-language translations" },
      { source: "sunnah.com API", license: "needs_permission until API key (HTML scrape forbidden)", fills: "Sunni text/numbering/grades" },
      { source: "dorar.net API", license: "needs_permission", fills: "grades + Arabic snippets (cache TTL issue)" },
    ],
    narrator_rijal: [
      { source: "Wikidata", license: "allow (CC0)", fills: "names, death/birth where P569/P570 exist — human+label+death gate" },
      { source: "Sanadset 650K", license: "allow (CC BY 4.0)", fills: "missing chains only (exact book+number); NO auto aliases" },
      { source: "Hawramani transmitters", license: "needs_permission", fills: "bio + jarh snippets" },
      { source: "muslimscholars.info", license: "needs_permission", fills: "bio, teachers/students, grades" },
      { source: "OpenITI rijal texts", license: "paused (NC until commercial clarified)", fills: "quoted classical rulings" },
      { source: "Shamela / library PDFs (Tahdhib, Najashi, Tusi…)", license: "per-work check", fills: "narrator_assessments with book/vol/page" },
    ],
    scholars_imams: [
      { source: "Wikidata verified rebuild", license: "allow", fills: "23 accepted QIDs; fields from entity only" },
    ],
    books: [
      { source: "Wikidata works + verified authors", license: "allow", fills: "title/author QID where accepted" },
      { source: "thaqalayn / hadith-api info.json", license: "allow_with_conditions", fills: "edition metadata" },
    ],
    categories_lookups: [
      { source: "curated lookup seeds + classical taxonomies", license: "project-curated with citation", fills: "grade/chain/type/scope codes; category tree" },
    ],
  };

  const report = {
    generated_at: new Date().toISOString(),
    mode: "read_only_deliverable_A",
    table_counts: tableCounts,
    column_fill,
    entity_coverage,
    suspicious_narrator_bio_audit: suspiciousBreakdown,
    variation_hadith_grouping: grouping_proposal,
    permission,
    source_candidates,
    decisions_needed: [
      "Approve splitting topic-bucket hadiths into matn-fingerprint clusters (migration 017 proposal).",
      "Confirm commercial status before any OpenITI use.",
      "Decide unpublish vs keep-unpublished for Dorar (17) + Sunnah scrape (~623) variations under needs_permission batches.",
      "Treat unsourced narrator bio/death/generation as NULL-candidates in a later migration, or require source attach first?",
      "madhhab/tradition on scholars: leave null until Wikidata/source provides, or allow curated seed with provenance?",
    ],
    not_done: [
      "No migrations written (B/C next).",
      "No collectors applied.",
      "No RPC changes.",
      "No chain_narrators rewrites.",
    ],
  };

  const unmatchedDir = path.join("data", "unmatched");
  const docsDir = path.join("docs");
  mkdirSync(unmatchedDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(unmatchedDir, "gap-report-a.json"), JSON.stringify(report, null, 2), "utf8");

  const md = renderMarkdown(report);
  writeFileSync(path.join(docsDir, "gap-report-a.md"), md, "utf8");
  console.log(JSON.stringify({ table_counts: tableCounts, suspicious: suspiciousBreakdown.total_with_any_bio_death_or_generation, hadiths: hadithSummaries.length, variations: variations.length }, null, 2));
  console.log("Wrote data/unmatched/gap-report-a.json and docs/gap-report-a.md");
}

function renderMarkdown(report: any): string {
  const lines: string[] = [];
  lines.push("# Gap report A — knowledge graph completeness (read-only)");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Table | Rows |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(report.table_counts)) {
    lines.push(`| \`${k}\` | ${v} |`);
  }
  lines.push("");
  lines.push("## Entity coverage");
  lines.push("");
  lines.push("### Canonical hadiths vs variations");
  const g = report.variation_hadith_grouping.current_state;
  lines.push(`- Canonical \`hadiths\`: **${g.canonical_hadiths}**`);
  lines.push(`- \`source_variations\`: **${g.variations}** (≈${(g.ratio as number).toFixed(0)}× per hadith)`);
  lines.push("");
  lines.push("| hadith_id | slug | variations | books | traditions |");
  lines.push("|---|---|---|---|---|");
  for (const h of g.per_hadith) {
    lines.push(
      `| ${h.hadith_id} | ${h.slug} | ${h.variation_count} | ${h.distinct_books} | ${(h.traditions || []).join(", ")} |`
    );
  }
  lines.push("");
  lines.push("**Problem:** " + report.variation_hadith_grouping.problem);
  lines.push("");
  lines.push("**Proposed grouping:**");
  for (const [k, v] of Object.entries(report.variation_hadith_grouping.proposed_model)) {
    lines.push(`- **${k}:** ${v}`);
  }
  lines.push("");
  lines.push("### Narrators");
  const n = report.entity_coverage.narrator;
  lines.push(`- Total: **${n.total}** (clean ${n.clean} / fragment ${n.fragment} / needs_review ${n.needs_review})`);
  lines.push(`- With Arabic-script \`arabic_name\`: ${n.with_arabic_script_name}`);
  lines.push(`- With \`narrator_assessments\`: ${n.with_assessment}`);
  lines.push(`- With biography: ${n.with_biography} (source URL: ${n.with_biography_source_url})`);
  lines.push(`- With death_year_ah: ${n.with_death_year_ah}; generation: ${n.with_generation}`);
  lines.push("");
  lines.push("### Suspicious bio/death/generation population");
  const s = report.suspicious_narrator_bio_audit;
  lines.push(`- Rows with any of bio/death/generation: **${s.total_with_any_bio_death_or_generation}**`);
  lines.push(`- biography without source URL: see \`missing_both_bio_provenance_fields\` = **${s.missing_both_bio_provenance_fields}**`);
  lines.push(`- death_year_ah without biography_source_url: **${s.death_without_source_url}**`);
  lines.push(`- generation without biography_source_url: **${s.generation_without_source_url}**`);
  lines.push(`- biography_source value counts: \`${JSON.stringify(s.biography_source_value_counts)}\``);
  lines.push(`- **Verdict:** ${s.verdict}`);
  lines.push("");
  lines.push("### Chains / assessments / books / scholars / graph");
  const c = report.entity_coverage.chain;
  lines.push(`- Chains: ${c.total} (with nodes ${c.with_nodes}, empty ${c.empty_nodes}); nodes ${c.nodes_total} (linked ${c.nodes_linked_to_narrator}, orphan ${c.nodes_orphan_narrator_id})`);
  lines.push(`- Hadith assessments: ${report.table_counts.hadith_assessments}; narrator assessments: ${report.table_counts.narrator_assessments}; chain assessments: ${report.table_counts.chain_assessments}`);
  lines.push(`- Scholars: ${report.entity_coverage.scholar.total}; Books: ${report.entity_coverage.book.total}`);
  lines.push(`- name_aliases: ${report.entity_coverage.graph_edges.name_aliases}; narrator_relations: ${report.entity_coverage.graph_edges.narrator_relations}`);
  lines.push(`- Categories: ${report.entity_coverage.lookups.categories}; grade_lookup codes: ${(report.entity_coverage.lookups.grade_lookup || []).join(", ") || "(none)"}`);
  lines.push("");
  lines.push("## Column fill (selected critical gaps)");
  lines.push("");
  const critical = [
    ["source_variations", ["translator", "volume", "page", "hadith_type", "transmission_scope", "grade_code", "source_url"]],
    ["narrators", ["arabic_name", "kunya", "nisba", "laqab", "tradition", "biography_source_url", "tabaqah", "gender"]],
    ["scholars", ["arabic_name", "madhhab", "region", "works", "teachers", "students"]],
    ["books", ["arabic_title", "author", "category", "publisher", "edition", "volumes", "hadith_count", "canonical_book_id"]],
    ["hadith_assessments", ["normalized_grade", "explanation", "reference_book", "source_url", "verified"]],
    ["narrator_assessments", ["normalized_term", "explanation", "reference_book", "source_url", "computed_summary"]],
    ["chain_narrators", ["narrator_id", "transmission_word", "weak_link_reason"]],
    ["narrator_relations", ["source_url", "verified"]],
  ] as const;
  for (const [table, cols] of critical) {
    lines.push(`### ${table}`);
    lines.push("| column | filled | empty | % |");
    lines.push("|---|---|---|---|");
    const rows = report.column_fill[table] as ColFill[];
    for (const col of cols) {
      const r = rows.find((x) => x.column === col);
      if (!r) continue;
      lines.push(`| ${r.column} | ${r.filled} | ${r.empty} | ${r.fill_pct}% |`);
    }
    lines.push("");
  }
  lines.push("## Source candidates (high level)");
  lines.push("");
  for (const [family, list] of Object.entries(report.source_candidates)) {
    lines.push(`### ${family}`);
    for (const item of list as any[]) {
      lines.push(`- **${item.source}** (${item.license}): ${item.fills}`);
    }
    lines.push("");
  }
  lines.push("## Import permission status");
  lines.push("");
  for (const b of report.permission.batches) {
    lines.push(`- batch ${b.id}: \`${b.provider}\` → **${b.permission_status}**${b.is_superseded ? " (superseded)" : ""}`);
  }
  lines.push("");
  lines.push("## Decisions needed");
  lines.push("");
  for (const d of report.decisions_needed) lines.push(`- ${d}`);
  lines.push("");
  lines.push("## Not done (this step)");
  lines.push("");
  for (const d of report.not_done) lines.push(`- ${d}`);
  lines.push("");
  lines.push("Full machine-readable dump: `data/unmatched/gap-report-a.json`.");
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
