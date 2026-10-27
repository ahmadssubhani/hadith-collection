import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

function normalizeArabic(s: string) {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "");
}

function walk(dir: string, out: string[] = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.html?$/i.test(ent.name) && !/sunnah-narrator-/.test(ent.name)) out.push(p);
  }
  return out;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const linkNames = new Map<string, string>();
  for (const f of [...walk("data/raw"), ...walk("data/scraped")]) {
    const html = readFileSync(f, "utf8");
    const $ = cheerio.load(html);
    $("a[href*='/narrator/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/narrator\/(\d+)/);
      if (!m) return;
      const text = ($(el).text() || "").replace(/\s+/g, " ").trim();
      if (text) linkNames.set(m[1], text);
    });
  }

  const { data: vchains } = await sb.from("chains").select("id").eq("verified", true).limit(50);
  const ids = (vchains || []).map((c) => c.id);
  const { data: nodes } = await sb
    .from("chain_narrators")
    .select("narrator_id,raw_name,narrators(id,name,arabic_name)")
    .in("chain_id", ids)
    .not("narrator_id", "is", null)
    .limit(30);

  console.log("sample links", [...linkNames.entries()].slice(0, 8));
  console.log(
    "sample nodes",
    (nodes || []).map((n: any) => ({
      nid: n.narrator_id,
      raw: n.raw_name,
      ar: n.narrators?.arabic_name || n.narrators?.name,
      rawNorm: normalizeArabic(n.raw_name || ""),
    }))
  );

  // try match counts
  let hits = 0;
  for (const n of nodes || []) {
    const raw = normalizeArabic((n as any).raw_name || "");
    for (const [sid, text] of linkNames) {
      const nt = normalizeArabic(text);
      if (raw && nt && (raw.includes(nt) || nt.includes(raw) || raw === nt)) {
        hits++;
        console.log("HIT", { sid, text: text.slice(0, 40), raw: (n as any).raw_name?.slice(0, 40) });
        break;
      }
    }
  }
  console.log({ linkNames: linkNames.size, tried: nodes?.length, hits });
}

main().catch(console.error);
