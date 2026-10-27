/**
 * Make Bukhari variations a–d eligible (minChainNodes≥2) and publish them:
 *   1) scrape sunnah.com/bukhari:{N} arabic_sanad for stub chains
 *   2) resolve/create narrators (alias sunnah:{id})
 *   3) scrape Critical Appraisals for every uncited chain narrator
 *   4) verify chains when all nodes have cited assessments
 *   5) publish full-isnad eligible variations topic-wise
 *
 *   npx tsx scripts/collectors/scrape-full-isnad-and-publish.ts
 *   npx tsx scripts/collectors/scrape-full-isnad-and-publish.ts --apply --limit=5
 *   npx tsx scripts/collectors/scrape-full-isnad-and-publish.ts --apply
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as cheerio from "cheerio";
import { chromium, type BrowserContext } from "playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEligibleVariations } from "../../lib/eligible-variations";
import { evaluateVariationEligibility } from "../../lib/first-wahi-eligibility";
import type { NarratorAssessment, SourceVariationDetail } from "../../lib/types";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 0;
const skipAppraisals = process.argv.includes("--skip-appraisals");
const skipPublish = process.argv.includes("--skip-publish");

const RAW_DIR = path.join(process.cwd(), "data", "raw");
const OUT_DIR = path.join(process.cwd(), "data", "unmatched");
const PROGRESS_PATH = path.join(OUT_DIR, "full-isnad-progress.json");
const SUMMARY_PATH = path.join(OUT_DIR, "full-isnad-summary.json");
const MAPPING_METHOD = "sunnah_com_import";
const USER_AGENT =
  "HadithCollectionResearchBot/1.0 (+full-isnad scrape for eligible publish)";
const REQUEST_GAP_MS = 1600;

type SunnahLink = { sunnahId: string; linkText: string; titleName: string };

type Progress = {
  scrapedHadith: Record<string, { links: number; branches: number; ok: boolean; error?: string }>;
  appraisalsDone: string[];
  verifiedChainIds: number[];
  publishedVariationIds: number[];
};

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function normalizeWs(s: string) {
  return s.replace(/\s+/g, " ").trim();
}
function stripHarakat(s: string) {
  return s.normalize("NFD").replace(/[\u064B-\u065F\u0670]/g, "");
}
function scholarSlug(name: string) {
  return `sunnah-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
}
function citationBookFromWording(term: string): string {
  for (const p of [/تحرير تقريب التهذيب/, /تقريب التهذيب/, /التقريب/, /الثقات/, /الكاشف/, /الضعفاء والمتروكين/]) {
    const m = term.match(p);
    if (m) return m[0];
  }
  return "";
}

function loadProgress(): Progress {
  if (!existsSync(PROGRESS_PATH)) {
    return { scrapedHadith: {}, appraisalsDone: [], verifiedChainIds: [], publishedVariationIds: [] };
  }
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as Progress;
  } catch {
    return { scrapedHadith: {}, appraisalsDone: [], verifiedChainIds: [], publishedVariationIds: [] };
  }
}
function saveProgress(p: Progress) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2), "utf8");
}

function parseHrefTitle(href: string, text: string, title: string): SunnahLink | null {
  const m = href.match(/\/narrator\/(\d+)/);
  if (!m) return null;
  return {
    sunnahId: m[1],
    linkText: normalizeWs(text),
    titleName: normalizeWs(title),
  };
}

function linksFromHtmlChunk(chunkHtml: string): SunnahLink[] {
  const $ = cheerio.load(`<div id="root">${chunkHtml}</div>`);
  const links: SunnahLink[] = [];
  $("#root a[href*='/narrator/']").each((_, el) => {
    const parsed = parseHrefTitle($(el).attr("href") ?? "", $(el).text(), $(el).attr("title") ?? "");
    if (parsed) links.push(parsed);
  });
  return links;
}

function expandWawPeers(links: SunnahLink[]): SunnahLink[][] {
  if (links.length < 3) return [links];
  const peerIdxs: number[] = [];
  links.forEach((l, idx) => {
    const t = stripHarakat(l.linkText).replace(/\s+/g, "");
    if (/^و/.test(t) && idx > 0) peerIdxs.push(idx);
  });
  if (!peerIdxs.length) return [links];
  const forkAt = peerIdxs[0];
  const peerPrev = forkAt - 1;
  if (peerPrev < 0 || forkAt >= links.length) return [links];
  const prefix = links.slice(0, peerPrev);
  const peers = [links[peerPrev], links[forkAt]].map((p) => ({
    ...p,
    linkText: stripHarakat(p.linkText).replace(/^\s*و\s*/, "").trim() || p.linkText,
  }));
  const suffix = links.slice(forkAt + 1);
  return peers.map((peer) => [...prefix, peer, ...suffix]);
}

