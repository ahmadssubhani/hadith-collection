/**
 * Corpus-wide eligibility — same a–d bar as EligibleFirstWahiVariation,
 * applied to every hadith/topic (not only First Wahi).
 *
 * Rules (lib/first-wahi-eligibility.ts):
 *   a) verified chain
 *   b) every chain node linked to a narrator (complete profile)
 *   c) every narrator has a verified, cited assessment
 *   d) Arabic + English text present
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { one } from "@/lib/format";
import {
  evaluateVariationEligibility,
  type EligibleChainView,
  type EligibilityFailure,
} from "@/lib/first-wahi-eligibility";
import type {
  Book,
  Chain,
  Hadith,
  HadithAssessment,
  NarratorAssessment,
  SourceVariation,
  SourceVariationDetail,
} from "@/lib/types";

function db(client?: SupabaseClient): SupabaseClient {
  return client ?? createServerSupabaseClient();
}

export type EligibleVariation = SourceVariationDetail & {
  eligibleChains: EligibleChainView[];
  hadith: Pick<Hadith, "id" | "slug" | "title" | "topics" | "review_status"> | null;
};

export type EligibleVariationRow = {
  variationId: number;
  hadithId: number;
  hadithSlug: string | null;
  topics: string[];
  bookTitle: string | null;
  hadithNumber: string | null;
  chapter: string | null;
  eligible: boolean;
  failures: EligibilityFailure[];
  verifiedChainCount: number;
  completeChainCount: number;
};

export type EligibleByTopic = {
  topic: string;
  hadithIds: number[];
  variationIds: number[];
  variationCount: number;
  hadithCount: number;
};

export type GetEligibleOptions = {
  /** Only variations whose hadith.topics contains this string (case-insensitive substring ok via exact match on array). */
  topic?: string;
  /** Limit to one hadith id. */
  hadithId?: number;
  /** Prefer published hadiths (default true for public loaders). */
  publishedOnly?: boolean;
  /**
   * Minimum narrator nodes on at least one complete eligible chain.
   * Use 2+ to exclude single-node "Narrated X" stubs (First Wahi–quality isnads).
   * Default 1 (pass any a–d complete chain).
   */
  minChainNodes?: number;
  /** Max variations to scan (default: all). */
  limit?: number;
  /** Override Supabase client (scripts can pass service-role). */
  client?: SupabaseClient;
};

const BOOKS_EMBED = "books!source_variations_book_id_fkey(*)";

