// /// <reference lib="dom" />
// import { chromium, Page } from "playwright";
// import * as fs from "fs";
// import * as path from "path";
// import * as crypto from "crypto";
// import * as readline from "readline";

// /* ----------------------------- types ----------------------------- */

// export type Sel = string | string[]; // list = fallback candidates, first one that matches wins
// export type FieldName =
//   | "reference" | "book" | "chapter" | "arabic" | "english"
//   | "narrator" | "grade" | "explanation" | "title";

// export interface Hadith {
//   id: string;
//   source: string;
//   url: string;
//   title: string | null;
//   reference: string | null;
//   book: string | null;
//   chapter: string | null;
//   narrator: string | null;
//   grade: string | null;
//   arabic: string | null;
//   arabicPlain: string | null; // no tashkeel, normalized alef/yaa
//   english: string | null;
//   explanation: string | null;
//   meta: Record<string, string>;
//   scrapedAt: string;
// }

// export interface SiteConfig {
//   name: string;
//   seeds: string[];
//   /** which links to put in the crawl queue */
//   follow: (u: URL) => boolean;
//   /** which pages contain hadith data to extract */
//   isContent: (u: URL) => boolean;
//   /** container per hadith (or the page body for single-hadith pages) */
//   item: Sel;
//   /** per-field selectors, resolved inside each item. ":self" = the item itself */
//   fields: Partial<Record<FieldName, Sel>>;
//   /** optional block of "label: value" lines (used by dorar.net) */
//   info?: Sel;
//   /** wait for this selector before extracting (JS-rendered pages) */
//   waitFor?: string;
//   /** remove these elements' text from every field (e.g. "span.text-gray") */
//   strip?: string[];
//   /** map labels in `info` to fields; unmapped labels go to meta */
//   labels?: Record<string, FieldName>;
//   maxPages?: number;
//   delayMs?: [number, number];
// }

// export interface RunOptions {
//   headless?: boolean;
//   maxPages?: number;
//   fresh?: boolean;
//   login?: boolean; // pause after opening the first seed so you can log in / solve a check
//   outDir?: string;
// }

// /* ----------------------------- helpers ----------------------------- */

// const sleep = (min: number, max: number) =>
//   new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

// const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0640]/g;

// export const plainArabic = (s: string | null): string | null =>
//   s
//     ? s.replace(TASHKEEL, "").replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").trim()
//     : null;

// const clean = (s: string | null | undefined): string | null => {
//   if (!s) return null;
//   const t = s.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
//   return t || null;
// };

// const norm = (u: URL): string => {
//   const c = new URL(u.href);
//   c.hash = "";
//   if (c.pathname.length > 1) c.pathname = c.pathname.replace(/\/+$/, "");
//   return c.href;
// };

// const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

// function parseInfo(
//   text: string | null,
//   labels: Record<string, FieldName> = {}
// ): { mapped: Partial<Record<FieldName, string>>; meta: Record<string, string> } {
//   const mapped: Partial<Record<FieldName, string>> = {};
//   const meta: Record<string, string> = {};
//   if (!text) return { mapped, meta };
//   const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
//   for (let i = 0; i < lines.length; i++) {
//     const m = lines[i].match(/^([^:：]{1,60})[:：]\s*(.*)$/);
//     if (!m) continue;
//     const label = m[1].trim();
//     let value = m[2].trim();
//     if (!value && lines[i + 1] && !/[:：]\s*$/.test(lines[i + 1])) value = lines[++i];
//     if (!value) continue;
//     const field = labels[label];
//     if (field) mapped[field] = value;
//     else meta[label] = value;
//   }
//   return { mapped, meta };
// }

// /* ----------------------------- extraction ----------------------------- */

