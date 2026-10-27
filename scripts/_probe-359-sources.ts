import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { getEligibleVariations } from "../lib/eligible-variations";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const soft = await getEligibleVariations({ client: sb, publishedOnly: false, minChainNodes: 1 });
  const stubs = soft.variations.filter((v) => {
    const max = Math.max(0, ...v.eligibleChains.map((c) => c.nodes.length));
    const fw =
      v.hadith?.slug === "first-revelation-at-hira" ||
      (v.hadith?.topics || []).some((t) => /first.?wahi/i.test(t));
    return max <= 1 && !fw;
  });

  const hosts = new Map<string, number>();
  const books = new Map<string, number>();
  const withSunnahUrl: string[] = [];
  const sample: any[] = [];

  for (const v of stubs) {
    const u = v.source_url || "";
    let host = "none";
    try {
      host = u ? new URL(u).hostname : "none";
    } catch {
      host = "bad";
    }
    hosts.set(host, (hosts.get(host) || 0) + 1);
    const b = v.books?.title || "?";
    books.set(b, (books.get(b) || 0) + 1);
    if (/sunnah\.com/i.test(u)) withSunnahUrl.push(u);
    if (sample.length < 8) {
      sample.push({
        id: v.id,
        num: v.hadith_number,
        book: b,
        url: u,
        chapter: v.chapter,
        ar_len: (v.arabic_text || "").length,
        en_len: (v.english_text || "").length,
        chain_nodes: Math.max(0, ...v.eligibleChains.map((c) => c.nodes.length)),
      });
    }
  }

  // how many have raw_chain_text somewhere?
  const ids = stubs.map((v) => v.id);
  let withRawChain = 0;
  let multiNodeAlready = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data: chs } = await sb
      .from("chains")
      .select("id,variation_id,raw_chain_text,chain_narrators(id)")
      .in("variation_id", chunk);
    for (const c of chs || []) {
      if ((c.raw_chain_text || "").trim().length > 20) withRawChain++;
      if ((c.chain_narrators || []).length > 1) multiNodeAlready++;
    }
  }

  console.log(
    JSON.stringify(
      {
        stub_count: stubs.length,
        hosts: Object.fromEntries(hosts),
        books: Object.fromEntries([...books.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
        sunnah_urls: withSunnahUrl.length,
        sample_urls: withSunnahUrl.slice(0, 5),
        chains_with_raw_text_rows: withRawChain,
        chains_already_multi_node: multiNodeAlready,
        sample,
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