function truncateBranchAtNahwahu(inner: string): string {
  const plain = stripHarakat(inner);
  const idx = plain.indexOf("نحوه");
  if (idx <= 0) return inner;
  let strippedLen = 0;
  for (let i = 0; i < inner.length; i++) {
    if (!/[\u064B-\u065F\u0670]/.test(inner[i])) strippedLen += 1;
    if (strippedLen >= idx) return inner.slice(0, i);
  }
  return inner;
}

function extractSunnahLinks(html: string): { all: SunnahLink[]; branches: SunnahLink[][]; sanadText: string } {
  const $ = cheerio.load(html);
  const sanad = $("span.arabic_sanad, .arabic_sanad").first();
  let inner = sanad.html() ?? "";
  const sanadText = normalizeWs(sanad.text());
  {
    const plain = stripHarakat(inner);
    const idx = plain.indexOf("تابعه");
    if (idx > 0) {
      let strippedLen = 0;
      for (let i = 0; i < inner.length; i++) {
        if (!/[\u064B-\u065F\u0670]/.test(inner[i])) strippedLen += 1;
        if (strippedLen >= idx) {
          inner = inner.slice(0, i);
          break;
        }
      }
    }
  }
  const all = linksFromHtmlChunk(inner);
  const branchHtmls = inner.split(/\sح\s+/);
  const branches: SunnahLink[][] = [];
  for (const chunk of branchHtmls) {
    const trimmed = truncateBranchAtNahwahu(chunk);
    const rawLinks = linksFromHtmlChunk(trimmed);
    for (const b of expandWawPeers(rawLinks)) {
      if (b.length) branches.push(b);
    }
  }
  if (!branches.length) return { all, branches: all.length ? [all] : [], sanadText };
  return { all, branches, sanadText };
}

let pwContext: BrowserContext | null = null;

async function getPwContext(): Promise<BrowserContext> {
  if (pwContext) return pwContext;
  const profile = path.join(process.cwd(), ".browser-profile", "sunnah");
  mkdirSync(profile, { recursive: true });
  pwContext = await chromium.launchPersistentContext(profile, {
    headless: true,
    userAgent: USER_AGENT,
  });
  return pwContext;
}

async function fetchHtml(url: string, cacheFile: string, okMarker: string): Promise<string> {
  mkdirSync(RAW_DIR, { recursive: true });
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile, "utf8");
    if (cached.length > 800 && cached.includes(okMarker)) return cached;
  }
  await delay(REQUEST_GAP_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (res.ok) {
      const html = await res.text();
      if (html.includes(okMarker) || html.length > 2000) {
        writeFileSync(cacheFile, html, "utf8");
        return html;
      }
    }
  } catch {
    /* Playwright fallback */
  }
  const ctx = await getPwContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
    const html = await page.content();
    if (html.length < 500) throw new Error(`empty page ${url}`);
    writeFileSync(cacheFile, html, "utf8");
    return html;
  } finally {
    await page.close();
  }
}

async function loadHadithHtml(bukhariN: string): Promise<string> {
  const file = path.join(RAW_DIR, `sunnah-bukhari-${bukhariN}.html`);
  return fetchHtml(`https://sunnah.com/bukhari:${bukhariN}`, file, "arabic_sanad");
}

async function loadNarratorHtml(sunnahId: string): Promise<string> {
  const file = path.join(RAW_DIR, `sunnah-narrator-${sunnahId}.html`);
  return fetchHtml(`https://sunnah.com/narrator/${sunnahId}`, file, "hero-title");
}

type AppraisalRow = {
  narrator_sunnah_id: string;
  narrator_name_ar: string;
  scholar_name_ar: string;
  original_term_ar: string;
  citation_book: string;
  source_url: string;
};

