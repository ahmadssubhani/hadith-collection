import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicSupabaseUrl, getServiceRoleKey } from "@/lib/env";
import {
  getTopicDefinition,
  getAllTopicDefinitions,
  type TopicDefinition,
  type HadithCandidate,
} from "./topics-registry";
import { FetchAggregator } from "./fetchers/aggregator";
import { RelevanceRanker } from "./relevance-ranker";
import { persistCandidate } from "./persist-candidate";

export interface DailyIngestResult {
  success: boolean;
  topicSlug: string;
  topicTitle: string;
  dayNumber: number;
  runDate: string;
  count: number;
  remainingInTopicPool: number;
  sourceHealth?: Array<{
    sourceType: string;
    name: string;
    status: string;
    fetchedCount: number;
    errorMessage?: string;
  }>;
  shortlistedHadiths: Array<{
    identifier: string;
    bookTitle: string;
    hadithNumber: string;
    chapter: string;
    arabicPreview: string;
    englishPreview: string;
    hadithStatus: string;
    sourceUrl?: string;
    narrator?: string;
    tradition?: string;
  }>;
  isDryRun: boolean;
  message: string;
  error?: string;
}

export function getServiceRoleSupabaseClient(): SupabaseClient | null {
  try {
    const url = getPublicSupabaseUrl();
    const serviceKey = getServiceRoleKey();
    if (!url || !serviceKey) return null;
    return createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}

/**
 * Publishes an on-demand batch of 5 candidate hadiths for a topic.
 * When apply: true, unpublishes/archives the previous live batch (setting verified = false
 * and review_status = 'draft' on its variations/hadiths) and publishes the new batch
 * to daily_hadith_batch, hadiths, source_variations, chains, etc.
 */
export async function publishDailyHadithBatch(options?: {
  topicSlug?: string;
  forceNextDay?: boolean;
  apply?: boolean;
  batchSize?: number;
}): Promise<DailyIngestResult> {
  const batchSize = options?.batchSize ?? 5;
  const isDryRun = !options?.apply;
  const runDate = new Date().toISOString().split("T")[0];

  const supabase = getServiceRoleSupabaseClient();

  if (!isDryRun && !supabase) {
    return {
      success: false,
      topicSlug: options?.topicSlug || "unknown",
      topicTitle: "unknown",
      dayNumber: 0,
      runDate,
      count: 0,
      remainingInTopicPool: 0,
      shortlistedHadiths: [],
      isDryRun,
      message: "Cannot apply: Supabase client failed to initialize. Check that your Supabase URL and service role key environment variables are set correctly.",
      error: "Supabase client is null — missing or invalid environment variables (SUPABASE URL / SERVICE_ROLE_KEY).",
    };
  }

  // 1. Identify target topic
  let targetSlug = options?.topicSlug;
  let topicId: number | null = null;
  let topicTitle = "The Beginning of Revelation (First Wahi at Cave Hira)";

  if (supabase) {
    try {
      if (targetSlug) {
        const { data: topic } = await supabase
          .from("daily_topics")
          .select("id, slug, title, is_active")
          .eq("slug", targetSlug)
          .maybeSingle();
        if (topic) {
          topicId = topic.id;
          topicTitle = topic.title;
        }
      } else {
        const { data: activeTopic } = await supabase
          .from("daily_topics")
          .select("id, slug, title, is_active")
          .eq("is_active", true)
          .maybeSingle();
        if (activeTopic) {
          targetSlug = activeTopic.slug;
          topicId = activeTopic.id;
          topicTitle = activeTopic.title;
        }
      }
    } catch {
      // Fallback if DB table pending
    }
  }

  targetSlug = targetSlug || "first-wahi";
  const topicDef = getTopicDefinition(targetSlug);
  if (!topicDef) {
    return {
      success: false,
      topicSlug: targetSlug,
      topicTitle: targetSlug,
      dayNumber: 0,
      runDate,
      count: 0,
      remainingInTopicPool: 0,
      shortlistedHadiths: [],
      isDryRun,
      message: `Topic '${targetSlug}' is not registered in the system.`,
      error: `Unknown topic slug: ${targetSlug}`,
    };
  }

  topicTitle = topicDef.title;

  // 2. Query current live batch from daily_hadith_batch (if any)
  let currentBatch: {
    id: number;
    day_number: number;
    hadith_identifiers: string[];
    variation_ids: number[];
    hadith_ids: number[];
  } | null = null;

  if (supabase && topicId) {
    try {
      const { data: bRow } = await supabase
        .from("daily_hadith_batch")
        .select("*")
        .eq("topic_id", topicId)
        .maybeSingle();

      if (bRow) {
        currentBatch = {
          id: bRow.id,
          day_number: bRow.day_number,
          hadith_identifiers: bRow.hadith_identifiers ?? [],
          variation_ids: bRow.variation_ids ?? [],
          hadith_ids: bRow.hadith_ids ?? [],
        };
      }
    } catch {
      // Table may not exist yet
    }
  }

  // 3. If APPLY mode and a current batch exists -> Archive / Unpublish old batch records
  if (!isDryRun && supabase && topicId && currentBatch) {
    try {
      // Unpublish old variations by setting verified = false
      if (currentBatch.variation_ids.length > 0) {
        await supabase
          .from("source_variations")
          .update({ verified: false })
          .in("id", currentBatch.variation_ids);
      }

      // Check parent clusters: if no active (verified=true) variations remain, archive hadith cluster
      if (currentBatch.hadith_ids.length > 0) {
        for (const hid of currentBatch.hadith_ids) {
          const { data: activeVars } = await supabase
            .from("source_variations")
            .select("id")
            .eq("hadith_id", hid)
            .eq("verified", true)
            .limit(1);

          if (!activeVars || activeVars.length === 0) {
            await supabase
              .from("hadiths")
              .update({ review_status: "draft" })
              .eq("id", hid);
          }
        }
      }
    } catch (err) {
      console.warn("Notice during archiving previous batch:", err);
    }
  }

  // 4. Fetch candidates across DATA_INGESTION.md sources
  const aggregator = new FetchAggregator();
  const aggregateResult = await aggregator.aggregate(topicDef, 20);
  let rawCandidates = aggregateResult.candidates;
  const sourceHealth = aggregateResult.sourceHealth;

  if (rawCandidates.length === 0 && topicDef && topicDef.hadithCandidates && topicDef.hadithCandidates.length > 0) {
    rawCandidates = topicDef.hadithCandidates.map((c: HadithCandidate) => ({
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

  // 5. Rank candidates by relevance
  const ranker = new RelevanceRanker();
  const rankedCandidates = ranker.rank(rawCandidates, topicDef);

  // 6. Exclude ONLY the identifiers that were JUST live in the batch being replaced
  const justRemoved = new Set<string>(currentBatch?.hadith_identifiers ?? []);
  const availableCandidates = rankedCandidates
    .map((r) => r.candidate)
    .filter((c) => !justRemoved.has(c.sourceIdentifier));

  const candidatePool = availableCandidates.length > 0 ? availableCandidates : rankedCandidates.map((r) => r.candidate);
  let selectedBatch = candidatePool.slice(0, batchSize);

  // In offline preview mode or rotation fallback, rotate batch if needed
  if (!supabase && candidatePool.length > batchSize) {
    const dayIndex = Math.floor(new Date().getTime() / (1000 * 60 * 60 * 24));
    const startIndex = (dayIndex * batchSize) % candidatePool.length;
    const rotated = [
      ...candidatePool.slice(startIndex),
      ...candidatePool.slice(0, startIndex),
    ];
    selectedBatch = rotated.slice(0, batchSize);
  }

  const dayNumber = (currentBatch?.day_number ?? 0) + 1;
  const remainingInPool = Math.max(0, candidatePool.length - selectedBatch.length);

  const shortlistedSummary = selectedBatch.map((item) => ({
    identifier: item.sourceIdentifier,
    bookTitle: item.bookTitle,
    hadithNumber: item.hadithNumber,
    chapter: item.chapter,
    arabicPreview: item.arabicText.slice(0, 140) + (item.arabicText.length > 140 ? "..." : ""),
    englishPreview: item.englishText.slice(0, 220) + (item.englishText.length > 220 ? "..." : ""),
    hadithStatus: item.hadithStatus,
    sourceUrl: item.sourceUrl,
    narrator: item.nodes && item.nodes.length > 0 ? item.nodes[0].rawName : "Primary Transmitter",
    tradition: item.tradition || (item.bookTitle.includes("Kafi") || item.bookTitle.includes("Nahj") ? "Twelver Shia" : "Sunni"),
  }));

  // 7. If APPLY mode, publish new batch to DB & write daily_hadith_batch
  if (!isDryRun && supabase) {
    try {
      if (!topicId) {
        const { data: newTopic } = await supabase
          .from("daily_topics")
          .upsert(
            {
              slug: topicDef.slug,
              title: topicDef.title,
              arabic_title: topicDef.arabicTitle,
              description: topicDef.description,
              keywords: topicDef.keywords,
              is_active: true,
              daily_batch_size: batchSize,
            },
            { onConflict: "slug" },
          )
          .select("id")
          .single();
        if (newTopic) topicId = newTopic.id;
      }

      const clusterSlug = topicDef.slug === "first-wahi" ? "first-revelation-at-hira" : topicDef.slug;
      const clusterOptions = {
        clusterSlug,
        clusterTitle: topicDef.title,
        clusterArabicTitle: topicDef.arabicTitle,
        clusterSummary: topicDef.description,
        clusterKeywords: topicDef.keywords,
      };

      const insertedVariationIds: number[] = [];
      const insertedHadithIds: number[] = [];

      for (const item of selectedBatch) {
        const candidate: HadithCandidate = {
          identifier: item.sourceIdentifier,
          bookTitle: item.bookTitle,
          hadithNumber: item.hadithNumber,
          chapter: item.chapter,
          volume: item.volume,
          page: item.page,
          arabicText: item.arabicText,
          englishText: item.englishText,
          translator: item.translator,
          sourceUrl: item.sourceUrl,
          hadithStatus: item.hadithStatus,
          chainStatus: item.chainStatus,
          narrationStatus: item.narrationStatus,
          statusNotes: item.statusNotes,
          rawChainText: item.rawChainText,
          nodes: item.nodes,
          assessments: item.assessments,
        };
        const res = await persistCandidate(candidate, clusterOptions, supabase);
        if (res) {
          insertedVariationIds.push(res.variationId);
          insertedHadithIds.push(res.hadithId);
        }
      }

      if (topicId) {
        await supabase
          .from("daily_hadith_batch")
          .upsert(
            {
              topic_id: topicId,
              day_number: dayNumber,
              hadith_identifiers: selectedBatch.map((b) => b.sourceIdentifier),
              variation_ids: insertedVariationIds,
              hadith_ids: Array.from(new Set(insertedHadithIds)),
              published_at: new Date().toISOString(),
            },
            { onConflict: "topic_id" },
          );

        await supabase.from("daily_hadith_logs").upsert(
          {
            topic_id: topicId,
            run_date: runDate,
            day_number: dayNumber,
            items_count: selectedBatch.length,
            source_variation_ids: insertedVariationIds,
            hadith_identifiers: selectedBatch.map((b) => b.sourceIdentifier),
            status: "success",
            notes: `Day ${dayNumber}: Published ${selectedBatch.length} hadiths on-demand for topic '${topicTitle}'.`,
          },
          { onConflict: "topic_id,run_date" },
        );
      }
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : (err && typeof err === "object")
            ? JSON.stringify(err, Object.getOwnPropertyNames(err))
            : String(err);
      return {
        success: false,
        topicSlug: targetSlug,
        topicTitle,
        dayNumber,
        runDate,
        count: selectedBatch.length,
        remainingInTopicPool: remainingInPool,
        shortlistedHadiths: shortlistedSummary,
        isDryRun,
        message: `Database error during publishing: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  return {
    success: true,
    topicSlug: targetSlug,
    topicTitle,
    dayNumber,
    runDate,
    count: selectedBatch.length,
    remainingInTopicPool: remainingInPool,
    sourceHealth,
    shortlistedHadiths: shortlistedSummary,
    isDryRun,
    message: isDryRun
      ? `[DRY-RUN] Day ${dayNumber}: Preview of next ${selectedBatch.length} candidate hadiths for '${topicTitle}'. (Remaining in pool: ${remainingInPool}). Pass apply: true or --apply to publish.`
      : `[PUBLISHED] Day ${dayNumber}: Successfully published ${selectedBatch.length} hadiths for '${topicTitle}' and archived previous batch.`,
  };
}

export const runDailyHadithIngest = publishDailyHadithBatch;

/**
 * Switches the active topic or registers a new topic.
 */
export async function setActiveTopic(
  topicSlug: string,
  customTopic?: Partial<TopicDefinition>,
): Promise<{ success: boolean; message: string; activeTopic: unknown }> {
  const supabase = getServiceRoleSupabaseClient();
  const existingDef = getTopicDefinition(topicSlug);

  const title = customTopic?.title ?? existingDef?.title ?? topicSlug;
  const arabicTitle = customTopic?.arabicTitle ?? existingDef?.arabicTitle ?? "";
  const description = customTopic?.description ?? existingDef?.description ?? "";
  const keywords = customTopic?.keywords ?? existingDef?.keywords ?? [topicSlug];

  if (supabase) {
    try {
      await supabase.from("daily_topics").update({ is_active: false }).neq("id", 0);

      const { data: updated, error } = await supabase
        .from("daily_topics")
        .upsert(
          {
            slug: topicSlug,
            title,
            arabic_title: arabicTitle,
            description,
            keywords,
            is_active: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "slug" },
        )
        .select("*")
        .single();

      if (error) throw error;
      return {
        success: true,
        message: `Active daily topic switched to '${title}' (${topicSlug}).`,
        activeTopic: updated,
      };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : (err && typeof err === "object")
            ? JSON.stringify(err, Object.getOwnPropertyNames(err))
            : String(err);
      return {
        success: false,
        message: `Failed to set active topic in database: ${errorMessage}`,
        activeTopic: null,
      };
    }
  }

  return {
    success: true,
    message: `Active daily topic configured as '${title}' (${topicSlug}) [Offline / Registry mode].`,
    activeTopic: { slug: topicSlug, title, is_active: true },
  };
}

/**
 * Gets the current daily status, active topic, currently live batch, and a preview of the next 5 hadiths.
 */
export async function getDailyStatus(topicSlug?: string) {
  const targetSlug = topicSlug || "first-wahi";
  const supabase = getServiceRoleSupabaseClient();
  const topicDef = getTopicDefinition(targetSlug);
  const topicTitle = topicDef?.title || "First Wahi";

  let currentBatch: {
    day_number: number;
    published_at: string;
    hadith_identifiers: string[];
    variation_ids: number[];
  } | null = null;

  if (supabase) {
    try {
      const { data: topic } = await supabase
        .from("daily_topics")
        .select("id")
        .eq("slug", targetSlug)
        .maybeSingle();

      if (topic) {
        const { data: bRow } = await supabase
          .from("daily_hadith_batch")
          .select("day_number, published_at, hadith_identifiers, variation_ids")
          .eq("topic_id", topic.id)
          .maybeSingle();

        if (bRow) {
          currentBatch = bRow;
        }
      }
    } catch {
      // Fallback
    }
  }

  const preview = await publishDailyHadithBatch({
    topicSlug: targetSlug,
    apply: false,
  });

  const allTopics = getAllTopicDefinitions().map((t) => ({
    slug: t.slug,
    title: t.title,
    candidateCount: t.hadithCandidates?.length ?? 0,
  }));

  return {
    activeTopic: {
      slug: targetSlug,
      title: topicTitle,
      dayNumber: currentBatch?.day_number ?? preview.dayNumber,
      publishedAt: currentBatch?.published_at ?? preview.runDate,
    },
    liveBatchCount: currentBatch?.hadith_identifiers?.length ?? 0,
    liveIdentifiers: currentBatch?.hadith_identifiers ?? [],
    upcomingShortlist: preview.shortlistedHadiths,
    remainingCandidatesInPool: preview.remainingInTopicPool,
    availableTopics: allTopics,
  };
}