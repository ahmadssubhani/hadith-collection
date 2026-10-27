/**
 * Publish allowlisted First Wahi Bukhari variations (dry-run by default).
 *
 * Usage:
 *   npx tsx scripts/publish-first-wahi.ts
 *   npx tsx scripts/publish-first-wahi.ts --apply
 *
 * Allowlist: data/publish-allowlist.json
 * Hold rows (stay unverified): data/hold-rows.json
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";

const ALLOWLIST_PATH = path.join(process.cwd(), "data", "publish-allowlist.json");
const HOLD_PATH = path.join(process.cwd(), "data", "hold-rows.json");

type Allowlist = { cluster: string; variation_ids: number[] };
type HoldAssessment = {
  narrator_id: number;
  scholar_arabic_name: string;
  reason?: string;
};
type HoldFile = { assessments: HoldAssessment[] };

type NarratorCheck = {
  narratorId: number;
  arabicName: string | null;
  name: string;
  identityStatus: string;
  assessmentsWithSourceUrl: number;
  assessmentVerifiedTrue: number;
  assessmentVerifiedFalse: number;
  sunnahImportTotal: number;
  sunnahImportUnverified: number;
};

type VariationReport = {
  variationId: number;
  bookTitle: string | null;
  hadithNumber: string | null;
  hasArabic: boolean;
  hasEnglish: boolean;
  variationVerified: boolean;
  chainCount: number;
  nullNarratorNodes: number;
  chains: Array<{ id: number; chainNumber: number; verified: boolean }>;
  narrators: NarratorCheck[];
  pass: boolean;
  failReasons: string[];
};

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function loadAllowlist(): Allowlist {
  if (!existsSync(ALLOWLIST_PATH)) throw new Error(`Missing ${ALLOWLIST_PATH}`);
  const data = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Allowlist;
  if (!Array.isArray(data.variation_ids) || !data.variation_ids.length) {
    throw new Error("publish-allowlist.json must include a non-empty variation_ids array");
  }
  return data;
}

function loadHold(): HoldFile {
  if (!existsSync(HOLD_PATH)) {
    return { assessments: [] };
  }
  return JSON.parse(readFileSync(HOLD_PATH, "utf8")) as HoldFile;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function resolveHoldAssessmentIds(
  supabase: SupabaseClient,
  hold: HoldFile,
): Promise<{ ids: number[]; details: string[] }> {
  const ids: number[] = [];
  const details: string[] = [];
  for (const row of hold.assessments ?? []) {
    const scholarName = normalizeWs(row.scholar_arabic_name);
    const { data: byArabic, error: sErr } = await supabase
      .from("scholars")
      .select("id, arabic_name, name")
      .eq("arabic_name", scholarName);
    if (sErr) throw new Error(`Hold scholar lookup: ${sErr.message}`);
    let scholarIds = (byArabic ?? []).map((s) => s.id as number);
    if (!scholarIds.length) {
      const { data: byName } = await supabase.from("scholars").select("id").eq("name", scholarName);
      scholarIds = (byName ?? []).map((s) => s.id as number);
    }

    if (!scholarIds.length) {
      details.push(
        `HOLD miss: no scholar matching "${scholarName}" for narrator_id=${row.narrator_id} (${row.reason ?? ""})`,
      );
      continue;
    }

    const { data: assessments, error: aErr } = await supabase
      .from("narrator_assessments")
      .select("id, scholar_id, mapping_method, verified")
      .eq("narrator_id", row.narrator_id)
      .in("scholar_id", scholarIds)
      .eq("mapping_method", "sunnah_com_import");
    if (aErr) throw new Error(`Hold assessment lookup: ${aErr.message}`);

    if (!assessments?.length) {
      details.push(
        `HOLD miss: no sunnah_com_import row for narrator_id=${row.narrator_id} scholar="${scholarName}"`,
      );
      continue;
    }
    for (const a of assessments) {
      ids.push(a.id);
      details.push(
        `HOLD id=${a.id} narrator_id=${row.narrator_id} scholar="${scholarName}" verified=${a.verified} — ${row.reason ?? "held"}`,
      );
    }
  }
  return { ids: [...new Set(ids)], details };
}

async function inspectVariation(
  supabase: SupabaseClient,
  variationId: number,
): Promise<VariationReport> {
  const { data: variation, error: vErr } = await supabase
    .from("source_variations")
    .select("id, hadith_number, arabic_text, english_text, verified, books(title)")
    .eq("id", variationId)
    .maybeSingle();
  if (vErr) throw new Error(`variation ${variationId}: ${vErr.message}`);
  if (!variation) {
    return {
      variationId,
      bookTitle: null,
      hadithNumber: null,
      hasArabic: false,
      hasEnglish: false,
      variationVerified: false,
      chainCount: 0,
      nullNarratorNodes: 0,
      chains: [],
      narrators: [],
      pass: false,
      failReasons: [`variation_id=${variationId} not found`],
    };
  }

  const book = Array.isArray(variation.books) ? variation.books[0] : variation.books;
  const hasArabic = Boolean((variation.arabic_text ?? "").trim());
  const hasEnglish = Boolean((variation.english_text ?? "").trim());

  const { data: chains, error: cErr } = await supabase
    .from("chains")
    .select("id, chain_number, verified, chain_narrators(id, narrator_id, position, narrators(id, name, arabic_name, identity_status))")
    .eq("variation_id", variationId)
    .order("chain_number");
  if (cErr) throw new Error(`chains for ${variationId}: ${cErr.message}`);

  const chainRows = chains ?? [];
  let nullNarratorNodes = 0;
  const narratorIds = new Set<number>();
  const narratorMeta = new Map<number, { name: string; arabicName: string | null; identityStatus: string }>();

  for (const chain of chainRows) {
    const nodes = [...((chain as { chain_narrators?: Array<Record<string, unknown>> }).chain_narrators ?? [])];
    for (const node of nodes) {
      if (node.narrator_id == null) {
        nullNarratorNodes += 1;
        continue;
      }
      const nid = Number(node.narrator_id);
      narratorIds.add(nid);
      const narr = Array.isArray(node.narrators) ? node.narrators[0] : node.narrators;
      const narrObj = narr as { name?: string; arabic_name?: string | null; identity_status?: string } | null;
      if (!narratorMeta.has(nid)) {
        narratorMeta.set(nid, {
          name: narrObj?.name ?? `narrator_id=${nid}`,
          arabicName: narrObj?.arabic_name ?? null,
          identityStatus: narrObj?.identity_status ?? "unknown",
        });
      }
    }
  }

  const narratorChecks: NarratorCheck[] = [];
  for (const nid of [...narratorIds].sort((a, b) => a - b)) {
    const meta = narratorMeta.get(nid)!;
    const { data: assessments, error: aErr } = await supabase
      .from("narrator_assessments")
      .select("id, verified, source_url, mapping_method")
      .eq("narrator_id", nid);
    if (aErr) throw new Error(`assessments for narrator ${nid}: ${aErr.message}`);

    const rows = assessments ?? [];
    const withUrl = rows.filter((r) => Boolean((r.source_url ?? "").trim())).length;
    const verifiedTrue = rows.filter((r) => r.verified === true).length;
    const verifiedFalse = rows.filter((r) => r.verified !== true).length;
    const sunnah = rows.filter((r) => r.mapping_method === "sunnah_com_import");
    const sunnahUnverified = sunnah.filter((r) => r.verified !== true).length;

    narratorChecks.push({
      narratorId: nid,
      arabicName: meta.arabicName,
      name: meta.name,
      identityStatus: meta.identityStatus,
      assessmentsWithSourceUrl: withUrl,
      assessmentVerifiedTrue: verifiedTrue,
      assessmentVerifiedFalse: verifiedFalse,
      sunnahImportTotal: sunnah.length,
      sunnahImportUnverified: sunnahUnverified,
    });
  }

  const failReasons: string[] = [];
  if (!hasArabic) failReasons.push("missing Arabic text");
  if (!hasEnglish) failReasons.push("missing English text");
  if (!chainRows.length) failReasons.push("no chains");
  if (nullNarratorNodes > 0) failReasons.push(`${nullNarratorNodes} chain_narrators with narrator_id NULL`);
  for (const n of narratorChecks) {
    if (n.assessmentsWithSourceUrl < 1) {
      failReasons.push(
        `narrator_id=${n.narratorId} (${n.arabicName || n.name}) has 0 assessments with source_url`,
      );
    }
  }

  return {
    variationId,
    bookTitle: (book as { title?: string } | null)?.title ?? null,
    hadithNumber: variation.hadith_number,
    hasArabic,
    hasEnglish,
    variationVerified: Boolean(variation.verified),
    chainCount: chainRows.length,
    nullNarratorNodes,
    chains: chainRows.map((c) => ({
      id: c.id as number,
      chainNumber: c.chain_number as number,
      verified: Boolean(c.verified),
    })),
    narrators: narratorChecks,
    pass: failReasons.length === 0,
    failReasons,
  };
}

function printReport(report: VariationReport) {
  const label = [
    report.bookTitle,
    report.hadithNumber ? `#${report.hadithNumber}` : null,
    `variation_id=${report.variationId}`,
  ]
    .filter(Boolean)
    .join(" ");
  console.log(`\n=== ${label} ===`);
  console.log(`  Arabic text: ${report.hasArabic ? "yes" : "NO"}`);
  console.log(`  English text: ${report.hasEnglish ? "yes" : "NO"}`);
  console.log(`  source_variations.verified: ${report.variationVerified}`);
  console.log(`  Chains: ${report.chainCount}  (null narrator nodes: ${report.nullNarratorNodes})`);
  for (const c of report.chains) {
    console.log(`    chain id=${c.id} #${c.chainNumber} verified=${c.verified}`);
  }
  console.log(`  Narrators (${report.narrators.length}):`);
  for (const n of report.narrators) {
    console.log(
      `    id=${n.narratorId}  ${n.arabicName || n.name}  identity_status=${n.identityStatus}  assessments_with_source_url=${n.assessmentsWithSourceUrl}  (verified T/F=${n.assessmentVerifiedTrue}/${n.assessmentVerifiedFalse}; sunnah_com_import=${n.sunnahImportTotal}, unverified=${n.sunnahImportUnverified})`,
    );
  }
  if (report.pass) {
    console.log("  PASS");
  } else {
    console.log("  FAIL");
    for (const reason of report.failReasons) console.log(`    - ${reason}`);
  }
}

async function applyPublish(
  variationIds: number[],
  holdAssessmentIds: number[],
): Promise<{
  variationsUpdated: number;
  chainsUpdated: number;
  narratorsUpdated: number;
  assessmentsUpdated: number;
  narratorIds: number[];
  assessmentIds: number[];
  heldSkipped: number;
}> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for --apply (single transaction)");
  }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query("BEGIN");

    // Narrator ids linked to allowlisted variations only
    const narrRes = await client.query<{ narrator_id: number }>(
      `SELECT DISTINCT cn.narrator_id
       FROM public.chain_narrators cn
       JOIN public.chains c ON c.id = cn.chain_id
       WHERE c.variation_id = ANY($1::bigint[])
         AND cn.narrator_id IS NOT NULL`,
      [variationIds],
    );
    const narratorIds = narrRes.rows.map((r) => Number(r.narrator_id));

    const varRes = await client.query(
      `UPDATE public.source_variations
       SET verified = true
       WHERE id = ANY($1::bigint[])
         AND verified IS DISTINCT FROM true
       RETURNING id`,
      [variationIds],
    );

    const chainRes = await client.query(
      `UPDATE public.chains
       SET verified = true
       WHERE variation_id = ANY($1::bigint[])
         AND verified IS DISTINCT FROM true
       RETURNING id`,
      [variationIds],
    );

    const narrUpd = await client.query(
      `UPDATE public.narrators
       SET identity_status = 'verified'
       WHERE id = ANY($1::bigint[])
         AND identity_status IS DISTINCT FROM 'verified'
       RETURNING id`,
      [narratorIds],
    );

    const holdIds = holdAssessmentIds.length ? holdAssessmentIds : [-1];
    const assessRes = await client.query<{ id: number }>(
      `UPDATE public.narrator_assessments
       SET verified = true
       WHERE narrator_id = ANY($1::bigint[])
         AND mapping_method = 'sunnah_com_import'
         AND verified IS DISTINCT FROM true
         AND NOT (id = ANY($2::bigint[]))
       RETURNING id`,
      [narratorIds, holdIds],
    );

    // Count hold rows that would have been candidates but were skipped
    const heldRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM public.narrator_assessments
       WHERE narrator_id = ANY($1::bigint[])
         AND mapping_method = 'sunnah_com_import'
         AND id = ANY($2::bigint[])`,
      [narratorIds, holdIds],
    );

    await client.query("COMMIT");

    return {
      variationsUpdated: varRes.rowCount ?? varRes.rows.length,
      chainsUpdated: chainRes.rowCount ?? chainRes.rows.length,
      narratorsUpdated: narrUpd.rowCount ?? narrUpd.rows.length,
      assessmentsUpdated: assessRes.rowCount ?? assessRes.rows.length,
      narratorIds,
      assessmentIds: assessRes.rows.map((r) => Number(r.id)),
      heldSkipped: Number(heldRes.rows[0]?.count ?? 0),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

async function maybeRedeploy() {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL?.trim();
  if (!hook) {
    console.log(
      'Deploy hook not set: push to git or redeploy from the Vercel dashboard.',
    );
    return;
  }
  const res = await fetch(hook, { method: "POST" });
  console.log(`Deploy hook response status: ${res.status}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const allowlist = loadAllowlist();
  const hold = loadHold();
  const supabase = adminClient();

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Cluster: ${allowlist.cluster}`);
  console.log(`Allowlisted variation_ids: ${allowlist.variation_ids.join(", ")}`);
  console.log(`Hold assessments entries: ${(hold.assessments ?? []).length}`);

  const { ids: holdIds, details: holdDetails } = await resolveHoldAssessmentIds(supabase, hold);
  if (holdDetails.length) {
    console.log("\nHold rows:");
    for (const line of holdDetails) console.log(`  ${line}`);
  }

  const reports: VariationReport[] = [];
  for (const id of allowlist.variation_ids) {
    reports.push(await inspectVariation(supabase, id));
  }

  for (const report of reports) printReport(report);

  const failed = reports.filter((r) => !r.pass);
  console.log("\n========== SUMMARY ==========");
  console.log(`Variations checked: ${reports.length}`);
  console.log(`PASS: ${reports.length - failed.length}`);
  console.log(`FAIL: ${failed.length}`);

  if (failed.length) {
    console.log("\nRefusing to publish: one or more allowlisted variations failed checks.");
    process.exitCode = 1;
    return;
  }

  // Collect scope for rollback SQL preview (dry-run and apply)
  const allNarratorIds = [
    ...new Set(reports.flatMap((r) => r.narrators.map((n) => n.narratorId))),
  ].sort((a, b) => a - b);
  const variationIds = allowlist.variation_ids;

  const rollbackSql = [
    `-- Rollback First Wahi publish (allowlist ${variationIds.join(",")})`,
    `UPDATE public.source_variations SET verified = false WHERE id IN (${variationIds.join(", ")});`,
    `UPDATE public.chains SET verified = false WHERE variation_id IN (${variationIds.join(", ")});`,
    `UPDATE public.narrators SET identity_status = 'unverified' WHERE id IN (${allNarratorIds.join(", ")});`,
    `UPDATE public.narrator_assessments SET verified = false`,
    `  WHERE narrator_id IN (${allNarratorIds.join(", ")})`,
    `    AND mapping_method = 'sunnah_com_import'`,
    holdIds.length
      ? `    AND id NOT IN (${holdIds.join(", ")}); -- hold rows were never flipped`
      : `    ;`,
  ].join("\n");

  if (!apply) {
    console.log("\nAll variations PASS. Dry-run only — no database writes.");
    console.log("To publish:");
    console.log("  npm run hadith:publish-first-wahi:apply");
    console.log("\n=== Proposed ROLLBACK SQL (after apply) ===");
    console.log(rollbackSql);
    return;
  }

  console.log("\nAll variations PASS. Applying in one transaction…");
  const result = await applyPublish(variationIds, holdIds);

  console.log("\n=== Rows changed ===");
  console.log(`  source_variations.verified=true: ${result.variationsUpdated}`);
  console.log(`  chains.verified=true: ${result.chainsUpdated}`);
  console.log(`  narrators.identity_status='verified': ${result.narratorsUpdated}`);
  console.log(`  narrator_assessments.verified=true (sunnah_com_import): ${result.assessmentsUpdated}`);
  console.log(`  hold rows skipped (left unverified): ${result.heldSkipped}`);

  console.log("\n=== ROLLBACK SQL ===");
  console.log(rollbackSql);

  console.log("");
  await maybeRedeploy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