function extractAppraisals(sunnahId: string, html: string): AppraisalRow[] {
  const $ = cheerio.load(html);
  const source_url = `https://sunnah.com/narrator/${sunnahId}`;
  const narratorNameAr =
    normalizeWs($("h1.hero-title.arabic").first().text()) ||
    normalizeWs(($("title").text() || "").split("-")[0] || "");
  const rows: AppraisalRow[] = [];
  const section = $("section.mb-section")
    .filter((_, el) => {
      const titles = $(el)
        .find(".section-title")
        .map((__, t) => normalizeWs($(t).text()))
        .get();
      return titles.some((t) => t === "Critical Appraisals" || t === "الجرح والتعديل");
    })
    .first();

  section.find("div.verdict.verdict--ar").each((_, el) => {
    const scholar = normalizeWs($(el).find(".verdict-scholar").first().text());
    const term = normalizeWs($(el).find(".critic-quote").first().text());
    if (!scholar || !term) return;
    if (!/[\u0600-\u06FF]/.test(scholar) || !/[\u0600-\u06FF]/.test(term)) return;
    rows.push({
      narrator_sunnah_id: sunnahId,
      narrator_name_ar: narratorNameAr,
      scholar_name_ar: scholar,
      original_term_ar: term.slice(0, 800),
      citation_book: citationBookFromWording(term),
      source_url,
    });
  });

  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.scholar_name_ar}|${r.original_term_ar}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** sunnahId → narrator_id */
async function loadSunnahNarratorMap(sb: SupabaseClient): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  // aliases sunnah:123
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("name_aliases")
      .select("alias,entity_id")
      .eq("entity_type", "narrator")
      .ilike("alias", "sunnah:%")
      .range(from, from + 999);
    if (!data?.length) break;
    for (const row of data) {
      const m = String(row.alias).match(/^sunnah:(\d+)$/i);
      if (m) map.set(m[1], Number(row.entity_id));
    }
    if (data.length < 1000) break;
  }
  // slugs sunnah-123
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("narrators")
      .select("id,slug")
      .ilike("slug", "sunnah-%")
      .range(from, from + 999);
    if (!data?.length) break;
    for (const row of data) {
      const m = String(row.slug).match(/^sunnah-(\d+)$/i);
      if (m && !map.has(m[1])) map.set(m[1], Number(row.id));
    }
    if (data.length < 1000) break;
  }
  // batch2 mapping
  const mappingPath = path.join("data", "bukhari-batch2-mapping.json");
  if (existsSync(mappingPath)) {
    const doc = JSON.parse(readFileSync(mappingPath, "utf8"));
    for (const row of doc.rows || []) {
      if (row.sunnahId && row.narratorId && !map.has(String(row.sunnahId))) {
        map.set(String(row.sunnahId), Number(row.narratorId));
      }
    }
  }
  return map;
}

async function resolveOrCreateNarrator(
  sb: SupabaseClient,
  link: SunnahLink,
  cache: Map<string, number>,
): Promise<number> {
  const hit = cache.get(link.sunnahId);
  if (hit) return hit;

  const slug = `sunnah-${link.sunnahId}`;
  const arabicName = link.titleName || link.linkText;
  const name = link.titleName || link.linkText;

  const { data: bySlug } = await sb.from("narrators").select("id").eq("slug", slug).maybeSingle();
  if (bySlug) {
    cache.set(link.sunnahId, bySlug.id);
    await ensureAlias(sb, bySlug.id, link.sunnahId);
    return bySlug.id;
  }

  if (!APPLY) {
    const fake = -Number(link.sunnahId);
    cache.set(link.sunnahId, fake);
    return fake;
  }

  const { data: created, error } = await sb
    .from("narrators")
    .insert({
      slug,
      name,
      arabic_name: arabicName,
      alternative_names: link.linkText && link.linkText !== name ? [link.linkText] : [],
      identity_status: "unverified",
    })
    .select("id")
    .single();
  if (error) {
    // race: slug taken
    const { data: again } = await sb.from("narrators").select("id").eq("slug", slug).maybeSingle();
    if (again) {
      cache.set(link.sunnahId, again.id);
      await ensureAlias(sb, again.id, link.sunnahId);
      return again.id;
    }
    throw new Error(`create narrator ${slug}: ${error.message}`);
  }
  cache.set(link.sunnahId, created.id);
  await ensureAlias(sb, created.id, link.sunnahId);
  return created.id;
}

async function ensureAlias(sb: SupabaseClient, narratorId: number, sunnahId: string) {
  if (!APPLY || narratorId < 0) return;
  await sb.from("name_aliases").upsert(
    {
      entity_type: "narrator",
      entity_id: narratorId,
      alias: `sunnah:${sunnahId}`,
      alias_normalized: `sunnah:${sunnahId}`,
      script: "other",
      source_name: "sunnah.com",
      source_url: `https://sunnah.com/narrator/${sunnahId}`,
    },
    { onConflict: "entity_type,entity_id,alias" },
  );
}

