// // /**
// //  * Playwright scraper for the five web sources in data-templates/source-register.csv:
// //  *   sunnah.com | thaqalayn.net | hadeethenc.com | dorar.net | al-islam.org
// //  *
// //  * Saves JSON under data/scraped/<run-id>/. Does NOT write to Supabase.
// //  * Site layouts change — selectors may need tuning after you inspect saved HTML.
// //  *
// //  * Usage:
// //  *   npx tsx scripts/scrapers/scrape-all-sources.ts --query "بدء الوحي"
// //  *   npx tsx scripts/scrapers/scrape-all-sources.ts --query "first revelation" --sources sunnah,dorar
// //  *   npx tsx scripts/scrapers/scrape-all-sources.ts --query "iqra" --headed --save-html
// //  *
// //  * Flags:
// //  *   --query <text>     Search / topic phrase (required)
// //  *   --sources a,b,c    Subset of: sunnah,thaqalayn,hadeethenc,dorar,al-islam (default: all)
// //  *   --max <n>          Max items per source (default 20)
// //  *   --headed           Show browser (default headless)
// //  *   --save-html        Also write raw page HTML for selector debugging
// //  *   --out <dir>        Output root (default data/scraped)
// //  *
// //  * Respect each site's terms. Dorar and others may block automation; run locally
// //  * and prefer official APIs when you have permission.
// //  */
// // import { mkdirSync, writeFileSync } from "node:fs";
// // import path from "node:path";
// // import { chromium, type Browser, type Page } from "playwright";

// // type SourceId = "sunnah" | "thaqalayn" | "hadeethenc" | "dorar" | "al-islam";

// // type ScrapedItem = {
// //   index: number;
// //   source: SourceId;
// //   sourceUrl: string;
// //   reference?: string;
// //   narrator?: string;
// //   arabicText?: string;
// //   englishText?: string;
// //   grade?: string;
// //   extra?: Record<string, string>;
// // };

// // type SourceResult = {
// //   source: SourceId;
// //   query: string;
// //   startedAt: string;
// //   finishedAt: string;
// //   pageUrl: string;
// //   ok: boolean;
// //   error?: string;
// //   itemCount: number;
// //   items: ScrapedItem[];
// // };

// // const ALL_SOURCES: SourceId[] = ["sunnah", "thaqalayn", "hadeethenc", "dorar", "al-islam"];

// // const USER_AGENT =
// //   "HadithCollectionResearchBot/1.0 (+local Playwright scraper; operator-run; no bulk redistribution)";

// // function argValue(flag: string): string | undefined {
// //   const i = process.argv.indexOf(flag);
// //   if (i < 0) return undefined;
// //   return process.argv[i + 1];
// // }

// // function hasFlag(flag: string): boolean {
// //   return process.argv.includes(flag);
// // }

// // function sleep(ms: number): Promise<void> {
// //   return new Promise((r) => setTimeout(r, ms));
// // }

// // async function newPage(browser: Browser): Promise<Page> {
// //   const page = await browser.newPage({
// //     userAgent: USER_AGENT,
// //     locale: "en-US",
// //   });
// //   page.setDefaultTimeout(45000);
// //   return page;
// // }

// // async function goto(page: Page, url: string): Promise<void> {
// //   await page.goto(url, { waitUntil: "domcontentloaded" });
// //   await sleep(2500);
// // }

// // /** ——— Site adapters ——— */

// // async function scrapeSunnah(page: Page, query: string, max: number): Promise<ScrapedItem[]> {
// //   const url = `https://sunnah.com/search?q=${encodeURIComponent(query)}`;
// //   await goto(page, url);

// //   // Prefer search hits; fall back to chapter-style containers if present
// //   const items = await page.evaluate((limit) => {
// //     const out: Array<{
// //       reference: string;
// //       narrator: string;
// //       arabicText: string;
// //       englishText: string;
// //       grade: string;
// //       href: string;
// //     }> = [];

// //     const containers = document.querySelectorAll(
// //       ".actualHadithContainer, .search_hadith_info, .hadith_container",
// //     );
// //     containers.forEach((el) => {
// //       if (out.length >= limit) return;
// //       const root = el as HTMLElement;
// //       const arabic =
// //         root.querySelector(".arabic_text_details, .arabic_hadith_full, .arabic, [lang='ar']")
// //           ?.textContent?.trim() ?? "";
// //       const english =
// //         root.querySelector(".text_details, .english_hadith_full, .hadith_english")?.textContent?.trim() ??
// //         "";
// //       const narrator = root.querySelector(".english_narrator, .narrated")?.textContent?.trim() ?? "";
// //       const reference =
// //         root.querySelector(".hadith_reference, .reference, a.greyText")?.textContent?.trim() ?? "";
// //       const grade = root.querySelector(".gradetable, .grade, .hadith_grade")?.textContent?.trim() ?? "";
// //       const link = root.querySelector("a[href*='bukhari'], a[href*='muslim'], a[href*='/']") as
// //         | HTMLAnchorElement
// //         | null;
// //       if (!arabic && !english) return;
// //       out.push({
// //         reference,
// //         narrator,
// //         arabicText: arabic,
// //         englishText: english,
// //         grade,
// //         href: link?.href ?? location.href,
// //       });
// //     });
// //     return out;
// //   }, max);

// //   return items.map((it, i) => ({
// //     index: i + 1,
// //     source: "sunnah" as const,
// //     sourceUrl: it.href || page.url(),
// //     reference: it.reference || undefined,
// //     narrator: it.narrator || undefined,
// //     arabicText: it.arabicText || undefined,
// //     englishText: it.englishText || undefined,
// //     grade: it.grade || undefined,
// //   }));
// // }

// // async function scrapeThaqalayn(page: Page, query: string, max: number): Promise<ScrapedItem[]> {
// //   // Site search UI varies; try English search then collect hadith-like blocks
// //   const url = `https://thaqalayn.net/search?q=${encodeURIComponent(query)}`;
// //   await goto(page, url);

