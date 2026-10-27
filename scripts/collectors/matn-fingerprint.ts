/**
 * Compute Arabic matn fingerprints and (with --apply) split topic-bucket hadiths
 * into draft matn-level hadith rows (within a single tradition only).
 * Cross-tradition near-matches → data/unmatched/hadith-grouping-review.csv.
 *
 * Guardrails (user-approved):
 * - normalize: strip tashkeel; unify alef/ya/ta marbuta; extract matn core after isnad
 * - auto-cluster within one tradition only
 * - first-revelation-at-hira stays a TOPIC (category); clusters get new hadith rows
 * - write hadith_id_remap; variations stay review_status=draft
 *
 *   npx tsx scripts/collectors/matn-fingerprint.ts
 *   npx tsx scripts/collectors/matn-fingerprint.ts --apply
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { APPLY, adminClient, fetchAll, writeUnmatchedCsv, logMode } from "./_shared";

const FP_SLICE = 160;

function normalizeArabicMatn(raw: string): string {
  let s = raw.normalize("NFC");
  s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "");
  s = s.replace(/[أإآٱ]/g, "ا");
  s = s.replace(/ى/g, "ي");
  s = s.replace(/ة/g, "ه");
  s = s.replace(/ـ/g, "");
  s = s.replace(/[^\u0600-\u06FF\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Prefer matn body after prophetic speech / known anchors; else light isnad strip. */
function extractMatnCore(norm: string): string {
  const anchors = [
    "اول ما بدئ",
    "اول ما بدء",
    "قال رسول الله صلي الله عليه وسلم",
    "قال النبي صلي الله عليه وسلم",
    "ان رسول الله صلي الله عليه وسلم",
    "ان النبي صلي الله عليه وسلم",
    "سمعت رسول الله صلي الله عليه وسلم",
    "عن النبي صلي الله عليه وسلم قال",
    "عن رسول الله صلي الله عليه وسلم قال",
  ];
  let cut = -1;
  for (const a of anchors) {
    const idx = norm.lastIndexOf(a);
    if (idx > cut) cut = idx;
  }
  if (cut >= 0) return norm.slice(cut);
  let s = norm;
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^عن\s[\s\S]{3,120}?(?:قال|قالت)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}

function fingerprint(core: string): string {
  if (core.length < 20) return "";
  return createHash("sha256").update(core.slice(0, FP_SLICE)).digest("hex").slice(0, 24);
}

const TOPIC_SLUGS = new Set([
  "first-revelation-at-hira",
  "scraped-inbox-sunnah",
  "scraped-inbox-dorar",
  "scraped-inbox-hadeethenc",
  "combined-847",
]);

