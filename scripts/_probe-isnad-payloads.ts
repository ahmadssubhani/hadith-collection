import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url!, key, { auth: { persistSession: false } });

  for (const batchId of [2, 3, 5, 6]) {
    const { data } = await sb
      .from("raw_import_records")
      .select("id,batch_id,raw_payload")
      .eq("batch_id", batchId)
      .limit(2);
    for (const r of data ?? []) {
      const p = r.raw_payload as any;
      console.log("\nbatch", batchId, "id", r.id);
      console.log("keys", Object.keys(p ?? {}));
      console.log("narrator:", String(p?.narrator ?? p?.isnad ?? p?.chain ?? "").slice(0, 300));
      console.log("english:", String(p?.english ?? "").slice(0, 200));
    }
  }

  // Also chains that look English-noisy
  const { data: noisy } = await sb
    .from("chains")
    .select("id,raw_chain_text")
    .or("raw_chain_text.ilike.%quoted%,raw_chain_text.ilike.%narrated%,raw_chain_text.ilike.%Hadith.%")
    .limit(10);
  console.log("\nnoisy chains", noisy?.length);
  for (const c of noisy ?? []) {
    console.log(c.id, (c.raw_chain_text ?? "").slice(0, 180));
  }
}

main().catch(console.error);