// //   // If search 404s, land on home and note empty — user can pass a book URL later
// //   const items = await page.evaluate((limit) => {
// //     const out: Array<{
// //       reference: string;
// //       arabicText: string;
// //       englishText: string;
// //       href: string;
// //     }> = [];

// //     const candidates = document.querySelectorAll(
// //       "a[href*='/hadith/'], a[href*='/chapter/'], .hadith, article, .result, .card",
// //     );
// //     candidates.forEach((el) => {
// //       if (out.length >= limit) return;
// //       const root = el as HTMLElement;
// //       const text = root.textContent?.replace(/\s+/g, " ").trim() ?? "";
// //       if (text.length < 40) return;
// //       const href = (root as HTMLAnchorElement).href || root.querySelector("a")?.getAttribute("href") || "";
// //       const abs = href.startsWith("http") ? href : href ? new URL(href, location.origin).href : location.href;
// //       const arabicMatch = text.match(/[\u0600-\u06FF][^]*?[\u0600-\u06FF].{0,200}/);
// //       out.push({
// //         reference: abs,
// //         arabicText: arabicMatch?.[0]?.slice(0, 500) ?? "",
// //         englishText: text.slice(0, 500),
// //         href: abs,
// //       });
// //     });
// //     return out.slice(0, limit);
// //   }, max);

// //   return items.map((it, i) => ({
// //     index: i + 1,
// //     source: "thaqalayn" as const,
// //     sourceUrl: it.href,
// //     reference: it.reference || undefined,
// //     arabicText: it.arabicText || undefined,
// //     englishText: it.englishText || undefined,
// //   }));
// // }

// // async function scrapeHadeethEnc(page: Page, query: string, max: number): Promise<ScrapedItem[]> {
// //   const url = `https://hadeethenc.com/en/home?s=${encodeURIComponent(query)}`;
// //   await goto(page, url);

// //   // Prefer API-shaped pages if the UI exposes cards; also try search path
// //   const searchUrl = `https://hadeethenc.com/en/browse/hadith?phrase=${encodeURIComponent(query)}`;
// //   try {
// //     await goto(page, searchUrl);
// //   } catch {
// //     // stay on previous page
// //   }

// //   const items = await page.evaluate((limit) => {
// //     const out: Array<{
// //       arabicText: string;
// //       englishText: string;
// //       grade: string;
// //       href: string;
// //     }> = [];

// //     document
// //       .querySelectorAll(".hadith-card-container, .card, article, .hadith, [class*='Hadith']")
// //       .forEach((el) => {
// //         if (out.length >= limit) return;
// //         const root = el as HTMLElement;
// //         const english =
// //           root.querySelector(".hadith-text, .hadeeth-text, p")?.textContent?.trim() ??
// //           root.textContent?.replace(/\s+/g, " ").trim().slice(0, 600) ??
// //           "";
// //         const arabic =
// //           root.querySelector("[lang='ar'], .arabic, .ar")?.textContent?.trim() ?? "";
// //         const grade = root.querySelector(".grade, .authenticity, .badge")?.textContent?.trim() ?? "";
// //         const link = root.querySelector("a[href*='hadith']") as HTMLAnchorElement | null;
// //         if (english.length < 30 && !arabic) return;
// //         out.push({
// //           arabicText: arabic,
// //           englishText: english.slice(0, 800),
// //           grade,
// //           href: link?.href ?? location.href,
// //         });
// //       });
// //     return out;
// //   }, max);

// //   return items.map((it, i) => ({
// //     index: i + 1,
// //     source: "hadeethenc" as const,
// //     sourceUrl: it.href,
// //     arabicText: it.arabicText || undefined,
// //     englishText: it.englishText || undefined,
// //     grade: it.grade || undefined,
// //   }));
// // }

// // async function scrapeDorar(page: Page, query: string, max: number): Promise<ScrapedItem[]> {
// //   const url = `https://dorar.net/hadith/search?q=${encodeURIComponent(query)}`;
// //   await goto(page, url);

// //   // Cloudflare may challenge; give extra time
// //   await sleep(3000);

// //   const items = await page.evaluate((limit) => {
// //     const out: Array<{
// //       arabicText: string;
// //       narrator: string;
// //       grader: string;
// //       book: string;
// //       number: string;
// //       verdict: string;
// //       href: string;
// //     }> = [];

// //     const blocks = document.querySelectorAll(".hadith, .border, .hadith-info");
// //     const seen = new Set<string>();

// //     document.querySelectorAll(".border, .hadith").forEach((el) => {
// //       if (out.length >= limit) return;
// //       const root = el.closest(".border") ?? el;
// //       const arabic = root.querySelector(".hadith")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
// //       if (!arabic || arabic.length < 20 || seen.has(arabic.slice(0, 80))) return;
// //       seen.add(arabic.slice(0, 80));

// //       const info = root.textContent?.replace(/\s+/g, " ") ?? "";
// //       const pick = (label: string) => {
// //         const m = info.match(new RegExp(`${label}\\s*:\\s*([^:]+?)(?=الراوي|المحدث|المصدر|الصفحة|خلاصة|المزيد|$)`));
// //         return m?.[1]?.trim() ?? "";
// //       };

// //       const more = root.querySelector("a[href*='hadith']") as HTMLAnchorElement | null;
// //       out.push({
// //         arabicText: arabic.replace(/^\d+\s*[-–]\s*/, "").slice(0, 1200),
// //         narrator: pick("الراوي"),
// //         grader: pick("المحدث"),
// //         book: pick("المصدر"),
// //         number: pick("الصفحة أو الرقم"),
// //         verdict: pick("خلاصة حكم المحدث") || pick("درجة الحديث"),
// //         href: more?.href ?? location.href,
// //       });
// //     });

// //     // Fallback: split on visual separators if cards not found
// //     if (!out.length && blocks.length) {
// //       // no-op; already tried
// //     }
// //     return out.slice(0, limit);
// //   }, max);

