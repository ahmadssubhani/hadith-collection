/**
 * Publish all a–d eligible variations, grouped by topic (chapter → category).
 * Also verifies narrators / cited sunnah appraisals for those chains.
 *
 *   npx tsx scripts/publish-eligible-by-topic.ts
 *   npx tsx scripts/publish-eligible-by-topic.ts --apply
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { one } from "../lib/format";
import { evaluateVariationEligibility } from "../lib/first-wahi-eligibility";
import type {
  Book,
  Chain,
  NarratorAssessment,
  SourceVariation,
  SourceVariationDetail,
} from "../lib/types";

const APPLY = process.argv.includes("--apply");
const DATA_DIR = path.join(process.cwd(), "data");
const OUT_PATH = path.join(DATA_DIR, "unmatched", "publish-by-topic-summary.json");

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function slugifyTopic(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "general";
}

/** Map chapter/text → core category slugs (existing tree). */
function mapTopicTextToSlugs(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  if (/first\s*wahi|beginning of revelation|cave hira|iqra|commencement of revelation|بدء الوحي/.test(t)) {
    out.add("first-wahi");
  }
  if (/tawheed|tawhid|oneness|uniqueness of allah|aqidah|creed|belief|apostate|عقيد/.test(t)) {
    out.add("aqidah");
  }
  if (/prayer|salat|salah|صلاة/.test(t)) out.add("prayer");
  if (/fast|sawm|ramadan|صيام/.test(t)) out.add("fasting");
  if (/zakat|charity|زكاة/.test(t)) out.add("zakat");
  if (/hajj|umrah|pilgrim|حج/.test(t)) out.add("hajj");
  if (/marriage|nikah|wives|نكاح/.test(t)) out.add("marriage");
  if (/tafsir|qur.?an|تفسير/.test(t)) out.add("tafsir");
  if (/akhlaq|ethics|adab|manners|أخلاق|wish|coercion|trick|truthful person|honor/.test(t)) {
    out.add("akhlaq");
  }
  if (/dream/.test(t)) out.add("akhlaq");
  if (/affliction|end of the world|eschat|fitna|signs of the hour/.test(t)) out.add("seerah");
  if (/virtue|fada.?il|فضائل/.test(t)) out.add("virtues");
  if (/seerah|maghazi|banner|battle|migration|hijra|سيرة/.test(t)) out.add("seerah");
  if (/fiqh|ibadat|worship|معامل|transaction|blood money|prisoner|trick/.test(t)) {
    if (/transaction|muamal|بيع|trade|trick|coercion/.test(t)) out.add("fiqh-muamalat");
    else out.add("fiqh-ibadat");
  }
  return [...out];
}

function isIgnoredDuplicate(v: SourceVariation): boolean {
  return Boolean(v.status_notes?.includes("merged_duplicate_of:"));
}

async function fetchAllVariations(sb: SupabaseClient): Promise<SourceVariation[]> {
  const rows: SourceVariation[] = [];
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await sb
      .from("source_variations")
      .select("*, books!source_variations_book_id_fkey(*)")
      .order("id")
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as SourceVariation[]));
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function loadDetails(
  sb: SupabaseClient,
  variationRows: SourceVariation[]
): Promise<{
  details: SourceVariationDetail[];
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>;
}> {
  const assessmentsByNarratorId = new Map<number, NarratorAssessment[]>();
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb
        .from("narrator_assessments")
        .select("*, scholars(*)")
        .range(from, from + page - 1);
      if (error) throw error;
      if (!data?.length) break;
      for (const row of data as NarratorAssessment[]) {
        const list = assessmentsByNarratorId.get(row.narrator_id) ?? [];
        list.push(row);
        assessmentsByNarratorId.set(row.narrator_id, list);
      }
      if (data.length < page) break;
      from += page;
    }
  }

  const variationIds = variationRows.map((r) => r.id);
  const chains: Chain[] = [];
  for (let i = 0; i < variationIds.length; i += 100) {
    const chunk = variationIds.slice(i, i + 100);
    const { data, error } = await sb
      .from("chains")
      .select("*, chain_narrators(*, narrators(*)), chain_assessments(*, scholars(*))")
      .in("variation_id", chunk)
      .order("chain_number");
    if (error) throw error;
    chains.push(...((data ?? []) as Chain[]));
  }

  const details: SourceVariationDetail[] = variationRows.map((variation) => ({
    ...variation,
    books: one(variation.books as Book | Book[] | null),
    chains: chains
      .filter((c) => c.variation_id === variation.id)
      .map((chain) => ({
        ...chain,
        chain_narrators: [...(chain.chain_narrators ?? [])].sort((a, b) => a.position - b.position),
      })),
    hadith_assessments: [],
  }));

  return { details, assessmentsByNarratorId };
}