// export async function extractItems(page: Page, cfg: Pick<SiteConfig, "item" | "fields" | "info" | "strip">) {
//   return page.evaluate(
//     ({ item, fields, info, strip }) => {
//       const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]);
//       const readText = (el: Element) => ((el as HTMLElement).innerText || el.textContent || "").trim();
//       const first = (root: Element, sel?: string | string[] | null) => {
//         if (!sel) return null;
//         for (const s of list(sel)) {
//           if (s === ":self") {
//             const t = readText(root);
//             if (t) return t;
//             continue;
//           }
//           const n = root.querySelector(s);
//           if (n) {
//             let t: string;
//             if (strip.length && n.querySelector(strip.join(","))) {
//               const c = n.cloneNode(true) as Element;
//               c.querySelectorAll(strip.join(",")).forEach((x) => x.remove());
//               t = (c.textContent || "").trim();
//             } else {
//               t = readText(n);
//             }
//             if (t) return t;
//           }
//         }
//         return null;
//       };
//       let els: Element[] = [];
//       for (const s of list(item)) {
//         const found = Array.from(document.querySelectorAll(s));
//         if (found.length) {
//           els = found;
//           break;
//         }
//       }
//       return els.map((el) => {
//         const f: Record<string, string | null> = {};
//         for (const [k, s] of Object.entries(fields)) f[k] = first(el, s as string | string[]);
//         return { fields: f, info: first(el, info), pageTitle: document.title };
//       });
//     },
//     { item: cfg.item, fields: cfg.fields, info: cfg.info ?? null, strip: cfg.strip ?? [] }
//   );
// }

// async function gotoRetry(page: Page, url: string) {
//   let lastErr: unknown;
//   for (let attempt = 1; attempt <= 3; attempt++) {
//     try {
//       await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
//       // Cloudflare / bot-check: give a human 60s to solve it in the headed window
//       if (/just a moment|attention required|verify you are human/i.test(await page.title())) {
//         console.warn("  bot check detected, waiting up to 60s (solve it in the browser)...");
//         await page.waitForFunction(
//           () => !/just a moment|attention required|verify you are human/i.test(document.title),
//           null,
//           { timeout: 60000 }
//         );
//       }
//       await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
//       return;
//     } catch (e) {
//       lastErr = e;
//       console.warn(`  attempt ${attempt}/3 failed for ${url}`);
//       await sleep(2000 * attempt, 4000 * attempt);
//     }
//   }
//   throw lastErr;
// }

// /* ----------------------------- crawler ----------------------------- */

// export async function runSite(cfg: SiteConfig, opts: RunOptions = {}) {
//   const outDir = opts.outDir ?? path.join("data", "raw");
//   fs.mkdirSync(outDir, { recursive: true });
//   const outFile = path.join(outDir, `${cfg.name}.jsonl`);
//   const stateFile = path.join(outDir, `${cfg.name}.state.json`);
//   const failedFile = path.join(outDir, `${cfg.name}.failed.txt`);

//   if (opts.fresh) {
//     for (const f of [outFile, stateFile, failedFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
//   }

//   // dedupe ids from earlier runs
//   const ids = new Set<string>();
//   if (fs.existsSync(outFile)) {
//     for (const line of fs.readFileSync(outFile, "utf8").split("\n")) {
//       if (!line) continue;
//       try { ids.add(JSON.parse(line).id); } catch { /* ignore partial line */ }
//     }
//   }

//   // resume state: visited + queue
//   let visited = new Set<string>();
//   let queue: string[] = [];
//   if (fs.existsSync(stateFile)) {
//     const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
//     visited = new Set(s.visited);
//     queue = s.queue;
//     console.log(`[${cfg.name}] resuming: ${visited.size} visited, ${queue.length} queued, ${ids.size} saved`);
//   } else {
//     queue = cfg.seeds.map((s) => norm(new URL(s)));
//   }
//   const queued = new Set(queue);
//   const saveState = () =>
//     fs.writeFileSync(stateFile, JSON.stringify({ visited: [...visited], queue }));