// //   return items.map((it, i) => ({
// //     index: i + 1,
// //     source: "dorar" as const,
// //     sourceUrl: it.href,
// //     arabicText: it.arabicText || undefined,
// //     narrator: it.narrator || undefined,
// //     reference: [it.book, it.number].filter(Boolean).join(" #") || undefined,
// //     grade: it.verdict || undefined,
// //     extra: {
// //       grader: it.grader,
// //       book: it.book,
// //       pageOrNumber: it.number,
// //     },
// //   }));
// // }

// // async function scrapeAlIslam(page: Page, query: string, max: number): Promise<ScrapedItem[]> {
// //   const url = `https://www.al-islam.org/search/site/${encodeURIComponent(query)}`;
// //   await goto(page, url);

// //   const items = await page.evaluate((limit) => {
// //     const out: Array<{ title: string; snippet: string; href: string }> = [];
// //     document.querySelectorAll(".search-result, .views-row, article, li.search-result, .result").forEach((el) => {
// //       if (out.length >= limit) return;
// //       const root = el as HTMLElement;
// //       const link = root.querySelector("a") as HTMLAnchorElement | null;
// //       const title = link?.textContent?.trim() || root.querySelector("h2,h3,.title")?.textContent?.trim() || "";
// //       const snippet =
// //         root.querySelector(".search-snippet, .snippet, p")?.textContent?.replace(/\s+/g, " ").trim() ||
// //         root.textContent?.replace(/\s+/g, " ").trim().slice(0, 400) ||
// //         "";
// //       if (!title && snippet.length < 40) return;
// //       out.push({
// //         title,
// //         snippet: snippet.slice(0, 600),
// //         href: link?.href ?? location.href,
// //       });
// //     });

// //     // Generic fallback: main content links
// //     if (!out.length) {
// //       document.querySelectorAll("main a[href], #content a[href]").forEach((a) => {
// //         if (out.length >= limit) return;
// //         const el = a as HTMLAnchorElement;
// //         const t = el.textContent?.trim() ?? "";
// //         if (t.length < 15) return;
// //         out.push({ title: t.slice(0, 200), snippet: "", href: el.href });
// //       });
// //     }
// //     return out.slice(0, limit);
// //   }, max);

// //   return items.map((it, i) => ({
// //     index: i + 1,
// //     source: "al-islam" as const,
// //     sourceUrl: it.href,
// //     reference: it.title || undefined,
// //     englishText: it.snippet || it.title || undefined,
// //   }));
// // }

// // async function runSource(
// //   browser: Browser,
// //   source: SourceId,
// //   query: string,
// //   max: number,
// //   saveHtml: boolean,
// //   outDir: string,
// // ): Promise<SourceResult> {
// //   const startedAt = new Date().toISOString();
// //   const page = await newPage(browser);
// //   let pageUrl = "";
// //   try {
// //     console.log(`\n[${source}] starting…`);
// //     let items: ScrapedItem[] = [];
// //     switch (source) {
// //       case "sunnah":
// //         items = await scrapeSunnah(page, query, max);
// //         break;
// //       case "thaqalayn":
// //         items = await scrapeThaqalayn(page, query, max);
// //         break;
// //       case "hadeethenc":
// //         items = await scrapeHadeethEnc(page, query, max);
// //         break;
// //       case "dorar":
// //         items = await scrapeDorar(page, query, max);
// //         break;
// //       case "al-islam":
// //         items = await scrapeAlIslam(page, query, max);
// //         break;
// //     }
// //     pageUrl = page.url();
// //     if (saveHtml) {
// //       const htmlPath = path.join(outDir, `${source}.html`);
// //       writeFileSync(htmlPath, await page.content(), "utf8");
// //       console.log(`[${source}] wrote ${htmlPath}`);
// //     }
// //     console.log(`[${source}] ${items.length} item(s) from ${pageUrl}`);
// //     return {
// //       source,
// //       query,
// //       startedAt,
// //       finishedAt: new Date().toISOString(),
// //       pageUrl,
// //       ok: true,
// //       itemCount: items.length,
// //       items,
// //     };
// //   } catch (err) {
// //     const message = err instanceof Error ? err.message : String(err);
// //     console.error(`[${source}] FAILED: ${message}`);
// //     if (saveHtml) {
// //       try {
// //         writeFileSync(path.join(outDir, `${source}.error.html`), await page.content(), "utf8");
// //       } catch {
// //         /* ignore */
// //       }
// //     }
// //     return {
// //       source,
// //       query,
// //       startedAt,
// //       finishedAt: new Date().toISOString(),
// //       pageUrl: page.url() || pageUrl,
// //       ok: false,
// //       error: message,
// //       itemCount: 0,
// //       items: [],
// //     };
// //   } finally {
// //     await page.close();
// //     await sleep(1500);
// //   }
// // }

// // async function main() {
// //   const query = argValue("--query")?.trim();
// //   if (!query) {
// //     console.error('Missing --query. Example: --query "بدء الوحي"');
// //     process.exit(1);
// //   }

// //   const sourcesArg = argValue("--sources");
// //   const sources: SourceId[] = sourcesArg
// //     ? (sourcesArg.split(",").map((s) => s.trim().toLowerCase()) as SourceId[])
// //     : [...ALL_SOURCES];

// //   for (const s of sources) {
// //     if (!ALL_SOURCES.includes(s)) {
// //       console.error(`Unknown source "${s}". Allowed: ${ALL_SOURCES.join(", ")}`);
// //       process.exit(1);
// //     }
// //   }

// //   const max = Number(argValue("--max") ?? "20") || 20;
// //   const headed = hasFlag("--headed");
// //   const saveHtml = hasFlag("--save-html");
// //   const outRoot = argValue("--out") ?? path.join(process.cwd(), "data", "scraped");
// //   const runId = new Date().toISOString().replace(/[:.]/g, "-");
// //   const outDir = path.join(outRoot, runId);
// //   mkdirSync(outDir, { recursive: true });

// //   console.log("Playwright multi-source scrape");
// //   console.log(`  query   : ${query}`);
// //   console.log(`  sources : ${sources.join(", ")}`);
// //   console.log(`  max/src : ${max}`);
// //   console.log(`  out     : ${outDir}`);
// //   console.log(`  mode    : ${headed ? "headed" : "headless"}`);
// //   console.log("  note    : no database writes; review JSON before any import");

