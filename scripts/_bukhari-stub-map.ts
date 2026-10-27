import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data: books } = await sb.from("books").select("id,title").order("id");
  const stubs = (books ?? []).filter((b) => /^Sahih al-Bukhari \d/i.test(b.title));
  for (const b of stubs) {
    const m = b.title.match(/Sahih al-Bukhari\s+([\d,\s]+)/i);
    const nums = (m?.[1] ?? "").split(/[,\s]+/).filter(Boolean);
    const { count } = await sb
      .from("source_variations")
      .select("*", { count: "exact", head: true })
      .eq("book_id", b.id);
    console.log(JSON.stringify({ id: b.id, title: b.title, extracted_numbers: nums, variation_count: count }));
  }
}
main();
