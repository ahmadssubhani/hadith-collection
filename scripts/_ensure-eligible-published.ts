/**
 * Ensure every a–d eligible variation is verified + its hadith is published.
 * Uses lib/eligible-variations (same bar as EligibleFirstWahiVariation).
 *
 *   npx tsx scripts/_ensure-eligible-published.ts
 *   npx tsx scripts/_ensure-eligible-published.ts --apply
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { getEligibleVariations } from "../lib/eligible-variations";

const APPLY = process.argv.includes("--apply");

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const { variations, error } = await getEligibleVariations({
    client: sb,
    publishedOnly: false,
  });
  if (error) throw error;

  const varIds = variations.map((v) => v.id);
  const hadithIds = [...new Set(variations.map((v) => v.hadith_id))];

  // Remap Bukhari #3 onto first-wahi cluster if eligible elsewhere
  const { data: fw } = await sb
    .from("hadiths")
    .select("id")
    .eq("slug", "first-revelation-at-hira")
    .maybeSingle();
  const bukhari3 = variations.find((v) => v.hadith_number === "3" && v.books?.title?.includes("Bukhari"));
  if (fw && bukhari3 && bukhari3.hadith_id !== fw.id) {
    console.log(`Remap Bukhari #3 var=${bukhari3.id}: hadith ${bukhari3.hadith_id} → ${fw.id}`);
    if (APPLY) {
      await sb.from("source_variations").update({ hadith_id: fw.id, verified: true }).eq("id", bukhari3.id);
    }
  }

  let needVar = 0;
  let needHadith = 0;
  for (let i = 0; i < varIds.length; i += 100) {
    const chunk = varIds.slice(i, i + 100);
    const { data } = await sb.from("source_variations").select("id,verified,hadith_id").in("id", chunk);
    for (const v of data || []) if (!v.verified) needVar++;
  }
  for (let i = 0; i < hadithIds.length; i += 100) {
    const chunk = hadithIds.slice(i, i + 100);
    const { data } = await sb.from("hadiths").select("id,review_status").in("id", chunk);
    for (const h of data || []) if (h.review_status !== "published") needHadith++;
  }

  console.log({
    eligible_variations: varIds.length,
    eligible_hadiths: hadithIds.length,
    variations_needing_verified: needVar,
    hadiths_needing_published: needHadith,
    mode: APPLY ? "APPLY" : "dry-run",
  });

  if (!APPLY) {
    console.log("Re-run with --apply to publish.");
    return;
  }

  for (let i = 0; i < varIds.length; i += 80) {
    const chunk = varIds.slice(i, i + 80);
    await sb.from("source_variations").update({ verified: true }).in("id", chunk);
    await sb.from("chains").update({ verified: true }).in("variation_id", chunk);
  }

  // narrators on eligible chains
  const narrIds = new Set<number>();
  for (let i = 0; i < varIds.length; i += 80) {
    const chunk = varIds.slice(i, i + 80);
    const { data: chs } = await sb
      .from("chains")
      .select("chain_narrators(narrator_id)")
      .in("variation_id", chunk);
    for (const c of chs || []) {
      for (const n of (c as any).chain_narrators || []) {
        if (n.narrator_id != null) narrIds.add(n.narrator_id);
      }
    }
  }
  const narrList = [...narrIds];
  for (let i = 0; i < narrList.length; i += 80) {
    const chunk = narrList.slice(i, i + 80);
    await sb.from("narrators").update({ identity_status: "verified" }).in("id", chunk);
    await sb
      .from("narrator_assessments")
      .update({ verified: true })
      .in("narrator_id", chunk)
      .eq("mapping_method", "sunnah_com_import")
      .not("source_url", "is", null);
  }

  // include fw id after possible remap
  const publishHadithIds = [...new Set([...hadithIds, fw?.id].filter(Boolean))] as number[];
  for (let i = 0; i < publishHadithIds.length; i += 80) {
    const chunk = publishHadithIds.slice(i, i + 80);
    await sb
      .from("hadiths")
      .update({ review_status: "published", updated_at: new Date().toISOString() })
      .in("id", chunk);
  }

  if (fw) {
    const { data: cat } = await sb.from("categories").select("id").eq("slug", "first-wahi").maybeSingle();
    if (cat) {
      await sb.from("hadith_categories").upsert(
        { hadith_id: fw.id, category_id: cat.id },
        { onConflict: "hadith_id,category_id" }
      );
    }
    await sb
      .from("hadiths")
      .update({
        topics: [
          "First Revelation (Wahi)",
          "Chapter: How the Divine Revelation started being revealed to Allah's Messenger",
        ],
      })
      .eq("id", fw.id);
  }

  // recount
  const { variations: after } = await getEligibleVariations({ client: sb, publishedOnly: true });
  const { count: pub } = await sb
    .from("hadiths")
    .select("id", { count: "exact", head: true })
    .eq("review_status", "published");
  console.log({
    published_hadiths: pub,
    eligible_published_variations: after.length,
    eligible_published_hadiths: new Set(after.map((v) => v.hadith_id)).size,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