// //   const browser = await chromium.launch({
// //     headless: !headed,
// //     channel: headed ? "chrome" : undefined,
// //   });

// //   const results: SourceResult[] = [];
// //   try {
// //     for (const source of sources) {
// //       results.push(await runSource(browser, source, query, max, saveHtml, outDir));
// //     }
// //   } finally {
// //     await browser.close();
// //   }

// //   const summary = {
// //     runId,
// //     query,
// //     createdAt: new Date().toISOString(),
// //     sources,
// //     totals: Object.fromEntries(results.map((r) => [r.source, { ok: r.ok, count: r.itemCount, error: r.error }])),
// //     results,
// //   };

// //   const summaryPath = path.join(outDir, "summary.json");
// //   writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
// //   for (const r of results) {
// //     writeFileSync(path.join(outDir, `${r.source}.json`), JSON.stringify(r, null, 2), "utf8");
// //   }

// //   console.log("\n=== DONE ===");
// //   for (const r of results) {
// //     console.log(`  ${r.source}: ${r.ok ? `${r.itemCount} items` : `ERROR — ${r.error}`}`);
// //   }
// //   console.log(`Summary: ${summaryPath}`);
// // }

// // main().catch((err) => {
// //   console.error(err);
// //   process.exit(1);
// // });

// /**
//  * First-revelation (بدء الوحي) collector — five sources, READ-ONLY, writes JSON only.
//  * Does NOT touch Supabase. Review the JSON, then import.
//  *
//  * How each source is read (verified where marked):
//  *   hadeethenc : official public API v1 (endpoints verified in its Postman docs). Terms: do not
//  *                modify content, credit HadeethEnc.com.
//  *   thaqalayn  : public Thaqalayn API v2 (thaqalayn-api.net; /query?q= verified in its README).
//  *   sunnah     : Playwright. Fixed seed hadiths (page layout confirmed by your first run) + search.
//  *   dorar      : Playwright, OPT-IN, headed only. Cloudflare may ask you to tick a box — you do it
//  *                by hand in the window; the script waits. Selectors are UNVERIFIED.
//  *   al-islam   : Playwright. Returns LEADS (page titles/snippets), not structured hadith.
//  *
//  * Setup (once):   npm i -D playwright tsx   &&   npx playwright install chromium
//  * Needs Node 18+ (uses built-in fetch).
//  *
//  * Run examples:
//  *   npx tsx scripts/scrapers/scrape-first-revelation.ts
//  *   npx tsx scripts/scrapers/scrape-first-revelation.ts --sources hadeethenc,thaqalayn
//  *   npx tsx scripts/scrapers/scrape-first-revelation.ts --sources sunnah --headed --save-html
//  *   npx tsx scripts/scrapers/scrape-first-revelation.ts --sources dorar --headed
//  *
//  * Flags:
//  *   --sources a,b   subset of sunnah,thaqalayn,hadeethenc,dorar,al-islam
//  *                   (default: sunnah,thaqalayn,hadeethenc,al-islam — dorar is opt-in)
//  *   --max <n>       max items per query/source (default 25)
//  *   --refs a,b      Sunnah.com seed refs, e.g. bukhari:4953,muslim:160 (replaces default seeds)
//  *   --he-ids a,b    extra HadeethEnc hadith ids to fetch
//  *   --queries a|b   replace the default search phrases (separate with |)
//  *   --headed        show the browser     --chrome  use your installed Chrome
//  *   --save-html     save raw HTML of browser pages for selector debugging
//  *   --out <dir>     output root (default data/scraped)
//  */
// import { createHash } from "node:crypto";
// import { mkdirSync, writeFileSync } from "node:fs";
// import path from "node:path";
// import { chromium, type BrowserContext, type Page } from "playwright";

// type SourceId = "sunnah" | "thaqalayn" | "hadeethenc" | "dorar" | "al-islam";

// type Item = {
//   source: SourceId;
//   kind: "hadith" | "lead";
//   sourceUrl: string;
//   externalId?: string;
//   collection?: string;
//   reference?: string;
//   narrator?: string;
//   arabicText?: string;
//   englishText?: string;
//   grade?: string;
//   gradeBy?: string;
//   chain?: string;
//   matchedQueries: string[];
//   extra?: Record<string, string>;
//   relevance?: { relevant: boolean; core: string[]; support: string[] };
//   checksum?: string;
//   retrievedAt: string;
// };

// type SourceReport = { source: SourceId; ok: boolean; count: number; error?: string; note: string };

// const ALL: SourceId[] = ["sunnah", "thaqalayn", "hadeethenc", "dorar", "al-islam"];
// const DEFAULT_SOURCES: SourceId[] = ["sunnah", "thaqalayn", "hadeethenc", "al-islam"];
// const UA = "HadithCollectionResearchBot/1.0 (+operator-run, low volume, non-commercial research)";
// const DELAY_MS = 1500;

// const DEFAULT_QUERIES = [
//   "Hira",
//   "Iqra",
//   "beginning of the revelation",
//   "first revelation",
//   "period of pause",
//   "بدء الوحي",
//   "غار حراء",
// ];
// const DEFAULT_SUNNAH_REFS = [
//   "bukhari:1", "bukhari:2", "bukhari:3", "bukhari:4", "bukhari:5", "bukhari:6", "bukhari:7",
//   "bukhari:4953", "bukhari:6982", "muslim:160",
// ];

// const NOTES: Record<SourceId, string> = {
//   sunnah: "Playwright. Official Sunnah.com API request is pending — switch to it when you get a key.",
//   thaqalayn: "Public Thaqalayn API v2. Search is exact-substring; diacritized Arabic may be missed. Credit thaqalayn.net.",
//   hadeethenc: "Official API. Terms: no modification of content; credit HadeethEnc.com.",
//   dorar: "Opt-in, headed, manual Cloudflare step. Selectors unverified. Get permission for bulk use.",
//   "al-islam": "Leads only (titles/snippets). Pages carry their own copyright.",
// };

