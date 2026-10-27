/**
 * Prints eligibility for First Wahi source variations (rules a–d).
 * Read-only. Uses the same evaluateVariationEligibility logic as the app.
 *
 * Usage:
 *   npx tsx scripts/check-first-wahi-eligibility.ts
 *   npx tsx scripts/check-first-wahi-eligibility.ts --groups
 *
 * --groups: uses data/merge-plan.json from npm run hadith:dedupe and reports
 * eligibility at the hadith-group level (any member passing a–d).
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { one } from "../lib/format";
import { evaluateVariationEligibility } from "../lib/first-wahi-eligibility";
import type {
  Book,
  Chain,
  HadithAssessment,
  NarratorAssessment,
  SourceVariation,
  SourceVariationDetail,
} from "../lib/types";

const FIRST_WAHI_SLUG = "first-revelation-at-hira";
const GROUPS = process.argv.includes("--groups");
const MERGE_PLAN = path.join(process.cwd(), "data", "merge-plan.json");

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and a Supabase key in .env.local");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

type MergePlanFile = {
  groups: Array<{
    group_id: string;
    confidence: string;
    status: string;
    canonical_variation_id: number | null;
    members: Array<{
      variation_id: number;
      source: string;
      hadith_number: string | null;
      eligible?: boolean;
    }>;
  }>;
  review_groups: Array<{
    group_id: string;
    confidence: string;
    members: Array<{ variation_id: number; source: string; hadith_number: string | null }>;
  }>;
};

async function loadDetailsForIds(
  supabase: ReturnType<typeof client>,
  variationRows: SourceVariation[],
): Promise<{
  details: SourceVariationDetail[];
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>;
}> {
  const variationIds = variationRows.map((row) => row.id);
  const [{ data: chains }, { data: assessments }] = await Promise.all([
    supabase
      .from("chains")
      .select("*, chain_narrators(*, narrators(*)), chain_assessments(*, scholars(*))")
      .in("variation_id", variationIds)
      .order("chain_number"),
    supabase.from("narrator_assessments").select("*, scholars(*)"),
  ]);

  const assessmentsByNarratorId = new Map<number, NarratorAssessment[]>();
  for (const row of (assessments ?? []) as NarratorAssessment[]) {
    const list = assessmentsByNarratorId.get(row.narrator_id) ?? [];
    list.push(row);
    assessmentsByNarratorId.set(row.narrator_id, list);
  }

  const details: SourceVariationDetail[] = variationRows.map((variation) => ({
    ...variation,
    books: one(variation.books as Book | Book[] | null),
    chains: ((chains ?? []) as Chain[])
      .filter((chain) => chain.variation_id === variation.id)
      .map((chain) => ({
        ...chain,
        chain_narrators: [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position),
      })),
    hadith_assessments: [] as HadithAssessment[],
  }));

  return { details, assessmentsByNarratorId };
}

async function runFirstWahi() {
  const supabase = client();
  const usingService = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`First Wahi eligibility check (${usingService ? "service role" : "anon / RLS"})\n`);

  const { data: hadith, error: hadithError } = await supabase
    .from("hadiths")
    .select("*")
    .eq("slug", FIRST_WAHI_SLUG)
    .maybeSingle();

  if (hadithError) throw new Error(hadithError.message);
  if (!hadith) {
    console.log(`No hadith with slug "${FIRST_WAHI_SLUG}".`);
    return;
  }

  const { data: variations, error: variationError } = await supabase
    .from("source_variations")
    .select("*, books!source_variations_book_id_fkey(*)")
    .eq("hadith_id", hadith.id)
    .order("id");

  if (variationError) throw new Error(variationError.message);
  if (!variations?.length) {
    console.log("No source_variations for this cluster.");
    return;
  }

  const variationRows = variations as SourceVariation[];
  const { details, assessmentsByNarratorId } = await loadDetailsForIds(supabase, variationRows);

  let eligibleCount = 0;
  const failCounts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };

  for (const variation of details) {
    const book = variation.books;
    const label = `${book?.title ?? "Untitled"}${variation.hadith_number ? ` #${variation.hadith_number}` : ""} (id=${variation.id})`;
    const result = evaluateVariationEligibility(variation, assessmentsByNarratorId);

    if (result.eligible) {
      eligibleCount += 1;
      console.log(`PASS  ${label}  — ${result.completeChains.length} complete chain(s)`);
    } else {
      const rules = result.failures.map((f) => f.rule).join(",");
      for (const f of result.failures) failCounts[f.rule] = (failCounts[f.rule] ?? 0) + 1;
      console.log(`FAIL  ${label}`);
      console.log(`      fails (${rules || "?"}): ${result.failures.map((f) => `${f.rule}: ${f.detail}`).join("; ")}`);
    }
  }

  console.log("\n---");
  console.log(`Total variations: ${details.length}`);
  console.log(`Eligible: ${eligibleCount}`);
  console.log(`Fail rule counts (variations listing each rule once): a=${failCounts.a} b=${failCounts.b} c=${failCounts.c} d=${failCounts.d}`);
}

function hostOf(source: string): string {
  const m = source.match(/\[([^\]]+)\]/);
  return m?.[1] ?? source;
}

async function runGroups() {
  if (!existsSync(MERGE_PLAN)) {
    console.error(`Missing ${MERGE_PLAN}. Run npm run hadith:dedupe first.`);
    process.exit(1);
  }

  const plan = JSON.parse(readFileSync(MERGE_PLAN, "utf8")) as MergePlanFile;
  const supabase = client();
  const usingService = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`Hadith group eligibility (${usingService ? "service role" : "anon / RLS"})`);
  console.log(`Using merge plan: ${MERGE_PLAN}\n`);

  // plan.groups covers every variation once (EXACT/HIGH mergeable + REVIEW + unique).
  const primaryGroups = plan.groups;
  const covered = new Set(primaryGroups.flatMap((g) => g.members.map((m) => m.variation_id)));
  const allIds = [...covered];

  const variationRows: SourceVariation[] = [];
  for (let i = 0; i < allIds.length; i += 200) {
    const chunk = allIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from("source_variations")
      .select("*, books!source_variations_book_id_fkey(*)")
      .in("id", chunk);
    if (error) throw new Error(error.message);
    variationRows.push(...((data ?? []) as SourceVariation[]));
  }

  const { details, assessmentsByNarratorId } = await loadDetailsForIds(supabase, variationRows);
  const detailById = new Map(details.map((d) => [d.id, d]));

  const failCounts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
  let eligibleVariations = 0;
  let eligibleGroups = 0;
  const bySource = new Map<
    string,
    { groups: number; eligibleGroups: number; variations: number; eligibleVariations: number }
  >();
  const eligibleList: string[] = [];

  for (const g of primaryGroups) {
    let groupEligible = false;
    const hosts = new Set<string>();
    for (const m of g.members) {
      const detail = detailById.get(m.variation_id);
      if (!detail) continue;
      const host = hostOf(m.source);
      hosts.add(host);
      const bucket = bySource.get(host) ?? {
        groups: 0,
        eligibleGroups: 0,
        variations: 0,
        eligibleVariations: 0,
      };
      bucket.variations += 1;
      const result = evaluateVariationEligibility(detail, assessmentsByNarratorId);
      if (result.eligible) {
        eligibleVariations += 1;
        bucket.eligibleVariations += 1;
        groupEligible = true;
        const book = detail.books?.title ?? "Untitled";
        eligibleList.push(
          `${book}${detail.hadith_number ? ` #${detail.hadith_number}` : ""} (id=${detail.id})`,
        );
      } else {
        for (const f of result.failures) failCounts[f.rule] = (failCounts[f.rule] ?? 0) + 1;
      }
      bySource.set(host, bucket);
    }
    if (groupEligible) eligibleGroups += 1;
    for (const host of hosts) {
      const bucket = bySource.get(host)!;
      bucket.groups += 1;
      if (groupEligible) bucket.eligibleGroups += 1;
      bySource.set(host, bucket);
    }
  }

  const reviewOnly = primaryGroups.filter((g) => g.confidence === "REVIEW" || g.status === "review_only");

  console.log(`Total variations: ${covered.size}`);
  console.log(`Total hadith groups (incl. unique singletons): ${primaryGroups.length}`);
  console.log(`Review-only groups (not auto-merged): ${reviewOnly.length}`);
  console.log(`Eligible groups: ${eligibleGroups}`);
  console.log(`Eligible variations: ${eligibleVariations}`);
  console.log(
    `Fail rule counts (per variation, each rule once): a=${failCounts.a} b=${failCounts.b} c=${failCounts.c} d=${failCounts.d}`,
  );
  console.log("\nBreakdown by source/host:");
  for (const [host, s] of [...bySource.entries()].sort((a, b) => b[1].variations - a[1].variations)) {
    console.log(
      `  ${host}: variations=${s.variations} (eligible=${s.eligibleVariations}), groups_touching=${s.groups} (eligible_touching=${s.eligibleGroups})`,
    );
  }
  console.log("\nEligible hadith (name and number):");
  if (!eligibleList.length) console.log("  (none)");
  else for (const line of eligibleList) console.log(`  ${line}`);
}

async function main() {
  if (GROUPS) await runGroups();
  else await runFirstWahi();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
