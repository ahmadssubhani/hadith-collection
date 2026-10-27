import { one } from "@/lib/format";
import type { Chain, ChainNarrator, Narrator, NarratorAssessment, SourceVariationDetail } from "@/lib/types";

export const FIRST_WAHI_HADITH_SLUG = "first-revelation-at-hira";
/** Public page that lists eligible First Wahi variations (not the homepage). */
export const FIRST_WAHI_PUBLISHED_PATH = "/published-clusters/first-wahi";
export const FIRST_WAHI_EMPTY_MESSAGE =
  "No hadith have complete, verified chain and narrator evidence yet.";
/** Single plain-text credit under the Published clusters First Wahi list. Delete this constant to remove the line. */
export const FIRST_WAHI_SOURCE_CREDIT =
  "Hadith texts and narrator appraisals compiled from Sunnah.com.";

export type EligibilityRule = "a" | "b" | "c" | "d";

export type ChainRole = "collector" | "teacher" | "student" | "companion";

export type EligibilityFailure = {
  rule: EligibilityRule;
  detail: string;
};

export type ChainNodeView = {
  chainNarratorId: number;
  narratorId: number;
  position: number;
  name: string;
  arabicName: string | null;
  slug: string;
  role: ChainRole;
  generation: string | null;
};

export type EligibleChainView = {
  id: number;
  chainNumber: number;
  rawChainText: string | null;
  notes: string | null;
  nodes: ChainNodeView[];
};

/** Citation rule (c): source_url OR (reference_book AND page). */
export function hasCitedAssessmentCitation(row: {
  reference_book?: string | null;
  page?: string | null;
  source_url?: string | null;
}): boolean {
  const url = row.source_url?.trim() ?? "";
  if (url) return true;
  const book = row.reference_book?.trim() ?? "";
  const page = row.page?.trim() ?? "";
  return Boolean(book && page);
}

export function citedVerifiedAssessments(assessments: NarratorAssessment[]): NarratorAssessment[] {
  return assessments.filter((row) => row.verified && hasCitedAssessmentCitation(row));
}

export function roleForChainPosition(index: number, length: number): ChainRole {
  if (length <= 1) return "companion";
  if (index === 0) return "companion";
  if (index === length - 1) return "collector";
  const midpoint = (length - 1) / 2;
  return index <= midpoint ? "teacher" : "student";
}

export const CHAIN_ROLE_LABEL: Record<ChainRole, string> = {
  collector: "Collector",
  teacher: "Teacher",
  student: "Student",
  companion: "Companion",
};

export function buildChainNodeViews(nodes: ChainNarrator[]): ChainNodeView[] | null {
  const sorted = [...nodes].sort((a, b) => a.position - b.position);
  if (!sorted.length) return null;
  if (sorted.some((node) => node.narrator_id == null)) return null;

  const views: ChainNodeView[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const node = sorted[i];
    const narrator = one(node.narrators);
    if (!narrator?.slug || node.narrator_id == null) return null;
    views.push({
      chainNarratorId: node.id,
      narratorId: node.narrator_id,
      position: node.position,
      name: narrator.name,
      arabicName: narrator.arabic_name ?? null,
      slug: narrator.slug,
      role: roleForChainPosition(i, sorted.length),
      generation: narrator.generation ?? null,
    });
  }
  return views;
}

/**
 * Display order: Collector (left) ← … ← Companion (right).
 * Chronological nodes are reversed so the collector appears first.
 */
export function displayOrderNodes(nodes: ChainNodeView[]): ChainNodeView[] {
  return [...nodes].reverse();
}