//   // persistent profile: logins and bot-check cookies survive between runs
//   const ctx = await chromium.launchPersistentContext(path.join(".browser-profile", cfg.name), {
//     headless: opts.headless ?? false,
//     channel: "chrome",
//     locale: "en-US",
//   });
//   await ctx.addInitScript("window.__name = (fn) => fn;"); // tsx/esbuild helper missing in the page
//   await ctx.route("**/*", (route) =>
//     ["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue()
//   );
//   const page = await ctx.newPage();
//   const out = fs.createWriteStream(outFile, { flags: "a", encoding: "utf8" });

//   if (opts.login) {
//     await page.goto(cfg.seeds[0], { waitUntil: "domcontentloaded" }).catch(() => {});
//     await new Promise<void>((res) => {
//       const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
//       rl.question("Log in / solve any check in the browser window, then press Enter here... ", () => {
//         rl.close();
//         res();
//       });
//     });
//   }

//   const max = opts.maxPages ?? cfg.maxPages ?? Infinity;
//   const [dMin, dMax] = cfg.delayMs ?? [1200, 3200];
//   let pages = 0;
//   let saved = 0;

//   try {
//     while (queue.length && pages < max) {
//       const url = queue.shift()!;
//       queued.delete(url);
//       if (visited.has(url)) continue;
//       visited.add(url);
//       pages++;

//       try {
//         await gotoRetry(page, url);
//         const current = new URL(page.url());
//         let got = 0;

//         if (cfg.isContent(current)) {
//           const wanted = cfg.waitFor ?? (Array.isArray(cfg.item) ? cfg.item : [cfg.item]).join(",");
//           await page.waitForSelector(wanted, { timeout: 15000, state: "attached" }).catch(() => null);
//           const raw = await extractItems(page, cfg);

//           for (const r of raw) {
//             const info = parseInfo(r.info, cfg.labels);
//             const f = { ...r.fields, ...info.mapped } as Record<string, string | null>;
//             const arabic = clean(f.arabic);
//             const english = clean(f.english);
//             if (!arabic && !english) continue;

//             const h: Hadith = {
//               id: sha1(`${cfg.name}|${current.pathname}|${f.reference ?? ""}|${(arabic ?? english ?? "").slice(0, 200)}`),
//               source: cfg.name,
//               url: current.href,
//               title: clean(f.title),
//               reference: clean(f.reference),
//               book: clean(f.book),
//               chapter: clean(f.chapter),
//               narrator: clean(f.narrator),
//               grade: clean(f.grade), // null when the site shows none, never a guessed value
//               arabic,
//               arabicPlain: plainArabic(arabic),
//               english,
//               explanation: clean(f.explanation),
//               meta: { ...info.meta, pageTitle: r.pageTitle },
//               scrapedAt: new Date().toISOString(),
//             };
//             if (ids.has(h.id)) continue;
//             ids.add(h.id);
//             out.write(JSON.stringify(h) + "\n");
//             got++;
//           }
//           saved += got;
//         }

//         // discover more links
//         const hrefs = await page.evaluate(() =>
//           Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href)
//         );
//         let added = 0;
//         for (const href of hrefs) {
//           let l: URL;
//           try { l = new URL(href); } catch { continue; }
//           if (!/^https?:$/.test(l.protocol)) continue;
//           const n = norm(l);
//           if (visited.has(n) || queued.has(n)) continue;
//           if (cfg.follow(l) || cfg.isContent(l)) {
//             queue.push(n);
//             queued.add(n);
//             added++;
//           }
//         }
//         console.log(`[${cfg.name}] #${pages} ${current.pathname}${current.search} | +${got} hadiths | +${added} links | queue ${queue.length} | total ${saved}`);
//       } catch (e: any) {
//         console.error(`[${cfg.name}] FAILED ${url}: ${e?.message ?? e}`);
//         fs.appendFileSync(failedFile, url + "\n");
//       }

//       if (pages % 10 === 0) saveState();
//       await sleep(dMin, dMax);
//     }
//   } finally {
//     saveState();
//     out.end();
//     await ctx.close();
//     console.log(`[${cfg.name}] done: ${pages} pages crawled, ${saved} new hadiths -> ${outFile}`);
//   }
// }