async function rewriteChain(
  sb: SupabaseClient,
  variationId: number,
  branches: SunnahLink[][],
  sanadText: string,
  narratorCache: Map<string, number>,
): Promise<{ chainIds: number[]; nodeCount: number; sunnahIds: string[] }> {
  const sunnahIds: string[] = [];
  // ensure primary chain exists
  let { data: existing } = await sb
    .from("chains")
    .select("id,chain_number")
    .eq("variation_id", variationId)
    .order("chain_number");

  if (!existing?.length) {
    if (!APPLY) return { chainIds: [], nodeCount: 0, sunnahIds: [] };
    const { data: created, error } = await sb
      .from("chains")
      .insert({
        variation_id: variationId,
        chain_number: 1,
        raw_chain_text: sanadText || null,
        continuity_status: "unverified",
        quality_status: "unverified",
        verified: false,
        notes: "full isnad scraped from sunnah.com arabic_sanad",
      })
      .select("id,chain_number")
      .single();
    if (error) throw new Error(`create chain: ${error.message}`);
    existing = [created];
  }

  // Use up to 3 branches (tahwil); ensure chain rows exist for each
  const useBranches = branches.filter((b) => b.length >= 2).slice(0, 3);
  if (!useBranches.length && branches[0]?.length) {
    // allow single-link fallback only if that's all we got (won't pass minChainNodes:2)
    useBranches.push(branches[0]);
  }

  const chainIds: number[] = [];
  let nodeCount = 0;

  for (let bi = 0; bi < useBranches.length; bi++) {
    const branch = useBranches[bi];
    const chainNumber = bi + 1;
    let chain = existing.find((c) => c.chain_number === chainNumber);
    if (!chain && APPLY) {
      const { data: created, error } = await sb
        .from("chains")
        .insert({
          variation_id: variationId,
          chain_number: chainNumber,
          raw_chain_text: sanadText || null,
          continuity_status: "unverified",
          quality_status: "unverified",
          verified: false,
          notes: "full isnad scraped from sunnah.com arabic_sanad",
        })
        .select("id,chain_number")
        .single();
      if (error) throw new Error(`create chain #${chainNumber}: ${error.message}`);
      chain = created;
      existing.push(created);
    }
    if (!chain) continue;
    chainIds.push(chain.id);

    if (APPLY) {
      await sb.from("chains").update({
        raw_chain_text: sanadText || null,
        verified: false,
        notes: "full isnad scraped from sunnah.com arabic_sanad",
      }).eq("id", chain.id);

      // wipe old nodes
      await sb.from("chain_narrators").delete().eq("chain_id", chain.id);

      const rows = [];
      for (let i = 0; i < branch.length; i++) {
        const link = branch[i];
        sunnahIds.push(link.sunnahId);
        const narratorId = await resolveOrCreateNarrator(sb, link, narratorCache);
        rows.push({
          chain_id: chain.id,
          position: i + 1,
          narrator_id: narratorId > 0 ? narratorId : null,
          raw_name: link.linkText || link.titleName,
          transmission_word: i === 0 ? "haddathana" : "an",
          match_confidence: 0.95,
          match_notes: `sunnah:${link.sunnahId}`,
        });
      }
      const { error: insErr } = await sb.from("chain_narrators").insert(rows);
      if (insErr) throw new Error(`chain_narrators insert: ${insErr.message}`);
      nodeCount += rows.length;
    } else {
      for (const link of branch) {
        sunnahIds.push(link.sunnahId);
        await resolveOrCreateNarrator(sb, link, narratorCache);
      }
      nodeCount += branch.length;
    }
  }

  // update source_url to canonical hadith page if we know number
  return { chainIds, nodeCount, sunnahIds: [...new Set(sunnahIds)] };
}