// /* ───────────── helpers ───────────── */

// const arg = (f: string): string | undefined => {
//   const i = process.argv.indexOf(f);
//   const v = i >= 0 ? process.argv[i + 1] : undefined;
//   return v && !v.startsWith("--") ? v : undefined;
// };
// const flag = (f: string): boolean => process.argv.includes(f);
// const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// const str = (v: unknown): string =>
//   typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
// const rec = (v: unknown): Record<string, unknown> =>
//   v && typeof v === "object" ? (v as Record<string, unknown>) : {};

// function normAr(s: string): string {
//   return s
//     .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
//     .replace(/[أإآٱ]/g, "ا")
//     .replace(/ى/g, "ي")
//     .replace(/ؤ/g, "و")
//     .replace(/ئ/g, "ي")
//     .replace(/ة/g, "ه")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// async function fetchJson(url: string, tries = 3): Promise<unknown> {
//   let last: unknown;
//   for (let i = 1; i <= tries; i++) {
//     const ctrl = new AbortController();
//     const timer = setTimeout(() => ctrl.abort(), 60_000);
//     try {
//       const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
//       if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
//       return await res.json();
//     } catch (e) {
//       last = e;
//       await sleep(DELAY_MS * i);
//     } finally {
//       clearTimeout(timer);
//     }
//   }
//   throw last instanceof Error ? last : new Error(String(last));
// }

// /* ───────────── relevance (first revelation / بدء الوحي) ───────────── */

// const CORE: Array<[string, RegExp]> = [
//   ["hira", /(?<![a-z])hir[aāá](?![a-z])|حراء/i],
//   ["iqra", /(?<![a-z])iqr[aāá](?![a-z])|read in the name|اقرا باسم/i],
//   ["beginning-of-revelation",
//     /beginning of (the )?(divine )?(revelation|inspiration)|first revelation|first (thing |verses? |surah )?(that )?(was |were )?revealed|بدء الوحي|اول ما نزل/i],
//   ["pause-in-revelation", /(pause|intermission) (in|of) (the )?(divine )?(revelation|inspiration)|فتره الوحي|fatrat/i],
// ];
// const SUPPORT: Array<[string, RegExp]> = [
//   ["dream", /(true|righteous|good|sound|pious) dream|الرويا الصالحه|الرويا الصادقه/i],
//   ["angel-gabriel", /(?<![a-z])(gabriel|jibr[iī]l|jibreel|angel)(?![a-z])|جبريل|الملك/i],
//   ["revelation-word", /(?<![a-z])(revelation|inspiration|revealed)(?![a-z])|الوحي/i],
//   ["muddaththir", /(?<![a-z])muddath+ir|المدثر|المزمل/i],
// ];

// function scoreRelevance(it: Item): NonNullable<Item["relevance"]> {
//   const hay = `${normAr(it.arabicText ?? "")} ${(it.englishText ?? "").toLowerCase()}`;
//   const core = CORE.filter(([, re]) => re.test(hay)).map(([n]) => n);
//   const support = SUPPORT.filter(([, re]) => re.test(hay)).map(([n]) => n);
//   return { relevant: core.length > 0 || support.length >= 2, core, support };
// }

// function finalize(items: Item[]): Item[] {
//   const byKey = new Map<string, Item>();
//   for (const it of items) {
//     const ar = normAr(it.arabicText ?? "");
//     const basis = ar ? ar.slice(0, 300) : (it.englishText ?? "").toLowerCase().replace(/\s+/g, " ").slice(0, 300);
//     const key = `${it.source}|${it.externalId || it.sourceUrl || sha(basis)}`;
//     const seen = byKey.get(key);
//     if (seen) {
//       seen.matchedQueries = [...new Set([...seen.matchedQueries, ...it.matchedQueries])];
//       continue;
//     }
//     it.checksum = sha(`${it.source}|${basis}`);
//     it.relevance = scoreRelevance(it);
//     byKey.set(key, it);
//   }
//   return [...byKey.values()];
// }

// /* ───────────── HadeethEnc (official API) ───────────── */

// async function runHadeethEnc(max: number, extraIds: string[]): Promise<Item[]> {
//   const API = "https://hadeethenc.com/api/v1";
//   const TITLE_RE = /revelation|inspiration|hira|iqra|gabriel|jibr|angel|dream|first revealed|qur.?an was revealed/i;
//   const CAT_RE = /revelation|prophet|biograph|sira|qur|dream|angel|faith|belief/i;
//   const ids = new Map<string, string>(); // id -> why

//   const cats = await fetchJson(`${API}/categories/list/?language=en`);
//   const catList = (Array.isArray(cats) ? cats : []).map(rec).filter((c) => CAT_RE.test(str(c.title))).slice(0, 15);
//   console.log(`[hadeethenc] scanning ${catList.length} matching categories`);

//   for (const c of catList) {
//     for (let page = 1; page <= 6 && ids.size < max * 4; page++) {
//       await sleep(DELAY_MS);
//       const j = rec(await fetchJson(`${API}/hadeeths/list/?language=en&category_id=${str(c.id)}&page=${page}&per_page=50`));
//       const rows = Array.isArray(j.data) ? j.data.map(rec) : [];
//       for (const r of rows) if (TITLE_RE.test(str(r.title))) ids.set(str(r.id), `category:${str(c.title)}`);
//       const last = Number(rec(j.meta).last_page ?? 1);
//       if (page >= last || !rows.length) break;
//     }
//   }
//   for (const id of extraIds) ids.set(id, "--he-ids");