// /* ----------------------------- CLI helper ----------------------------- */

// export function parseCli(argv: string[]) {
//   const flags = argv.filter((a) => a.startsWith("--"));
//   const names = argv.filter((a) => !a.startsWith("--"));
//   const val = (k: string) => flags.find((f) => f.startsWith(`--${k}=`))?.split("=")[1];
//   const opts: RunOptions = {
//     headless: flags.includes("--headless"),
//     fresh: flags.includes("--fresh"),
//     login: flags.includes("--login"),
//     maxPages: val("max") ? Number(val("max")) : undefined,
//   };
//   return { names, opts };
// }

/// <reference lib="dom" />
import { chromium, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as readline from "readline";

/* ----------------------------- types ----------------------------- */

export type Sel = string | string[]; // list = fallback candidates, first one that matches wins
export type FieldName =
  | "reference" | "book" | "chapter" | "arabic" | "english"
  | "narrator" | "grade" | "explanation" | "title";

export interface Hadith {
  id: string;
  source: string;
  url: string;
  title: string | null;
  reference: string | null;
  book: string | null;
  chapter: string | null;
  narrator: string | null;
  grade: string | null;
  arabic: string | null;
  arabicPlain: string | null; // no tashkeel, normalized alef/yaa
  english: string | null;
  explanation: string | null;
  meta: Record<string, string>;
  scrapedAt: string;
}

export interface SiteConfig {
  name: string;
  seeds: string[];
  /** which links to put in the crawl queue */
  follow: (u: URL) => boolean;
  /** which pages contain hadith data to extract */
  isContent: (u: URL) => boolean;
  /** container per hadith (or the page body for single-hadith pages) */
  item: Sel;
  /** per-field selectors, resolved inside each item. ":self" = the item itself */
  fields: Partial<Record<FieldName, Sel>>;
  /** optional block of "label: value" lines (used by dorar.net) */
  info?: Sel;
  /** wait for this selector before extracting (JS-rendered pages) */
  waitFor?: string;
  /** remove these elements' text from every field (e.g. "span.text-gray") */
  strip?: string[];
  /** remove a leading pattern from the Arabic text (e.g. dorar's "1 - " numbering) */
  arabicStripPrefix?: RegExp;
  /** map labels in `info` to fields; unmapped labels go to meta */
  labels?: Record<string, FieldName>;
  maxPages?: number;
  delayMs?: [number, number];
}

export interface RunOptions {
  headless?: boolean;
  /** Cap on content pages (cfg.isContent); navigation pages do not count */
  maxPages?: number;
  /** Hard safety cap on non-content pages visited (default 2000) */
  maxNavPages?: number;
  fresh?: boolean;
  login?: boolean; // pause after opening the first seed so you can log in / solve a check
  outDir?: string;
}

/* ----------------------------- helpers ----------------------------- */

const sleep = (min: number, max: number) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0640]/g;

export const plainArabic = (s: string | null): string | null =>
  s
    ? s.replace(TASHKEEL, "").replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").trim()
    : null;

const clean = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = s.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t || null;
};

const norm = (u: URL): string => {
  const c = new URL(u.href);
  c.hash = "";
  if (c.pathname.length > 1) c.pathname = c.pathname.replace(/\/+$/, "");
  return c.href;
};

const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

