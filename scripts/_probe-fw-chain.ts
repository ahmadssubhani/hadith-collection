import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: c } = await sb
    .from("chains")
    .select("id,verified,raw_chain_text,chain_narrators(position,narrator_id,raw_name)")
    .eq("variation_id", 271);
  console.log("FW chain:", JSON.stringify(c, null, 2));

  const { data: stub } = await sb
    .from("source_variations")
    .select("id,hadith_number,source_url,arabic_text,english_text")
    .eq("id", 860)
    .single();
  console.log("stub 860:", stub);

  const { data: aliases } = await sb
    .from("name_aliases")
    .select("alias,entity_id,source_name")
    .eq("entity_type", "narrator")
    .ilike("alias", "sunnah:%")
    .limit(15);
  console.log("sunnah aliases sample:", aliases);

  const { count } = await sb
    .from("name_aliases")
    .select("*", { count: "exact", head: true })
    .eq("entity_type", "narrator")
    .ilike("alias", "sunnah:%");
  console.log("sunnah: alias count:", count);

  // Parse cached bukhari 1 html for structure
  const htmlPath = path.join("data", "raw", "sunnah-bukhari-1.html");
  if (existsSync(htmlPath)) {
    const $ = cheerio.load(readFileSync(htmlPath, "utf8"));
    const sanad = $("span.arabic_sanad, .arabic_sanad").first();
    const links: string[] = [];
    sanad.find("a[href*='/narrator/']").each((_, el) => {
      links.push(`${$(el).attr("href")} | ${$(el).text().trim()} | ${$(el).attr("title")}`);
    });
    console.log("bukhari:1 sanad links:", links.length);
    console.log(links.slice(0, 12));
    console.log("sanad text sample:", sanad.text().slice(0, 200));
  }

  // How many stubs have hadith_number
  const { data: nums } = await sb
    .from("source_variations")
    .select("id,hadith_number")
    .eq("book_id", 1)
    .not("source_url", "is", null)
    .ilike("source_url", "%sunnah.com%")
    .limit(20);
  console.log("sample numbers:", nums?.map((r) => ({ id: r.id, n: r.hadith_number })));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