async function pageSelect<T>(
  client: SupabaseClient,
  table: string,
  select: string,
  apply?: (q: any) => any,
  pageSize = 500,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    let q = client.from(table).select(select).range(from, from + pageSize - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function collectNarratorIds(variations: SourceVariationDetail[]): number[] {
  const ids = new Set<number>();
  for (const variation of variations) {
    for (const chain of variation.chains ?? []) {
      for (const node of chain.chain_narrators ?? []) {
        if (node.narrator_id != null) ids.add(node.narrator_id);
      }
    }
  }
  return [...ids];
}

async function loadAllNarratorAssessments(
  client: SupabaseClient,
  narratorIds: number[],
): Promise<Map<number, NarratorAssessment[]>> {
  const map = new Map<number, NarratorAssessment[]>();
  if (!narratorIds.length) return map;
  for (let i = 0; i < narratorIds.length; i += 200) {
    const chunk = narratorIds.slice(i, i + 200);
    const { data, error } = await client
      .from("narrator_assessments")
      .select("*, scholars(*)")
      .in("narrator_id", chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as NarratorAssessment[]) {
      const list = map.get(row.narrator_id) ?? [];
      list.push(row);
      map.set(row.narrator_id, list);
    }
  }
  return map;
}

async function attachChainsAndBooks(
  client: SupabaseClient,
  variationRows: SourceVariation[],
): Promise<SourceVariationDetail[]> {
  if (!variationRows.length) return [];
  const variationIds = variationRows.map((r) => r.id);
  const chains: Chain[] = [];
  const assessments: HadithAssessment[] = [];

  for (let i = 0; i < variationIds.length; i += 100) {
    const chunk = variationIds.slice(i, i + 100);
    const [{ data: ch }, { data: ha }] = await Promise.all([
      client
        .from("chains")
        .select("*, chain_narrators(*, narrators(*)), chain_assessments(*, scholars(*))")
        .in("variation_id", chunk)
        .order("chain_number"),
      client.from("hadith_assessments").select("*, scholars(*)").in("variation_id", chunk),
    ]);
    chains.push(...((ch ?? []) as Chain[]));
    assessments.push(...((ha ?? []) as HadithAssessment[]));
  }

  return variationRows.map((variation) => ({
    ...variation,
    books: one(variation.books as Book | Book[] | null),
    chains: chains
      .filter((chain) => chain.variation_id === variation.id)
      .map((chain) => ({
        ...chain,
        chain_narrators: [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position),
      })),
    hadith_assessments: assessments.filter((a) => a.variation_id === variation.id),
  }));
}

async function loadHadithMap(client: SupabaseClient, hadithIds: number[]): Promise<Map<number, Hadith>> {
  const map = new Map<number, Hadith>();
  if (!hadithIds.length) return map;
  for (let i = 0; i < hadithIds.length; i += 200) {
    const chunk = hadithIds.slice(i, i + 200);
    const { data, error } = await client
      .from("hadiths")
      .select("id, slug, title, arabic_title, summary, topics, review_status")
      .in("id", chunk);
    if (error) throw new Error(error.message);
    for (const h of (data ?? []) as Hadith[]) map.set(h.id, h);
  }
  return map;
}

/**
 * All variations that pass a–d, across every topic/hadith.
 * Same filter shape as getEligibleFirstWahiVariations, corpus-wide.
 */
export async function getEligibleVariations(
  options: GetEligibleOptions = {},
): Promise<{ variations: EligibleVariation[]; error: Error | null }> {
  const publishedOnly = options.publishedOnly !== false;
  const client = db(options.client);
  try {
    let variationRows = await pageSelect<SourceVariation>(
      client,
      "source_variations",
      `*, ${BOOKS_EMBED}`,
      (q) => {
        let qq = q.order("id");
        if (options.hadithId != null) qq = qq.eq("hadith_id", options.hadithId);
        // Live bar needs verified chains; verified variations are the published set.
        if (publishedOnly) qq = qq.eq("verified", true);
        return qq;
      },
    );

    if (options.limit != null) variationRows = variationRows.slice(0, options.limit);

    const hadithIds = [...new Set(variationRows.map((v) => v.hadith_id))];
    const hadithById = await loadHadithMap(client, hadithIds);

    if (publishedOnly || options.topic) {
      variationRows = variationRows.filter((v) => {
        const h = hadithById.get(v.hadith_id);
        if (!h) return false;
        if (publishedOnly && h.review_status !== "published") return false;
        if (options.topic) {
          const topics = (h.topics ?? []).map((t) => t.toLowerCase());
          const needle = options.topic.toLowerCase();
          if (!topics.some((t) => t === needle || t.includes(needle))) return false;
        }
        return true;
      });
    }

    const details = await attachChainsAndBooks(client, variationRows);
    const assessmentsByNarratorId = await loadAllNarratorAssessments(
      client,
      collectNarratorIds(details),
    );

    const minNodes = options.minChainNodes ?? 1;
    const eligible: EligibleVariation[] = [];
    for (const variation of details) {
      const result = evaluateVariationEligibility(variation, assessmentsByNarratorId);
      if (!result.eligible) continue;
      const deepEnough = result.completeChains.filter((c) => c.nodes.length >= minNodes);
      if (!deepEnough.length) continue;
      const h = hadithById.get(variation.hadith_id) ?? null;
      eligible.push({
        ...variation,
        chains: variation.chains.filter((chain) => deepEnough.some((c) => c.id === chain.id)),
        eligibleChains: deepEnough,
        hadith: h
          ? {
              id: h.id,
              slug: h.slug,
              title: h.title,
              topics: h.topics ?? [],
              review_status: h.review_status,
            }
          : null,
      });
    }

    return { variations: eligible, error: null };
  } catch (e) {
    return { variations: [], error: e instanceof Error ? e : new Error(String(e)) };
  }
}

function summarizeEligible(variations: EligibleVariation[]) {
  const narratorIds = new Set<number>();
  const hadithIds = new Set<number>();
  let chainCount = 0;
  for (const variation of variations) {
    hadithIds.add(variation.hadith_id);
    chainCount += variation.eligibleChains.length;
    for (const chain of variation.eligibleChains) {
      for (const node of chain.nodes) narratorIds.add(node.narratorId);
    }
  }
  return {
    hadiths: hadithIds.size,
    variations: variations.length,
    chains: chainCount,
    narrators: narratorIds.size,
  };
}

function groupEligibleByTopic(variations: EligibleVariation[]): {
  byTopic: EligibleByTopic[];
  uncategorized: EligibleByTopic | null;
} {
  const buckets = new Map<string, { hadithIds: Set<number>; variationIds: number[] }>();
  const uncatHadith = new Set<number>();
  const uncatVars: number[] = [];

  for (const v of variations) {
    const topics = v.hadith?.topics?.filter(Boolean) ?? [];
    if (!topics.length) {
      uncatHadith.add(v.hadith_id);
      uncatVars.push(v.id);
      continue;
    }
    for (const topic of topics) {
      const b = buckets.get(topic) ?? { hadithIds: new Set(), variationIds: [] };
      b.hadithIds.add(v.hadith_id);
      b.variationIds.push(v.id);
      buckets.set(topic, b);
    }
  }

  const byTopic: EligibleByTopic[] = [...buckets.entries()]
    .map(([topic, b]) => ({
      topic,
      hadithIds: [...b.hadithIds],
      variationIds: b.variationIds,
      variationCount: b.variationIds.length,
      hadithCount: b.hadithIds.size,
    }))
    .sort((a, b) => b.variationCount - a.variationCount);

  const uncategorized: EligibleByTopic | null = uncatVars.length
    ? {
        topic: "(no topic)",
        hadithIds: [...uncatHadith],
        variationIds: uncatVars,
        variationCount: uncatVars.length,
        hadithCount: uncatHadith.size,
      }
    : null;

  return { byTopic, uncategorized };
}

/** Stats over the corpus-wide eligible set. */
export async function getEligibleVariationStats(options: GetEligibleOptions = {}) {
  const { variations, error } = await getEligibleVariations(options);
  return { ...summarizeEligible(variations), error };
}

/**
 * One pass: eligible list + stats + topic buckets (for homepage / dashboards).
 */
export async function getEligibleCorpusSnapshot(options: GetEligibleOptions = {}) {
  const { variations, error } = await getEligibleVariations(options);
  if (error) {
    return {
      variations: [] as EligibleVariation[],
      stats: { hadiths: 0, variations: 0, chains: 0, narrators: 0 },
      byTopic: [] as EligibleByTopic[],
      uncategorized: null as EligibleByTopic | null,
      error,
    };
  }
  const { byTopic, uncategorized } = groupEligibleByTopic(variations);
  return {
    variations,
    stats: summarizeEligible(variations),
    byTopic,
    uncategorized,
    error: null,
  };
}

/** Group eligible variations by hadith.topics (each topic gets a bucket). */
export async function getEligibleVariationsByTopic(
  options: GetEligibleOptions = {},
): Promise<{ byTopic: EligibleByTopic[]; uncategorized: EligibleByTopic | null; error: Error | null }> {
  const { variations, error } = await getEligibleVariations(options);
  if (error) return { byTopic: [], uncategorized: null, error };
  const grouped = groupEligibleByTopic(variations);
  return { ...grouped, error: null };
}

/**
 * Diagnostic rows for every scanned variation (eligible or not).
 * Heavier than getEligibleVariations — use for scripts / admin.
 */
export async function getEligibilityDiagnostics(
  options: GetEligibleOptions = {},
): Promise<{ rows: EligibleVariationRow[]; error: Error | null }> {
  const publishedOnly = options.publishedOnly === true;
  const client = db(options.client);
  try {
    let variationRows = await pageSelect<SourceVariation>(
      client,
      "source_variations",
      `*, ${BOOKS_EMBED}`,
      (q) => {
        let qq = q.order("id");
        if (options.hadithId != null) qq = qq.eq("hadith_id", options.hadithId);
        return qq;
      },
    );
    if (options.limit != null) variationRows = variationRows.slice(0, options.limit);

    const hadithById = await loadHadithMap(
      client,
      [...new Set(variationRows.map((v) => v.hadith_id))],
    );
    if (publishedOnly || options.topic) {
      variationRows = variationRows.filter((v) => {
        const h = hadithById.get(v.hadith_id);
        if (!h) return false;
        if (publishedOnly && h.review_status !== "published") return false;
        if (options.topic) {
          const topics = (h.topics ?? []).map((t) => t.toLowerCase());
          const needle = options.topic.toLowerCase();
          if (!topics.some((t) => t === needle || t.includes(needle))) return false;
        }
        return true;
      });
    }

    const details = await attachChainsAndBooks(client, variationRows);
    const assessmentsByNarratorId = await loadAllNarratorAssessments(
      client,
      collectNarratorIds(details),
    );

    const rows: EligibleVariationRow[] = details.map((variation) => {
      const result = evaluateVariationEligibility(variation, assessmentsByNarratorId);
      const h = hadithById.get(variation.hadith_id);
      return {
        variationId: variation.id,
        hadithId: variation.hadith_id,
        hadithSlug: h?.slug ?? null,
        topics: h?.topics ?? [],
        bookTitle: variation.books?.title ?? null,
        hadithNumber: variation.hadith_number,
        chapter: variation.chapter ?? null,
        eligible: result.eligible,
        failures: result.failures,
        verifiedChainCount: (variation.chains ?? []).filter((c) => c.verified).length,
        completeChainCount: result.completeChains.length,
      };
    });

    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e : new Error(String(e)) };
  }
}