export function parseInfo(
  text: string | null,
  labels: Record<string, FieldName> = {}
): { mapped: Partial<Record<FieldName, string>>; meta: Record<string, string> } {
  const mapped: Partial<Record<FieldName, string>> = {};
  const meta: Record<string, string> = {};
  if (!text) return { mapped, meta };

  // Longest-first: Dorar uses multi-word labels and packs "الراوي : X | المحدث : Y" on one line.
  const known = [
    ...Object.keys(labels),
    "خلاصة حكم المحدث",
    "الصفحة أو الرقم",
    "التصنيف الموضوعي",
    "الراوي",
    "المحدث",
    "المصدر",
    "التخريج",
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => b.length - a.length);

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flat = text.replace(/\s*\|\s*/g, " | ");
  // Allow a known label after |, newline, or whitespace (e.g. "6/14 التخريج : ...")
  const re = new RegExp(`(?:^|[|\\n]|\\s)(${known.map(esc).join("|")})\\s*[:：]\\s*`, "g");
  const matches = [...flat.matchAll(re)];

  if (matches.length) {
    for (let i = 0; i < matches.length; i++) {
      const label = matches[i][1].trim();
      const start = matches[i].index! + matches[i][0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index! : flat.length;
      const value = flat.slice(start, end).replace(/^\s*\|\s*|\s*\|\s*$/g, "").trim();
      if (!value) continue;
      const field = labels[label];
      if (field) mapped[field] = value;
      else if (label.length <= 40) meta[label] = value;
    }
    return { mapped, meta };
  }

  // Fallback: classic line-oriented "label: value"
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([^:：]{1,60})[:：]\s*(.*)$/);
    if (!m) continue;
    const label = m[1].replace(/^\|\s*/, "").trim();
    let value = m[2].trim();
    if (!value && lines[i + 1] && !/[:：]\s*$/.test(lines[i + 1])) value = lines[++i];
    if (!value) continue;
    const field = labels[label];
    if (field) mapped[field] = value;
    else if (label.length <= 25) meta[label] = value;
  }
  return { mapped, meta };
}

/* ----------------------------- extraction ----------------------------- */

export async function extractItems(page: Page, cfg: Pick<SiteConfig, "item" | "fields" | "info" | "strip">) {
  return page.evaluate(
    ({ item, fields, info, strip }) => {
      const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]);
      const readText = (el: Element) => ((el as HTMLElement).innerText || el.textContent || "").trim();
      const textOf = (n: Element) => {
        if (strip.length && n.querySelector(strip.join(","))) {
          const c = n.cloneNode(true) as Element;
          c.querySelectorAll(strip.join(",")).forEach((x) => x.remove());
          return (c.textContent || "").trim();
        }
        return readText(n);
      };
      const first = (root: Element, sel?: string | string[] | null) => {
        if (!sel) return null;
        for (const raw of list(sel)) {
          if (raw === ":self") {
            const t = readText(root);
            if (t) return t;
            continue;
          }
          // ":doc selector" = query from document (e.g. chapter h1 outside the item)
          let s = raw;
          let scope: ParentNode = root;
          if (s.startsWith(":doc ")) {
            scope = document;
            s = s.slice(5);
          }
          // "selector@1" = Nth match (0-based); "selector@*" = join all matches
          const at = s.match(/^(.*)@(\d+|\*)$/);
          if (at && at[2] === "*") {
            const nodes = Array.from(scope.querySelectorAll(at[1]));
            const parts = nodes
              .map((n) => {
                // thaqalayn grading-row: "Author: grade"
                const author = n.querySelector(".grading-author");
                const badge = n.querySelector(".grading-value .badge, .badge");
                if (author && badge) {
                  return `${readText(author)}: ${readText(badge)}`.replace(/\s+/g, " ").trim();
                }
                return textOf(n)
                  .replace(/\s+/g, " ")
                  .replace(/([A-Za-z])([\u0600-\u06FF])/g, "$1 $2")
                  .trim();
              })
              .filter(Boolean);
            if (parts.length) return parts.join(" | ");
            continue;
          }
          const n = at ? scope.querySelectorAll(at[1])[Number(at[2])] : scope.querySelector(s);
          if (n) {
            const t = textOf(n);
            if (t) return t;
          }
        }
        return null;
      };
      let els: Element[] = [];
      for (const s of list(item)) {
        const found = Array.from(document.querySelectorAll(s));
        if (found.length) {
          els = found;
          break;
        }
      }
      return els.map((el) => {
        const f: Record<string, string | null> = {};
        for (const [k, s] of Object.entries(fields)) f[k] = first(el, s as string | string[]);
        return { fields: f, info: first(el, info), pageTitle: document.title };
      });
    },
    { item: cfg.item, fields: cfg.fields, info: cfg.info ?? null, strip: cfg.strip ?? [] }
  );
}