export function evaluateVariationEligibility(
  variation: Pick<SourceVariationDetail, "arabic_text" | "english_text" | "chains">,
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>,
): { eligible: boolean; failures: EligibilityFailure[]; completeChains: EligibleChainView[] } {
  const failures: EligibilityFailure[] = [];
  const completeChains: EligibleChainView[] = [];

  const arabic = variation.arabic_text?.trim() ?? "";
  const english = variation.english_text?.trim() ?? "";
  if (!arabic || !english) {
    failures.push({
      rule: "d",
      detail: !arabic && !english ? "missing Arabic and English text" : !arabic ? "missing Arabic text" : "missing English text",
    });
  }

  const verifiedChains = (variation.chains ?? []).filter((chain) => chain.verified);
  if (!verifiedChains.length) {
    failures.push({ rule: "a", detail: "no verified chain" });
  }

  for (const chain of verifiedChains) {
    const nodes = [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position);
    const unresolved = nodes.filter((node) => node.narrator_id == null);
    if (unresolved.length) {
      failures.push({
        rule: "b",
        detail: `chain ${chain.chain_number}: ${unresolved.length} unresolved narrator node(s)`,
      });
      continue;
    }
    if (!nodes.length) {
      failures.push({ rule: "b", detail: `chain ${chain.chain_number}: no chain_narrators rows` });
      continue;
    }

    const missingEvidence: string[] = [];
    for (const node of nodes) {
      const narratorId = node.narrator_id as number;
      const cited = citedVerifiedAssessments(assessmentsByNarratorId.get(narratorId) ?? []);
      if (!cited.length) {
        const narrator = one(node.narrators);
        missingEvidence.push(narrator?.name ?? node.raw_name ?? `narrator_id=${narratorId}`);
      }
    }
    if (missingEvidence.length) {
      failures.push({
        rule: "c",
        detail: `chain ${chain.chain_number}: no verified cited assessment for ${missingEvidence.join(", ")}`,
      });
      continue;
    }

    const views = buildChainNodeViews(nodes);
    if (!views) {
      failures.push({ rule: "b", detail: `chain ${chain.chain_number}: narrator profile incomplete` });
      continue;
    }

    completeChains.push({
      id: chain.id,
      chainNumber: chain.chain_number,
      rawChainText: chain.raw_chain_text,
      notes: chain.notes ?? null,
      nodes: views,
    });
  }

  const textOk = Boolean(arabic && english);
  const hasCompleteChain = completeChains.length > 0;
  const isEligible = textOk && hasCompleteChain;

  if (isEligible) {
    return { eligible: true, failures: [], completeChains };
  }

  // Keep only failures that actually block eligibility; prefer specific rules.
  const uniqueFailures = dedupeFailures(failures);
  if (!verifiedChains.length && !uniqueFailures.some((f) => f.rule === "a")) {
    uniqueFailures.push({ rule: "a", detail: "no verified chain" });
  }
  if (verifiedChains.length && !hasCompleteChain && !uniqueFailures.some((f) => f.rule === "b" || f.rule === "c")) {
    uniqueFailures.push({ rule: "b", detail: "no verified chain with fully resolved narrators" });
  }
  if (!textOk && !uniqueFailures.some((f) => f.rule === "d")) {
    uniqueFailures.push({
      rule: "d",
      detail: !arabic && !english ? "missing Arabic and English text" : !arabic ? "missing Arabic text" : "missing English text",
    });
  }

  return { eligible: false, failures: uniqueFailures, completeChains: [] };
}

function dedupeFailures(failures: EligibilityFailure[]): EligibilityFailure[] {
  const seen = new Set<EligibilityRule>();
  const out: EligibilityFailure[] = [];
  for (const failure of failures) {
    if (seen.has(failure.rule)) continue;
    seen.add(failure.rule);
    out.push(failure);
  }
  return out;
}

export function neighborsInChain(
  nodes: ChainNarrator[],
  narratorId: number,
): { teacher: Narrator | null; student: Narrator | null } {
  const sorted = [...nodes].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex((node) => node.narrator_id === narratorId);
  if (index < 0) return { teacher: null, student: null };
  const teacherNode = sorted[index - 1];
  const studentNode = sorted[index + 1];
  return {
    teacher: teacherNode ? one(teacherNode.narrators) : null,
    student: studentNode ? one(studentNode.narrators) : null,
  };
}

export type NarratorPanelEvidence = {
  narrator: Pick<Narrator, "id" | "slug" | "name" | "arabic_name" | "death_year_ah" | "region" | "generation">;
  assessments: NarratorAssessment[];
  citedCount: number;
  mappedScore: number | null;
  mappedLabel: string | null;
  teacher: { name: string; slug: string | null } | null;
  student: { name: string; slug: string | null } | null;
  chainId: number | null;
};

/** Pure check used by scripts and server loaders when assessments are preloaded. */
export function diagnoseChain(
  chain: Chain,
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>,
): EligibilityFailure[] {
  const failures: EligibilityFailure[] = [];
  if (!chain.verified) {
    failures.push({ rule: "a", detail: `chain ${chain.chain_number} is not verified` });
    return failures;
  }
  const nodes = [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position);
  if (nodes.some((n) => n.narrator_id == null)) {
    failures.push({ rule: "b", detail: `chain ${chain.chain_number} has unresolved narrator_id` });
    return failures;
  }
  for (const node of nodes) {
    const cited = citedVerifiedAssessments(assessmentsByNarratorId.get(node.narrator_id as number) ?? []);
    if (!cited.length) {
      const narrator = one(node.narrators);
      failures.push({
        rule: "c",
        detail: `${narrator?.name ?? node.raw_name} lacks verified cited assessment`,
      });
      return failures;
    }
  }
  return [];
}
