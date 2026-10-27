/**
 * Human-check remaining Hadith variations, shortlist those that meet the site
 * live bar (eligibility rules a–d), then optionally publish them.
 *
 * Live bar (same as First Wahi public page):
 *   a) verified chain
 *   b) every chain node linked to a narrator
 *   c) every narrator has a verified, cited assessment
 *   d) Arabic + English text present
 *
 * Skips variations tagged merged_duplicate_of: (ignored duplicates from combine).
 *
 * Usage:
 *   npx tsx scripts/human-check-and-publish.ts              # dry-run shortlist
 *   npx tsx scripts/human-check-and-publish.ts --apply      # publish shortlist
 *   npx tsx scripts/human-check-and-publish.ts --first-wahi-only
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { one } from "../lib/format";
import { evaluateVariationEligibility } from "../lib/first-wahi-eligibility";
import type {
  Book,
  Chain,
  NarratorAssessment,
  SourceVariation,
  SourceVariationDetail,
} from "../lib/types";

const APPLY = process.argv.includes("--apply");
const FIRST_WAHI_ONLY = process.argv.includes("--first-wahi-only");
const FIRST_WAHI_SLUG = "first-revelation-at-hira";
const DATA_DIR = path.join(process.cwd(), "data");
const SHORTLIST_PATH = path.join(DATA_DIR, "human-check-shortlist.json");
const ALLOWLIST_PATH = path.join(DATA_DIR, "publish-allowlist.json");

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function fetchAllVariations(sb: SupabaseClient): Promise<SourceVariation[]> {
  if (FIRST_WAHI_ONLY) {
    const { data: hadith, error } = await sb.from("hadiths").select("id").eq("slug", FIRST_WAHI_SLUG).maybeSingle();
    if (error) throw error;
    if (!hadith) return [];
    const { data, error: vErr } = await sb
      .from("source_variations")
      .select("*, books!source_variations_book_id_fkey(*)")
      .eq("hadith_id", hadith.id)
      .order("id");
    if (vErr) throw vErr;
    return (data ?? []) as SourceVariation[];
  }

  const rows: SourceVariation[] = [];
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await sb
      .from("source_variations")
      .select("*, books!source_variations_book_id_fkey(*)")
      .order("id")
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as SourceVariation[]));
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function loadDetails(
  sb: SupabaseClient,
  variationRows: SourceVariation[]
): Promise<{
  details: SourceVariationDetail[];
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>;
}> {
  const variationIds = variationRows.map((r) => r.id);
  const assessmentsByNarratorId = new Map<number, NarratorAssessment[]>();

  // assessments: page if large
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb
        .from("narrator_assessments")
        .select("*, scholars(*)")
        .range(from, from + page - 1);
      if (error) throw error;
      if (!data?.length) break;
      for (const row of data as NarratorAssessment[]) {
        const list = assessmentsByNarratorId.get(row.narrator_id) ?? [];
        list.push(row);
        assessmentsByNarratorId.set(row.narrator_id, list);
      }
      if (data.length < page) break;
      from += page;
    }
  }

  const chains: Chain[] = [];
  for (let i = 0; i < variationIds.length; i += 100) {
    const chunk = variationIds.slice(i, i + 100);
    const { data, error } = await sb
      .from("chains")
      .select("*, chain_narrators(*, narrators(*)), chain_assessments(*, scholars(*))")
      .in("variation_id", chunk)
      .order("chain_number");
    if (error) throw error;
    chains.push(...((data ?? []) as Chain[]));
  }

  const details: SourceVariationDetail[] = variationRows.map((variation) => ({
    ...variation,
    books: one(variation.books as Book | Book[] | null),
    chains: chains
      .filter((c) => c.variation_id === variation.id)
      .map((chain) => ({
        ...chain,
        chain_narrators: [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position),
      })),
    hadith_assessments: [],
  }));

  return { details, assessmentsByNarratorId };
}

function isIgnoredDuplicate(v: SourceVariation): boolean {
  return Boolean(v.status_notes?.includes("merged_duplicate_of:"));
}

type SoftReady = {
  arabic: boolean;
  english: boolean;
  reference: boolean;
  sourceUrl: boolean;
  chainText: boolean;
  grade: boolean;
};

function softReady(detail: SourceVariationDetail): SoftReady {
  return {
    arabic: Boolean(detail.arabic_text?.trim()),
    english: Boolean(detail.english_text?.trim()),
    reference: Boolean(detail.hadith_number?.trim()),
    sourceUrl: Boolean(detail.source_url?.trim()),
    chainText: (detail.chains ?? []).some((c) => Boolean(c.raw_chain_text?.trim())),
    grade: detail.hadith_status != null && detail.hadith_status !== "not_graded",
  };
}

async function publishIdsViaPg(variationIds: number[]) {
  const databaseUrl = process.env.DATABASE_URL!.trim();
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("BEGIN");

    const narrRes = await client.query<{ narrator_id: number }>(
      `SELECT DISTINCT cn.narrator_id
       FROM public.chain_narrators cn
       JOIN public.chains c ON c.id = cn.chain_id
       WHERE c.variation_id = ANY($1::bigint[])
         AND cn.narrator_id IS NOT NULL`,
      [variationIds]
    );
    const narratorIds = narrRes.rows.map((r) => Number(r.narrator_id));

    const varRes = await client.query(
      `UPDATE public.source_variations
       SET verified = true
       WHERE id = ANY($1::bigint[])
         AND verified IS DISTINCT FROM true
       RETURNING id`,
      [variationIds]
    );

    const chainRes = await client.query(
      `UPDATE public.chains
       SET verified = true
       WHERE variation_id = ANY($1::bigint[])
         AND verified IS DISTINCT FROM true
       RETURNING id`,
      [variationIds]
    );

    const narrUpd = narratorIds.length
      ? await client.query(
          `UPDATE public.narrators
           SET identity_status = 'verified'
           WHERE id = ANY($1::bigint[])
             AND identity_status IS DISTINCT FROM 'verified'
           RETURNING id`,
          [narratorIds]
        )
      : { rowCount: 0, rows: [] as { id: number }[] };

    const assessRes = narratorIds.length
      ? await client.query(
          `UPDATE public.narrator_assessments
           SET verified = true
           WHERE narrator_id = ANY($1::bigint[])
             AND mapping_method = 'sunnah_com_import'
             AND verified IS DISTINCT FROM true
             AND nullif(trim(source_url), '') IS NOT NULL
           RETURNING id`,
          [narratorIds]
        )
      : { rowCount: 0, rows: [] as { id: number }[] };

    const hadithRes = await client.query(
      `UPDATE public.hadiths h
       SET review_status = 'published', updated_at = now()
       FROM public.source_variations sv
       WHERE sv.hadith_id = h.id
         AND sv.id = ANY($1::bigint[])
         AND h.review_status IS DISTINCT FROM 'published'
       RETURNING h.id`,
      [variationIds]
    );

    await client.query("COMMIT");
    return {
      variations: varRes.rowCount ?? varRes.rows.length,
      chains: chainRes.rowCount ?? chainRes.rows.length,
      narrators: narrUpd.rowCount ?? narrUpd.rows.length,
      assessments: assessRes.rowCount ?? assessRes.rows.length,
      hadiths: hadithRes.rowCount ?? hadithRes.rows.length,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

/** Fallback when DATABASE_URL is unset — uses service-role Supabase client. */
async function publishIdsViaSupabase(sb: SupabaseClient, variationIds: number[]) {
  const { data: chainRows, error: cErr } = await sb
    .from("chains")
    .select("id, chain_narrators(narrator_id)")
    .in("variation_id", variationIds);
  if (cErr) throw cErr;

  const narratorIds = new Set<number>();
  for (const chain of chainRows ?? []) {
    for (const node of (chain.chain_narrators as { narrator_id: number | null }[] | null) ?? []) {
      if (node.narrator_id != null) narratorIds.add(node.narrator_id);
    }
  }
  const narratorIdList = [...narratorIds];

  const { data: vars, error: vErr } = await sb
    .from("source_variations")
    .update({ verified: true })
    .in("id", variationIds)
    .select("id, hadith_id");
  if (vErr) throw vErr;

  const { data: chains, error: chErr } = await sb
    .from("chains")
    .update({ verified: true })
    .in("variation_id", variationIds)
    .select("id");
  if (chErr) throw chErr;

  let narratorsUpdated = 0;
  let assessmentsUpdated = 0;
  if (narratorIdList.length) {
    const { data: narrs, error: nErr } = await sb
      .from("narrators")
      .update({ identity_status: "verified" })
      .in("id", narratorIdList)
      .neq("identity_status", "verified")
      .select("id");
    if (nErr) throw nErr;
    narratorsUpdated = narrs?.length ?? 0;

    const { data: assesses, error: aErr } = await sb
      .from("narrator_assessments")
      .update({ verified: true })
      .in("narrator_id", narratorIdList)
      .eq("mapping_method", "sunnah_com_import")
      .eq("verified", false)
      .not("source_url", "is", null)
      .select("id");
    if (aErr) throw aErr;
    assessmentsUpdated = assesses?.length ?? 0;
  }

  const { data: allVars, error: avErr } = await sb
    .from("source_variations")
    .select("hadith_id")
    .in("id", variationIds);
  if (avErr) throw avErr;
  const uniqueHadithIds = [...new Set((allVars ?? []).map((v) => v.hadith_id).filter(Boolean))];

  let hadithsUpdated = 0;
  if (uniqueHadithIds.length) {
    const { data: hs, error: hErr } = await sb
      .from("hadiths")
      .update({ review_status: "published", updated_at: new Date().toISOString() })
      .in("id", uniqueHadithIds)
      .neq("review_status", "published")
      .select("id");
    if (hErr) throw hErr;
    hadithsUpdated = hs?.length ?? 0;
  }

  return {
    variations: vars?.length ?? 0,
    chains: chains?.length ?? 0,
    narrators: narratorsUpdated,
    assessments: assessmentsUpdated,
    hadiths: hadithsUpdated,
  };
}