/** Wait + extract + parse into final Hadith records (shared by crawler and --extract). */
export async function buildHadiths(page: Page, cfg: SiteConfig, url: string | URL): Promise<Hadith[]> {
  const current = typeof url === "string" ? new URL(url) : url;
  const wanted = cfg.waitFor ?? (Array.isArray(cfg.item) ? cfg.item : [cfg.item]).join(",");
  await page.waitForSelector(wanted, { timeout: 15000, state: "attached" }).catch(() => null);
  const raw = await extractItems(page, cfg);
  const out: Hadith[] = [];
  for (const r of raw) {
    const info = parseInfo(r.info, cfg.labels);
    const f = { ...r.fields, ...info.mapped } as Record<string, string | null>;
    let arabic = clean(f.arabic);
    if (arabic && cfg.arabicStripPrefix) arabic = arabic.replace(cfg.arabicStripPrefix, "").trim() || null;
    const english = clean(f.english);
    if (!arabic && !english) continue;
    out.push({
      id: sha1(`${cfg.name}|${current.pathname}|${f.reference ?? ""}|${(arabic ?? english ?? "").slice(0, 200)}`),
      source: cfg.name,
      url: current.href,
      title: clean(f.title),
      reference: clean(f.reference),
      book: clean(f.book),
      chapter: clean(f.chapter),
      narrator: clean(f.narrator),
      grade: clean(f.grade), // null when the site shows none, never a guessed value
      arabic,
      arabicPlain: plainArabic(arabic),
      english,
      explanation: clean(f.explanation),
      meta: { ...info.meta, pageTitle: r.pageTitle },
      scrapedAt: new Date().toISOString(),
    });
  }
  return out;
}

async function gotoRetry(page: Page, url: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Cloudflare / bot-check: give a human 60s to solve it in the headed window
      if (/just a moment|attention required|verify you are human/i.test(await page.title())) {
        console.warn("  bot check detected, waiting up to 60s (solve it in the browser)...");
        await page.waitForFunction(
          () => !/just a moment|attention required|verify you are human/i.test(document.title),
          null,
          { timeout: 60000 }
        );
      }
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`  attempt ${attempt}/3 failed for ${url}`);
      await sleep(2000 * attempt, 4000 * attempt);
    }
  }
  throw lastErr;
}

/* ----------------------------- crawler ----------------------------- */