//   const out: Item[] = [];
//   for (const [id, why] of [...ids].slice(0, max * 4)) {
//     try {
//       await sleep(DELAY_MS);
//       const en = rec(await fetchJson(`${API}/hadeeths/one/?language=en&id=${id}`));
//       await sleep(DELAY_MS);
//       const ar = rec(await fetchJson(`${API}/hadeeths/one/?language=ar&id=${id}`));
//       out.push({
//         source: "hadeethenc", kind: "hadith",
//         sourceUrl: `https://hadeethenc.com/en/browse/hadith/${id}`,
//         externalId: id,
//         reference: str(en.attribution) || undefined,
//         arabicText: str(ar.hadeeth) || undefined,
//         englishText: str(en.hadeeth) || undefined,
//         grade: str(en.grade) || undefined,
//         matchedQueries: [why],
//         extra: { title: str(en.title), explanation: str(en.explanation), reference: str(en.reference) },
//         retrievedAt: new Date().toISOString(),
//       });
//     } catch (e) {
//       console.error(`[hadeethenc] id ${id} failed: ${e instanceof Error ? e.message : e}`);
//     }
//   }
//   return out;
// }

// /* ───────────── Thaqalayn (public API v2) ───────────── */

// async function runThaqalayn(queries: string[], max: number): Promise<Item[]> {
//   const API = "https://www.thaqalayn-api.net/api/v2";
//   const out: Item[] = [];
//   for (const q of queries) {
//     await sleep(DELAY_MS);
//     let json: unknown;
//     try {
//       json = await fetchJson(`${API}/query?q=${encodeURIComponent(q)}`);
//     } catch (e) {
//       console.error(`[thaqalayn] "${q}" failed: ${e instanceof Error ? e.message : e}`);
//       continue;
//     }
//     const j = rec(json);
//     const rows = (Array.isArray(json) ? json : Array.isArray(j.results) ? j.results : Array.isArray(j.data) ? j.data : Array.isArray(j.hadiths) ? j.hadiths : []) as unknown[];
//     console.log(`[thaqalayn] "${q}": ${rows.length} match(es), keeping up to ${max}`);
//     for (const raw of rows.slice(0, max)) {
//       const r = rec(raw);
//       const gradeBy = r.majlisiGrading ? "Majlisi" : r.behbudiGrading ? "Behbudi" : r.mohseniGrading ? "Mohseni" : "";
//       const grade = str(r.majlisiGrading) || str(r.behbudiGrading) || str(r.mohseniGrading);
//       out.push({
//         source: "thaqalayn", kind: "hadith",
//         sourceUrl: str(r.URL) || str(r.url),
//         externalId: `${str(r.bookId)}:${str(r.id)}`,
//         collection: str(r.book) || undefined,
//         reference: [str(r.book), str(r.idInBook) || str(r.id)].filter(Boolean).join(" #") || undefined,
//         arabicText: str(r.arabicText) || undefined,
//         englishText: str(r.englishText) || undefined,
//         grade: grade || undefined,
//         gradeBy: gradeBy || undefined,
//         chain: str(r.thaqalaynSanad) || str(r.sanad) || undefined,
//         matchedQueries: [q],
//         extra: { chapter: str(r.chapter), volume: str(r.volume), part: str(r.part), gradingsFull: JSON.stringify(r.gradingsFull ?? "") },
//         retrievedAt: new Date().toISOString(),
//       });
//     }
//   }
//   return out;
// }

// /* ───────────── Browser sources ───────────── */

// async function gotoOk(page: Page, url: string): Promise<boolean> {
//   const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
//   await sleep(2000);
//   return !!resp && resp.status() < 400;
// }

// async function sunnahCards(page: Page, limit: number) {
//   return page.evaluate((lim) => {
//     const pick = (root: Element, sels: string): string => {
//       for (const s of sels.split(",")) {
//         const t = root.querySelector(s.trim())?.textContent?.replace(/\s+/g, " ").trim();
//         if (t) return t;
//       }
//       return "";
//     };
//     const out: Array<Record<string, string>> = [];
//     const seen = new Set<string>();
//     document.querySelectorAll(".actualHadithContainer, .search_hadith_info, .hadith_container").forEach((el) => {
//       if (out.length >= lim) return;
//       const ar = pick(el, ".arabic_text_details, .arabic_hadith_full, .arabic, [lang='ar']");
//       const en = pick(el, ".text_details, .english_hadith_full, .hadith_english");
//       if (!ar && !en) return;
//       const key = (ar || en).slice(0, 80);
//       if (seen.has(key)) return;
//       seen.add(key);
//       const hrefs = Array.from(el.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href);
//       const link =
//         hrefs.find((h) => /sunnah\.com\/[a-z0-9]+:[\w.:-]+$/i.test(h)) ||
//         hrefs.find((h) => /sunnah\.com\/[a-z0-9]+\/[\w-]+\/[\w.-]+$/i.test(h)) ||
//         location.href;
//       out.push({
//         href: link, ar, en,
//         narrator: pick(el, ".hadith_narrated, .english_narrator, .narrated"),
//         reference: pick(el, ".hadith_reference_sticky, .hadith_reference, .reference"),
//         grade: pick(el, ".gradetable, .grade, .hadith_grade"),
//       });
//     });
//     return out;
//   }, limit);
// }

// function sunnahItem(c: Record<string, string>, query: string): Item {
//   const ref = c.reference;
//   const refClean = ref.match(/Reference\s*:\s*(.+?)(?=In-book|USC-MSA|English translation|Arabic reference|$)/i)?.[1]?.trim() || ref;
//   const m = c.href.match(/sunnah\.com\/([a-z0-9]+)[:/](.+)$/i);
//   return {
//     source: "sunnah", kind: "hadith", sourceUrl: c.href,
//     externalId: m ? `${m[1]}:${m[2]}` : undefined,
//     collection: m?.[1],
//     reference: refClean || undefined,
//     narrator: c.narrator || undefined,
//     arabicText: c.ar || undefined,
//     englishText: c.en || undefined,
//     grade: c.grade || undefined,
//     matchedQueries: [query],
//     extra: { referenceRaw: ref },
//     retrievedAt: new Date().toISOString(),
//   };
// }

