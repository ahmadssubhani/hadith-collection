/**
 * Identify duplicate Hadiths and combine their useful fields into one complete record.
 *
 * What it does
 * ────────────
 * 1. Loads source_variations (+ books, chains, hadith_assessments).
 * 2. Groups duplicates by normalised Arabic/English matn (EXACT / HIGH).
 * 3. For each group, picks the richest "keeper" variation and fills only its
 *    empty fields from siblings (text, chapter, grade/status, translator, etc.).
 * 4. Preserves every original source: all member variations stay in the DB,
 *    re-pointed under one draft hadith cluster. Non-keepers are tagged
 *    `merged_duplicate_of:<keeperId>` so they can be ignored in UI without
 *    deleting unique references, chains, or assessments.
 *
 * Never deletes rows. Never overwrites a non-empty keeper field.
 *
 * Usage
 * ─────
 *   npx tsx scripts/combine-duplicate-hadiths.ts                 # dry-run
 *   npx tsx scripts/combine-duplicate-hadiths.ts --inbox-only    # scraped inboxes only
 *   npx tsx scripts/combine-duplicate-hadiths.ts --apply         # write
 *   npx tsx scripts/combine-duplicate-hadiths.ts --apply --inbox-only
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const INBOX_ONLY = process.argv.includes("--inbox-only");
const DATA_DIR = path.join(process.cwd(), "data");
const REPORT_PATH = path.join(DATA_DIR, "combine-duplicates-report.json");

const HONORIFICS =
  /صلى\s*الله\s*عليه\s*(وآله\s*)?(وسلم|وسلم)?|صلعم|عليه\s*(الصلاة\s*و)?السلام|رضي\s*الله\s*عن[هماوهن]*|رحمه\s*الله/gi;

type Confidence = "EXACT" | "HIGH" | "REVIEW";

type VariationRow = {
  id: number;
  hadith_id: number;
  book_id: number;
  hadith_number: string | null;
  chapter: string | null;
  volume: string | null;
  page: string | null;
  arabic_text: string | null;
  english_text: string | null;
  translator: string | null;
  source_url: string | null;
  hadith_status: string | null;
  chain_status: string | null;
  narration_status: string[] | null;
  status_notes: string | null;
  verified: boolean;
  books: { id: number; title: string; tradition: string | null } | null;
};

type ChainRow = {
  id: number;
  variation_id: number;
  chain_number: number;
  raw_chain_text: string | null;
  continuity_status: string | null;
  quality_status: string | null;
};

type AssessmentRow = {
  id: number;
  variation_id: number;
  original_grade: string;
  normalized_grade: string | null;
  scholar_id: number;
};

type Loaded = VariationRow & {
  normArabic: string;
  normEnglish: string;
  arabicHash: string;
  englishHash: string;
  chains: ChainRow[];
  assessments: AssessmentRow[];
  sourceHost: string;
  tradition: "sunni" | "shia" | "unknown";
  collectionKey: string | null;
  completeness: number;
};

type FieldPatch = Partial<{
  arabic_text: string;
  english_text: string;
  chapter: string;
  volume: string;
  page: string;
  translator: string;
  hadith_status: string;
  chain_status: string;
  status_notes: string;
}>;

type GroupPlan = {
  group_id: string;
  confidence: Confidence;
  similarity: number;
  reason: string;
  keeper_id: number;
  member_ids: number[];
  filled_fields: string[];
  preserved_sources: {
    variation_id: number;
    book: string | null;
    hadith_number: string | null;
    source_url: string | null;
    grade: string | null;
    narrator: string | null;
  }[];
  patch: FieldPatch;
  cluster_slug: string;
};

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function normalizeArabic(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/ـ/g, "")
    .replace(HONORIFICS, " ")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEnglish(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(peace be upon him|pbuh|may allah be pleased with (him|her|them))\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text: string): string {
  if (!text) return "";
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "(none)";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "(none)";
  }
}

function traditionOf(host: string, book: VariationRow["books"]): "sunni" | "shia" | "unknown" {
  if (host.includes("thaqalayn")) return "shia";
  if (host.includes("sunnah.com") || host.includes("hadeethenc") || host.includes("dorar")) return "sunni";
  const t = (book?.tradition ?? "").toLowerCase();
  if (t.includes("shia") || t.includes("twelver")) return "shia";
  if (t.includes("sunni")) return "sunni";
  return "unknown";
}

function collectionKey(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  if (/bukhari|البخاري/.test(t)) return "bukhari";
  if (/\bmuslim\b|مسلم/.test(t) && !/bukhari/.test(t)) return "muslim";
  if (/abu\s*dawud|abu\s*daoud|ابو\s*داود/.test(t)) return "abu_dawud";
  if (/tirmidhi|الترمذي/.test(t)) return "tirmidhi";
  if (/nasa'?i|النسائي/.test(t)) return "nasai";
  if (/ibn\s*majah|ابن\s*ماجه/.test(t)) return "ibn_majah";
  if (/kafi|الكافي/.test(t)) return "kafi";
  return null;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 1);
}

function shingles(wordList: string[], size = 2): Set<string> {
  const out = new Set<string>();
  if (wordList.length < size) {
    for (const w of wordList) out.add(w);
    return out;
  }
  for (let i = 0; i <= wordList.length - size; i++) out.add(wordList.slice(i, i + size).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function completeness(v: Loaded): number {
  let s = 0;
  if (v.arabic_text?.trim()) s += 3;
  if (v.english_text?.trim()) s += 3;
  if (v.hadith_number?.trim()) s += 1;
  if (v.chapter?.trim()) s += 1;
  if (v.translator?.trim()) s += 1;
  if (v.source_url?.trim()) s += 1;
  if (v.hadith_status && v.hadith_status !== "not_graded") s += 2;
  if (v.chains.some((c) => c.raw_chain_text?.trim())) s += 2;
  if (v.assessments.length) s += 2;
  s += Math.min(v.arabic_text?.length ?? 0, 500) / 500;
  s += Math.min(v.english_text?.length ?? 0, 500) / 500;
  return s;
}

class UnionFind {
  parent = new Map<number, number>();
  find(x: number): number {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let p = this.parent.get(x)!;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

async function fetchAll<T>(sb: SupabaseClient, table: string, select: string): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as T[]));
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function loadVariations(sb: SupabaseClient): Promise<Loaded[]> {
  let inboxIds: number[] | null = null;
  if (INBOX_ONLY) {
    const { data, error } = await sb.from("hadiths").select("id, slug").like("slug", "scraped-inbox-%");
    if (error) throw error;
    inboxIds = (data ?? []).map((h) => h.id as number);
    if (!inboxIds.length) {
      console.log("No scraped-inbox-* hadiths found.");
      return [];
    }
  }

  const variations = await fetchAll<VariationRow>(
    sb,
    "source_variations",
    "*, books!source_variations_book_id_fkey(*)"
  );
  const filtered = inboxIds ? variations.filter((v) => inboxIds!.includes(v.hadith_id)) : variations;

  const chains = await fetchAll<ChainRow>(
    sb,
    "chains",
    "id, variation_id, chain_number, raw_chain_text, continuity_status, quality_status"
  );
  const assessments = await fetchAll<AssessmentRow>(
    sb,
    "hadith_assessments",
    "id, variation_id, original_grade, normalized_grade, scholar_id"
  );

  const chainsByVar = new Map<number, ChainRow[]>();
  for (const c of chains) {
    const list = chainsByVar.get(c.variation_id) ?? [];
    list.push(c);
    chainsByVar.set(c.variation_id, list);
  }
  const assessmentsByVar = new Map<number, AssessmentRow[]>();
  for (const a of assessments) {
    const list = assessmentsByVar.get(a.variation_id) ?? [];
    list.push(a);
    assessmentsByVar.set(a.variation_id, list);
  }

  return filtered.map((v) => {
    const ar = v.arabic_text?.trim() ?? "";
    const en = v.english_text?.trim() ?? "";
    const normArabic = normalizeArabic(ar);
    const normEnglish = normalizeEnglish(en);
    const host = hostOf(v.source_url);
    const loaded: Loaded = {
      ...v,
      normArabic,
      normEnglish,
      arabicHash: hashText(normArabic),
      englishHash: hashText(normEnglish),
      chains: chainsByVar.get(v.id) ?? [],
      assessments: assessmentsByVar.get(v.id) ?? [],
      sourceHost: host,
      tradition: traditionOf(host, v.books),
      collectionKey: collectionKey(v.books?.title),
      completeness: 0,
    };
    loaded.completeness = completeness(loaded);
    return loaded;
  });
}

type Edge = { a: number; b: number; confidence: Confidence; similarity: number; reason: string };

function comparePair(a: Loaded, b: Loaded): Edge | null {
  const crossTradition =
    a.tradition !== "unknown" && b.tradition !== "unknown" && a.tradition !== b.tradition;
  const involvesHadeethEnc =
    a.sourceHost.includes("hadeethenc") || b.sourceHost.includes("hadeethenc");

  const arSim =
    a.normArabic && b.normArabic ? jaccard(shingles(words(a.normArabic)), shingles(words(b.normArabic))) : 0;
  const enSim =
    a.normEnglish && b.normEnglish ? jaccard(shingles(words(a.normEnglish)), shingles(words(b.normEnglish))) : 0;

  const sameCollectionNumber =
    Boolean(a.collectionKey && a.collectionKey === b.collectionKey) &&
    Boolean(a.hadith_number && b.hadith_number) &&
    String(a.hadith_number).replace(/^0+/, "") === String(b.hadith_number).replace(/^0+/, "") &&
    !involvesHadeethEnc;

  if (a.arabicHash && b.arabicHash && a.arabicHash === b.arabicHash) {
    if (crossTradition || (involvesHadeethEnc && a.sourceHost !== b.sourceHost)) {
      return { a: a.id, b: b.id, confidence: "REVIEW", similarity: 1, reason: "exact_arabic_needs_review" };
    }
    return { a: a.id, b: b.id, confidence: "EXACT", similarity: 1, reason: "exact_arabic_hash" };
  }

  if (sameCollectionNumber && !crossTradition) {
    return {
      a: a.id,
      b: b.id,
      confidence: "HIGH",
      similarity: Math.max(arSim, enSim, 0.9),
      reason: `same_collection_number:${a.collectionKey}#${a.hadith_number}`,
    };
  }

  // Same book, different numbers → likely related wording, not the same hadith
  const sameBookDifferentNumber =
    Boolean(a.collectionKey && a.collectionKey === b.collectionKey) &&
    Boolean(a.hadith_number && b.hadith_number) &&
    String(a.hadith_number).replace(/^0+/, "") !== String(b.hadith_number).replace(/^0+/, "");

  if (arSim >= 0.85 && !crossTradition && !involvesHadeethEnc) {
    if (sameBookDifferentNumber) {
      return {
        a: a.id,
        b: b.id,
        confidence: "REVIEW",
        similarity: arSim,
        reason: "arabic_similar_same_book_different_number",
      };
    }
    return { a: a.id, b: b.id, confidence: "HIGH", similarity: arSim, reason: "arabic_jaccard_high" };
  }

  if (arSim >= 0.6 || enSim >= 0.7 || sameCollectionNumber) {
    return {
      a: a.id,
      b: b.id,
      confidence: "REVIEW",
      similarity: Math.max(arSim, enSim),
      reason: crossTradition ? "cross_tradition_review" : "fuzzy_review",
    };
  }

  return null;
}

function pickKeeper(members: Loaded[]): Loaded {
  return [...members].sort((a, b) => {
    if (b.completeness !== a.completeness) return b.completeness - a.completeness;
    return a.id - b.id;
  })[0];
}

function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

function buildPatch(keeper: Loaded, members: Loaded[]): { patch: FieldPatch; filled: string[] } {
  const others = members.filter((m) => m.id !== keeper.id);
  const patch: FieldPatch = {};
  const filled: string[] = [];

  const fill = (key: keyof FieldPatch, current: string | null | undefined, candidates: Array<string | null | undefined>) => {
    if (current?.trim()) return;
    const v = firstNonEmpty(...candidates);
    if (v) {
      patch[key] = v;
      filled.push(key);
    }
  };

  fill(
    "arabic_text",
    keeper.arabic_text,
    others.map((o) => o.arabic_text)
  );
  fill(
    "english_text",
    keeper.english_text,
    others.map((o) => o.english_text)
  );
  fill(
    "chapter",
    keeper.chapter,
    others.map((o) => o.chapter)
  );
  fill(
    "volume",
    keeper.volume,
    others.map((o) => o.volume)
  );
  fill(
    "page",
    keeper.page,
    others.map((o) => o.page)
  );
  fill(
    "translator",
    keeper.translator,
    others.map((o) => o.translator)
  );

  if (!keeper.hadith_status || keeper.hadith_status === "not_graded") {
    const graded = others.find((o) => o.hadith_status && o.hadith_status !== "not_graded");
    if (graded?.hadith_status) {
      patch.hadith_status = graded.hadith_status;
      filled.push("hadith_status");
    }
  }

  if (!keeper.chain_status || keeper.chain_status === "unverified") {
    const better = others.find((o) => o.chain_status && o.chain_status !== "unverified");
    if (better?.chain_status) {
      patch.chain_status = better.chain_status;
      filled.push("chain_status");
    }
  }

  // Preserve unique source refs / grades / narrators in status_notes (append-only)
  const sourceLines: string[] = [];
  for (const m of members) {
    const book = m.books?.title ?? "?";
    const num = m.hadith_number ?? "—";
    const url = m.source_url ?? "";
    const grade =
      m.assessments[0]?.original_grade ||
      (m.hadith_status && m.hadith_status !== "not_graded" ? m.hadith_status : null) ||
      null;
    const narrator = m.chains.map((c) => c.raw_chain_text).filter(Boolean)[0] ?? null;
    sourceLines.push(
      `src#${m.id}:${book} #${num}` +
        (url ? ` <${url}>` : "") +
        (grade ? ` grade=${grade}` : "") +
        (narrator ? ` narrator=${String(narrator).slice(0, 80)}` : "")
    );
  }

  const existingNotes = keeper.status_notes?.trim() ?? "";
  const combinedNotes = [
    existingNotes,
    `combined_from:[${members.map((m) => m.id).join(",")}]`,
    ...sourceLines,
  ]
    .filter(Boolean)
    .join(" | ");

  if (combinedNotes !== existingNotes) {
    patch.status_notes = combinedNotes.slice(0, 8000);
    if (!filled.includes("status_notes")) filled.push("status_notes");
  }

  return { patch, filled };
}

function planGroups(loaded: Loaded[]): { plans: GroupPlan[]; reviewCount: number } {
  const edges: Edge[] = [];
  for (let i = 0; i < loaded.length; i++) {
    for (let j = i + 1; j < loaded.length; j++) {
      const e = comparePair(loaded[i], loaded[j]);
      if (e) edges.push(e);
    }
  }

  const mergeEdges = edges.filter((e) => e.confidence === "EXACT" || e.confidence === "HIGH");
  const reviewCount = edges.filter((e) => e.confidence === "REVIEW").length;

  const uf = new UnionFind();
  for (const v of loaded) uf.find(v.id);
  for (const e of mergeEdges) uf.union(e.a, e.b);

  const components = new Map<number, number[]>();
  for (const v of loaded) {
    const root = uf.find(v.id);
    const list = components.get(root) ?? [];
    list.push(v.id);
    components.set(root, list);
  }

  const byId = new Map(loaded.map((v) => [v.id, v]));
  const plans: GroupPlan[] = [];
  let gi = 0;

  for (const [, ids] of components) {
    if (ids.length < 2) continue;
    gi++;
    const members = ids.map((id) => byId.get(id)!);
    const componentEdges = mergeEdges.filter((e) => ids.includes(e.a) && ids.includes(e.b));
    const confidence: Confidence = componentEdges.some((e) => e.confidence === "EXACT") ? "EXACT" : "HIGH";
    const bestEdge = componentEdges.sort((a, b) => b.similarity - a.similarity)[0];
    const keeper = pickKeeper(members);
    const { patch, filled } = buildPatch(keeper, members);

    plans.push({
      group_id: `G${String(gi).padStart(3, "0")}`,
      confidence,
      similarity: bestEdge?.similarity ?? 1,
      reason: bestEdge?.reason ?? "grouped",
      keeper_id: keeper.id,
      member_ids: ids,
      filled_fields: filled,
      preserved_sources: members.map((m) => ({
        variation_id: m.id,
        book: m.books?.title ?? null,
        hadith_number: m.hadith_number,
        source_url: m.source_url,
        grade:
          m.assessments[0]?.original_grade ??
          (m.hadith_status && m.hadith_status !== "not_graded" ? m.hadith_status : null),
        narrator: m.chains.map((c) => c.raw_chain_text).find(Boolean) ?? null,
      })),
      patch,
      cluster_slug: `combined-${keeper.id}`,
    });
  }

  return { plans, reviewCount };
}

async function ensureCluster(sb: SupabaseClient, plan: GroupPlan, keeper: Loaded): Promise<number> {
  const titleBits = plan.preserved_sources
    .map((s) => `${s.book ?? "?"} #${s.hadith_number ?? "—"}`)
    .slice(0, 4)
    .join(" + ");
  const payload = {
    slug: plan.cluster_slug,
    title: `Combined hadith (${plan.group_id}): ${titleBits}`.slice(0, 200),
    summary: `Auto-combined from variation ids [${plan.member_ids.join(", ")}]. Keeper=${plan.keeper_id}. Sources preserved as sibling variations.`,
    topics: ["combined", "dedupe", plan.confidence.toLowerCase()],
    review_status: "draft",
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await sb.from("hadiths").select("id").eq("slug", plan.cluster_slug).maybeSingle();
  if (existing) {
    await sb.from("hadiths").update(payload).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await sb.from("hadiths").insert(payload).select("id").single();
  if (error) throw error;
  void keeper;
  return data.id;
}

async function applyPlan(sb: SupabaseClient, plan: GroupPlan, byId: Map<number, Loaded>) {
  const keeper = byId.get(plan.keeper_id)!;
  const clusterId = await ensureCluster(sb, plan, keeper);

  // 1) Enrich keeper (fill empties only)
  if (Object.keys(plan.patch).length) {
    const { error } = await sb.from("source_variations").update(plan.patch).eq("id", plan.keeper_id);
    if (error) throw error;
  }

  // 2) If keeper has no chain text but a sibling does, copy a chain onto the keeper
  const keeperHasChain = keeper.chains.some((c) => c.raw_chain_text?.trim());
  if (!keeperHasChain) {
    const donor = plan.member_ids
      .map((id) => byId.get(id)!)
      .find((m) => m.id !== plan.keeper_id && m.chains.some((c) => c.raw_chain_text?.trim()));
    const raw = donor?.chains.find((c) => c.raw_chain_text?.trim())?.raw_chain_text;
    if (raw) {
      await sb.from("chains").upsert(
        {
          variation_id: plan.keeper_id,
          chain_number: 1,
          raw_chain_text: raw,
          continuity_status: "unverified",
          quality_status: "unverified",
          verified: false,
          notes: `Copied from variation ${donor!.id} during combine`,
        },
        { onConflict: "variation_id,chain_number" }
      );
    }
  }

  // 3) Re-point all members under the cluster; tag non-keepers
  for (const id of plan.member_ids) {
    const member = byId.get(id)!;
    const isKeeper = id === plan.keeper_id;
    const tag = `merged_duplicate_of:${plan.keeper_id}`;
    let notes = member.status_notes ?? "";
    if (!isKeeper && !notes.includes(tag)) {
      notes = [notes, tag, `combined_group:${plan.group_id}`].filter(Boolean).join(" | ");
    }
    if (isKeeper && plan.patch.status_notes) notes = plan.patch.status_notes;

    const { error } = await sb
      .from("source_variations")
      .update({
        hadith_id: clusterId,
        ...(isKeeper ? {} : { status_notes: notes.slice(0, 8000) }),
      })
      .eq("id", id);
    if (error) throw error;
  }
}

async function main() {
  console.log(`\n=== Combine duplicate Hadiths (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
  if (INBOX_ONLY) console.log("Scope: scraped-inbox-* only");

  const sb = admin();
  const loaded = await loadVariations(sb);
  console.log(`Loaded variations: ${loaded.length}`);

  const { plans, reviewCount } = planGroups(loaded);
  console.log(`Combinable groups (EXACT/HIGH): ${plans.length}`);
  console.log(`Review-only pair edges (not auto-combined): ${reviewCount}`);

  for (const p of plans) {
    console.log(`\n${p.group_id} [${p.confidence}] sim=${p.similarity.toFixed(3)} (${p.reason})`);
    console.log(`  keeper: #${p.keeper_id}`);
    console.log(`  members: ${p.member_ids.join(", ")}`);
    console.log(`  fill into keeper: ${p.filled_fields.join(", ") || "(none — already complete)"}`);
    for (const s of p.preserved_sources) {
      console.log(
        `  keep source var ${s.variation_id}: ${s.book} #${s.hadith_number ?? "—"}` +
          (s.grade ? ` [${s.grade}]` : "") +
          (s.source_url ? ` ${s.source_url}` : "")
      );
    }
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    inbox_only: INBOX_ONLY,
    variation_count: loaded.length,
    combinable_groups: plans.length,
    review_pair_edges: reviewCount,
    groups: plans,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nWrote ${REPORT_PATH}`);

  if (!APPLY) {
    console.log("\nNo DB writes. Re-run with --apply to combine.");
    console.log("Rules: fill empty keeper fields only; never delete; all sources kept as variations under one draft hadith.");
    return;
  }

  if (!plans.length) {
    console.log("Nothing to apply.");
    return;
  }

  const byId = new Map(loaded.map((v) => [v.id, v]));
  let ok = 0;
  for (const p of plans) {
    try {
      await applyPlan(sb, p, byId);
      ok++;
      console.log(`  applied ${p.group_id} → hadith slug ${p.cluster_slug}`);
    } catch (e) {
      console.error(`  FAILED ${p.group_id}:`, e);
    }
  }
  console.log(`\nDone. Applied ${ok}/${plans.length} groups.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
