import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const { data: vars } = await sb
    .from("source_variations")
    .select("id")
    .ilike("source_url", "%sunnah.com%")
    .limit(20);

  for (const v of vars || []) {
    const { data: chs } = await sb
      .from("chains")
      .select("id,verified,raw_chain_text,chain_narrators(position,narrator_id,raw_name)")
      .eq("variation_id", v.id);
    const c = chs?.[0] as any;
    console.log(
      JSON.stringify({
        vid: v.id,
        chain: c
          ? {
              verified: c.verified,
              raw: (c.raw_chain_text || "").slice(0, 100),
              nodes: (c.chain_narrators || [])
                .sort((a: any, b: any) => a.position - b.position)
                .map((n: any) => ({
                  p: n.position,
                  nid: n.narrator_id,
                  raw: (n.raw_name || "").slice(0, 60),
                  ar: /[\u0600-\u06FF]/.test(n.raw_name || ""),
                })),
            }
          : null,
      })
    );
  }

  // counts
  let withArabicNodes = 0;
  let withAnyNodes = 0;
  let emptyNodes = 0;
  for (let from = 0; ; from += 200) {
    const { data } = await sb
      .from("source_variations")
      .select("id")
      .ilike("source_url", "%sunnah.com%")
      .range(from, from + 199);
    if (!data?.length) break;
    const { data: chs } = await sb
      .from("chains")
      .select("id,chain_narrators(raw_name)")
      .in(
        "variation_id",
        data.map((d) => d.id)
      );
    for (const c of chs || []) {
      const nodes = (c as any).chain_narrators || [];
      if (!nodes.length) emptyNodes++;
      else {
        withAnyNodes++;
        if (nodes.some((n: any) => /[\u0600-\u06FF]/.test(n.raw_name || ""))) withArabicNodes++;
      }
    }
    if (data.length < 200) break;
  }
  console.log({ withArabicNodes, withAnyNodes, emptyNodes });
}

main().catch(console.error);