async function ensureCategories(
  sb: SupabaseClient,
  needed: Array<{ slug: string; title: string }>
): Promise<Map<string, number>> {
  const { data: existing, error } = await sb.from("categories").select("id,slug,title");
  if (error) throw error;
  const bySlug = new Map((existing ?? []).map((c) => [c.slug as string, c.id as number]));

  for (const row of needed) {
    if (bySlug.has(row.slug)) continue;
    if (!APPLY) {
      bySlug.set(row.slug, -1);
      continue;
    }
    const { data: ins, error: iErr } = await sb
      .from("categories")
      .upsert(
        {
          slug: row.slug,
          title: row.title.slice(0, 200),
          description: `Topic from source chapter: ${row.title.slice(0, 180)}`,
          keywords: [row.slug, ...row.title.toLowerCase().split(/\s+/).slice(0, 8)],
          sort_order: 200,
        },
        { onConflict: "slug" }
      )
      .select("id,slug")
      .single();
    if (iErr) {
      // race / exists
      const { data: again } = await sb.from("categories").select("id,slug").eq("slug", row.slug).maybeSingle();
      if (again) bySlug.set(again.slug, again.id);
      else console.warn("category upsert", row.slug, iErr.message);
      continue;
    }
    bySlug.set(ins.slug, ins.id);
  }

  // refresh if dry-run left placeholders
  if (APPLY) {
    const { data: all } = await sb.from("categories").select("id,slug");
    for (const c of all ?? []) bySlug.set(c.slug, c.id);
  }
  return bySlug;
}

