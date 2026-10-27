import { createServerSupabaseClient } from "@/lib/supabase/server";
import { one } from "@/lib/format";
import {
  FIRST_WAHI_HADITH_SLUG,
  citedVerifiedAssessments,
  evaluateVariationEligibility,
  neighborsInChain,
  type EligibleChainView,
  type EligibilityFailure,
  type NarratorPanelEvidence,
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

export type { NarratorPanelEvidence };

export type EligibleFirstWahiVariation = SourceVariationDetail & {
  eligibleChains: EligibleChainView[];
};

export type FirstWahiEligibilityRow = {
  variationId: number;
  bookTitle: string | null;
  hadithNumber: string | null;
  eligible: boolean;
  failures: EligibilityFailure[];
  verifiedChainCount: number;
  completeChainCount: number;
};

async function loadFirstWahiHadith() {
  const supabase = createServerSupabaseClient();
  const { data: hadith, error } = await supabase
    .from("hadiths")
    .select("*")
    .eq("slug", FIRST_WAHI_HADITH_SLUG)
    .maybeSingle();
  return { hadith: (hadith as Hadith | null) ?? null, error };
}

async function loadVariationDetails(hadithId: number): Promise<{
  variations: SourceVariationDetail[];
  error: Error | null;
}> {
  const supabase = createServerSupabaseClient();
  const { data: variations, error: variationError } = await supabase
    .from("source_variations")
    .select("*, books!source_variations_book_id_fkey(*)")
    .eq("hadith_id", hadithId)
    .order("id");

  if (variationError) {
    return { variations: [], error: new Error(variationError.message) };
  }
  if (!variations?.length) {
    return { variations: [], error: null };
  }

  const variationRows = variations as SourceVariation[];
  const variationIds = variationRows.map((row) => row.id);

  const [{ data: chains }, { data: assessments }] = await Promise.all([
    supabase
      .from("chains")
      .select("*, chain_narrators(*, narrators(*)), chain_assessments(*, scholars(*))")
      .in("variation_id", variationIds)
      .order("chain_number"),
    supabase.from("hadith_assessments").select("*, scholars(*)").in("variation_id", variationIds),
  ]);

  const details: SourceVariationDetail[] = variationRows.map((variation) => ({
    ...variation,
    books: one(variation.books as Book | Book[] | null),
    chains: ((chains ?? []) as Chain[])
      .filter((chain) => chain.variation_id === variation.id)
      .map((chain) => ({
        ...chain,
        chain_narrators: [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position),
      })),
    hadith_assessments: ((assessments ?? []) as HadithAssessment[]).filter(
      (assessment) => assessment.variation_id === variation.id,
    ),
  }));

  return { variations: details, error: null };
}

async function loadAssessmentsByNarratorIds(narratorIds: number[]): Promise<Map<number, NarratorAssessment[]>> {
  const map = new Map<number, NarratorAssessment[]>();
  if (!narratorIds.length) return map;

  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("narrator_assessments")
    .select("*, scholars(*)")
    .in("narrator_id", narratorIds);

  for (const row of (data ?? []) as NarratorAssessment[]) {
    const list = map.get(row.narrator_id) ?? [];
    list.push(row);
    map.set(row.narrator_id, list);
  }
  return map;
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

/**
 * Shared eligibility loader for First Wahi list pages, counts, and the detail page.
 * Only returns variations that pass rules a–d.
 */
export async function getEligibleFirstWahiVariations(): Promise<{
  hadith: Hadith | null;
  variations: EligibleFirstWahiVariation[];
  error: Error | null;
}> {
  const { hadith, error: hadithError } = await loadFirstWahiHadith();
  if (hadithError) {
    return { hadith: null, variations: [], error: new Error(hadithError.message) };
  }
  if (!hadith) {
    return { hadith: null, variations: [], error: null };
  }

  const { variations, error } = await loadVariationDetails(hadith.id);
  if (error) return { hadith, variations: [], error };

  const assessmentsByNarratorId = await loadAssessmentsByNarratorIds(collectNarratorIds(variations));
  const eligible: EligibleFirstWahiVariation[] = [];

  for (const variation of variations) {
    const result = evaluateVariationEligibility(variation, assessmentsByNarratorId);
    if (!result.eligible) continue;
    eligible.push({
      ...variation,
      // Only expose complete verified chains on the page.
      chains: variation.chains.filter((chain) => result.completeChains.some((c) => c.id === chain.id)),
      eligibleChains: result.completeChains,
    });
  }

  return { hadith, variations: eligible, error: null };
}

/** Homepage stats from the same eligibility set — never raw table counts. */
export async function getEligibleFirstWahiStats() {
  const { variations, error } = await getEligibleFirstWahiVariations();
  const narratorIds = new Set<number>();
  let chainCount = 0;
  for (const variation of variations) {
    chainCount += variation.eligibleChains.length;
    for (const chain of variation.eligibleChains) {
      for (const node of chain.nodes) narratorIds.add(node.narratorId);
    }
  }

  return {
    hadiths: variations.length > 0 ? 1 : 0,
    variations: variations.length,
    chains: chainCount,
    narrators: narratorIds.size,
    error,
  };
}

/** Diagnostic rows for every First Wahi variation (eligible or not). */
export async function getFirstWahiEligibilityDiagnostics(): Promise<{
  rows: FirstWahiEligibilityRow[];
  error: Error | null;
}> {
  const { hadith, error: hadithError } = await loadFirstWahiHadith();
  if (hadithError) return { rows: [], error: new Error(hadithError.message) };
  if (!hadith) return { rows: [], error: null };

  const { variations, error } = await loadVariationDetails(hadith.id);
  if (error) return { rows: [], error };

  const assessmentsByNarratorId = await loadAssessmentsByNarratorIds(collectNarratorIds(variations));
  const rows: FirstWahiEligibilityRow[] = variations.map((variation) => {
    const result = evaluateVariationEligibility(variation, assessmentsByNarratorId);
    const book = variation.books;
    return {
      variationId: variation.id,
      bookTitle: book?.title ?? null,
      hadithNumber: variation.hadith_number,
      eligible: result.eligible,
      failures: result.failures,
      verifiedChainCount: (variation.chains ?? []).filter((c) => c.verified).length,
      completeChainCount: result.completeChains.length,
    };
  });

  return { rows, error: null };
}

export async function getNarratorPanelEvidence(
  slug: string,
  chainId: number | null,
): Promise<{ data: NarratorPanelEvidence | null; error: string | null }> {
  const supabase = createServerSupabaseClient();
  const { data: narrator, error: narratorError } = await supabase
    .from("narrators")
    .select("id, slug, name, arabic_name, death_year_ah, region, generation")
    .eq("slug", slug)
    .maybeSingle();

  if (narratorError) return { data: null, error: narratorError.message };
  if (!narrator) return { data: null, error: "Narrator not found." };

  const { data: assessmentRows, error: assessmentError } = await supabase
    .from("narrator_assessments")
    .select("*, scholars(*)")
    .eq("narrator_id", narrator.id);

  if (assessmentError) return { data: null, error: assessmentError.message };

  // Stable DB/source order by id — never by sentiment or score. No computed score ring.
  const assessments = citedVerifiedAssessments((assessmentRows ?? []) as NarratorAssessment[]).sort(
    (a, b) => a.id - b.id,
  );

  let teacher: NarratorPanelEvidence["teacher"] = null;
  let student: NarratorPanelEvidence["student"] = null;

  if (chainId != null) {
    const { data: chain } = await supabase
      .from("chains")
      .select("id, chain_narrators(*, narrators(id, slug, name))")
      .eq("id", chainId)
      .maybeSingle();

    if (chain) {
      const nodes = [...((chain as Chain).chain_narrators ?? [])].sort((a, b) => a.position - b.position);
      const neighbors = neighborsInChain(nodes, narrator.id);
      if (neighbors.teacher) {
        teacher = { name: neighbors.teacher.name, slug: neighbors.teacher.slug };
      }
      if (neighbors.student) {
        student = { name: neighbors.student.name, slug: neighbors.student.slug };
      }
    }
  }

  return {
    data: {
      narrator,
      assessments,
      citedCount: assessments.length,
      mappedScore: null,
      mappedLabel: null,
      teacher,
      student,
      chainId,
    },
    error: null,
  };
}
