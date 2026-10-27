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
    return max <= 1 && !fw && v.hadith_number;
  });

  const byBook = new Map<string, number>();
  const urlPatterns = new Map<string, number>();
  for (const v of stubs) {
    const book = v.books?.title || "unknown";
    byBook.set(book, (byBook.get(book) || 0) + 1);
    const u = v.source_url || "";
    let pat = "none";
    const m = u.match(/sunnah\.com\/([a-z0-9]+)[:/]/i);
    if (m) pat = m[1].toLowerCase();
    else if (/sunnah\.com/i.test(u)) pat = "sunnah-other";
    urlPatterns.set(pat, (urlPatterns.get(pat) || 0) + 1);
  }
  console.log(
    JSON.stringify(
      {
        stubs: stubs.length,
        by_book: Object.fromEntries([...byBook.entries()].sort((a, b) => b[1] - a[1])),
        by_url_collection: Object.fromEntries([...urlPatterns.entries()].sort((a, b) => b[1] - a[1])),
        sample: stubs.slice(0, 8).map((v) => ({
          id: v.id,
          n: v.hadith_number,
          book: v.books?.title,
          url: v.source_url,
        })),
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
