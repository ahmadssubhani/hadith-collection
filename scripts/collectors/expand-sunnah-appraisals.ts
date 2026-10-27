/**
 * Expand sunnah appraisals for narrators on sunnah.com chains (mostly single-node
 * "Narrated X" stubs), then verify those chains when cited → lifts publish a–d count.
 *
 *   npx tsx scripts/collectors/expand-sunnah-appraisals.ts
 *   npx tsx scripts/collectors/expand-sunnah-appraisals.ts --apply --limit=60
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as cheerio from "cheerio";
import { chromium, type BrowserContext } from "playwright";
import { evaluateVariationEligibility } from "../../lib/first-wahi-eligibility";
import type { NarratorAssessment, SourceVariationDetail } from "../../lib/types";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 60;

const RAW_DIR = path.join(process.cwd(), "data", "raw");
const OUT_CSV = path.join(process.cwd(), "data", "narrator-appraisals-review-expanded.csv");
const MAPPING_METHOD = "sunnah_com_import";
const USER_AGENT =
  "HadithCollectionResearchBot/1.0 (+Critical Appraisals for sunnah chain companions)";
const REQUEST_GAP_MS = 1800;

/** Verified companion English name → sunnah.com narrator id (checked against page titles). */
const EN_NAME_TO_SUNNAH: Record<string, string> = {
  "abu huraira": "4396",
  "abu hurayrah": "4396",
  "abi huraira": "4396",
  aisha: "4049",
  "`aisha": "4049",
  "'aisha": "4049",
  "anas bin malik": "720",
  anas: "720",
  "ibn abbas": "4883",
  "ibn `abbas": "4883",
  "ibn 'abbas": "4883",
  "abu musa": "5021",
  "abu musa al-ash`ari": "5021",
  "abu musa al-ashari": "5021",
  "ibn umar": "4967",
  "ibn `umar": "4967",
  "ibn 'umar": "4967",
  "abdullah bin umar": "4967",
  "'abdullah bin 'umar": "4967",
  "abdullah bin 'umar": "4967",
  jabir: "2069",
  "jabir bin abdullah": "2069",
  "jabir bin 'abdullah": "2069",
  "sahl bin sad": "3672",
  "sahl bin sa`d": "3672",
  "sahl bin sa'd": "3672",
  hudhaifa: "2324",
  "hudhaifa bin al-yaman": "2324",
  "abu sa`id": "3260",
  "abu said": "3260",
  "abu sa'id": "3260",
  "abu sa`id al-khudri": "3260",
  "abu said al-khudri": "3260",
  "ibn masud": "5079",
  "ibn mas`ud": "5079",
  "ibn mas'ud": "5079",
  ali: "5722",
  "`ali": "5722",
  "'ali": "5722",
  "ali bin abi talib": "5722",
  "`ali bin abi talib": "5722",
  "'ali bin abi talib": "5722",
  "abu musa al-ashari": "5021",
  "abu said al-khudri": "3260",
  "sahl bin sad as-saidi": "3672",
  "hudhaifa bin al-yaman": "2324",
  "abi huraira": "4396",
};