export async function runSite(cfg: SiteConfig, opts: RunOptions = {}) {
  const outDir = opts.outDir ?? path.join("data", "raw");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${cfg.name}.jsonl`);
  const stateFile = path.join(outDir, `${cfg.name}.state.json`);
  const failedFile = path.join(outDir, `${cfg.name}.failed.txt`);

  if (opts.fresh) {
    for (const f of [outFile, stateFile, failedFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // dedupe ids from earlier runs
  const ids = new Set<string>();
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, "utf8").split("\n")) {
      if (!line) continue;
      try { ids.add(JSON.parse(line).id); } catch { /* ignore partial line */ }
    }
  }

  // resume state: visited + queue
  let visited = new Set<string>();
  let queue: string[] = [];
  if (fs.existsSync(stateFile)) {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    visited = new Set(s.visited);
    queue = s.queue;
    console.log(`[${cfg.name}] resuming: ${visited.size} visited, ${queue.length} queued, ${ids.size} saved`);
  } else {
    queue = cfg.seeds.map((s) => norm(new URL(s)));
  }
  const queued = new Set(queue);
  const saveState = () =>
    fs.writeFileSync(stateFile, JSON.stringify({ visited: [...visited], queue }));

  // persistent profile: logins and bot-check cookies survive between runs
  const ctx = await chromium.launchPersistentContext(path.join(".browser-profile", cfg.name), {
    headless: opts.headless ?? false,
    channel: "chrome",
    locale: "en-US",
  });
  await ctx.addInitScript("window.__name = (fn) => fn;"); // tsx/esbuild helper missing in the page
  await ctx.route("**/*", (route) =>
    ["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue()
  );
  const page = await ctx.newPage();
  const out = fs.createWriteStream(outFile, { flags: "a", encoding: "utf8" });

  if (opts.login) {
    await page.goto(cfg.seeds[0], { waitUntil: "domcontentloaded" }).catch(() => {});
    await new Promise<void>((res) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Log in / solve any check in the browser window, then press Enter here... ", () => {
        rl.close();
        res();
      });
    });
  }

  const maxContent = opts.maxPages ?? cfg.maxPages ?? Infinity;
  const maxNav = opts.maxNavPages ?? 2000;
  const [dMin, dMax] = cfg.delayMs ?? [1200, 3200];
  let contentPages = 0;
  let navPages = 0;
  let saved = 0;

  try {
    while (queue.length && contentPages < maxContent && navPages < maxNav) {
      const url = queue.shift()!;
      queued.delete(url);
      if (visited.has(url)) continue;
      visited.add(url);

      let counted = false;
      try {
        await gotoRetry(page, url);
        const current = new URL(page.url());
        const isContent = cfg.isContent(current);
        if (isContent) contentPages++;
        else navPages++;
        counted = true;
        let got = 0;

        if (isContent) {
          const batch = await buildHadiths(page, cfg, current);
          for (const h of batch) {
            if (ids.has(h.id)) continue;
            ids.add(h.id);
            out.write(JSON.stringify(h) + "\n");
            got++;
          }
          saved += got;
        }

        // discover more links: content URLs to the front, navigation to the back
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href)
        );
        let added = 0;
        for (const href of hrefs) {
          let l: URL;
          try { l = new URL(href); } catch { continue; }
          if (!/^https?:$/.test(l.protocol)) continue;
          const n = norm(l);
          if (visited.has(n) || queued.has(n)) continue;
          if (cfg.isContent(l)) {
            queue.unshift(n);
            queued.add(n);
            added++;
          } else if (cfg.follow(l)) {
            queue.push(n);
            queued.add(n);
            added++;
          }
        }
        console.log(
          `[${cfg.name}] content ${contentPages}/${maxContent === Infinity ? "∞" : maxContent}` +
            ` nav ${navPages}/${maxNav} ${current.pathname}${current.search}` +
            ` | +${got} hadiths | +${added} links | queue ${queue.length} | total ${saved}`
        );
      } catch (e: any) {
        // failed navigations still consume a slot so a broken URL can't stall forever
        if (!counted) {
          try {
            const u = new URL(url);
            if (cfg.isContent(u)) contentPages++;
            else navPages++;
          } catch {
            navPages++;
          }
        }
        console.error(`[${cfg.name}] FAILED ${url}: ${e?.message ?? e}`);
        fs.appendFileSync(failedFile, url + "\n");
      }

      if ((contentPages + navPages) % 10 === 0) saveState();
      await sleep(dMin, dMax);
    }
  } finally {
    saveState();
    out.end();
    await ctx.close();
    console.log(
      `[${cfg.name}] done: ${contentPages} content + ${navPages} nav pages, ${saved} new hadiths -> ${outFile}`
    );
  }
}

/* ----------------------------- CLI helper ----------------------------- */

export function parseCli(argv: string[]) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const names = argv.filter((a) => !a.startsWith("--"));
  const val = (k: string) => flags.find((f) => f.startsWith(`--${k}=`))?.split("=")[1];
  const opts: RunOptions = {
    headless: flags.includes("--headless"),
    fresh: flags.includes("--fresh"),
    login: flags.includes("--login"),
    maxPages: val("max") ? Number(val("max")) : undefined,
    maxNavPages: val("max-nav") ? Number(val("max-nav")) : undefined,
  };
  return { names, opts };
}