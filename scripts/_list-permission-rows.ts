import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function fetchAll(table: string, select: string) {
  const page = 1000;
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from(table).select(select).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

async function main() {
  const batches = await fetchAll(
    "import_batches",
    "id,provider,source_url,permission_status,notes,retrieved_at"
  );
  const vars = await fetchAll(
    "source_variations",
    "id,hadith_id,book_id,hadith_number,source_url,verified,review_status,data_origin"
  );
  const assessments = await fetchAll(
    "hadith_assessments",
    "id,variation_id,scholar_id,original_grade,source_url,verified"
  );

  const byHost = (host: string) => vars.filter((v) => (v.source_url || "").includes(host));
  const dorar = byHost("dorar.net");
  const sunnah = byHost("sunnah.com");
  const he = byHost("hadeethenc.com");
  const thaq = vars.filter((v) => /thaqalayn/i.test(v.source_url || ""));

  const dorarIds = new Set(dorar.map((v) => v.id));
  const haOnDorar = assessments.filter((a) => dorarIds.has(a.variation_id));

  const report = {
    batches,
    counts: {
      dorar_variations: dorar.length,
      sunnah_variations: sunnah.length,
      hadeethenc_variations: he.length,
      thaqalayn_variations: thaq.length,
      dorar_hadith_assessments: haOnDorar.length,
    },
    dorar_variations: dorar,
    dorar_hadith_assessments: haOnDorar,
  };

  mkdirSync("data/unmatched", { recursive: true });
  writeFileSync(path.join("data", "unmatched", "needs-permission-rows.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.counts, null, 2));
  console.log("batches:", batches.length);
  console.log("Wrote data/unmatched/needs-permission-rows.json");
  console.log("\nDorar variations:");
  for (const v of dorar) {
    console.log(
      `  var=${v.id} hadith=${v.hadith_id} book=${v.book_id} num=${v.hadith_number} verified=${v.verified} review=${v.review_status} url=${v.source_url}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
