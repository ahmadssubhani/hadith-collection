import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { getEligibleVariations } from "../lib/eligible-variations";
import { evaluateVariationEligibility } from "../lib/first-wahi-eligibility";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const soft = await getEligibleVariations({ client: sb, publishedOnly: false, minChainNodes: 1 });
  const full = await getEligibleVariations({ client: sb, publishedOnly: false, minChainNodes: 2 });

  let stub = 0;
  let multiSoft = 0;
  let fw = 0;
  const softNotFull: { id: number; n: string | null; nodes: number; reasons: string[] }[] = [];

  for (const v of soft.variations) {
    const max = Math.max(0, ...v.eligibleChains.map((c) => c.nodes.length));
    const isFw =
      v.hadith?.slug === "first-revelation-at-hira" ||
      (v.hadith?.topics || []).some((t) => /first.?wahi/i.test(t));
    if (isFw) fw++;
    if (max <= 1) stub++;
    else multiSoft++;

    const inFull = full.variations.some((f) => f.id === v.id);
    if (!inFull && max >= 2) {
      // re-eval with min 2 for failure reasons
      const ev = evaluateVariationEligibility(v as never, { minChainNodes: 2 });
      softNotFull.push({
        id: v.id,
        n: v.hadith_number,
        nodes: max,
        reasons: ev.failures?.slice(0, 4) || [ev.summary || "unknown"],
      });
    }
  }

  // Also: variations that are NOT soft-eligible but have multi-node unverified chains
  // Sample bukhari variations with hadith_number that fail soft
  const { count: varCount } = await sb
    .from("source_variations")
    .select("id", { count: "exact", head: true })
    .not("hadith_number", "is", null);

  // Count chains with >=2 nodes but unverified
  const { data: multiChains } = await sb
    .from("chains")
    .select("id,verified,variation_id,chain_narrators(narrator_id)")
    .limit(5000);

  let multiNodeChains = 0;
  let multiVerified = 0;
  let multiUnverified = 0;
  const varMulti = new Set<number>();
  for (const c of multiChains || []) {
    const nodes = (c as { chain_narrators?: unknown[] }).chain_narrators || [];
    if (nodes.length < 2) continue;
    multiNodeChains++;
    varMulti.add(c.variation_id);
    if (c.verified) multiVerified++;
    else multiUnverified++;
  }

  console.log(
    JSON.stringify(
      {
        softEligible: soft.variations.length,
        fullIsnadEligible: full.variations.length,
        soft_stub_nodes1: stub,
        soft_multi_nodes2plus: multiSoft,
        soft_first_wahi: fw,
        softMultiNotFullIsnad: softNotFull.length,
        softMultiNotFull_sample: softNotFull.slice(0, 12),
        sourceVariationsWithNumber: varCount,
        sampledChains: (multiChains || []).length,
        multiNodeChains,
        multiVerified,
        multiUnverified,
        variationsWithMultiNodeChain: varMulti.size,
        fullPublished: full.variations.filter((v) => v.hadith?.review_status === "published").length,
        softPublished: soft.variations.filter((v) => v.hadith?.review_status === "published").length,
      },
      null,
      2
    )
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
