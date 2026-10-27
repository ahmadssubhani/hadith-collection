/**
 * Dry-run (default): detect duplicate matn across source_variations, compare
 * stored data per copy, and write a merge plan. No writes.
 *
 * Apply (only after explicit approval): npm run hadith:dedupe:apply
 *   Re-points variation→hadith links in one transaction; never moves chains.
 *
 * Usage:
 *   npx tsx scripts/dedupe-hadith.ts
 *   npx tsx scripts/dedupe-hadith.ts --apply
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { one } from "../lib/format";
import { evaluateVariationEligibility } from "../lib/first-wahi-eligibility";
import type {
  Book,
  Chain,
  HadithAssessment,
  NarratorAssessment,
  SourceVariation,
  SourceVariationDetail,
} from "../lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const REPORT_CSV = path.join(DATA_DIR, "duplicate-report.csv");
const MATRIX_CSV = path.join(DATA_DIR, "duplicate-data-matrix.csv");
const MERGE_PLAN = path.join(DATA_DIR, "merge-plan.json");
const FINGERPRINT = path.join(DATA_DIR, "dedupe-fingerprint.json");

const APPLY = process.argv.includes("--apply");

const MATN_CUT =
  /(?:أَنَّهَا\s+قَالَتْ|أَنَّهُ\s+قَالَ|أَنَّ\s+رَسُولَ|أَنَّ\s+النَّبِيَّ|سَمِعْتُ\s+رَسُولَ|قَالَ\s*:\s*سَمِعْتُ\s+رَسُولَ|قَالَ\s+رَسُولُ|قَالَ\s+النَّبِيُّ|قَالَتْ\s+عَائِشَة|قَالَ\s+كَانَ|فِي\s+قَوْلِهِ|نَحْوَهُ\s+قَالَ|أَنَّ\s+هِرَقْلَ|أَنَّ\s+الْحَارِثَ|وَهُوَ\s+يُحَدِّثُ\s+عَنْ|فِي\s+حَدِيثِهِ|عَلَى\s+الْمِنْبَرِ|عَنِ\s+النَّبِيِّ|عَن\s+رَسُولِ\s+اللَّهِ)/;

const SOFT_MATN = /أَوَّلُ\s+مَا|بَيْنَا\s+أَنَا|كَانَ\s+رَسُولُ|إِنَّمَا\s+الأَعْمَال|بَيْنَمَا\s+هُوَ/;

const HONORIFICS =
  /صلى\s*الله\s*عليه\s*(وآله\s*)?(وسلم|وسلم)?|صلعم|عليه\s*(الصلاة\s*و)?السلام|رضي\s*الله\s*عن[هماوهن]*|رحمه\s*الله|قدس\s*سره|ع\s*ج|ص\s*ل\s*ى/gi;

type Confidence = "EXACT" | "HIGH" | "REVIEW";

type LoadedVariation = SourceVariation & {
  books: Book | null;
  sourceHost: string;
  tradition: "sunni" | "shia" | "unknown";
  collectionKey: string | null;
  matnArabic: string;
  matnEnglish: string;
  normArabic: string;
  normEnglish: string;
  arabicHash: string;
  englishHash: string;
  chains: Chain[];
  hadith_assessments: HadithAssessment[];
};

type PairEdge = {
  a: number;
  b: number;
  confidence: Confidence;
  similarity: number;
  reason: string;
};

type GroupMemberPlan = {
  variation_id: number;
  source: string;
  hadith_number: string | null;
  role: "canonical" | "member";
  contributes: string[];
  eligible: boolean;
  fails_rules: string[];
  display: "complete" | "text_and_grading_only" | "incomplete";
};

type MergeGroupPlan = {
  group_id: string;
  confidence: Confidence;
  status: "eligible" | "not_eligible" | "review_only";
  canonical_variation_id: number | null;
  members: GroupMemberPlan[];
  notes: string[];
};

type MergePlanFile = {
  generated_at: string;
  fingerprint: Fingerprint;
  summary: Record<string, number | string>;
  groups: MergeGroupPlan[];
  review_groups: MergeGroupPlan[];
  unique_variation_ids: number[];
};

type Fingerprint = {
  variation_count: number;
  max_id: number;
  sum_ids: number;
  arabic_chars: number;
  english_chars: number;
  hash: string;
};

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "(none)";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "(none)";
  }
}

function detectTradition(host: string, book: Book | null): "sunni" | "shia" | "unknown" {
  if (host.includes("thaqalayn")) return "shia";
  if (host.includes("sunnah.com") || host.includes("hadeethenc")) return "sunni";
  const t = (book?.tradition ?? "").toLowerCase();
  if (t.includes("shia") || t.includes("twelver")) return "shia";
  if (t.includes("sunni")) return "sunni";
  return "unknown";
}

function collectionKey(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ʿ|ʾ|'|'/g, "");
  if (/bukhari|bukhari|البخاري/.test(t)) return "bukhari";
  if (/\bmuslim\b|مسلم/.test(t) && !/bukhari/.test(t)) return "muslim";
  if (/abu\s*dawud|abu\s*daoud|ابو\s*داود/.test(t)) return "abu_dawud";
  if (/tirmidhi|termedhy|الترمذي/.test(t)) return "tirmidhi";
  if (/nasa'?i|النسائي/.test(t)) return "nasai";
  if (/ibn\s*majah|ibn\s*maajah|ابن\s*ماجه/.test(t)) return "ibn_majah";
  if (/\bahmad\b|مسند/.test(t)) return "ahmad";
  if (/malik|الموطا/.test(t)) return "malik";
  if (/darimi|الدارمي/.test(t)) return "darimi";
  if (/bayhaqi|البيهقي/.test(t)) return "bayhaqi";
  if (/kafi|الكافي/.test(t)) return "kafi";
  return null;
}

/** Extra matn normalisation beyond lib/normalization (honorifics, tatweel). */
function normalizeMatnArabic(text: string): string {
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

function normalizeMatnEnglish(text: string): string {
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

function extractArabicMatn(arabic: string, chains: Chain[]): string {
  const cleaned = arabic.trim();
  if (!cleaned) return "";

  const rawChains = chains
    .map((c) => c.raw_chain_text?.trim() ?? "")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const raw of rawChains) {
    const idx = cleaned.indexOf(raw);
    if (idx >= 0) {
      const after = cleaned.slice(idx + raw.length).replace(/^[\s،,.:：\-–—]+/, "").trim();
      if (after.length >= 12) return after;
    }
    // Fuzzy: normalised containment of first ~40 chars of chain
    const head = raw.slice(0, 40);
    const softIdx = cleaned.indexOf(head);
    if (softIdx >= 0 && softIdx < cleaned.length * 0.7) {
      const after = cleaned.slice(softIdx + raw.length > cleaned.length ? softIdx + head.length : softIdx + raw.length);
      const trimmed = after.replace(/^[\s،,.:：\-–—]+/, "").trim();
      if (trimmed.length >= 12) return trimmed;
    }
  }

  const cut = cleaned.match(MATN_CUT);
  if (cut?.index != null && cut.index > 8) {
    // Keep from the transmission marker onward (matn usually starts at/after it)
    const fromMarker = cleaned.slice(cut.index).trim();
    if (fromMarker.length >= 12) return fromMarker;
  }

  const soft = cleaned.search(SOFT_MATN);
  if (soft > 10) return cleaned.slice(soft).trim();

  // Short encyclopedia style often starts with عن …
  if (/^عن\s/.test(cleaned) && cleaned.length < 800) return cleaned;

  return cleaned;
}

function extractEnglishMatn(english: string): string {
  const cleaned = english.trim();
  if (!cleaned) return "";
  return cleaned
    .replace(/^(narrated(?:\s+by)?\s+[^:]{1,80}:\s*)/i, "")
    .replace(/^(it is narrated(?:\s+on the authority of)?[^:]{0,80}:\s*)/i, "")
    .replace(/^(from\s+[^:]{1,60}:\s*)/i, "")
    .trim();
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
  for (let i = 0; i <= wordList.length - size; i += 1) {
    out.add(wordList.slice(i, i + size).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function wordContainment(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const longSet = new Set(longer);
  let hit = 0;
  for (const w of shorter) if (longSet.has(w)) hit += 1;
  return hit / shorter.length;
}

function sourceLabel(v: LoadedVariation): string {
  const book = v.books?.title ?? "Untitled";
  return `${book} [${v.sourceHost}]`;
}

function sitePairKey(a: string, b: string): string {
  return [a, b].sort().join(" vs ");
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

async function fetchChains(sb: SupabaseClient, variationIds: number[]): Promise<Chain[]> {
  const out: Chain[] = [];
  for (let i = 0; i < variationIds.length; i += 200) {
    const chunk = variationIds.slice(i, i + 200);
    const { data, error } = await sb
      .from("chains")
      .select("*, chain_narrators(*, narrators(*))")
      .in("variation_id", chunk)
      .order("chain_number");
    if (error) throw error;
    out.push(...((data ?? []) as Chain[]));
  }
  return out;
}

async function loadBundle(sb: SupabaseClient): Promise<{
  variations: LoadedVariation[];
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>;
  fingerprint: Fingerprint;
}> {
  const raw = await fetchAllVariations(sb);
  const ids = raw.map((r) => r.id);
  const [chains, hadithAssessments, narratorAssessments] = await Promise.all([
    fetchChains(sb, ids),
    (async () => {
      const out: HadithAssessment[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from("hadith_assessments").select("*").in("variation_id", ids.slice(i, i + 200));
        if (error) throw error;
        out.push(...((data ?? []) as HadithAssessment[]));
      }
      return out;
    })(),
    (async () => {
      const { data, error } = await sb.from("narrator_assessments").select("*");
      if (error) throw error;
      return (data ?? []) as NarratorAssessment[];
    })(),
  ]);

  const chainsByVar = new Map<number, Chain[]>();
  for (const c of chains) {
    const list = chainsByVar.get(c.variation_id) ?? [];
    list.push({
      ...c,
      chain_narrators: [...(c.chain_narrators ?? [])].sort((a, b) => a.position - b.position),
    });
    chainsByVar.set(c.variation_id, list);
  }

  const assessmentsByVar = new Map<number, HadithAssessment[]>();
  for (const a of hadithAssessments) {
    const list = assessmentsByVar.get(a.variation_id) ?? [];
    list.push(a);
    assessmentsByVar.set(a.variation_id, list);
  }

  const assessmentsByNarratorId = new Map<number, NarratorAssessment[]>();
  for (const row of narratorAssessments) {
    const list = assessmentsByNarratorId.get(row.narrator_id) ?? [];
    list.push(row);
    assessmentsByNarratorId.set(row.narrator_id, list);
  }

  let sumIds = 0;
  let maxId = 0;
  let arabicChars = 0;
  let englishChars = 0;

  const variations: LoadedVariation[] = raw.map((row) => {
    const book = one(row.books as Book | Book[] | null);
    const host = hostOf(row.source_url);
    const varChains = chainsByVar.get(row.id) ?? [];
    const matnArabic = extractArabicMatn(row.arabic_text ?? "", varChains);
    const matnEnglish = extractEnglishMatn(row.english_text ?? "");
    const normArabic = normalizeMatnArabic(matnArabic);
    const normEnglish = normalizeMatnEnglish(matnEnglish);
    sumIds += row.id;
    maxId = Math.max(maxId, row.id);
    arabicChars += (row.arabic_text ?? "").length;
    englishChars += (row.english_text ?? "").length;
    return {
      ...row,
      books: book,
      sourceHost: host,
      tradition: detectTradition(host, book),
      collectionKey: collectionKey(book?.title),
      matnArabic,
      matnEnglish,
      normArabic,
      normEnglish,
      arabicHash: hashText(normArabic),
      englishHash: hashText(normEnglish),
      chains: varChains,
      hadith_assessments: assessmentsByVar.get(row.id) ?? [],
    };
  });

  const fingerprintPayload = `${variations.length}|${maxId}|${sumIds}|${arabicChars}|${englishChars}`;
  const fingerprint: Fingerprint = {
    variation_count: variations.length,
    max_id: maxId,
    sum_ids: sumIds,
    arabic_chars: arabicChars,
    english_chars: englishChars,
    hash: createHash("sha256").update(fingerprintPayload).digest("hex"),
  };

  return { variations, assessmentsByNarratorId, fingerprint };
}

function comparePair(a: LoadedVariation, b: LoadedVariation): PairEdge | null {
  const crossTradition =
    a.tradition !== "unknown" && b.tradition !== "unknown" && a.tradition !== b.tradition;
  // HadeethEnc is shortened/reworded and uses encyclopedia IDs — never auto HIGH/EXACT vs others
  // except true identical normalised Arabic hash (still demoted if cross-tradition).
  const involvesHadeethEnc =
    a.sourceHost.includes("hadeethenc") || b.sourceHost.includes("hadeethenc");

  const aAr = shingles(words(a.normArabic));
  const bAr = shingles(words(b.normArabic));
  const aEn = shingles(words(a.normEnglish));
  const bEn = shingles(words(b.normEnglish));
  const arSim = a.normArabic && b.normArabic ? jaccard(aAr, bAr) : 0;
  const enSim = a.normEnglish && b.normEnglish ? jaccard(aEn, bEn) : 0;
  const containment =
    a.normArabic && b.normArabic
      ? wordContainment(words(a.normArabic), words(b.normArabic))
      : a.normEnglish && b.normEnglish
        ? wordContainment(words(a.normEnglish), words(b.normEnglish))
        : 0;

  const sameCollectionNumber =
    Boolean(a.collectionKey && b.collectionKey && a.collectionKey === b.collectionKey) &&
    Boolean(a.hadith_number && b.hadith_number) &&
    String(a.hadith_number).replace(/^0+/, "") === String(b.hadith_number).replace(/^0+/, "") &&
    !involvesHadeethEnc;

  if (a.arabicHash && b.arabicHash && a.arabicHash === b.arabicHash) {
    if (crossTradition) {
      return { a: a.id, b: b.id, confidence: "REVIEW", similarity: 1, reason: "exact_arabic_cross_tradition" };
    }
    if (involvesHadeethEnc && a.sourceHost !== b.sourceHost) {
      return { a: a.id, b: b.id, confidence: "REVIEW", similarity: 1, reason: "exact_arabic_hadeethenc_pair" };
    }
    return { a: a.id, b: b.id, confidence: "EXACT", similarity: 1, reason: "exact_arabic_hash" };
  }

  if (sameCollectionNumber) {
    if (crossTradition) {
      return {
        a: a.id,
        b: b.id,
        confidence: "REVIEW",
        similarity: Math.max(arSim, enSim, 0.9),
        reason: `same_collection_number_cross_tradition:${a.collectionKey}#${a.hadith_number}`,
      };
    }
    return {
      a: a.id,
      b: b.id,
      confidence: "HIGH",
      similarity: Math.max(arSim, enSim, 0.9),
      reason: `same_collection_number:${a.collectionKey}#${a.hadith_number}`,
    };
  }

  if (arSim >= 0.85) {
    if (crossTradition || involvesHadeethEnc) {
      return {
        a: a.id,
        b: b.id,
        confidence: "REVIEW",
        similarity: arSim,
        reason: involvesHadeethEnc ? "arabic_jaccard_hadeethenc" : "arabic_jaccard_cross_tradition",
      };
    }
    return { a: a.id, b: b.id, confidence: "HIGH", similarity: arSim, reason: "arabic_jaccard_high" };
  }

  if (arSim >= 0.6) {
    return { a: a.id, b: b.id, confidence: "REVIEW", similarity: arSim, reason: "arabic_jaccard_review" };
  }

  if (containment >= 0.85 && Math.max(arSim, enSim) < 0.85) {
    return {
      a: a.id,
      b: b.id,
      confidence: "REVIEW",
      similarity: Math.max(arSim, enSim, containment * 0.9),
      reason: crossTradition ? "abridged_cross_tradition" : "abridged_or_partial",
    };
  }

  // English-only similarity (no usable Arabic on one or both, or Arabic too weak)
  if ((!a.normArabic || !b.normArabic || arSim < 0.6) && enSim >= 0.6) {
    return {
      a: a.id,
      b: b.id,
      confidence: "REVIEW",
      similarity: enSim,
      reason: crossTradition ? "english_only_cross_tradition" : "english_only_similarity",
    };
  }

  return null;
}

function groupConfidence(edges: PairEdge[]): Confidence {
  if (edges.some((e) => e.confidence === "EXACT")) return "EXACT";
  if (edges.some((e) => e.confidence === "HIGH")) return "HIGH";
  return "REVIEW";
}

function buildGroups(
  variations: LoadedVariation[],
  edges: PairEdge[],
): { groups: Map<string, { confidence: Confidence; memberIds: number[]; edges: PairEdge[] }>; uniqueIds: number[] } {
  const byId = new Map(variations.map((v) => [v.id, v]));
  const mergeEdges = edges.filter((e) => e.confidence === "EXACT" || e.confidence === "HIGH");
  const reviewEdges = edges.filter((e) => e.confidence === "REVIEW");

  const ufMerge = new UnionFind();
  for (const v of variations) ufMerge.find(v.id);
  for (const e of mergeEdges) ufMerge.union(e.a, e.b);

  const mergeComponents = new Map<number, number[]>();
  for (const v of variations) {
    const root = ufMerge.find(v.id);
    const list = mergeComponents.get(root) ?? [];
    list.push(v.id);
    mergeComponents.set(root, list);
  }

  const assigned = new Set<number>();
  const groups = new Map<string, { confidence: Confidence; memberIds: number[]; edges: PairEdge[] }>();
  let gExact = 0;
  let gHigh = 0;

  for (const [, memberIds] of mergeComponents) {
    if (memberIds.length < 2) continue;
    const componentEdges = mergeEdges.filter((e) => memberIds.includes(e.a) && memberIds.includes(e.b));
    const conf = groupConfidence(componentEdges);
    const gid = conf === "EXACT" ? `E${++gExact}` : `H${++gHigh}`;
    groups.set(gid, { confidence: conf, memberIds: [...memberIds].sort((a, b) => a - b), edges: componentEdges });
    for (const id of memberIds) assigned.add(id);
  }

  // REVIEW: anchor-based clusters (not transitive single-linkage) to avoid mega-groups
  // where A~B and B~C but A ≁ C.
  const leftovers = variations.map((v) => v.id).filter((id) => !assigned.has(id));
  const leftoverSet = new Set(leftovers);
  const reviewAmong = reviewEdges
    .filter((e) => leftoverSet.has(e.a) && leftoverSet.has(e.b))
    .sort((a, b) => b.similarity - a.similarity);

  const reviewAdj = new Map<number, PairEdge[]>();
  for (const e of reviewAmong) {
    if (!reviewAdj.has(e.a)) reviewAdj.set(e.a, []);
    if (!reviewAdj.has(e.b)) reviewAdj.set(e.b, []);
    reviewAdj.get(e.a)!.push(e);
    reviewAdj.get(e.b)!.push(e);
  }

  const reviewUnassigned = new Set(leftovers);
  let gReview = 0;
  const seedOrder = [...leftovers].sort((a, b) => {
    const va = byId.get(a)!;
    const vb = byId.get(b)!;
    return textCompleteness(vb) - textCompleteness(va);
  });

  for (const seed of seedOrder) {
    if (!reviewUnassigned.has(seed)) continue;
    const memberIds = [seed];
    const usedEdges: PairEdge[] = [];
    const candidates = (reviewAdj.get(seed) ?? [])
      .map((e) => ({ edge: e, other: e.a === seed ? e.b : e.a }))
      .filter((c) => reviewUnassigned.has(c.other))
      .sort((a, b) => b.edge.similarity - a.edge.similarity);
    for (const c of candidates) {
      // Require direct edge to seed (anchor), not only to another member
      memberIds.push(c.other);
      usedEdges.push(c.edge);
    }
    if (memberIds.length < 2) continue;
    const gid = `R${++gReview}`;
    groups.set(gid, {
      confidence: "REVIEW",
      memberIds: [...memberIds].sort((a, b) => a - b),
      edges: usedEdges,
    });
    for (const id of memberIds) {
      reviewUnassigned.delete(id);
      assigned.add(id);
    }
  }

  const uniqueIds = variations.map((v) => v.id).filter((id) => !assigned.has(id));
  return { groups, uniqueIds };
}

function authorityScore(v: LoadedVariation): number {
  let score = 0;
  if (v.sourceHost.includes("sunnah.com")) score += 100;
  else if (v.sourceHost.includes("thaqalayn")) score += 40;
  else if (v.sourceHost.includes("hadeethenc")) score += 10;
  else score += 20;

  const title = (v.books?.title ?? "").toLowerCase();
  if (/sahih al-bukhari|sahīh muslim|sahih muslim/.test(title)) score += 50;
  else if (v.collectionKey === "bukhari" || v.collectionKey === "muslim") score += 30;
  else if (v.collectionKey) score += 15;

  score += Math.min(40, Math.floor(((v.arabic_text?.length ?? 0) + (v.english_text?.length ?? 0)) / 80));
  const nodes = v.chains.reduce((n, c) => n + (c.chain_narrators?.length ?? 0), 0);
  score += Math.min(20, nodes);
  if (v.hadith_assessments.length) score += 5;
  return score;
}

function textCompleteness(v: LoadedVariation): number {
  return (v.arabic_text?.trim().length ?? 0) + (v.english_text?.trim().length ?? 0);
}

function pickCanonical(members: LoadedVariation[]): LoadedVariation {
  return [...members].sort((a, b) => {
    const auth = authorityScore(b) - authorityScore(a);
    if (auth !== 0) return auth;
    return textCompleteness(b) - textCompleteness(a);
  })[0];
}

function matrixRow(
  groupId: string,
  confidence: Confidence,
  v: LoadedVariation,
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>,
): Record<string, string | number | boolean> {
  const detail: SourceVariationDetail = {
    ...v,
    books: v.books,
    chains: v.chains,
    hadith_assessments: v.hadith_assessments,
  };
  const elig = evaluateVariationEligibility(detail, assessmentsByNarratorId);

  const allNodes = v.chains.flatMap((c) => c.chain_narrators ?? []);
  const unresolved = allNodes.filter((n) => n.narrator_id == null).length;
  const linkedIds = [...new Set(allNodes.map((n) => n.narrator_id).filter((id): id is number => id != null))];
  const withAssess = linkedIds.filter((id) => (assessmentsByNarratorId.get(id) ?? []).length > 0).length;
  const chainVerified = v.chains.some((c) => c.verified);
  const narratorsVerified = linkedIds.length
    ? linkedIds.every((id) => {
        const n = allNodes.find((cn) => cn.narrator_id === id);
        const narrator = n ? one(n.narrators) : null;
        return narrator?.identity_status === "verified";
      })
    : false;
  const assessmentsVerified = linkedIds.length
    ? linkedIds.every((id) => (assessmentsByNarratorId.get(id) ?? []).some((a) => a.verified))
    : false;

  return {
    group_id: groupId,
    confidence,
    variation_id: v.id,
    source: sourceLabel(v),
    hadith_number: v.hadith_number ?? "",
    has_arabic: Boolean(v.arabic_text?.trim()),
    has_english: Boolean(v.english_text?.trim()),
    has_grading: v.hadith_assessments.length,
    chain_count: v.chains.length,
    chain_nodes: allNodes.length,
    unresolved_nodes: unresolved,
    narrators_linked: linkedIds.length,
    narrators_with_assessments: withAssess,
    narrators_total: linkedIds.length,
    chain_verified: chainVerified,
    narrators_verified: narratorsVerified,
    assessments_verified: assessmentsVerified,
    eligible: elig.eligible,
    fails_rules: elig.failures.map((f) => f.rule).join("|") || "",
  };
}

function memberContribution(v: LoadedVariation, elig: boolean, fails: string[]): GroupMemberPlan {
  const hasChain = v.chains.some((c) => (c.chain_narrators?.length ?? 0) > 0);
  const hasGrading = v.hadith_assessments.length > 0;
  const contributes: string[] = [];
  if (v.arabic_text?.trim()) contributes.push("arabic_text");
  if (v.english_text?.trim()) contributes.push("english_text");
  if (hasChain) contributes.push("chain");
  if (hasGrading) contributes.push("hadith_grading");
  const linked = v.chains.flatMap((c) => c.chain_narrators ?? []).filter((n) => n.narrator_id != null);
  if (linked.length) contributes.push("linked_narrators");

  let display: GroupMemberPlan["display"] = "incomplete";
  if (elig) display = "complete";
  else if (!hasChain && (v.arabic_text || v.english_text) && hasGrading) display = "text_and_grading_only";
  else if (!hasChain && (v.arabic_text || v.english_text)) display = "text_and_grading_only";

  return {
    variation_id: v.id,
    source: sourceLabel(v),
    hadith_number: v.hadith_number,
    role: "member",
    contributes,
    eligible: elig,
    fails_rules: fails,
    display,
  };
}

function summarizeMatrixGaps(
  groups: Map<string, { confidence: Confidence; memberIds: number[]; edges: PairEdge[] }>,
  byId: Map<number, LoadedVariation>,
  assessmentsByNarratorId: Map<number, NarratorAssessment[]>,
): void {
  let chainGap = 0;
  let assessGap = 0;
  let noneComplete = 0;

  for (const [gid, g] of groups) {
    if (g.memberIds.length < 2) continue;
    const members = g.memberIds.map((id) => byId.get(id)!);
    const hasChainFlags = members.map((v) => v.chains.some((c) => (c.chain_narrators?.length ?? 0) > 0));
    if (hasChainFlags.some(Boolean) && hasChainFlags.some((x) => !x)) chainGap += 1;

    const hasAssess = members.map((v) => {
      const nodes = v.chains.flatMap((c) => c.chain_narrators ?? []);
      const linked = [...new Set(nodes.map((n) => n.narrator_id).filter((x): x is number => x != null))];
      return linked.some((id) => (assessmentsByNarratorId.get(id) ?? []).length > 0) || v.hadith_assessments.length > 0;
    });
    if (hasAssess.some(Boolean) && hasAssess.some((x) => !x)) assessGap += 1;

    const anyComplete = members.some((v) => {
      const detail: SourceVariationDetail = { ...v, books: v.books, chains: v.chains, hadith_assessments: v.hadith_assessments };
      return evaluateVariationEligibility(detail, assessmentsByNarratorId).eligible;
    });
    if (!anyComplete) noneComplete += 1;

    const parts = members.map((v, i) => {
      const letter = String.fromCharCode(65 + i);
      const bits: string[] = [];
      if (hasChainFlags[i]) bits.push("chain");
      if (v.hadith_assessments.length) bits.push("grading");
      const nodes = v.chains.flatMap((c) => c.chain_narrators ?? []);
      const linked = nodes.filter((n) => n.narrator_id != null);
      if (linked.length) bits.push("assessments");
      if (!bits.length) bits.push("text only");
      return `${letter} (${v.sourceHost}) has ${bits.join("+")}`;
    });
    console.log(`  Group ${gid}: ${parts.join("; ")}.`);
  }

  console.log(`\nGap counts:`);
  console.log(`  groups where one copy has a chain and others do not: ${chainGap}`);
  console.log(`  groups where one copy has assessments/grading and others have none: ${assessGap}`);
  console.log(`  groups where no copy is complete (eligible a–d): ${noneComplete}`);
}

async function dryRun() {
  console.log("STEP 0 — how variations link to hadiths");
  console.log("  Column: source_variations.hadith_id → hadiths.id");
  const sb = adminClient();
  const { variations, assessmentsByNarratorId, fingerprint } = await loadBundle(sb);

  const hadithCounts = new Map<number, number>();
  for (const v of variations) hadithCounts.set(v.hadith_id, (hadithCounts.get(v.hadith_id) ?? 0) + 1);
  const top = [...hadithCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(
    `  All ${variations.length} variations currently point at ${hadithCounts.size} hadiths row(s); top: hadith_id=${top?.[0]} with ${top?.[1]} variations.`,
  );
  console.log("");

  const byId = new Map(variations.map((v) => [v.id, v]));
  const edges: PairEdge[] = [];
  for (let i = 0; i < variations.length; i += 1) {
    for (let j = i + 1; j < variations.length; j += 1) {
      const edge = comparePair(variations[i], variations[j]);
      if (edge) edges.push(edge);
    }
  }

  const { groups, uniqueIds } = buildGroups(variations, edges);

  mkdirSync(DATA_DIR, { recursive: true });

  // --- Phase 1 CSV ---
  const reportLines = [
    "group_id,confidence,variation_id,source,hadith_number,matn_preview,similarity_to_group_anchor",
  ];
  const confCounts = { EXACT: 0, HIGH: 0, REVIEW: 0 };
  const pairCounts = new Map<string, number>();

  for (const [gid, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    confCounts[g.confidence] += 1;
    const members = g.memberIds.map((id) => byId.get(id)!);
    const anchor = pickCanonical(members);
    const anchorShingles = anchor.normArabic
      ? shingles(words(anchor.normArabic))
      : shingles(words(anchor.normEnglish));

    for (const m of members) {
      const sim =
        m.id === anchor.id
          ? 1
          : m.normArabic && anchor.normArabic
            ? jaccard(shingles(words(m.normArabic)), anchorShingles)
            : m.normEnglish && anchor.normEnglish
              ? jaccard(shingles(words(m.normEnglish)), shingles(words(anchor.normEnglish)))
              : 0;
      const preview = (m.matnArabic || m.matnEnglish || "").replace(/\s+/g, " ").slice(0, 80);
      reportLines.push(
        [
          gid,
          g.confidence,
          m.id,
          sourceLabel(m),
          m.hadith_number ?? "",
          preview,
          sim.toFixed(3),
        ]
          .map(csvEscape)
          .join(","),
      );

      if (m.id !== anchor.id) {
        const pk = sitePairKey(m.sourceHost, anchor.sourceHost);
        pairCounts.set(pk, (pairCounts.get(pk) ?? 0) + 1);
      }
    }

    // Also count all pairwise source sites inside the group
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const pk = sitePairKey(members[i].sourceHost, members[j].sourceHost);
        // counted above relative to anchor; keep a separate all-pairs map
        void pk;
      }
    }
  }

  // Source-pair counts from edges (clearer)
  const edgePairCounts = new Map<string, number>();
  for (const e of edges) {
    const a = byId.get(e.a)!;
    const b = byId.get(e.b)!;
    const pk = `${sitePairKey(a.sourceHost, b.sourceHost)} (${e.confidence})`;
    edgePairCounts.set(pk, (edgePairCounts.get(pk) ?? 0) + 1);
  }

  writeFileSync(REPORT_CSV, reportLines.join("\n") + "\n", "utf8");

  console.log("PHASE 1 — duplicate detection");
  console.log(`  Total variations: ${variations.length}`);
  console.log(`  Groups with 2+ members: ${groups.size}`);
  console.log(`  Groups per confidence: EXACT=${confCounts.EXACT} HIGH=${confCounts.HIGH} REVIEW=${confCounts.REVIEW}`);
  console.log(`  Unique variations (no match): ${uniqueIds.length}`);
  console.log("  Counts by source pair (edges):");
  for (const [k, n] of [...edgePairCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${n}`);
  }
  console.log(`  Wrote ${REPORT_CSV}`);

  // --- Phase 2 matrix ---
  const matrixHeader = [
    "group_id",
    "confidence",
    "variation_id",
    "source",
    "hadith_number",
    "has_arabic",
    "has_english",
    "has_grading",
    "chain_count",
    "chain_nodes",
    "unresolved_nodes",
    "narrators_linked",
    "narrators_with_assessments",
    "narrators_total",
    "chain_verified",
    "narrators_verified",
    "assessments_verified",
    "eligible",
    "fails_rules",
  ];
  const matrixLines = [matrixHeader.join(",")];
  console.log("\nPHASE 2 — data matrix summaries");
  for (const [gid, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const id of g.memberIds) {
      const row = matrixRow(gid, g.confidence, byId.get(id)!, assessmentsByNarratorId);
      matrixLines.push(matrixHeader.map((h) => csvEscape(row[h])).join(","));
    }
  }
  writeFileSync(MATRIX_CSV, matrixLines.join("\n") + "\n", "utf8");
  summarizeMatrixGaps(groups, byId, assessmentsByNarratorId);
  console.log(`  Wrote ${MATRIX_CSV}`);

  // --- Phase 3 merge plan ---
  console.log("\nPHASE 3 — combine plan (dry-run, no writes)");
  const mergeGroups: MergeGroupPlan[] = [];
  const reviewGroups: MergeGroupPlan[] = [];

  for (const [gid, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const members = g.memberIds.map((id) => byId.get(id)!);
    const memberPlans: GroupMemberPlan[] = members.map((v) => {
      const detail: SourceVariationDetail = {
        ...v,
        books: v.books,
        chains: v.chains,
        hadith_assessments: v.hadith_assessments,
      };
      const elig = evaluateVariationEligibility(detail, assessmentsByNarratorId);
      return memberContribution(
        v,
        elig.eligible,
        elig.failures.map((f) => f.rule),
      );
    });

    const anyEligible = memberPlans.some((m) => m.eligible);
    const notes: string[] = [
      "Chains stay bound to their own variation_id.",
      "Narrator assessments are not copied between narrator records.",
      "No variation/chain/narrator/assessment is deleted.",
      "New/changed hadiths rows would be review_status=draft.",
    ];

    if (g.confidence === "REVIEW") {
      const plan: MergeGroupPlan = {
        group_id: gid,
        confidence: "REVIEW",
        status: "review_only",
        canonical_variation_id: null,
        members: memberPlans,
        notes: [...notes, "REVIEW groups are listed for decision and not auto-merged."],
      };
      reviewGroups.push(plan);
      console.log(
        `  ${gid} REVIEW (not merged): members=${memberPlans.map((m) => `${m.variation_id}@${m.source}`).join(" | ")}`,
      );
      continue;
    }

    const canonical = pickCanonical(members);
    for (const m of memberPlans) {
      if (m.variation_id === canonical.id) m.role = "canonical";
    }
    const plan: MergeGroupPlan = {
      group_id: gid,
      confidence: g.confidence,
      status: anyEligible ? "eligible" : "not_eligible",
      canonical_variation_id: canonical.id,
      members: memberPlans,
      notes,
    };
    mergeGroups.push(plan);

    console.log(`  ${gid} ${g.confidence}:`);
    console.log(`    canonical: ${canonical.id} ${sourceLabel(canonical)} #${canonical.hadith_number ?? "—"}`);
    for (const m of memberPlans) {
      if (m.variation_id === canonical.id) continue;
      console.log(
        `    other: ${m.variation_id} ${m.source} → ${m.contributes.join(", ") || "nothing"} (${m.display})`,
      );
    }
    console.log(`    group status: ${plan.status}`);
  }

  // Singletons as one-member groups for eligibility:groups
  const singletonPlans: MergeGroupPlan[] = uniqueIds.map((id) => {
    const v = byId.get(id)!;
    const detail: SourceVariationDetail = {
      ...v,
      books: v.books,
      chains: v.chains,
      hadith_assessments: v.hadith_assessments,
    };
    const elig = evaluateVariationEligibility(detail, assessmentsByNarratorId);
    const member = memberContribution(
      v,
      elig.eligible,
      elig.failures.map((f) => f.rule),
    );
    member.role = "canonical";
    return {
      group_id: `U${id}`,
      confidence: "EXACT" as Confidence, // unused for unique
      status: elig.eligible ? ("eligible" as const) : ("not_eligible" as const),
      canonical_variation_id: id,
      members: [member],
      notes: ["Unique variation (no matn match); own group."],
    };
  });

  const planFile: MergePlanFile = {
    generated_at: new Date().toISOString(),
    fingerprint,
    summary: {
      total_variations: variations.length,
      multi_groups: groups.size,
      exact_groups: confCounts.EXACT,
      high_groups: confCounts.HIGH,
      review_groups: confCounts.REVIEW,
      unique_variations: uniqueIds.length,
      mergeable_groups: mergeGroups.length,
      eligible_mergeable_groups: mergeGroups.filter((g) => g.status === "eligible").length,
    },
    // Every variation appears in exactly one entry: mergeable, review-only, or unique singleton.
    groups: [...mergeGroups, ...reviewGroups, ...singletonPlans],
    review_groups: reviewGroups,
    unique_variation_ids: uniqueIds,
  };

  writeFileSync(MERGE_PLAN, JSON.stringify(planFile, null, 2), "utf8");
  writeFileSync(FINGERPRINT, JSON.stringify(fingerprint, null, 2), "utf8");
  console.log(`  Wrote ${MERGE_PLAN}`);
  console.log(`  Wrote ${FINGERPRINT}`);

  // Bukhari 1–7 cross-source check
  const bukhari17 = variations.filter(
    (v) =>
      v.collectionKey === "bukhari" &&
      v.sourceHost.includes("sunnah.com") &&
      ["1", "2", "3", "4", "5", "6", "7"].includes(String(v.hadith_number ?? "")),
  );
  console.log("\n--- Bukhari 1–7 (Sunnah.com) vs other sources ---");
  for (const [gid, g] of groups) {
    const members = g.memberIds.map((id) => byId.get(id)!);
    const hasB = members.some((m) => bukhari17.some((b) => b.id === m.id));
    if (!hasB) continue;
    const others = members.filter((m) => !bukhari17.some((b) => b.id === m.id));
    if (!others.length) continue;
    console.log(
      `  ${gid} (${g.confidence}): Bukhari#${members.find((m) => bukhari17.some((b) => b.id === m.id))?.hadith_number} with ${others.map((o) => `${o.id}@${o.sourceHost}`).join(", ")}`,
    );
  }
  const anyCross = [...groups.values()].some((g) => {
    const members = g.memberIds.map((id) => byId.get(id)!);
    const hasB = members.some((m) => bukhari17.some((b) => b.id === m.id));
    const hasOther = members.some((m) => !bukhari17.some((b) => b.id === m.id));
    return hasB && hasOther;
  });
  console.log(
    anyCross
      ? "  Result: yes — at least one group mixes Sahih al-Bukhari 1–7 with another source."
      : "  Result: no group mixes Sahih al-Bukhari 1–7 with another source.",
  );

  console.log("\nSTOP — dry-run complete. Do not apply until you say apply.");
  console.log(
    `Plain summary: EXACT groups=${confCounts.EXACT}, HIGH groups=${confCounts.HIGH}, REVIEW groups=${confCounts.REVIEW}; unique=${uniqueIds.length}.`,
  );
}

async function currentFingerprint(sb: SupabaseClient): Promise<Fingerprint> {
  const { variations, fingerprint } = await loadBundle(sb);
  void variations;
  return fingerprint;
}

async function applyMerge() {
  if (!existsSync(MERGE_PLAN) || !existsSync(FINGERPRINT)) {
    throw new Error("Missing dry-run artifacts. Run npm run hadith:dedupe first.");
  }
  const plan = JSON.parse(readFileSync(MERGE_PLAN, "utf8")) as MergePlanFile;
  const stored = JSON.parse(readFileSync(FINGERPRINT, "utf8")) as Fingerprint;

  const sb = adminClient();
  const live = await currentFingerprint(sb);
  if (live.hash !== stored.hash || live.variation_count !== stored.variation_count) {
    console.error("Dry-run report is older than current source_variations data.");
    console.error(`  stored hash=${stored.hash} count=${stored.variation_count}`);
    console.error(`  live   hash=${live.hash} count=${live.variation_count}`);
    console.error("Re-run: npm run hadith:dedupe");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for --apply (single transaction)");
  }

  const mergeable = plan.groups.filter(
    (g) =>
      (g.confidence === "EXACT" || g.confidence === "HIGH") &&
      g.members.length >= 2 &&
      g.canonical_variation_id != null,
  );
  if (!mergeable.length) {
    console.log("No EXACT/HIGH multi-member groups to apply.");
    return;
  }

  const runId = createHash("sha256").update(`${Date.now()}-${live.hash}`).digest("hex").slice(0, 12);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.hadith_merge_backup (
        id bigint generated always as identity primary key,
        variation_id bigint not null,
        old_hadith_id bigint not null,
        new_hadith_id bigint,
        run_id text not null,
        created_at timestamptz not null default now()
      )
    `);

    let hadithRows = 0;
    let variationRows = 0;
    let backupRows = 0;

    for (const g of mergeable) {
      const canonical = g.members.find((m) => m.variation_id === g.canonical_variation_id) ?? g.members[0];
      const slugBase = `merged-${g.group_id.toLowerCase()}-${canonical.variation_id}`;
      const title = `Merged ${g.group_id}: ${canonical.source}`;
      const insert = await client.query<{ id: number }>(
        `INSERT INTO public.hadiths (slug, title, summary, topics, review_status)
         VALUES ($1, $2, $3, $4, 'draft')
         ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
         RETURNING id`,
        [slugBase, title.slice(0, 200), `Dry-run merge group ${g.group_id}`, ["dedupe-merge"]],
      );
      const newHadithId = insert.rows[0].id;
      hadithRows += 1;

      for (const m of g.members) {
        const old = await client.query<{ hadith_id: number }>(
          `SELECT hadith_id FROM public.source_variations WHERE id = $1`,
          [m.variation_id],
        );
        const oldHadithId = old.rows[0]?.hadith_id;
        if (oldHadithId == null) continue;
        await client.query(
          `INSERT INTO public.hadith_merge_backup (variation_id, old_hadith_id, new_hadith_id, run_id)
           VALUES ($1, $2, $3, $4)`,
          [m.variation_id, oldHadithId, newHadithId, runId],
        );
        backupRows += 1;
        await client.query(`UPDATE public.source_variations SET hadith_id = $1 WHERE id = $2`, [
          newHadithId,
          m.variation_id,
        ]);
        variationRows += 1;
      }
    }

    await client.query("COMMIT");
    console.log("Apply complete.");
    console.log(`  run_id: ${runId}`);
    console.log(`  rows changed: hadiths≈${hadithRows}, source_variations=${variationRows}, hadith_merge_backup=${backupRows}`);
    console.log("  Chains, chain_narrators, narrators, assessments: unchanged.");
    console.log("\nRollback SQL (restores old variation→hadith links for this run):");
    console.log(`  BEGIN;`);
    console.log(`  UPDATE public.source_variations sv`);
    console.log(`  SET hadith_id = b.old_hadith_id`);
    console.log(`  FROM public.hadith_merge_backup b`);
    console.log(`  WHERE sv.id = b.variation_id AND b.run_id = '${runId}';`);
    console.log(`  -- Optional: delete draft hadiths created in this run if unused`);
    console.log(`  COMMIT;`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

async function main() {
  if (APPLY) {
    await applyMerge();
  } else {
    await dryRun();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