async function insertAppraisals(
  sb: SupabaseClient,
  rows: AppraisalRow[],
  sunnahToNarrator: Map<string, number>,
  scholarCache: Map<string, number>,
  aliases: Map<string, string>,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  async function resolveScholar(name: string): Promise<number | null> {
    const lookup = aliases.get(name) ?? name;
    if (scholarCache.has(lookup)) return scholarCache.get(lookup)!;
    const { data: hit } = await sb.from("scholars").select("id").eq("arabic_name", lookup).maybeSingle();
    if (hit) {
      scholarCache.set(lookup, hit.id);
      return hit.id;
    }
    const slug = scholarSlug(lookup);
    const { data: bySlug } = await sb.from("scholars").select("id").eq("slug", slug).maybeSingle();
    if (bySlug) {
      scholarCache.set(lookup, bySlug.id);
      return bySlug.id;
    }
    if (!APPLY) return -1;
    const { data: ins, error } = await sb
      .from("scholars")
      .insert({
        slug,
        name: lookup,
        arabic_name: lookup,
        tradition: null,
        provenance: "sunnah_com_import",
        verified: false,
      })
      .select("id")
      .single();
    if (error) {
      console.warn("scholar", error.message);
      return null;
    }
    scholarCache.set(lookup, ins.id);
    return ins.id;
  }

  for (const row of rows) {
    const narratorId = sunnahToNarrator.get(row.narrator_sunnah_id);
    if (!narratorId || narratorId < 0) {
      skipped++;
      continue;
    }
    const scholarId = await resolveScholar(row.scholar_name_ar);
    if (!scholarId || scholarId < 0) {
      skipped++;
      continue;
    }
    if (!APPLY) {
      inserted++;
      continue;
    }
    const { data: existing } = await sb
      .from("narrator_assessments")
      .select("id")
      .eq("narrator_id", narratorId)
      .eq("scholar_id", scholarId)
      .eq("original_term", row.original_term_ar)
      .eq("source_url", row.source_url)
      .maybeSingle();
    if (existing) {
      skipped++;
      continue;
    }
    const { error } = await sb.from("narrator_assessments").insert({
      narrator_id: narratorId,
      scholar_id: scholarId,
      original_term: row.original_term_ar,
      normalized_term: null,
      explanation: null,
      display_score: null,
      mapping_method: MAPPING_METHOD,
      reference_book: row.citation_book || null,
      edition: null,
      volume: null,
      page: null,
      source_url: row.source_url,
      verified: true,
    });
    if (error) console.warn(error.message);
    else inserted++;
  }
  return { inserted, skipped };
}

async function loadCitedNarratorIds(sb: SupabaseClient): Promise<Set<number>> {
  const cited = new Set<number>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("narrator_assessments")
      .select("narrator_id,verified,source_url,reference_book,page")
      .eq("verified", true)
      .range(from, from + 999);
    if (!data?.length) break;
    for (const a of data) {
      const url = a.source_url?.trim();
      const book = a.reference_book?.trim();
      const page = a.page?.trim();
      if (url || (book && page)) cited.add(a.narrator_id);
    }
    if (data.length < 1000) break;
  }
  return cited;
}

function slugifyTopic(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "general"
  );
}

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
  if (/akhlaq|ethics|adab|manners|أخلاق|wish|coercion|trick|truthful|honor|dream/.test(t)) {
    out.add("akhlaq");
  }
  if (/affliction|end of the world|eschat|fitna|signs of the hour/.test(t)) out.add("seerah");
  if (/virtue|fada.?il|فضائل/.test(t)) out.add("virtues");
  if (/seerah|maghazi|banner|battle|migration|hijra|سيرة/.test(t)) out.add("seerah");
  if (/fiqh|ibadat|worship|معامل|transaction|blood money|prisoner|trick/.test(t)) {
    if (/transaction|muamal|بيع|trade|trick|coercion/.test(t)) out.add("fiqh-muamalat");
    else out.add("fiqh-ibadat");
  }
  return [...out];
}

type TargetVar = {
  id: number;
  hadith_id: number | null;
  hadith_number: string | null;
  source_url: string | null;
  maxNodes: number;
};

async function loadBukhariTargets(sb: SupabaseClient): Promise<TargetVar[]> {
  const out: TargetVar[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await sb
      .from("source_variations")
      .select(
        `id,hadith_id,hadith_number,source_url,books!source_variations_book_id_fkey(title),chains(id,chain_narrators(narrator_id))`,
      )
      .not("hadith_number", "is", null)
      .range(from, from + 199);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const book = Array.isArray(row.books) ? row.books[0] : row.books;
      const title = String((book as { title?: string } | null)?.title || "").toLowerCase();
      const src = row.source_url || "";
      if (!/bukhari|البخاري/.test(title) && !/bukhari/i.test(src)) continue;
      let maxNodes = 0;
      for (const c of (row.chains || []) as { chain_narrators?: { narrator_id: number | null }[] }[]) {
        const n = (c.chain_narrators || []).filter((x) => x.narrator_id != null).length;
        if (n > maxNodes) maxNodes = n;
      }
      out.push({
        id: row.id,
        hadith_id: row.hadith_id,
        hadith_number: row.hadith_number,
        source_url: row.source_url,
        maxNodes,
      });
    }
    if (data.length < 200) break;
  }
  return out;
}