async function publishIds(sb: SupabaseClient, variationIds: number[]) {
  if (process.env.DATABASE_URL?.trim()) {
    console.log("Publishing via DATABASE_URL (transaction)...");
    return publishIdsViaPg(variationIds);
  }
  console.log("DATABASE_URL unset — publishing via Supabase service role...");
  return publishIdsViaSupabase(sb, variationIds);
}

async function main() {
  console.log(`\n=== Human check → shortlist → ${APPLY ? "PUBLISH" : "dry-run"} ===`);
  if (FIRST_WAHI_ONLY) console.log("Scope: first-revelation-at-hira only");

  const sb = admin();
  const all = await fetchAllVariations(sb);
  const ignored = all.filter(isIgnoredDuplicate);
  const candidates = all.filter((v) => !isIgnoredDuplicate(v));
  console.log(`Variations loaded: ${all.length} (ignored duplicates: ${ignored.length}, checking: ${candidates.length})`);

  const { details, assessmentsByNarratorId } = await loadDetails(sb, candidates);

  const shortlist: Array<{
    variation_id: number;
    book: string | null;
    hadith_number: string | null;
    source_url: string | null;
    complete_chains: number;
    soft: SoftReady;
  }> = [];
  const failCounts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
  let softComplete = 0;

  for (const detail of details) {
    const soft = softReady(detail);
    const softOk = soft.arabic && soft.english && soft.reference && soft.sourceUrl;
    if (softOk) softComplete += 1;

    const result = evaluateVariationEligibility(detail, assessmentsByNarratorId);
    const book = detail.books?.title ?? null;
    const label = `${book ?? "Untitled"}${detail.hadith_number ? ` #${detail.hadith_number}` : ""} (id=${detail.id})`;

    if (result.eligible) {
      shortlist.push({
        variation_id: detail.id,
        book,
        hadith_number: detail.hadith_number,
        source_url: detail.source_url,
        complete_chains: result.completeChains.length,
        soft,
      });
      console.log(`PASS  ${label}  — ${result.completeChains.length} complete chain(s)`);
    } else {
      for (const f of result.failures) failCounts[f.rule] = (failCounts[f.rule] ?? 0) + 1;
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Checked: ${details.length}`);
  console.log(`Soft content-complete (ar+en+ref+url): ${softComplete}`);
  console.log(`Live-ready shortlist (rules a–d): ${shortlist.length}`);
  console.log(`Fail counts: a=${failCounts.a} b=${failCounts.b} c=${failCounts.c} d=${failCounts.d}`);
  console.log(
    "\nNote: Scraped inbox rows usually fail a–c until chains are verified and narrators have cited assessments."
  );

  mkdirSync(DATA_DIR, { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    first_wahi_only: FIRST_WAHI_ONLY,
    checked: details.length,
    ignored_duplicates: ignored.length,
    soft_content_complete: softComplete,
    shortlist_count: shortlist.length,
    fail_counts: failCounts,
    shortlist,
  };
  writeFileSync(SHORTLIST_PATH, JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(
    ALLOWLIST_PATH,
    JSON.stringify(
      {
        cluster: FIRST_WAHI_ONLY ? "first-wahi" : "human-check-shortlist",
        variation_ids: shortlist.map((s) => s.variation_id),
        generated_at: payload.generated_at,
        note: "Generated by human-check-and-publish.ts — only eligibility a–d passers",
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\nWrote ${SHORTLIST_PATH}`);
  console.log(`Wrote ${ALLOWLIST_PATH} (${shortlist.length} ids)`);

  if (!APPLY) {
    console.log("\nNo publish. Re-run with --apply to set verified=true / review_status=published for the shortlist.");
    return;
  }

  if (!shortlist.length) {
    console.log("\nShortlist empty — nothing to publish.");
    return;
  }

  const ids = shortlist.map((s) => s.variation_id);
  const result = await publishIds(sb, ids);
  console.log("\nPublished:");
  console.log(`  source_variations.verified=true: ${result.variations}`);
  console.log(`  chains.verified=true: ${result.chains}`);
  console.log(`  narrators.identity_status=verified: ${result.narrators}`);
  console.log(`  narrator_assessments.verified=true: ${result.assessments}`);
  console.log(`  hadiths.review_status=published: ${result.hadiths}`);
  console.log("\nThey are now visible under RLS (verified variations / published clusters).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
