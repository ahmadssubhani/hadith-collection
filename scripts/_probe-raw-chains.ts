import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing env");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { count: rawCount } = await sb.from("raw_import_records").select("*", { count: "exact", head: true });
  console.log("raw_import_records", rawCount);

  const { data: raw } = await sb
    .from("raw_import_records")
    .select("id,batch_id,external_id,raw_payload")
    .limit(5);
  for (const r of raw ?? []) {
    const p = r.raw_payload as Record<string, unknown>;
    console.log("--- raw", r.id, "batch", r.batch_id, "keys", Object.keys(p ?? {}));
    console.log(JSON.stringify(p, null, 2).slice(0, 800));
  }

  const { data: chains } = await sb
    .from("chains")
    .select("id,variation_id,raw_chain_text,chain_narrators(id,position,raw_name)")
    .not("raw_chain_text", "is", null)
    .limit(5);
  console.log("chains with text", (chains ?? []).length);
  for (const c of chains ?? []) {
    console.log("--- chain", c.id, (c.raw_chain_text ?? "").slice(0, 200));
    console.log("nodes", (c as any).chain_narrators);
  }

  const { count: nCount } = await sb.from("narrators").select("*", { count: "exact", head: true });
  const { data: nSample } = await sb.from("narrators").select("id,name,arabic_name,identity_status").limit(8);
  console.log("narrators", nCount, nSample);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
