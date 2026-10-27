import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const tables = [
    "categories",
    "hadith_categories",
    "topics",
    "hadith_topics",
    "name_aliases",
    "narrator_teachers",
    "narrator_students",
    "grade_lookup",
  ];
  for (const t of tables) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    console.log(t, error ? `MISSING: ${error.code} ${error.message}` : `EXISTS count=${count}`);
  }
  const cols = ["arabic_search_text", "tradition", "kunya", "normalized_name"];
  for (const c of cols) {
    const { error } = await sb.from("source_variations").select(c).limit(1);
    console.log(`source_variations.${c}`, error ? `NO: ${error.message}` : "YES");
  }
  for (const c of ["kunya", "nisba", "gender", "tradition", "normalized_name"]) {
    const { error } = await sb.from("narrators").select(c).limit(1);
    console.log(`narrators.${c}`, error ? `NO: ${error.message}` : "YES");
  }
  for (const c of ["kunya", "laqab", "madhhab", "region", "normalized_name"]) {
    const { error } = await sb.from("scholars").select(c).limit(1);
    console.log(`scholars.${c}`, error ? `NO: ${error.message}` : "YES");
  }
  for (const c of ["publisher", "edition", "volumes", "hadith_count", "category"]) {
    const { error } = await sb.from("books").select(c).limit(1);
    console.log(`books.${c}`, error ? `NO: ${error.message}` : "YES");
  }
  // real-looking books (not attribution strings)
  const { data: books } = await sb.from("books").select("id,title,author,tradition,book_type").order("id").limit(120);
  const real = (books ?? []).filter((b) => !/^Narrated by /i.test(b.title) && !/Agreed upon/i.test(b.title) && !b.title.includes(" - Narrated"));
  console.log("\nNon-attribution books:", real.length);
  for (const b of real) console.log(`  ${b.id}|${b.tradition}|${b.book_type}|${b.author ?? "-"}|${b.title}`);
}
main();
