/**
 * Write docs/db-gaps.md from live counts (service role).
 *   npx tsx scripts/collectors/report-gaps.ts
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

async function count(
  sb: ReturnType<typeof createClient>,
  table: string,
  filter?: (q: any) => any
): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function fetchAllIds(sb: ReturnType<typeof createClient>, table: string, select: string) {
  const page = 1000;
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from(table).select(select).range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const narrators = await count(sb, "narrators");
  const assessedIds = new Set(
    (await fetchAllIds(sb, "narrator_assessments", "narrator_id")).map((r) => r.narrator_id)
  );
  const narratorsNoRuling = narrators - assessedIds.size;

  const chains = await fetchAllIds(sb, "chains", "id");
  const caIds = new Set(
    (await fetchAllIds(sb, "chain_assessments", "chain_id")).map((r) => r.chain_id)
  );
  const chainsNoAssessment = chains.filter((c) => !caIds.has(c.id)).length;

  const hadiths = await fetchAllIds(sb, "hadiths", "id");
  let hadithCats: any[] = [];
  try {
    hadithCats = await fetchAllIds(sb, "hadith_categories", "hadith_id");
  } catch {
    hadithCats = [];
  }
  const withCat = new Set(hadithCats.map((r) => r.hadith_id));
  const hadithsNoCategory = hadiths.filter((h) => !withCat.has(h.id)).length;

  const books = await fetchAllIds(sb, "books", "id,tradition,book_kind,title");
  const booksNoTradition = books.filter(
    (b) => !b.tradition || b.tradition === "unclassified"
  ).length;

  const cn = await fetchAllIds(sb, "chain_narrators", "chain_id");
  const nodes = new Map<number, number>();
  for (const r of cn) nodes.set(r.chain_id, (nodes.get(r.chain_id) ?? 0) + 1);
  const chainsNoNodes = chains.filter((c) => !nodes.has(c.id)).length;

  const vars = await fetchAllIds(sb, "source_variations", "id");
  const varsWithChain = new Set(
    (await fetchAllIds(sb, "chains", "variation_id")).map((c) => c.variation_id)
  );
  const varsNoChain = vars.filter((v) => !varsWithChain.has(v.id)).length;

  const scholarsNull = await count(sb, "scholars", (q) => q.is("tradition", null));
  const vba = await count(sb, "variation_book_attributions").catch(() => -1);

  const md = `# Database gaps

Generated: ${new Date().toISOString()}  
Project: ggmqufghubpgsquldjdx

## Priority gaps

| Gap | Count |
|-----|------:|
| Narrators with no jarh wa taʿdīl ruling | **${narratorsNoRuling}** / ${narrators} |
| Chains with no assessment | **${chainsNoAssessment}** / ${chains.length} |
| Hadiths with no category (M2M) | **${hadithsNoCategory}** / ${hadiths.length} |
| Books with no / unclassified tradition | **${booksNoTradition}** / ${books.length} |

## Structural gaps (collectors C)

| Gap | Count |
|-----|------:|
| Chains with zero nodes | ${chainsNoNodes} |
| Variations with no chain | ${varsNoChain} |
| Scholars with null tradition | ${scholarsNull} |
| variation_book_attributions rows | ${vba} |

## How to shrink gaps

\`\`\`bash
# After placing sourced CSVs under data/collectors/
npm run collect:rijal              # dry-run
npm run collect:rijal:apply
npm run collect:relations
npm run collect:relations:apply
npm run collect:chains
npm run collect:chains:apply
npm run collect:scholars
npm run collect:scholars:apply
npm run collect:books
npm run collect:books:apply
npm run collect:gaps               # refresh this file
\`\`\`

Unmatched rows land in \`data/unmatched/*.csv\`. Never invent rulings — leave NULL and log.
`;

  mkdirSync("docs", { recursive: true });
  writeFileSync(path.join("docs", "db-gaps.md"), md, "utf8");
  console.log(md);
  console.log("Wrote docs/db-gaps.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