// async function runSunnah(ctx: BrowserContext, queries: string[], refs: string[], max: number, outDir: string, saveHtml: boolean): Promise<Item[]> {
//   const page = await ctx.newPage();
//   page.setDefaultTimeout(45_000);
//   const out: Item[] = [];
//   try {
//     for (const ref of refs) {
//       // Muslim numbers are sometimes suffixed (160a); try the plain ref, then "a".
//       for (const candidate of [ref, `${ref}a`]) {
//         if (!(await gotoOk(page, `https://sunnah.com/${candidate}`))) continue;
//         const cards = await sunnahCards(page, 1);
//         if (cards.length) {
//           out.push(sunnahItem(cards[0], `seed:${candidate}`));
//           break;
//         }
//       }
//       await sleep(DELAY_MS);
//     }
//     for (const q of queries) {
//       if (await gotoOk(page, `https://sunnah.com/search?q=${encodeURIComponent(q)}`)) {
//         const cards = await sunnahCards(page, max);
//         console.log(`[sunnah] search "${q}": ${cards.length} card(s)`);
//         cards.forEach((c) => out.push(sunnahItem(c, `search:${q}`)));
//         if (saveHtml) writeFileSync(path.join(outDir, `sunnah-search-${sha(q).slice(0, 6)}.html`), await page.content(), "utf8");
//       }
//       await sleep(DELAY_MS);
//     }
//   } finally {
//     await page.close();
//   }
//   return out;
// }

// async function runAlIslam(ctx: BrowserContext, queries: string[], max: number): Promise<Item[]> {
//   const page = await ctx.newPage();
//   page.setDefaultTimeout(45_000);
//   const out: Item[] = [];
//   try {
//     for (const q of queries) {
//       if (await gotoOk(page, `https://www.al-islam.org/search/site/${encodeURIComponent(q)}`)) {
//         const rows = await page.evaluate((lim) => {
//           const r: Array<{ title: string; snippet: string; href: string }> = [];
//           document.querySelectorAll(".search-result, .views-row, li.search-result, article").forEach((el) => {
//             if (r.length >= lim) return;
//             const a = el.querySelector("a") as HTMLAnchorElement | null;
//             const title = a?.textContent?.trim() || "";
//             const snippet = (el.querySelector(".search-snippet, .snippet, p")?.textContent || "").replace(/\s+/g, " ").trim();
//             if (title && a) r.push({ title, snippet: snippet.slice(0, 600), href: a.href });
//           });
//           return r;
//         }, max);
//         console.log(`[al-islam] "${q}": ${rows.length} lead(s)`);
//         for (const x of rows)
//           out.push({
//             source: "al-islam", kind: "lead", sourceUrl: x.href, reference: x.title,
//             englishText: `${x.title}. ${x.snippet}`.trim(), matchedQueries: [q], retrievedAt: new Date().toISOString(),
//           });
//       }
//       await sleep(DELAY_MS);
//     }
//   } finally {
//     await page.close();
//   }
//   return out;
// }

// async function runDorar(outRoot: string, queries: string[], max: number, channel: "chrome" | undefined, saveHtml: boolean, outDir: string): Promise<Item[]> {
//   const ctx = await chromium.launchPersistentContext(path.join(outRoot, ".dorar-profile"), { headless: false, channel });
//   const page = ctx.pages()[0] ?? (await ctx.newPage());
//   page.setDefaultTimeout(45_000);
//   const out: Item[] = [];
//   try {
//     for (const q of queries.filter((x) => /[\u0600-\u06FF]/.test(x))) {
//       await page.goto(`https://dorar.net/hadith/search?q=${encodeURIComponent(q)}`, { waitUntil: "domcontentloaded" });
//       let warned = false;
//       const start = Date.now();
//       for (;;) {
//         const title = (await page.title()).toLowerCase();
//         const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 500).toLowerCase();
//         if (!(title.includes("just a moment") || body.includes("verify you are human") || body.includes("checking your browser"))) break;
//         if (!warned) { console.log("[dorar] Cloudflare check — complete it in the browser window (waiting up to 2 min)…"); warned = true; }
//         if (Date.now() - start > 120_000) throw new Error("Cloudflare challenge not cleared");
//         await sleep(3000);
//       }
//       await sleep(2500);
//       const rows = await page.evaluate((lim) => {
//         const r: Array<Record<string, string>> = [];
//         const seen = new Set<string>();
//         document.querySelectorAll(".border, .hadith").forEach((el) => {
//           if (r.length >= lim) return;
//           const root = el.closest(".border") ?? el;
//           const ar = (root.querySelector(".hadith")?.textContent || "").replace(/\s+/g, " ").trim();
//           if (ar.length < 20 || seen.has(ar.slice(0, 80))) return;
//           seen.add(ar.slice(0, 80));
//           const info = (root.textContent || "").replace(/\s+/g, " ");
//           const pick = (label: string) =>
//             info.match(new RegExp(`${label}\\s*:\\s*([^:]+?)(?=الراوي|المحدث|المصدر|الصفحة|خلاصة|المزيد|$)`))?.[1]?.trim() ?? "";
//           r.push({
//             ar: ar.replace(/^\d+\s*[-–]\s*/, "").slice(0, 1500),
//             narrator: pick("الراوي"), grader: pick("المحدث"), book: pick("المصدر"),
//             number: pick("الصفحة أو الرقم"), verdict: pick("خلاصة حكم المحدث") || pick("درجة الحديث"),
//             href: (root.querySelector("a[href*='hadith']") as HTMLAnchorElement | null)?.href ?? location.href,
//           });
//         });
//         return r;
//       }, max);
//       console.log(`[dorar] "${q}": ${rows.length} row(s)`);
//       if (saveHtml) writeFileSync(path.join(outDir, `dorar-${sha(q).slice(0, 6)}.html`), await page.content(), "utf8");
//       for (const x of rows)
//         out.push({
//           source: "dorar", kind: "hadith", sourceUrl: x.href, arabicText: x.ar, narrator: x.narrator || undefined,
//           reference: [x.book, x.number].filter(Boolean).join(" #") || undefined,
//           grade: x.verdict || undefined, gradeBy: x.grader || undefined,
//           matchedQueries: [q], retrievedAt: new Date().toISOString(),
//         });
//       await sleep(DELAY_MS * 2);
//     }
//   } finally {
//     await ctx.close();
//   }
//   return out;
// }

// /* ───────────── main ───────────── */

