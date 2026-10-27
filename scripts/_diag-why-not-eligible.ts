import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const cited = new Set<number>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("narrator_assessments")
      .select("narrator_id,source_url,reference_book,page")
      .eq("verified", true)
      .range(from, from + 999);
    if (!data?.length) break;
    for (const a of data) {
      if (a.source_url?.trim() || (a.reference_book?.trim() && a.page?.trim())) {
        cited.add(a.narrator_id);
      }
    }
    if (data.length < 1000) break;
  }

  type VarRow = {
    id: number;
    hadith_number: string | null;
    source_url: string | null;
    hadith_id: number | null;
    books: { title?: string } | { title?: string }[] | null;
    chains: {
      id: number;
      verified: boolean;
      chain_narrators: { narrator_id: number | null }[];
    }[];
  };

  const variations: VarRow[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await sb
      .from("source_variations")
      .select(
        `id,hadith_number,source_url,hadith_id,books!source_variations_book_id_fkey(title),chains(id,verified,chain_narrators(narrator_id))`
      )
      .not("hadith_number", "is", null)
      .range(from, from + 199);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data as VarRow[]) {
      const book = Array.isArray(row.books) ? row.books[0] : row.books;
      const title = (book?.title || "").toLowerCase();
      const src = row.source_url || "";
      if (!/bukhari|البخاري/.test(title) && !/bukhari/i.test(src)) continue;
      variations.push(row);
    }
    if (data.length < 200) break;
  }

  const narrToSunnah = new Map<number, string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("name_aliases")
      .select("alias,entity_id")
      .eq("entity_type", "narrator")
      .ilike("alias", "sunnah:%")
      .range(from, from + 999);
    if (!data?.length) break;
    for (const r of data) {
      const m = String(r.alias).match(/^sunnah:(\d+)$/i);
      if (m) narrToSunnah.set(Number(r.entity_id), m[1]);
    }
    if (data.length < 1000) break;
  }

  let needIsnad = 0;
  let needAppraisals = 0;
  let readyToVerify = 0;
  let alreadyVerifiedMulti = 0;
  const uncited = new Set<number>();
  const sunnahNeeded = new Set<string>();
  const candidates: number[] = [];

  for (const v of variations) {
    let maxNodes = 0;
    let bestAllCited = false;
    let bestVerified = false;
    for (const c of v.chains || []) {
      const nodes = (c.chain_narrators || []).filter((n) => n.narrator_id != null);
      if (nodes.length > maxNodes) maxNodes = nodes.length;
      if (nodes.length < 2) continue;
      const allCited = nodes.every((n) => cited.has(n.narrator_id as number));
      if (allCited) {
        bestAllCited = true;
        if (c.verified) bestVerified = true;
      }
      for (const n of nodes) {
        if (!cited.has(n.narrator_id as number)) {
          uncited.add(n.narrator_id as number);
          const sid = narrToSunnah.get(n.narrator_id as number);
          if (sid) sunnahNeeded.add(sid);
        }
      }
    }
    if (maxNodes < 2) {
      needIsnad++;
      candidates.push(v.id);
    } else if (!bestAllCited) {
      needAppraisals++;
      candidates.push(v.id);
    } else if (!bestVerified) {
      readyToVerify++;
      candidates.push(v.id);
    } else {
      alreadyVerifiedMulti++;
    }
  }

  console.log(
    JSON.stringify(
      {
        bukhari_variations: variations.length,
        needIsnadScrape: needIsnad,
        needAppraisalsOnChain: needAppraisals,
        readyToVerify,
        alreadyVerifiedMulti,
        pipelineCandidates: candidates.length,
        uncitedNarrators: uncited.size,
        uncitedWithSunnahAlias: sunnahNeeded.size,
        citedNarratorsTotal: cited.size,
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
