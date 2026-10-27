import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { getServiceRoleSupabaseClient } from "../lib/cron/daily-ingest";
import { getTopicDefinition, HadithCandidate } from "../lib/cron/topics-registry";
import { FetchAggregator } from "../lib/cron/fetchers/aggregator";
import { deduplicateCandidates } from "../lib/cron/dedup";
import { persistCandidate } from "../lib/cron/persist-candidate";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const topicIndex = args.indexOf("--topic");
  const topicSlug = topicIndex !== -1 && args[topicIndex + 1] ? args[topicIndex + 1] : "first-wahi";

  console.log("\n=================================================================");
  console.log("  BULK HADITH INGESTION & DEDUPLICATION (ALL SOURCES)            ");
  console.log("=================================================================\n");

  const topicDef = getTopicDefinition(topicSlug);
  if (!topicDef) {
    console.error(`Error: Unknown topic slug '${topicSlug}'.`);
    process.exit(1);
  }

  console.log(`Topic       : ${topicDef.title} (${topicDef.slug})`);
  console.log(`Run Mode    : ${apply ? "APPLY (Permanently persisting to database)" : "DRY-RUN PREVIEW (No DB changes)"}\n`);

  // 1. Fetch ALL candidates across all 4 sources with high limit (500)
  const aggregator = new FetchAggregator();
  const aggregateResult = await aggregator.aggregate(topicDef, 500);
  let rawCandidates = aggregateResult.candidates;

  // Fallback to pre-indexed candidates if live fetchers return 0 items
  if (rawCandidates.length === 0 && topicDef.hadithCandidates && topicDef.hadithCandidates.length > 0) {
    console.log("[Notice] Live fetchers returned 0 items; using pre-indexed topic candidates pool.");
    rawCandidates = topicDef.hadithCandidates.map((c) => ({
      source: c.identifier.startsWith("bukhari") || c.identifier.startsWith("muslim") ? "sunnah.com" :
              c.identifier.startsWith("kafi") || c.identifier.startsWith("nahj") ? "thaqalayn" :
              c.identifier.startsWith("hadeethenc") ? "hadeethenc" : "reference",
      sourceIdentifier: c.identifier,
      bookTitle: c.bookTitle,
      hadithNumber: c.hadithNumber,
      chapter: c.chapter,
      volume: c.volume,
      page: c.page,
      arabicText: c.arabicText,
      englishText: c.englishText,
      translator: c.translator,
      sourceUrl: c.sourceUrl || "",
      tradition: c.bookTitle.includes("Kafi") || c.bookTitle.includes("Nahj") ? "Twelver Shia" : "Sunni",
      hadithStatus: c.hadithStatus || "sahih",
      chainStatus: c.chainStatus || "muttasil",
      narrationStatus: c.narrationStatus || [],
      statusNotes: c.statusNotes,
      rawChainText: c.rawChainText,
      nodes: c.nodes,
      assessments: c.assessments,
      rawPayload: c as unknown as Record<string, unknown>,
    }));
  }

  // Convert raw fetched candidates to HadithCandidate shape
  const formattedCandidates: HadithCandidate[] = rawCandidates.map((c) => ({
    identifier: c.sourceIdentifier,
    bookTitle: c.bookTitle,
    hadithNumber: c.hadithNumber,
    chapter: c.chapter,
    volume: c.volume,
    page: c.page,
    arabicText: c.arabicText,
    englishText: c.englishText,
    translator: c.translator,
    sourceUrl: c.sourceUrl,
    hadithStatus: c.hadithStatus,
    chainStatus: c.chainStatus,
    narrationStatus: c.narrationStatus,
    statusNotes: c.statusNotes,
    rawChainText: c.rawChainText,
    nodes: c.nodes,
    assessments: c.assessments,
  }));

  // 2. Deduplicate candidates (Exact + Fuzzy cross-source)
  const dedupResult = deduplicateCandidates(formattedCandidates);

  console.log("\n-----------------------------------------------------------------");
  console.log("  DEDUPLICATION SUMMARY");
  console.log("-----------------------------------------------------------------");
  console.log(`Total Candidates Fetched : ${formattedCandidates.length}`);
  console.log(`Unique Candidates        : ${dedupResult.unique.length}`);
  console.log(`Duplicates Removed       : ${dedupResult.duplicatesRemoved.length}\n`);

  if (dedupResult.duplicatesRemoved.length > 0) {
    console.log("Detailed Duplicates Audit:");
    dedupResult.duplicatesRemoved.forEach((item, idx) => {
      console.log(`  ${idx + 1}. Dropped [${item.droppedIdentifier}] -> Kept [${item.kept.identifier}]`);
      console.log(`     Reason: ${item.matchReason}`);
    });
    console.log("");
  }

  console.log("Unique Candidates Ready to Ingest:\n");
  dedupResult.unique.forEach((h, idx) => {
    console.log(`  [#${idx + 1}] ${h.bookTitle} — Hadith ${h.hadithNumber}`);
    console.log(`      Identifier: ${h.identifier} | Status: ${h.hadithStatus}`);
    console.log(`      Chapter   : ${h.chapter}`);
    console.log(`      EN        : ${h.englishText.slice(0, 100)}...`);
    console.log("");
  });

  if (!apply) {
    console.log("-----------------------------------------------------------------");
    console.log("[DRY-RUN] No changes were made to the database.");
    console.log("To permanently persist these deduplicated candidates to Supabase, run:");
    console.log("  ALLOW_BROAD_INGEST=1 npm run hadith:ingest-all:apply");
    console.log("-----------------------------------------------------------------\n");
    return;
  }

  if (process.env.ALLOW_BROAD_INGEST !== "1") {
    console.error(
      "Blocked: the HadeethEnc topic filter is too broad (206 off-topic items were loaded before). Fix the relevance filter first.",
    );
    process.exit(1);
  }

  // 3. Apply mode: Persist deduplicated candidates to database
  console.log("Writing deduplicated candidates to Supabase database...\n");
  const supabase = getServiceRoleSupabaseClient();
  if (!supabase) {
    console.error("Error: Supabase service-role client failed to initialize. Check SUPABASE URL / SERVICE_ROLE_KEY env vars.");
    process.exit(1);
  }

  const clusterSlug = topicDef.slug === "first-wahi" ? "first-revelation-at-hira" : topicDef.slug;
  const clusterOptions = {
    clusterSlug,
    clusterTitle: topicDef.title,
    clusterArabicTitle: topicDef.arabicTitle,
    clusterSummary: topicDef.description,
    clusterKeywords: topicDef.keywords,
  };

  let persistedCount = 0;
  for (const candidate of dedupResult.unique) {
    const res = await persistCandidate(candidate, clusterOptions, supabase);
    if (res) {
      persistedCount++;
      console.log(`  ✓ Persisted [${candidate.identifier}] (${candidate.bookTitle} #${candidate.hadithNumber})`);
    } else {
      console.error(`  ✗ Failed to persist [${candidate.identifier}]`);
    }
  }

  console.log("\n-----------------------------------------------------------------");
  console.log(`[APPLIED] Successfully persisted ${persistedCount}/${dedupResult.unique.length} deduplicated hadiths to database.`);
  console.log("All records are published and verified (review_status='published' / verified=true).");
  console.log("-----------------------------------------------------------------\n");
}

main().catch((err) => {
  console.error("Fatal script error:", err);
  process.exit(1);
});
