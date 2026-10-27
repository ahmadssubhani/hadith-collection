import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { count: qCount, error: qErr } = await sb
    .from("narrator_boilerplate_quarantine_017")
    .select("*", { count: "exact", head: true });
  console.log("quarantine_017:", qErr?.message ?? `rows=${qCount}`);

  const { count: dcl, error: dErr } = await sb
    .from("data_change_log")
    .select("*", { count: "exact", head: true });
  console.log("data_change_log:", dErr?.message ?? `rows=${dcl}`);

  const { data: n764 } = await sb
    .from("narrators")
    .select("id,biography,death_year_ah,generation,identity_status")
    .eq("id", 764)
    .maybeSingle();
  console.log("narrator 764:", n764);

  const { count: still } = await sb
    .from("narrators")
    .select("*", { count: "exact", head: true })
    .eq(
      "biography",
      "Transmitter recorded in early Hadith chains. Verified in classical Rijal registries."
    );
  console.log("still exact boilerplate bio:", still);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
