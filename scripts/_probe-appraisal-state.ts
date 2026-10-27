import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { readdirSync } from "node:fs";
import path from "node:path";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const { count: total } = await sb.from("narrator_assessments").select("*", { count: "exact", head: true });
  const { count: sunnahMethod } = await sb
    .from("narrator_assessments")
    .select("*", { count: "exact", head: true })
    .eq("mapping_method", "sunnah_com_import");
  const { count: sunnahVerified } = await sb
    .from("narrator_assessments")
    .select("*", { count: "exact", head: true })
    .eq("mapping_method", "sunnah_com_import")
    .eq("verified", true);
  const { count: withUrl } = await sb
    .from("narrator_assessments")
    .select("*", { count: "exact", head: true })
    .not("source_url", "is", null)
    .neq("source_url", "");

  const { data: mubarak } = await sb
    .from("narrators")
    .select("id,slug,name")
    .ilike("slug", "%mubarak%")
    .limit(5);

  // Distinct narrator_ids with cited verified assessments
  const { data: cited } = await sb
    .from("narrator_assessments")
    .select("narrator_id,verified,source_url,reference_book,page")
    .eq("verified", true)
    .limit(5000);

  const citedSet = new Set<number>();
  for (const a of cited || []) {
    if (a.source_url?.trim() || (a.reference_book?.trim() && a.page?.trim())) {
      citedSet.add(a.narrator_id);
    }
  }

  const rawFiles = readdirSync(path.join("data", "raw")).filter((f) =>
    /^sunnah-narrator-\d+\.html$/.test(f)
  );

  console.log(
    JSON.stringify(
      {
        assessments_total: total,
        sunnah_com_import: sunnahMethod,
        sunnah_com_import_verified: sunnahVerified,
        with_source_url: withUrl,
        narrators_with_cited_verified: citedSet.size,
        mubarak,
        raw_html_files: rawFiles.length,
        raw_ids: rawFiles.map((f) => f.replace(/\D/g, "")),
      },
      null,
      2
    )
  );
}

main().catch(console.error);