// async function main() {
//   const sources = (arg("--sources")?.split(",").map((s) => s.trim().toLowerCase()) ?? DEFAULT_SOURCES) as SourceId[];
//   for (const s of sources) if (!ALL.includes(s)) { console.error(`Unknown source "${s}". Allowed: ${ALL.join(", ")}`); process.exit(1); }
//   const max = Number(arg("--max") ?? "25") || 25;
//   const queries = arg("--queries")?.split("|").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_QUERIES;
//   const refs = arg("--refs")?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_SUNNAH_REFS;
//   const heIds = arg("--he-ids")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
//   const headed = flag("--headed");
//   const channel = flag("--chrome") ? ("chrome" as const) : undefined;
//   const saveHtml = flag("--save-html");
//   const outRoot = arg("--out") ?? path.join(process.cwd(), "data", "scraped");
//   const runId = new Date().toISOString().replace(/[:.]/g, "-");
//   const outDir = path.join(outRoot, `first-revelation-${runId}`);
//   mkdirSync(outDir, { recursive: true });

//   if (sources.includes("dorar") && !headed) { console.error("Dorar needs --headed (you may have to pass a Cloudflare check by hand)."); process.exit(1); }

//   console.log(`First-revelation collector\n  sources: ${sources.join(", ")}\n  queries: ${queries.join(" | ")}\n  out    : ${outDir}\n  note   : read-only, no database writes`);

//   const reports: SourceReport[] = [];
//   const all: Item[] = [];
//   const record = async (source: SourceId, fn: () => Promise<Item[]>) => {
//     try {
//       console.log(`\n[${source}] starting…`);
//       const items = finalize(await fn());
//       writeFileSync(path.join(outDir, `${source}.json`), JSON.stringify(items, null, 2), "utf8");
//       all.push(...items);
//       reports.push({ source, ok: true, count: items.length, note: NOTES[source] });
//     } catch (e) {
//       const error = e instanceof Error ? e.message : String(e);
//       console.error(`[${source}] FAILED: ${error}`);
//       reports.push({ source, ok: false, count: 0, error, note: NOTES[source] });
//     }
//   };

//   if (sources.includes("hadeethenc")) await record("hadeethenc", () => runHadeethEnc(max, heIds));
//   if (sources.includes("thaqalayn")) await record("thaqalayn", () => runThaqalayn(queries, max));

//   if (sources.includes("sunnah") || sources.includes("al-islam")) {
//     const browser = await chromium.launch({ headless: !headed, channel });
//     const ctx = await browser.newContext({ userAgent: UA, locale: "en-US" });
//     try {
//       if (sources.includes("sunnah")) {
//         await record("sunnah", () => runSunnah(ctx, queries, refs, Math.min(max, 10), outDir, saveHtml));
//       }
//       if (sources.includes("al-islam")) {
//         await record("al-islam", () => runAlIslam(ctx, queries.slice(0, 4), Math.min(max, 10)));
//       }
//     } finally {
//       await ctx.close();
//       await browser.close();
//     }
//   }
//   if (sources.includes("dorar")) await record("dorar", () => runDorar(outRoot, queries, max, channel, saveHtml, outDir));

//   const relevant = all.filter((i) => i.relevance?.relevant);
//   writeFileSync(path.join(outDir, "all-items.json"), JSON.stringify(all, null, 2), "utf8");
//   writeFileSync(path.join(outDir, "relevant-items.json"), JSON.stringify(relevant, null, 2), "utf8");
//   writeFileSync(
//     path.join(outDir, "summary.json"),
//     JSON.stringify({ runId, createdAt: new Date().toISOString(), queries, refs, reports, totals: { collected: all.length, relevant: relevant.length } }, null, 2),
//     "utf8",
//   );

//   console.log("\n=== DONE ===");
//   for (const r of reports) {
//     const rel = relevant.filter((i) => i.source === r.source).length;
//     console.log(`  ${r.source.padEnd(11)} ${r.ok ? `${r.count} collected, ${rel} relevant` : `ERROR — ${r.error}`}`);
//   }
//   console.log(`  total: ${all.length} collected, ${relevant.length} relevant\n  files: ${outDir}`);
// }

// main().catch((e) => {
//   console.error(e);
//   process.exit(1);
// });

import * as fs from "fs";
import * as path from "path";
import { runSite, parseCli } from "./hadith-scraper";
import { SITES, SITE_NAMES } from "./sites";

/*
  Usage:
    npx tsx scripts/scrapers/scrape-all-sources.ts                  # all sites
    npx tsx scripts/scrapers/scrape-all-sources.ts sunnah dorar     # selected sites
    npx tsx scripts/scrapers/scrape-all-sources.ts sunnah --max=20  # stop after 20 content pages
    flags: --headless  --fresh  --max=N (content pages)  --max-nav=N (nav page cap, default 2000)
*/
async function main() {
  const { names, opts } = parseCli(process.argv.slice(2));
  const targets = names.length ? names : SITE_NAMES;

  for (const n of targets) {
    if (!SITES[n]) {
      console.error(`Unknown site "${n}". Available: ${SITE_NAMES.join(", ")}`);
      process.exit(1);
    }
  }

  for (const n of targets) {
    console.log(`\n===== ${n} =====`);
    try {
      await runSite(SITES[n], opts);
    } catch (e) {
      console.error(`[${n}] crashed, continuing with next site`, e);
    }
  }

  // merge everything into one deduped file
  const rawDir = opts.outDir ?? path.join("data", "raw");
  const merged = new Map<string, string>();
  for (const f of fs.readdirSync(rawDir).filter((x) => x.endsWith(".jsonl") && x !== "all.jsonl")) {
    for (const line of fs.readFileSync(path.join(rawDir, f), "utf8").split("\n")) {
      if (!line) continue;
      try { merged.set(JSON.parse(line).id, line); } catch { /* skip bad line */ }
    }
  }
  fs.writeFileSync(path.join(rawDir, "all.jsonl"), [...merged.values()].join("\n") + "\n", "utf8");
  console.log(`\nMerged ${merged.size} unique records -> ${path.join(rawDir, "all.jsonl")}`);
}

main();