function normalizeWs(s: string) {
  return s.replace(/\s+/g, " ").trim();
}
function normKey(s: string) {
  return normalizeWs(s)
    .toLowerCase()
    .replace(/[`'’]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}
function normalizeArabic(s: string) {
  return normalizeWs(s)
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}
function csvEscape(v: string) {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
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
function walkHtml(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkHtml(p, out);
    else if (/\.html?$/i.test(ent.name)) out.push(p);
  }
  return out;
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

async function loadHtml(sunnahId: string): Promise<string> {
  mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, `sunnah-narrator-${sunnahId}.html`);
  if (existsSync(file) && readFileSync(file, "utf8").includes("verdict-scholar")) {
    return readFileSync(file, "utf8");
  }
  await delay(REQUEST_GAP_MS);
  try {
    const res = await fetch(`https://sunnah.com/narrator/${sunnahId}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (res.ok) {
      const html = await res.text();
      if (html.includes("verdict-scholar") || html.includes("hero-title")) {
        writeFileSync(file, html, "utf8");
        return html;
      }
    }
  } catch {
    /* fall through to Playwright */
  }
  const ctx = await getPwContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`https://sunnah.com/narrator/${sunnahId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(1500);
    const html = await page.content();
    if (!html.includes("hero-title") && !html.includes("verdict-scholar")) {
      throw new Error(`Playwright got challenge/empty page for ${sunnahId}`);
    }
    writeFileSync(file, html, "utf8");
    return html;
  } finally {
    await page.close();
  }
}

async function recountEligibility(sb: any) {
  const assessments = await (async () => {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("narrator_assessments")
        .select(
          "id,narrator_id,verified,source_url,reference_book,page,original_term,normalized_term,explanation,scholar_id"
        )
        .range(from, from + 999);
      if (!data?.length) break;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  })();
  const map = new Map<number, NarratorAssessment[]>();
  for (const a of assessments) {
    if (!map.has(a.narrator_id)) map.set(a.narrator_id, []);
    map.get(a.narrator_id)!.push(a);
  }
  const variations: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("source_variations")
      .select("id,hadith_id,arabic_text,english_text")
      .range(from, from + 999);
    if (!data?.length) break;
    variations.push(...data);
    if (data.length < 1000) break;
  }
  const chains: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("chains")
      .select("id,variation_id,chain_number,verified,raw_chain_text,notes")
      .range(from, from + 999);
    if (!data?.length) break;
    chains.push(...data);
    if (data.length < 1000) break;
  }
  const nodes: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("chain_narrators")
      .select("id,chain_id,narrator_id,position,raw_name")
      .range(from, from + 999);
    if (!data?.length) break;
    nodes.push(...data);
    if (data.length < 1000) break;
  }
  const narrIds = [...new Set(nodes.map((n) => n.narrator_id).filter(Boolean))];
  const narrators: any[] = [];
  for (let i = 0; i < narrIds.length; i += 200) {
    const { data } = await sb
      .from("narrators")
      .select("id,slug,name,arabic_name,generation")
      .in("id", narrIds.slice(i, i + 200));
    narrators.push(...(data || []));
  }
  const narrById = new Map(narrators.map((n) => [n.id, n]));
  const nodesByChain = new Map<number, any[]>();
  for (const n of nodes) {
    if (!nodesByChain.has(n.chain_id)) nodesByChain.set(n.chain_id, []);
    nodesByChain.get(n.chain_id)!.push(n);
  }
  const chainsByVar = new Map<number, any[]>();
  for (const c of chains) {
    if (!chainsByVar.has(c.variation_id)) chainsByVar.set(c.variation_id, []);
    chainsByVar.get(c.variation_id)!.push(c);
  }
  let full = 0;
  const fullHadith = new Set<number>();
  for (const v of variations) {
    const varChains = (chainsByVar.get(v.id) || []).map((c) => ({
      ...c,
      chain_narrators: (nodesByChain.get(c.id) || []).map((n) => ({
        ...n,
        narrators: n.narrator_id ? narrById.get(n.narrator_id) ?? null : null,
      })),
    }));
    const r = evaluateVariationEligibility(
      {
        arabic_text: v.arabic_text,
        english_text: v.english_text,
        chains: varChains,
      } as Pick<SourceVariationDetail, "arabic_text" | "english_text" | "chains">,
      map
    );
    if (r.eligible) {
      full++;
      fullHadith.add(v.hadith_id);
    }
  }
  return { full_variations: full, full_hadiths: fullHadith.size, cited_narrators: map.size };
}

async function main() {
  console.log("\n=== expand-sunnah-appraisals (companions) ===");
  console.log(APPLY ? "MODE: APPLY" : "MODE: dry-run");
  console.log(`limit=${LIMIT}`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  // Enrich EN map from cached HTML titles/links where possible
  const linkNames = new Map<string, string>();
  for (const f of [...walkHtml("data/raw"), ...walkHtml("data/scraped")]) {
    if (/sunnah-narrator-/.test(f)) continue;
    const $ = cheerio.load(readFileSync(f, "utf8"));
    $("a[href*='/narrator/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/narrator\/(\d+)/);
      if (!m) return;
      const text = normalizeWs($(el).text());
      if (text) linkNames.set(m[1], text);
    });
  }

  // Frequency of companion names on sunnah single-node chains
  const sunnahVars: { id: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("source_variations")
      .select("id")
      .ilike("source_url", "%sunnah.com%")
      .range(from, from + 999);
    if (!data?.length) break;
    sunnahVars.push(...(data as any));
    if (data.length < 1000) break;
  }

  type Comp = { narratorId: number; name: string; count: number };
  const freq = new Map<number, Comp>();
  for (let i = 0; i < sunnahVars.length; i += 100) {
    const chunk = sunnahVars.slice(i, i + 100).map((v) => v.id);
    const { data: chs } = await sb
      .from("chains")
      .select("id,chain_narrators(narrator_id,raw_name)")
      .in("variation_id", chunk);
    for (const c of chs || []) {
      const nodes = (c as any).chain_narrators || [];
      if (nodes.length !== 1) continue;
      const n = nodes[0];
      if (n.narrator_id == null) continue;
      const name = normalizeWs(n.raw_name || "");
      const prev = freq.get(n.narrator_id);
      if (prev) prev.count++;
      else freq.set(n.narrator_id, { narratorId: n.narrator_id, name, count: 1 });
    }
  }

  const ranked = [...freq.values()].sort((a, b) => b.count - a.count);
  console.log("Top single-node companions:");
  for (const r of ranked.slice(0, 15)) console.log(`  n${r.narratorId} x${r.count}: ${r.name}`);

  // Who already cited?
  const { data: assess } = await sb
    .from("narrator_assessments")
    .select("narrator_id,verified,source_url,reference_book,page");
  const cited = new Set<number>();
  const coveredSunnah = new Set<string>();
  for (const a of assess || []) {
    if (a.verified && (a.source_url?.trim() || (a.reference_book?.trim() && a.page?.trim()))) {
      cited.add(a.narrator_id);
    }
    const m = (a.source_url || "").match(/narrator\/(\d+)/);
    if (m) coveredSunnah.add(m[1]);
  }

  type Job = { sunnahId: string; narratorId: number; name: string; count: number };
  const jobs: Job[] = [];
  const usedN = new Set<number>();

  // Prefer verified Bukhari batch2 mappings first
  const mappingPath = path.join("data", "bukhari-batch2-mapping.json");
  if (existsSync(mappingPath)) {
    const doc = JSON.parse(readFileSync(mappingPath, "utf8"));
    for (const row of doc.rows || []) {
      if (!row.sunnahId || !row.narratorId) continue;
      if (cited.has(row.narratorId) || usedN.has(row.narratorId)) continue;
      usedN.add(row.narratorId);
      jobs.push({
        sunnahId: String(row.sunnahId),
        narratorId: Number(row.narratorId),
        name: row.rawName || row.sunnahPageName || "",
        count: 0,
      });
    }
  }

  // Then high-frequency English single-node companions (same sunnah page may cite multiple DB ids)
  for (const r of ranked) {
    if (cited.has(r.narratorId) || usedN.has(r.narratorId)) continue;
    const key = normKey(r.name);
    // Skip composites / ambiguous bare names
    if (/\band\b/.test(key) || /^(abdullah|umar)$/i.test(key)) continue;
    const sunnahId = EN_NAME_TO_SUNNAH[key];
    if (!sunnahId) continue;
    usedN.add(r.narratorId);
    jobs.push({ sunnahId, narratorId: r.narratorId, name: r.name, count: r.count });
  }

  const queue = jobs.slice(0, LIMIT);
  console.log(`Jobs: ${queue.length}`);
  for (const j of queue.slice(0, 25)) {
    console.log(`  sunnah/${j.sunnahId} → n${j.narratorId} (x${j.count}) ${j.name}`);
  }

  const allRows: AppraisalRow[] = [];
  const sunnahToNarrators = new Map<string, number[]>();
  const fetchedSunnah = new Set<string>();
  let fetchFail = 0;
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    const list = sunnahToNarrators.get(job.sunnahId) ?? [];
    if (!list.includes(job.narratorId)) list.push(job.narratorId);
    sunnahToNarrators.set(job.sunnahId, list);
    if (fetchedSunnah.has(job.sunnahId)) {
      console.log(`  [${i + 1}/${queue.length}] sunnah/${job.sunnahId}: reuse cache → n${job.narratorId}`);
      continue;
    }
    try {
      const html = await loadHtml(job.sunnahId);
      const rows = extractAppraisals(job.sunnahId, html);
      fetchedSunnah.add(job.sunnahId);
      console.log(`  [${i + 1}/${queue.length}] sunnah/${job.sunnahId}: ${rows.length} appraisals`);
      allRows.push(...rows);
    } catch (e) {
      fetchFail++;
      console.warn(`  FAIL ${job.sunnahId}`, e instanceof Error ? e.message : e);
    }
  }

  writeFileSync(
    OUT_CSV,
    [
      "narrator_sunnah_id,narrator_name_ar,scholar_name_ar,original_term_ar,citation_book,source_url,verified",
      ...allRows.map((r) =>
        [
          r.narrator_sunnah_id,
          r.narrator_name_ar,
          r.scholar_name_ar,
          r.original_term_ar,
          r.citation_book,
          r.source_url,
          "true",
        ]
          .map(csvEscape)
          .join(",")
      ),
    ].join("\n") + "\n",
    "utf8"
  );
  console.log(`CSV ${allRows.length} rows, fetchFail=${fetchFail}`);

  if (!APPLY) {
    console.log("Dry-run done. Re-run with --apply");
    return;
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
  const scholarCache = new Map<string, number>();
  const { data: scholars } = await sb.from("scholars").select("id,arabic_name");
  for (const s of scholars || []) {
    const ar = normalizeWs(s.arabic_name || "");
    if (ar) scholarCache.set(ar, s.id);
  }

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

  let inserted = 0;
  let skippedDup = 0;
  for (const row of allRows) {
    const narratorIds = sunnahToNarrators.get(row.narrator_sunnah_id) ?? [];
    if (!narratorIds.length) continue;
    const scholarId = await resolveScholar(row.scholar_name_ar);
    if (!scholarId) continue;
    for (const narratorId of narratorIds) {
      const { data: existing } = await sb
        .from("narrator_assessments")
        .select("id")
        .eq("narrator_id", narratorId)
        .eq("scholar_id", scholarId)
        .eq("original_term", row.original_term_ar)
        .eq("source_url", row.source_url)
        .maybeSingle();
      if (existing) {
        skippedDup++;
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
  }
  console.log(`Inserted=${inserted} skippedDup=${skippedDup}`);

  // Refresh cited
  const { data: assess2 } = await sb
    .from("narrator_assessments")
    .select("narrator_id,verified,source_url,reference_book,page")
    .eq("verified", true);
  const cited2 = new Set<number>();
  for (const a of assess2 || []) {
    if (a.source_url?.trim() || (a.reference_book?.trim() && a.page?.trim())) cited2.add(a.narrator_id);
  }
  console.log(`Cited narrators: ${cited2.size}`);

  // Verify sunnah single-node (or full) chains where all nodes cited
  let newlyVerified = 0;
  for (let i = 0; i < sunnahVars.length; i += 100) {
    const chunk = sunnahVars.slice(i, i + 100).map((v) => v.id);
    const { data: chs } = await sb
      .from("chains")
      .select("id,verified,chain_narrators(narrator_id)")
      .in("variation_id", chunk)
      .eq("verified", false);
    for (const c of chs || []) {
      const nodes = (c as any).chain_narrators || [];
      if (!nodes.length || nodes.some((n: any) => n.narrator_id == null)) continue;
      if (!nodes.every((n: any) => cited2.has(n.narrator_id))) continue;
      const { error } = await sb.from("chains").update({ verified: true }).eq("id", c.id);
      if (!error) newlyVerified++;
    }
  }
  console.log(`Newly verified chains: ${newlyVerified}`);

  const elig = await recountEligibility(sb);
  console.log("Eligibility after expand:", elig);

  mkdirSync(path.join("data", "unmatched"), { recursive: true });
  writeFileSync(
    path.join("data", "unmatched", "expand-sunnah-appraisals-summary.json"),
    JSON.stringify({ inserted, skippedDup, newlyVerified, cited: cited2.size, ...elig }, null, 2),
    "utf8"
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    if (pwContext) await pwContext.close().catch(() => undefined);
  });