/** Collect sunnah ids for narrators on multi-node chains of these variations that lack citations. */
async function collectUncitedSunnahIds(
  sb: SupabaseClient,
  varIds: number[],
  narratorCache: Map<string, number>,
  cited: Set<number>,
): Promise<Set<string>> {
  const narrToSunnah = new Map<number, string>();
  for (const [sid, nid] of narratorCache) narrToSunnah.set(nid, sid);

  const needed = new Set<string>();
  for (let i = 0; i < varIds.length; i += 80) {
    const chunk = varIds.slice(i, i + 80);
    const { data: chs } = await sb
      .from("chains")
      .select("id,chain_narrators(narrator_id)")
      .in("variation_id", chunk);
    for (const c of chs || []) {
      const nodes = (c as { chain_narrators?: { narrator_id: number | null }[] }).chain_narrators || [];
      if (nodes.length < 2) continue;
      for (const n of nodes) {
        const nid = n.narrator_id;
        if (nid == null || cited.has(nid)) continue;
        const sid = narrToSunnah.get(nid);
        if (sid) needed.add(sid);
      }
    }
  }
  return needed;
}

async function main() {
  console.log(`\n=== Full-isnad scrape + publish (${APPLY ? "APPLY" : "dry-run"}) ===`);
  const sb = admin();
  const progress = loadProgress();

  // All Bukhari variations with a hadith number — not just soft-eligible stubs
  let targets = await loadBukhariTargets(sb);
  const needIsnad = targets.filter((t) => t.maxNodes < 2);
  console.log(
    `Bukhari targets: ${targets.length} (need isnad scrape: ${needIsnad.length}, already multi-node: ${targets.length - needIsnad.length})`,
  );

  let stubs = needIsnad;
  if (LIMIT > 0) stubs = stubs.slice(0, LIMIT);
  console.log(`Phase 1 queue: ${stubs.length}${LIMIT ? ` (limit=${LIMIT})` : ""}`);

  const narratorCache = await loadSunnahNarratorMap(sb);
  console.log(`Known sunnah→narrator mappings: ${narratorCache.size}`);

  const stats = {
    scraped: 0,
    scrapeFail: 0,
    chainsRewritten: 0,
    nodesWritten: 0,
    uniqueSunnahIds: new Set<string>(),
    appraisalsInserted: 0,
    appraisalsSkipped: 0,
    chainsVerified: 0,
    published: 0,
    fullIsnadEligible: 0,
  };

  // ---- Phase 1: scrape isnads + rewrite chains for stubs ----
  for (let i = 0; i < stubs.length; i++) {
    const v = stubs[i];
    const n = String(v.hadith_number).replace(/[^\d]/g, "");
    if (!n) {
      stats.scrapeFail++;
      continue;
    }
    const key = `${v.id}:${n}`;
    if (progress.scrapedHadith[key]?.ok) {
      // still collect sunnah ids from cache if we skipped rewrite
      stats.scraped++;
      continue;
    }
    process.stdout.write(`\r  [${i + 1}/${stubs.length}] bukhari:${n} var=${v.id}   `);

    try {
      const html = await loadHadithHtml(n);
      const { branches, sanadText } = extractSunnahLinks(html);
      const multi = branches.filter((b) => b.length >= 2);
      if (!multi.length && !branches[0]?.length) {
        progress.scrapedHadith[key] = { links: 0, branches: 0, ok: false, error: "no narrator links" };
        stats.scrapeFail++;
        continue;
      }
      const result = await rewriteChain(sb, v.id, multi.length ? multi : branches, sanadText, narratorCache);
      for (const sid of result.sunnahIds) stats.uniqueSunnahIds.add(sid);
      progress.scrapedHadith[key] = {
        links: result.nodeCount,
        branches: result.chainIds.length,
        ok: result.nodeCount >= 2,
      };
      if (result.nodeCount >= 2) {
        stats.chainsRewritten++;
        stats.nodesWritten += result.nodeCount;
      }
      stats.scraped++;

      if (APPLY) {
        await sb
          .from("source_variations")
          .update({ source_url: `https://sunnah.com/bukhari:${n}` })
          .eq("id", v.id);
      }
    } catch (e) {
      stats.scrapeFail++;
      progress.scrapedHadith[key] = {
        links: 0,
        branches: 0,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
      console.warn(`\n  FAIL bukhari:${n}`, e instanceof Error ? e.message : e);
    }

    if (i % 10 === 0) saveProgress(progress);
  }
  console.log(
    `\nPhase 1 done: scraped=${stats.scraped} fail=${stats.scrapeFail} multi-node=${stats.chainsRewritten} unique narrators=${stats.uniqueSunnahIds.size}`,
  );
  saveProgress(progress);

  // ---- Phase 2: appraisals for uncited narrators on ALL target chains ----
  if (!skipAppraisals) {
    const scholarCache = new Map<string, number>();
    const { data: scholars } = await sb.from("scholars").select("id,arabic_name");
    for (const s of scholars || []) {
      const ar = normalizeWs(s.arabic_name || "");
      if (ar) scholarCache.set(ar, s.id);
    }
    const aliases = new Map<string, string>();
    const aliasPath = path.join("data", "scholar-aliases.csv");
    if (existsSync(aliasPath)) {
      for (const line of readFileSync(aliasPath, "utf8").split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue;
        const parts = line.split(",");
        const alias = normalizeWs((parts[0] || "").replace(/^"|"$/g, ""));
        const canonical = normalizeWs((parts[1] || "").replace(/^"|"$/g, ""));
        if (alias && canonical) aliases.set(alias, canonical);
      }
    }

    const cited = await loadCitedNarratorIds(sb);
    // Refresh targets after phase 1 so newly multi-node vars are included
    targets = await loadBukhariTargets(sb);
    const fromChains = await collectUncitedSunnahIds(
      sb,
      targets.map((t) => t.id),
      narratorCache,
      cited,
    );
    for (const sid of stats.uniqueSunnahIds) fromChains.add(sid);

    let todo = [...fromChains].filter((sid) => {
      if (progress.appraisalsDone.includes(sid)) return false;
      const nid = narratorCache.get(sid);
      if (nid && nid > 0 && cited.has(nid)) return false;
      return true;
    });
    if (LIMIT > 0 && todo.length > LIMIT * 3) todo = todo.slice(0, LIMIT * 3);
    console.log(`Phase 2: fetch appraisals for ${todo.length} sunnah narrators`);

    for (let i = 0; i < todo.length; i++) {
      const sid = todo[i];
      process.stdout.write(`\r  [${i + 1}/${todo.length}] narrator/${sid}   `);
      try {
        const html = await loadNarratorHtml(sid);
        const rows = extractAppraisals(sid, html);
        // ensure narrator mapped
        if (!narratorCache.has(sid) && rows[0]) {
          await resolveOrCreateNarrator(
            sb,
            {
              sunnahId: sid,
              linkText: rows[0].narrator_name_ar,
              titleName: rows[0].narrator_name_ar,
            },
            narratorCache,
          );
        }
        const { inserted, skipped } = await insertAppraisals(sb, rows, narratorCache, scholarCache, aliases);
        stats.appraisalsInserted += inserted;
        stats.appraisalsSkipped += skipped;
        if (APPLY) progress.appraisalsDone.push(sid);
      } catch (e) {
        console.warn(`\n  FAIL narrator/${sid}`, e instanceof Error ? e.message : e);
      }
      if (i % 10 === 0) saveProgress(progress);
    }
    console.log(
      `\nPhase 2 done: inserted=${stats.appraisalsInserted} skipped=${stats.appraisalsSkipped}`,
    );
    saveProgress(progress);
  }

  // ---- Phase 3: verify chains where all nodes cited (all Bukhari targets) ----
  {
    const cited = await loadCitedNarratorIds(sb);
    console.log(`Phase 3: cited narrators=${cited.size}`);
    targets = await loadBukhariTargets(sb);
    const varIds = targets.map((t) => t.id);
    for (let i = 0; i < varIds.length; i += 80) {
      const chunk = varIds.slice(i, i + 80);
      const { data: chs } = await sb
        .from("chains")
        .select("id,verified,chain_narrators(narrator_id)")
        .in("variation_id", chunk);
      for (const c of chs || []) {
        const nodes = (c as { chain_narrators?: { narrator_id: number | null }[] }).chain_narrators || [];
        if (nodes.length < 2) continue;
        if (nodes.some((n) => n.narrator_id == null)) continue;
        if (!nodes.every((n) => cited.has(n.narrator_id as number))) continue;
        if (c.verified) {
          progress.verifiedChainIds.push(c.id);
          continue;
        }
        if (APPLY) {
          const { error } = await sb.from("chains").update({ verified: true }).eq("id", c.id);
          if (!error) {
            stats.chainsVerified++;
            progress.verifiedChainIds.push(c.id);
          }
        } else {
          stats.chainsVerified++;
        }
      }
    }
    console.log(`Phase 3 done: newly verified=${stats.chainsVerified}`);
    saveProgress(progress);
  }

  // ---- Phase 4: publish full-isnad eligible ----
  if (!skipPublish) {
    const full = await getEligibleVariations({
      client: sb,
      publishedOnly: false,
      minChainNodes: 2,
    });
    const passers = full.variations.filter((v) => {
      const max = Math.max(0, ...v.eligibleChains.map((c) => c.nodes.length));
      return max >= 2;
    });
    stats.fullIsnadEligible = passers.length;
    console.log(`Phase 4: full-isnad eligible=${passers.length}`);

    if (APPLY && passers.length) {
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
      };

      // ensure categories
      const catCache = new Map<string, number>();
      const { data: cats } = await sb.from("categories").select("id,slug");
      for (const c of cats || []) catCache.set(c.slug, c.id);

      for (const v of passers) {
        const chapter = (v.chapter || "").trim() || "General";
        const slugs = [...new Set([...mapTopicTextToSlugs(chapter), `ch-${slugifyTopic(chapter)}`])];
        for (const slug of slugs) {
          if (!catCache.has(slug)) {
            const title = CORE_TITLES[slug] || chapter;
            const { data: created } = await sb
              .from("categories")
              .upsert({ slug, title, description: null }, { onConflict: "slug" })
              .select("id,slug")
              .single();
            if (created) catCache.set(created.slug, created.id);
          }
          const catId = catCache.get(slug);
          if (catId && v.hadith_id) {
            await sb.from("hadith_categories").upsert(
              { hadith_id: v.hadith_id, category_id: catId },
              { onConflict: "hadith_id,category_id" },
            );
          }
        }

        await sb.from("source_variations").update({ verified: true }).eq("id", v.id);

        // verify narrators + assessments
        const narrIds = new Set<number>();
        for (const c of v.eligibleChains) {
          for (const n of c.nodes) narrIds.add(n.narratorId);
        }
        if (narrIds.size) {
          await sb
            .from("narrators")
            .update({ identity_status: "verified" })
            .in("id", [...narrIds])
            .neq("identity_status", "verified");
        }

        if (v.hadith_id) {
          const topics = [
            ...mapTopicTextToSlugs(chapter).map((s) => CORE_TITLES[s] || s),
            chapter,
          ].filter(Boolean);
          await sb
            .from("hadiths")
            .update({
              review_status: "published",
              topics: [...new Set(topics)],
              updated_at: new Date().toISOString(),
            })
            .eq("id", v.hadith_id);
        }
        progress.publishedVariationIds.push(v.id);
        stats.published++;
      }
    }
    console.log(`Phase 4 done: published=${stats.published}`);
    saveProgress(progress);
  }

  // Final recount
  const fullAfter = await getEligibleVariations({
    client: sb,
    publishedOnly: false,
    minChainNodes: 2,
  });
  const softAfter = await getEligibleVariations({
    client: sb,
    publishedOnly: false,
    minChainNodes: 1,
  });
  const publishedFull = fullAfter.variations.filter((v) => v.hadith?.review_status === "published");

  const summary = {
    apply: APPLY,
    limit: LIMIT || null,
    phase1: {
      scraped: stats.scraped,
      scrapeFail: stats.scrapeFail,
      multiNodeChains: stats.chainsRewritten,
      nodesWritten: stats.nodesWritten,
      uniqueSunnahIds: stats.uniqueSunnahIds.size,
    },
    phase2: {
      appraisalsInserted: stats.appraisalsInserted,
      appraisalsSkipped: stats.appraisalsSkipped,
    },
    phase3: { chainsVerified: stats.chainsVerified },
    phase4: { published: stats.published },
    after: {
      softEligible: softAfter.variations.length,
      fullIsnadEligible: fullAfter.variations.length,
      fullIsnadPublished: publishedFull.length,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) console.log("\nDry-run done. Re-run with --apply to write.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    if (pwContext) await pwContext.close().catch(() => undefined);
  });
