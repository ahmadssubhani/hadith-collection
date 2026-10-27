import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  for (const hid of [1, 2, 3, 4, 5]) {
    const { count } = await sb
      .from("source_variations")
      .select("*", { count: "exact", head: true })
      .eq("hadith_id", hid);
    console.log(`hadith ${hid} variations:`, count);
  }
  const { count: noChain } = await sb.from("chains").select("*", { count: "exact", head: true });
  console.log("chains total", noChain);

  // book_type distinct
  const { data: books } = await sb.from("books").select("id,title,author,tradition,book_type,arabic_title").range(0, 199);
  const types = new Map<string, number>();
  for (const b of books ?? []) types.set(b.book_type ?? "(null)", (types.get(b.book_type ?? "(null)") ?? 0) + 1);
  console.log("book_types", Object.fromEntries(types));
  console.log("fetched books", books?.length);

  // attribution vs real
  let attr = 0,
    bukhariNum = 0,
    realish = 0;
  for (const b of books ?? []) {
    const t = b.title;
    if (/^Narrated by /i.test(t) || /Agreed upon/i.test(t) || t.includes(" - Narrated")) attr++;
    else if (/Sahih al-Bukhari \d/i.test(t)) bukhariNum++;
    else realish++;
  }
  console.log({ attr, bukhariNum, realish });

  // generation buckets for narrators
  const gens = ["Sahabi", "Tabi'i", "Tabi al-Tabi'in", "Companion", "تابعي", "صحابي"];
  for (const g of gens) {
    const { count } = await sb.from("narrators").select("*", { count: "exact", head: true }).ilike("generation", `%${g}%`);
    console.log("generation~", g, count);
  }
  const { count: genNull } = await sb.from("narrators").select("*", { count: "exact", head: true }).is("generation", null);
  console.log("generation null", genNull);

  // alternative_names empty
  const { data: narrSample } = await sb.from("narrators").select("id,alternative_names").limit(1000);
  const emptyAlias = (narrSample ?? []).filter((n) => !n.alternative_names || n.alternative_names.length === 0).length;
  console.log("empty alternative_names in first 1000:", emptyAlias);

  // chains continuity
  for (const s of ["unverified", "muttasil", "mursal", "munqati", "muallaq", "connected", "broken"]) {
    const { count } = await sb.from("chains").select("*", { count: "exact", head: true }).eq("continuity_status", s);
    if (count) console.log("continuity", s, count);
  }
  const { data: contSample } = await sb.from("chains").select("continuity_status").limit(1000);
  const cb = new Map<string, number>();
  for (const c of contSample ?? []) cb.set(c.continuity_status ?? "(null)", (cb.get(c.continuity_status ?? "(null)") ?? 0) + 1);
  console.log("continuity buckets (sample<=1000)", Object.fromEntries(cb));
}
main();
