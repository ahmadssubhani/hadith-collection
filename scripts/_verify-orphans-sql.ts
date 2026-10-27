/**
 * Exact orphan / dangling checks (paginated service-role reads — no 1000-row skew).
 * Prefer DATABASE_URL when set; otherwise page through PostgREST.
 * Read-only.
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

async function fetchAllIds(
  sb: SupabaseClient,
  table: string,
  select: string
): Promise<Record<string, unknown>[]> {
  const page = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from(table).select(select).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as Record<string, unknown>[]));
    if (data.length < page) break;
  }
  return out;
}

async function viaSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("Mode: paginated PostgREST (DATABASE_URL unset)\n");

  const chains = await fetchAllIds(sb, "chains", "id,variation_id,chain_number,verified");
  const vars = await fetchAllIds(sb, "source_variations", "id");
  const narrators = await fetchAllIds(sb, "narrators", "id");
  const cn = await fetchAllIds(sb, "chain_narrators", "id,chain_id,narrator_id");

  const varIds = new Set(vars.map((v) => v.id as number));
  const narrIds = new Set(narrators.map((n) => n.id as number));
  const chainIds = new Set(chains.map((c) => c.id as number));

  const orphanChains = chains.filter((c) => !varIds.has(c.variation_id as number));
  const danglingNarr = cn.filter(
    (r) => r.narrator_id != null && !narrIds.has(r.narrator_id as number)
  );
  const orphanCn = cn.filter((r) => !chainIds.has(r.chain_id as number));
  const nodesByChain = new Map<number, number>();
  for (const r of cn) {
    const cid = r.chain_id as number;
    nodesByChain.set(cid, (nodesByChain.get(cid) ?? 0) + 1);
  }
  const chainsNoNodes = chains.filter((c) => !nodesByChain.has(c.id as number));
  const varsWithChain = new Set(chains.map((c) => c.variation_id as number));
  const varsNoChain = vars.filter((v) => !varsWithChain.has(v.id as number));
  const unresolved = cn.filter((r) => r.narrator_id == null);

  const report = {
    fetched: {
      chains: chains.length,
      source_variations: vars.length,
      narrators: narrators.length,
      chain_narrators: cn.length,
    },
    orphan_chains: orphanChains.length,
    orphan_chain_sample: orphanChains.slice(0, 20).map((c) => ({
      id: c.id,
      variation_id: c.variation_id,
      chain_number: c.chain_number,
      verified: c.verified,
    })),
    dangling_narrator_refs: danglingNarr.length,
    orphan_chain_narrators: orphanCn.length,
    chains_with_no_nodes: chainsNoNodes.length,
    variations_without_chains: varsNoChain.length,
    unresolved_narrator_nodes: unresolved.length,
  };

  console.log(JSON.stringify(report, null, 2));

  // Supporting lookups for migration draft
  const { data: bukhariStubs } = await sb
    .from("books")
    .select("id,title,tradition")
    .like("title", "Sahih al-Bukhari %");
  const stubs = (bukhariStubs ?? []).filter((b) => /^Sahih al-Bukhari \d/i.test(b.title));
  console.log("\nbukhari_number_stubs:", stubs.length, stubs.slice(0, 5));

  const { data: canonicalBukhari } = await sb
    .from("books")
    .select("id,title,author,tradition")
    .or("title.eq.Sahih al-Bukhari,title.eq.صحيح البخاري");
  console.log("canonical_bukhari_candidates:", canonicalBukhari);

  const { data: ibnHajar } = await sb
    .from("scholars")
    .select("id,slug,name,arabic_name,tradition,birth_year_ah,death_year_ah")
    .or("slug.ilike.%ibn-hajar%,name.ilike.%ibn hajar%");
  console.log("ibn_hajar:", ibnHajar);

  for (const sid of [1, 7]) {
    const ha = await sb
      .from("hadith_assessments")
      .select("*", { count: "exact", head: true })
      .eq("scholar_id", sid);
    const na = await sb
      .from("narrator_assessments")
      .select("*", { count: "exact", head: true })
      .eq("scholar_id", sid);
    console.log(`scholar ${sid} FKs: ha=${ha.count} na=${na.count}`);
  }

  const { count: nullTrad } = await sb
    .from("scholars")
    .select("*", { count: "exact", head: true })
    .is("tradition", null);
  console.log("scholars_null_tradition:", nullTrad);

  return report;
}

async function viaPg() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL!,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(`
    select
      (select count(*)::int from chains c where not exists (
        select 1 from source_variations v where v.id = c.variation_id)) as orphan_chains,
      (select count(*)::int from chain_narrators cn
        where cn.narrator_id is not null
          and not exists (select 1 from narrators n where n.id = cn.narrator_id)
      ) as dangling_narrator_refs,
      (select count(*)::int from chains c where not exists (
        select 1 from chain_narrators cn where cn.chain_id = c.id)) as chains_with_no_nodes,
      (select count(*)::int from source_variations v where not exists (
        select 1 from chains c where c.variation_id = v.id)) as variations_without_chains
  `);
  console.log("Mode: DATABASE_URL\n", rows[0]);
  await client.end();
  return rows[0];
}

async function main() {
  if (process.env.DATABASE_URL?.trim()) await viaPg();
  else await viaSupabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
