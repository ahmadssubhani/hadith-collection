import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  for (const t of ["categories", "name_aliases", "books"]) {
    const { data, error, status, statusText } = await sb.from(t).select("id").limit(1);
    console.log(JSON.stringify({ t, status, statusText, data, error }, null, 2));
  }
  // OpenAPI / schema via rpc if any
  const { data: rpcErr, error: e2 } = await sb.rpc("get_hadith_full", { query: "test" });
  console.log("get_hadith_full", e2 ? e2.message : rpcErr);

  // variation distribution by hadith
  const { data: vars } = await sb.from("source_variations").select("hadith_id").limit(5000);
  const byH = new Map<number, number>();
  for (const v of vars ?? []) byH.set(v.hadith_id, (byH.get(v.hadith_id) ?? 0) + 1);
  console.log("vars by hadith_id:", Object.fromEntries(byH));

  // transmission_word fill
  const { count: twNull } = await sb
    .from("chain_narrators")
    .select("*", { count: "exact", head: true })
    .is("transmission_word", null);
  const { count: twTotal } = await sb.from("chain_narrators").select("*", { count: "exact", head: true });
  console.log("chain_narrators transmission_word null:", twNull, "/", twTotal);

  // scholar mislabels
  const { data: scholars } = await sb.from("scholars").select("id,name,tradition").order("id").limit(20);
  console.log("first scholars:", scholars);

  // hadith assessments sample
  const { data: ha } = await sb
    .from("hadith_assessments")
    .select("id,variation_id,original_grade,normalized_grade,scholar_id,verified")
    .limit(10);
  console.log("hadith_assessments sample:", ha);

  // books with thaqalayn-ish
  const { data: shiaish } = await sb
    .from("books")
    .select("id,title,author,tradition")
    .or(
      "title.ilike.%kafi%,title.ilike.%kāfi%,title.ilike.%amali%,title.ilike.%amālī%,title.ilike.%ghayba%,title.ilike.%faqih%,title.ilike.%faqīh%,title.ilike.%khisal%,title.ilike.%khiṣāl%,title.ilike.%fada%,title.ilike.%faḍa%,title.ilike.%ziyarat%,title.ilike.%ziyārāt%,title.ilike.%uyun%,title.ilike.%ʿuyūn%,title.ilike.%maani%,title.ilike.%maʿānī%,title.ilike.%mumin%,title.ilike.%muʾmin%"
    );
  console.log("shia-titled books:", shiaish);
}
main();
