import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

async function all<T>(sb: any, table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  type N = {
    id: number;
    name: string;
    biography: string | null;
    death_year_ah: number | null;
    generation: string | null;
    identity_status: string;
    name_quality: string | null;
  };
  const narr = await all<N>(
    sb,
    "narrators",
    "id,name,biography,death_year_ah,generation,identity_status,name_quality"
  );
  const withAny = narr.filter(
    (n) =>
      (n.biography && n.biography.trim()) ||
      n.death_year_ah != null ||
      (n.generation && n.generation.trim())
  );

  const groups = new Map<string, N[]>();
  for (const n of withAny) {
    const key = JSON.stringify({
      bio: (n.biography || "").trim(),
      death: n.death_year_ah,
      gen: (n.generation || "").trim(),
    });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log("fingerprints", sorted.length);
  for (const [k, rows] of sorted) {
    console.log("--- count", rows.length);
    console.log(k.slice(0, 300));
    console.log(
      "sample",
      rows.slice(0, 3).map((r) => ({ id: r.id, name: r.name, q: r.name_quality, idst: r.identity_status }))
    );
  }

  const boilerplate = sorted[0][1];
  const realOnes = withAny.filter((n) => !boilerplate.some((b) => b.id === n.id));
  console.log("boilerplate", boilerplate.length, "real/other", realOnes.length);
  console.log("REAL", JSON.stringify(realOnes, null, 2));

  // scholars tradition
  type S = { id: number; slug: string; name: string; tradition: string | null; madhhab: string | null };
  const scholars = await all<S>(sb, "scholars", "id,slug,name,tradition,madhhab");
  const withT = scholars.filter((s) => s.tradition && s.tradition.trim());
  console.log("scholars tradition filled", withT.length, "/", scholars.length);
  const tcounts: Record<string, number> = {};
  for (const s of withT) tcounts[s.tradition!] = (tcounts[s.tradition!] || 0) + 1;
  console.log(tcounts);
  console.log(
    "null tradition scholars",
    scholars.filter((s) => !s.tradition).map((s) => s.slug)
  );

  // empty chains
  type C = { id: number; variation_id: number; raw_chain_text: string | null };
  const chains = await all<C>(sb, "chains", "id,variation_id,raw_chain_text");
  const cn = await all<{ chain_id: number }>(sb, "chain_narrators", "chain_id");
  const has = new Set(cn.map((x) => x.chain_id));
  const empty = chains.filter((c) => !has.has(c.id));
  const withRaw = empty.filter((c) => c.raw_chain_text && c.raw_chain_text.trim());
  const noRaw = empty.filter((c) => !(c.raw_chain_text && c.raw_chain_text.trim()));
  console.log("empty", empty.length, "withRaw", withRaw.length, "noRaw", noRaw.length);
  console.log(
    "withRaw samples",
    withRaw.slice(0, 5).map((c) => ({ id: c.id, vid: c.variation_id, raw: (c.raw_chain_text || "").slice(0, 100) }))
  );

  mkdirSync("data/unmatched", { recursive: true });
  writeFileSync(
    path.join("data/unmatched", "boilerplate-922-ids.json"),
    JSON.stringify(
      {
        boilerplate_count: boilerplate.length,
        boilerplate_fingerprint: JSON.parse(sorted[0][0]),
        boilerplate_ids: boilerplate.map((b) => b.id).sort((a, b) => a - b),
        keep_real: realOnes,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("wrote data/unmatched/boilerplate-922-ids.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