async function publishIdsViaPg(variationIds: number[]) {
  const databaseUrl = process.env.DATABASE_URL!.trim();
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("BEGIN");

    const narrRes = await client.query<{ narrator_id: number }>(
      `SELECT DISTINCT cn.narrator_id
       FROM public.chain_narrators cn
       JOIN public.chains c ON c.id = cn.chain_id
       WHERE c.variation_id = ANY($1::bigint[])
         AND cn.narrator_id IS NOT NULL`,
      [variationIds]
    );
    const narratorIds = narrRes.rows.map((r) => Number(r.narrator_id));

    const varRes = await client.query(
      `UPDATE public.source_variations
       SET verified = true
       WHERE id = ANY($1::bigint[])
         AND verified IS DISTINCT FROM true
       RETURNING id`,
      [variationIds]
    );

    const chainRes = await client.query(
      `UPDATE public.chains
       SET verified = true
       WHERE variation_id = ANY($1::bigint[])
         AND verified IS DISTINCT FROM true
       RETURNING id`,
      [variationIds]
    );

    const narrUpd = narratorIds.length
      ? await client.query(
          `UPDATE public.narrators
           SET identity_status = 'verified'
           WHERE id = ANY($1::bigint[])
             AND identity_status IS DISTINCT FROM 'verified'
           RETURNING id`,
          [narratorIds]
        )
      : { rowCount: 0, rows: [] as { id: number }[] };

    const assessRes = narratorIds.length
      ? await client.query(
          `UPDATE public.narrator_assessments
           SET verified = true
           WHERE narrator_id = ANY($1::bigint[])
             AND mapping_method = 'sunnah_com_import'
             AND verified IS DISTINCT FROM true
             AND nullif(trim(source_url), '') IS NOT NULL
           RETURNING id`,
          [narratorIds]
        )
      : { rowCount: 0, rows: [] as { id: number }[] };

    const hadithRes = await client.query(
      `UPDATE public.hadiths h
       SET review_status = 'published', updated_at = now()
       FROM public.source_variations sv
       WHERE sv.hadith_id = h.id
         AND sv.id = ANY($1::bigint[])
         AND h.review_status IS DISTINCT FROM 'published'
       RETURNING h.id`,
      [variationIds]
    );

    await client.query("COMMIT");
    return {
      variations: varRes.rowCount ?? varRes.rows.length,
      chains: chainRes.rowCount ?? chainRes.rows.length,
      narrators: narrUpd.rowCount ?? narrUpd.rows.length,
      assessments: assessRes.rowCount ?? assessRes.rows.length,
      hadiths: hadithRes.rowCount ?? hadithRes.rows.length,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

async function publishIdsViaSupabase(sb: SupabaseClient, variationIds: number[]) {
  const { data: chainRows, error: cErr } = await sb
    .from("chains")
    .select("id, chain_narrators(narrator_id)")
    .in("variation_id", variationIds);
  if (cErr) throw cErr;

  const narratorIds = new Set<number>();
  for (const chain of chainRows ?? []) {
    for (const node of (chain.chain_narrators as { narrator_id: number | null }[] | null) ?? []) {
      if (node.narrator_id != null) narratorIds.add(node.narrator_id);
    }
  }
  const narratorIdList = [...narratorIds];

  const { data: vars, error: vErr } = await sb
    .from("source_variations")
    .update({ verified: true })
    .in("id", variationIds)
    .select("id, hadith_id");
  if (vErr) throw vErr;

  const { data: chains, error: chErr } = await sb
    .from("chains")
    .update({ verified: true })
    .in("variation_id", variationIds)
    .select("id");
  if (chErr) throw chErr;

  let narratorsUpdated = 0;
  let assessmentsUpdated = 0;
  if (narratorIdList.length) {
    const { data: narrs, error: nErr } = await sb
      .from("narrators")
      .update({ identity_status: "verified" })
      .in("id", narratorIdList)
      .neq("identity_status", "verified")
      .select("id");
    if (nErr) throw nErr;
    narratorsUpdated = narrs?.length ?? 0;

    // page assessments update — supabase .update with filters may need chunking
    for (let i = 0; i < narratorIdList.length; i += 80) {
      const chunk = narratorIdList.slice(i, i + 80);
      const { data: assesses, error: aErr } = await sb
        .from("narrator_assessments")
        .update({ verified: true })
        .in("narrator_id", chunk)
        .eq("mapping_method", "sunnah_com_import")
        .eq("verified", false)
        .not("source_url", "is", null)
        .select("id");
      if (aErr) throw aErr;
      assessmentsUpdated += assesses?.length ?? 0;
    }
  }

  const uniqueHadithIds = [...new Set((vars ?? []).map((v) => v.hadith_id).filter(Boolean))];
  let hadithsUpdated = 0;
  for (let i = 0; i < uniqueHadithIds.length; i += 80) {
    const chunk = uniqueHadithIds.slice(i, i + 80);
    const { data: hs, error: hErr } = await sb
      .from("hadiths")
      .update({ review_status: "published", updated_at: new Date().toISOString() })
      .in("id", chunk)
      .neq("review_status", "published")
      .select("id");
    if (hErr) throw hErr;
    hadithsUpdated += hs?.length ?? 0;
  }

  return {
    variations: vars?.length ?? 0,
    chains: chains?.length ?? 0,
    narrators: narratorsUpdated,
    assessments: assessmentsUpdated,
    hadiths: hadithsUpdated,
  };
}

async function publishIds(sb: SupabaseClient, variationIds: number[]) {
  if (process.env.DATABASE_URL?.trim()) {
    console.log("Publishing via DATABASE_URL (transaction)...");
    return publishIdsViaPg(variationIds);
  }
  console.log("DATABASE_URL unset — publishing via Supabase service role...");
  return publishIdsViaSupabase(sb, variationIds);
}

async function main() {
  console.log(`\n=== Publish eligible by topic (${APPLY ? "APPLY" : "dry-run"}) ===`);
  const sb = admin();

  const all = await fetchAllVariations(sb);
  const candidates = all.filter((v) => !isIgnoredDuplicate(v));
  console.log(`Variations: ${all.length} (checking ${candidates.length})`);

  const { details, assessmentsByNarratorId } = await loadDetails(sb, candidates);

  type Item = {
    variation_id: number;
    hadith_id: number;
    chapter: string;
    topic_slugs: string[];
    topic_titles: string[];
    book: string | null;
    hadith_number: string | null;
    complete_chains: number;
  };

  const shortlist: Item[] = [];
  for (const detail of details) {
    const result = evaluateVariationEligibility(detail, assessmentsByNarratorId);
    if (!result.eligible) continue;
    const chapter = (detail.chapter || "").trim() || "General";
    const core = mapTopicTextToSlugs(chapter);
    const chapterSlug = `ch-${slugifyTopic(chapter)}`;
    const topic_slugs = [...new Set([...core, chapterSlug])];
    const topic_titles = [
      ...core,
      chapter,
    ];
    shortlist.push({
      variation_id: detail.id,
      hadith_id: detail.hadith_id,
      chapter,
      topic_slugs,
      topic_titles: [...new Set(topic_titles)],
      book: detail.books?.title ?? null,
      hadith_number: detail.hadith_number,
      complete_chains: result.completeChains.length,
    });
  }

  console.log(`Eligible a–d: ${shortlist.length}`);

  // Ensure categories: core + chapter-derived
  const neededCats: Array<{ slug: string; title: string }> = [];
  const seenSlug = new Set<string>();
  const CORE_TITLES: Record<string, string> = {
    "first-wahi": "First Revelation (Wahi)",
    aqidah: "Creed / Aqidah",
    prayer: "Prayer",
    fasting: "Fasting",
    zakat: "Zakat",
    hajj: "Hajj",
    marriage: "Marriage",
    tafsir: "Tafsir",
    akhlaq: "Ethics / Akhlaq",
    virtues: "Virtues / Fada'il",
    seerah: "Seerah / Maghazi",
    "fiqh-ibadat": "Fiqh — Ibadat",
    "fiqh-muamalat": "Fiqh — Muamalat",
    creed: "Creed / Aqidah",
    ethics: "Ethics / Adab",
  };
  for (const item of shortlist) {
    for (const slug of item.topic_slugs) {
      if (seenSlug.has(slug)) continue;
      seenSlug.add(slug);
      const title = CORE_TITLES[slug] || item.chapter;
      neededCats.push({ slug, title });
    }
  }

  const catBySlug = await ensureCategories(sb, neededCats);
  console.log(`Categories ready/planned: ${neededCats.length}`);

  // Link hadith_categories + set hadiths.topics
  const linkRows: { hadith_id: number; category_id: number }[] = [];
  const topicsByHadith = new Map<number, string[]>();
  const byTopicCount = new Map<string, number>();

  for (const item of shortlist) {
    const titles: string[] = [];
    for (const slug of item.topic_slugs) {
      const cid = catBySlug.get(slug);
      if (cid && cid > 0) {
        linkRows.push({ hadith_id: item.hadith_id, category_id: cid });
      }
      const label = CORE_TITLES[slug] || item.chapter;
      titles.push(label);
      byTopicCount.set(label, (byTopicCount.get(label) || 0) + 1);
    }
    const prev = topicsByHadith.get(item.hadith_id) ?? [];
    topicsByHadith.set(item.hadith_id, [...new Set([...prev, ...titles])]);
  }

  // dedupe links
  const linkKey = new Set<string>();
  const uniqueLinks = linkRows.filter((r) => {
    const k = `${r.hadith_id}:${r.category_id}`;
    if (linkKey.has(k)) return false;
    linkKey.add(k);
    return true;
  });

  console.log(`Topic links planned: ${uniqueLinks.length}`);
  console.log("Top topics:");
  for (const [t, n] of [...byTopicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${n}× ${t}`);
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const summary = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    eligible_variations: shortlist.length,
    unique_hadiths: new Set(shortlist.map((s) => s.hadith_id)).size,
    topic_links: uniqueLinks.length,
    categories_planned: neededCats.length,
    by_topic: Object.fromEntries([...byTopicCount.entries()].sort((a, b) => b[1] - a[1])),
    variation_ids: shortlist.map((s) => s.variation_id),
  };
  writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(
    path.join(DATA_DIR, "publish-allowlist.json"),
    JSON.stringify(
      {
        cluster: "publish-eligible-by-topic",
        variation_ids: shortlist.map((s) => s.variation_id),
        generated_at: summary.generated_at,
        note: "a–d eligible, topic-linked from source chapters",
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Wrote ${OUT_PATH}`);

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to link topics and publish.");
    return;
  }

  // Apply category links
  for (let i = 0; i < uniqueLinks.length; i += 100) {
    const { error } = await sb.from("hadith_categories").upsert(uniqueLinks.slice(i, i + 100), {
      onConflict: "hadith_id,category_id",
    });
    if (error) console.warn("hadith_categories", error.message);
  }

  // Apply topics on hadiths
  let topicsUpdated = 0;
  for (const [hadithId, topics] of topicsByHadith) {
    const { error } = await sb
      .from("hadiths")
      .update({ topics, updated_at: new Date().toISOString() })
      .eq("id", hadithId);
    if (error) console.warn("hadith topics", hadithId, error.message);
    else topicsUpdated++;
  }
  console.log(`Hadith topics updated: ${topicsUpdated}`);

  const ids = shortlist.map((s) => s.variation_id);
  const result = await publishIds(sb, ids);
  console.log("\nPublished:");
  console.log(`  source_variations.verified=true: ${result.variations}`);
  console.log(`  chains.verified=true: ${result.chains}`);
  console.log(`  narrators.identity_status=verified: ${result.narrators}`);
  console.log(`  narrator_assessments.verified=true: ${result.assessments}`);
  console.log(`  hadiths.review_status=published: ${result.hadiths}`);

  writeFileSync(
    OUT_PATH,
    JSON.stringify({ ...summary, mode: "apply", publish_result: result, topics_updated: topicsUpdated }, null, 2),
    "utf8"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