async function main() {
  logMode("matn-fingerprint / regroup");
  const sb = adminClient();

  const books = await fetchAll<{ id: number; tradition: string }>(sb, "books", "id,tradition");
  const bookTrad = new Map(books.map((b) => [b.id, b.tradition || "unclassified"]));

  const variations = await fetchAll<{
    id: number;
    hadith_id: number;
    book_id: number;
    arabic_text: string | null;
    review_status: string | null;
  }>(sb, "source_variations", "id,hadith_id,book_id,arabic_text,review_status");

  const hadiths = await fetchAll<{
    id: number;
    slug: string;
    title: string;
    grouping_method: string | null;
  }>(sb, "hadiths", "id,slug,title,grouping_method");

  const hadithById = new Map(hadiths.map((h) => [h.id, h]));
  const topicHadithIds = new Set(
    hadiths
      .filter(
        (h) =>
          TOPIC_SLUGS.has(h.slug) ||
          h.grouping_method === "topic_bucket_pending_matn_split" ||
          (h.grouping_method || "").startsWith("topic_bucket")
      )
      .map((h) => h.id)
  );
  // Also treat any hadith with ≥10 variations as a topic bucket if not already matn-clustered
  const varCount = new Map<number, number>();
  for (const v of variations) varCount.set(v.hadith_id, (varCount.get(v.hadith_id) || 0) + 1);
  for (const [hid, n] of varCount) {
    const h = hadithById.get(hid);
    if (!h) continue;
    if (h.grouping_method === "matn_fingerprint_v1") continue;
    if (n >= 10) topicHadithIds.add(hid);
  }

  type Row = {
    id: number;
    hadith_id: number;
    book_id: number;
    tradition: string;
    core: string;
    fp: string;
  };

  const rows: Row[] = [];
  let skippedNoArabic = 0;
  let skippedShort = 0;
  for (const v of variations) {
    const ar = (v.arabic_text || "").trim();
    if (!ar) {
      skippedNoArabic++;
      continue;
    }
    const norm = normalizeArabicMatn(ar);
    const core = extractMatnCore(norm);
    const fp = fingerprint(core);
    if (!fp) {
      skippedShort++;
      continue;
    }
    rows.push({
      id: v.id,
      hadith_id: v.hadith_id,
      book_id: v.book_id,
      tradition: bookTrad.get(v.book_id) || "unclassified",
      core,
      fp,
    });
  }

  const clusters = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.tradition}|${r.fp}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(r);
  }

  const byFp = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byFp.has(r.fp)) byFp.set(r.fp, new Set());
    byFp.get(r.fp)!.add(r.tradition);
  }
  const cross: { fp: string; traditions: string[]; variation_ids: number[] }[] = [];
  for (const [fp, trads] of byFp) {
    if (trads.size > 1) {
      cross.push({
        fp,
        traditions: [...trads],
        variation_ids: rows.filter((r) => r.fp === fp).map((r) => r.id),
      });
    }
  }

  writeUnmatchedCsv(
    "hadith-grouping-review.csv",
    ["fingerprint", "traditions", "variation_ids"],
    cross.map((c) => [c.fp, c.traditions.join("|"), c.variation_ids.join("|")])
  );

  // Split candidates: clusters that have ≥1 member still on a topic bucket
  const splitClusters = [...clusters.entries()].filter(([, members]) =>
    members.some((m) => topicHadithIds.has(m.hadith_id))
  );
  const multi = splitClusters.filter(([, rs]) => rs.length >= 2);

  console.log(
    JSON.stringify(
      {
        variations_total: variations.length,
        with_fingerprint: rows.length,
        skipped_no_arabic: skippedNoArabic,
        skipped_short: skippedShort,
        topic_hadith_ids: [...topicHadithIds],
        clusters_total: clusters.size,
        split_clusters_from_topics: splitClusters.length,
        clusters_size_ge_2: multi.length,
        cross_tradition_fps: cross.length,
      },
      null,
      2
    )
  );

  if (!APPLY) {
    console.log("Dry-run: would update matn_fingerprint on", rows.length, "variations");
    console.log(
      "Dry-run: would create",
      splitClusters.length,
      "draft matn hadiths (split from topic buckets)"
    );
    return;
  }

  const CHUNK = 40;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await Promise.all(
      slice.map((r) =>
        sb
          .from("source_variations")
          .update({
            matn_fingerprint: r.fp,
            matn_fingerprint_norm: r.core.slice(0, FP_SLICE),
          })
          .eq("id", r.id)
      )
    );
    if ((i / CHUNK) % 5 === 0) {
      console.log(`fingerprints ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
    }
  }
  console.log("Updated fingerprints:", rows.length);

  let created = 0;
  let remapped = 0;
  let skippedCross = 0;

  type Plan = {
    key: string;
    fp: string;
    tradition: string;
    slug: string;
    title: string;
    core: string;
    members: Row[];
    fromFirstWahi: boolean;
  };

  const plans: Plan[] = [];
  for (const [key, members] of splitClusters) {
    const fp = key.split("|").slice(1).join("|");
    if ((byFp.get(fp)?.size ?? 0) > 1) {
      skippedCross++;
      continue;
    }
    const tradition = members[0].tradition;
    const slug = `matn-${tradition.replace(/\s+/g, "-").toLowerCase()}-${fp.slice(0, 12)}`;
    plans.push({
      key,
      fp,
      tradition,
      slug,
      title: `Matn ${fp.slice(0, 8)} (${tradition}, n=${members.length})`,
      core: members[0].core.slice(0, FP_SLICE),
      members,
      fromFirstWahi: members.some((m) => hadithById.get(m.hadith_id)?.slug === "first-revelation-at-hira"),
    });
  }

  // Resolve existing slugs
  const slugToId = new Map<string, number>();
  for (let i = 0; i < plans.length; i += 100) {
    const slugs = plans.slice(i, i + 100).map((p) => p.slug);
    const { data } = await sb.from("hadiths").select("id,slug").in("slug", slugs);
    for (const h of data || []) slugToId.set(h.slug, h.id);
  }

  const toInsert = plans.filter((p) => !slugToId.has(p.slug));
  for (let i = 0; i < toInsert.length; i += 50) {
    const batch = toInsert.slice(i, i + 50);
    const { data, error } = await sb
      .from("hadiths")
      .insert(
        batch.map((p) => ({
          slug: p.slug,
          title: p.title,
          review_status: "draft",
          data_origin: "collector",
          grouping_method: "matn_fingerprint_v1",
          matn_fingerprint_norm: p.core,
        }))
      )
      .select("id,slug");
    if (error) {
      console.warn("batch hadith insert failed", error.message, "falling back per-row");
      for (const p of batch) {
        const { data: one, error: e2 } = await sb
          .from("hadiths")
          .insert({
            slug: p.slug,
            title: p.title,
            review_status: "draft",
            data_origin: "collector",
            grouping_method: "matn_fingerprint_v1",
            matn_fingerprint_norm: p.core,
          })
          .select("id,slug")
          .single();
        if (e2) console.warn("hadith insert failed", p.slug, e2.message);
        else {
          slugToId.set(one!.slug, one!.id);
          created++;
        }
      }
    } else {
      for (const h of data || []) {
        slugToId.set(h.slug, h.id);
        created++;
      }
    }
    if (i % 200 === 0) console.log(`hadiths inserted ${Math.min(i + 50, toInsert.length)}/${toInsert.length}`);
  }

  const { data: firstWahiCat } = await sb
    .from("categories")
    .select("id")
    .eq("slug", "first-wahi")
    .maybeSingle();

  const catLinks: { hadith_id: number; category_id: number }[] = [];
  const remaps: {
    old_hadith_id: number;
    new_hadith_id: number;
    method: string;
    notes: string;
  }[] = [];

  for (const p of plans) {
    const newId = slugToId.get(p.slug);
    if (!newId) continue;
    if (p.fromFirstWahi && firstWahiCat) {
      catLinks.push({ hadith_id: newId, category_id: firstWahiCat.id });
    }
    for (const m of p.members) {
      if (m.hadith_id === newId) continue;
      if (!topicHadithIds.has(m.hadith_id)) continue;
      remaps.push({
        old_hadith_id: m.hadith_id,
        new_hadith_id: newId,
        method: "matn_fingerprint_v1",
        notes: `split from topic hadith ${m.hadith_id} (${hadithById.get(m.hadith_id)?.slug ?? "?"})`,
      });
    }
  }

  // Update variations in parallel chunks
  const varUpdates: { id: number; newId: number }[] = [];
  for (const p of plans) {
    const newId = slugToId.get(p.slug);
    if (!newId) continue;
    for (const m of p.members) {
      if (m.hadith_id === newId) continue;
      if (!topicHadithIds.has(m.hadith_id)) continue;
      varUpdates.push({ id: m.id, newId });
    }
  }
  for (let i = 0; i < varUpdates.length; i += CHUNK) {
    const slice = varUpdates.slice(i, i + CHUNK);
    await Promise.all(
      slice.map((u) =>
        sb
          .from("source_variations")
          .update({ hadith_id: u.newId, review_status: "draft" })
          .eq("id", u.id)
      )
    );
    remapped += slice.length;
    if (i % (CHUNK * 5) === 0) {
      console.log(`remapped variations ${Math.min(i + CHUNK, varUpdates.length)}/${varUpdates.length}`);
    }
  }

  // Dedupe: multi-member clusters produce duplicate (old,new,method) rows
  const remapSeen = new Set<string>();
  const remapsUnique = remaps.filter((r) => {
    const k = `${r.old_hadith_id}|${r.new_hadith_id}|${r.method}`;
    if (remapSeen.has(k)) return false;
    remapSeen.add(k);
    return true;
  });
  for (let i = 0; i < remapsUnique.length; i += 100) {
    const { error } = await sb.from("hadith_id_remap").upsert(remapsUnique.slice(i, i + 100), {
      onConflict: "old_hadith_id,new_hadith_id,method",
    });
    if (error) console.warn("remap upsert", error.message);
  }

  for (let i = 0; i < catLinks.length; i += 100) {
    const { error } = await sb.from("hadith_categories").upsert(catLinks.slice(i, i + 100), {
      onConflict: "hadith_id,category_id",
    });
    if (error) console.warn("hadith_categories", error.message);
  }

  mkdirSync(path.join("data", "unmatched"), { recursive: true });
  writeFileSync(
    path.join("data", "unmatched", "matn-fingerprint-apply-summary.json"),
    JSON.stringify(
      {
        created,
        remapped,
        skipped_cross_tradition: skippedCross,
        cross_tradition_fps: cross.length,
        topic_hadith_ids: [...topicHadithIds],
      },
      null,
      2
    ),
    "utf8"
  );
  console.log({ created, remapped, skippedCross, cross_review: cross.length });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
