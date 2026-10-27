import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  // variations on sunnah
  const sunnahVars: { id: number; hadith_number: string | null; source_url: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("source_variations")
      .select("id,hadith_number,source_url")
      .ilike("source_url", "%sunnah.com%")
      .range(from, from + 999);
    if (!data?.length) break;
    sunnahVars.push(...(data as any));
    if (data.length < 1000) break;
  }
  const sunnahVarIds = new Set(sunnahVars.map((v) => v.id));

  const { data: chains } = await sb
    .from("chains")
    .select("id,variation_id,verified")
    .in(
      "variation_id",
      [...sunnahVarIds].slice(0, 500)
    );

  // supabase in() limit — paginate
  let verifiedSunnahChains = 0;
  let nodesNeed = 0;
  const sample: any[] = [];

  for (let i = 0; i < sunnahVars.length; i += 100) {
    const chunk = sunnahVars.slice(i, i + 100).map((v) => v.id);
    const { data: chs } = await sb
      .from("chains")
      .select("id,variation_id,verified,chain_narrators(narrator_id,raw_name,position)")
      .in("variation_id", chunk);
    for (const c of chs || []) {
      if (!c.verified) continue;
      verifiedSunnahChains++;
      for (const n of (c as any).chain_narrators || []) {
        if (n.narrator_id) {
          nodesNeed++;
          if (sample.length < 15) sample.push({ vid: c.variation_id, ...n });
        }
      }
    }
  }

  // how many of these narrator_ids lack assessments
  const { data: assess } = await sb
    .from("narrator_assessments")
    .select("narrator_id")
    .eq("verified", true);
  const cited = new Set((assess || []).map((a) => a.narrator_id));
  const needIds = new Set(sample.map((s) => s.narrator_id).filter((id) => !cited.has(id)));

  console.log(
    JSON.stringify(
      {
        sunnah_variations: sunnahVars.length,
        verified_sunnah_chains_approx: verifiedSunnahChains,
        sample_nodes: sample,
        sample_needing_assess: [...needIds],
      },
      null,
      2
    )
  );
}

main().catch(console.error);
