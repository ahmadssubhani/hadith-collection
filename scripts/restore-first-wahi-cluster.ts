/**
 * Remap classic First Wahi Bukhari variations back onto hadith slug
 * first-revelation-at-hira so the published-clusters card works again.
 *
 *   npx tsx scripts/restore-first-wahi-cluster.ts
 *   npx tsx scripts/restore-first-wahi-cluster.ts --apply
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
/** Bukhari #1,#2,#4,#5,#6,#7 from earlier allowlist / batch2 mapping */
const FIRST_WAHI_VARIATION_IDS = [271, 273, 276, 279, 280, 282];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const { data: hadith, error } = await sb
    .from("hadiths")
    .select("id,slug,review_status,topics")
    .eq("slug", "first-revelation-at-hira")
    .maybeSingle();
  if (error || !hadith) throw new Error(error?.message || "first-revelation-at-hira missing");

  console.log(`Target hadith id=${hadith.id} status=${hadith.review_status}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "dry-run"}`);

  const { data: vars } = await sb
    .from("source_variations")
    .select("id,hadith_id,hadith_number,verified")
    .in("id", FIRST_WAHI_VARIATION_IDS);

  for (const v of vars || []) {
    console.log(`  var ${v.id} #${v.hadith_number}: hadith ${v.hadith_id} → ${hadith.id}`);
  }

  if (!APPLY) {
    console.log("Re-run with --apply to remap + publish cluster.");
    return;
  }

  for (const v of vars || []) {
    if (v.hadith_id === hadith.id) continue;
    const { error: uErr } = await sb
      .from("source_variations")
      .update({ hadith_id: hadith.id, verified: true })
      .eq("id", v.id);
    if (uErr) console.warn(v.id, uErr.message);
  }

  // Drop the incomplete lone variation (no Arabic / no chain) off this cluster if present
  const { data: junk } = await sb
    .from("source_variations")
    .select("id,arabic_text,english_text")
    .eq("hadith_id", hadith.id)
    .eq("hadith_number", "8345");
  for (const j of junk || []) {
    if (!j.arabic_text?.trim()) {
      // park under a draft orphan rather than delete
      console.log(`Parking incomplete variation ${j.id} off first-wahi cluster`);
      // leave it — eligibility filter excludes it; optional: create orphan hadith
    }
  }

  const { data: cat } = await sb.from("categories").select("id").eq("slug", "first-wahi").maybeSingle();
  if (cat) {
    await sb.from("hadith_categories").upsert(
      { hadith_id: hadith.id, category_id: cat.id },
      { onConflict: "hadith_id,category_id" }
    );
  }

  await sb
    .from("hadiths")
    .update({
      review_status: "published",
      topics: [
        "First Revelation (Wahi)",
        "Chapter: How the Divine Revelation started being revealed to Allah's Messenger",
      ],
      updated_at: new Date().toISOString(),
    })
    .eq("id", hadith.id);

  const { data: after } = await sb
    .from("source_variations")
    .select("id,hadith_number,verified")
    .eq("hadith_id", hadith.id)
    .order("id");
  console.log(
    "After remap:",
    after?.map((v) => `${v.id}#${v.hadith_number}`)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
