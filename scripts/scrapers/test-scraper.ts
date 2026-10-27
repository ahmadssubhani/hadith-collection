// // // // import { chromium } from "playwright";

// // // // async function runScraper() {
// // // //   const browser = await chromium.launch({
// // // //     headless: false,
// // // //     channel: "chrome",
// // // //   });

// // // //   const ctx = await browser.newContext()
// // // //   await page.goto("https://example.com", {
// // // //     waitUntil: "domcontentloaded",
// // // //   });

// // // //   const probe = await page.evaluate(() => {
// // // //     const safeAll = (root: ParentNode, sel: string): Element[] | null => {
// // // //       try {
// // // //         return Array.from(root.querySelectorAll(sel));
// // // //       } catch {
// // // //         return null;
// // // //       }
// // // //     };

// // // //     const itemCandidates = [".hadith", "article", "[class*='hadith']"];

// // // //     const items = itemCandidates.map((sel: string) => {
// // // //       const found = safeAll(document, sel);
// // // //       return { sel, count: found ? found.length : -1 };
// // // //     });

// // // //     return items;
// // // //   });

// // // //   console.log(probe);
// // // //   await browser.close();
// // // // }

// // // // runScraper();

// // // // /// <reference lib="dom" />
// // // // import { chromium } from "playwright";
// // // // import * as fs from "fs";
// // // // import * as path from "path";
// // // // import { SITES, SITE_NAMES } from "./sites";

// // // // /*
// // // //   Probe one page and see which selectors actually match.
// // // //     npx tsx scripts/scrapers/test-scraper.ts sunnah https://sunnah.com/bukhari/1
// // // //     npx tsx scripts/scrapers/test-scraper.ts dorar            (uses first seed)
// // // //   Writes data/debug/<site>.html and <site>.png so you can inspect the DOM.
// // // // */
// // // // async function main() {
// // // //   const [siteName, urlArg] = process.argv.slice(2);
// // // //   const cfg = SITES[siteName];
// // // //   if (!cfg) {
// // // //     console.error(`Usage: test-scraper.ts <${SITE_NAMES.join("|")}> [url]`);
// // // //     process.exit(1);
// // // //   }
// // // //   const url = urlArg ?? cfg.seeds[0];

// // // //   const browser = await chromium.launch({ headless: false, channel: "chrome" });
// // // //   try {
// // // //     const ctx = await browser.newContext();
// // // // await ctx.addInitScript("window.__name = (fn) => fn;");
// // // // const page = await ctx.newPage();
// // // //     console.log(`Opening ${url}`);
// // // //     await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
// // // //     await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

// // // //     const dir = path.join("data", "debug");
// // // //     fs.mkdirSync(dir, { recursive: true });
// // // //     fs.writeFileSync(path.join(dir, `${cfg.name}.html`), await page.content(), "utf8");
// // // //     await page.screenshot({ path: path.join(dir, `${cfg.name}.png`), fullPage: true });

// // // //     const itemCandidates = Array.isArray(cfg.item) ? cfg.item : [cfg.item];
// // // //     const report = await page.evaluate(
// // // //       ({ itemCandidates, fields, info }) => {
// // // //         const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]);
// // // //         const safeAll = (root: ParentNode, sel: string) => {
// // // //           try { return Array.from(root.querySelectorAll(sel)); } catch { return null; }
// // // //         };
// // // //         const snippet = (el: Element | undefined) =>
// // // //           el ? ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) : "";

// // // //         const items = itemCandidates.map((sel) => {
// // // //           const found = safeAll(document, sel);
// // // //           return { sel, count: found ? found.length : -1 };
// // // //         });
// // // //         const chosen = itemCandidates.find((s) => (safeAll(document, s)?.length ?? 0) > 0);
// // // //         const root = chosen ? safeAll(document, chosen)![0] : null;

// // // //         const fieldReport: { field: string; sel: string; count: number; text: string }[] = [];
// // // //         if (root) {
// // // //           const all: [string, string | string[] | null | undefined][] = [
// // // //             ...Object.entries(fields as Record<string, string | string[]>),
// // // //             ["(info)", info],
// // // //           ];
// // // //           for (const [name, sels] of all) {
// // // //             if (!sels) continue;
// // // //             for (const s of list(sels)) {
// // // //               if (s === ":self") {
// // // //                 fieldReport.push({ field: name, sel: s, count: 1, text: snippet(root) });
// // // //                 continue;
// // // //               }
// // // //               const f = safeAll(root, s);
// // // //               fieldReport.push({ field: name, sel: s, count: f ? f.length : -1, text: snippet(f?.[0]) });
// // // //             }
// // // //           }
// // // //         }
// // // //         return { items, chosen: chosen ?? null, fieldReport };
// // // //       },
// // // //       { itemCandidates, fields: cfg.fields, info: cfg.info ?? null }
// // // //     );

// // // //     console.log("\n--- item selectors (count, -1 = invalid selector) ---");
// // // //     for (const i of report.items) console.log(`${String(i.count).padStart(4)}  ${i.sel}`);
// // // //     console.log(`\nUsing item selector: ${report.chosen ?? "NONE MATCHED"}`);

// // // //     if (report.fieldReport.length) {
// // // //       console.log("\n--- fields inside the first item ---");
// // // //       for (const f of report.fieldReport) {
// // // //         console.log(`${f.count > 0 ? "OK  " : "MISS"} ${f.field.padEnd(12)} ${f.sel.padEnd(40)} ${f.count > 0 ? f.text : ""}`);
// // // //       }
// // // //     }

// // // //     const hrefs: string[] = await page.evaluate(() =>
// // // //       Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href)
// // // //     );
// // // //     const parsed = hrefs.flatMap((h) => { try { return [new URL(h)]; } catch { return []; } });
// // // //     const follow = parsed.filter((u) => cfg.follow(u));
// // // //     const content = parsed.filter((u) => cfg.isContent(u));
// // // //     console.log(`\n--- links --- total ${parsed.length}, follow ${follow.length}, content ${content.length}`);
// // // //     console.log("sample follow:", follow.slice(0, 5).map((u) => u.href));
// // // //     console.log(`this page isContent: ${cfg.isContent(new URL(page.url()))}`);
// // // //     console.log(`\nSaved ${path.join(dir, cfg.name)}.html / .png`);
// // // //   } finally {
// // // //     await browser.close();
// // // //   }
// // // // }

// // // // main();

// // // /// <reference lib="dom" />
// // // import { chromium } from "playwright";
// // // import * as fs from "fs";
// // // import * as path from "path";
// // // import { SITES, SITE_NAMES } from "./sites";

// // // /*
// // //   Probe one page and see which selectors actually match.
// // //     npx tsx scripts/scrapers/test-scraper.ts sunnah https://sunnah.com/bukhari/1
// // //     npx tsx scripts/scrapers/test-scraper.ts dorar            (uses first seed)
// // //   Writes data/debug/<site>.html and <site>.png so you can inspect the DOM.
// // // */
// // // async function main() {
// // //   const [siteName, urlArg] = process.argv.slice(2);
// // //   const cfg = SITES[siteName];
// // //   if (!cfg) {
// // //     console.error(`Usage: test-scraper.ts <${SITE_NAMES.join("|")}> [url]`);
// // //     process.exit(1);
// // //   }
// // //   const url = urlArg ?? cfg.seeds[0];

// // //   const browser = await chromium.launch({ headless: false, channel: "chrome" });
// // //   try {
// // //     const ctx = await browser.newContext();
// // //     await ctx.addInitScript("window.__name = (fn) => fn;"); // tsx/esbuild helper missing in the page
// // //     const page = await ctx.newPage();
// // //     console.log(`Opening ${url}`);
// // //     await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
// // //     await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

// // //     const dir = path.join("data", "debug");
// // //     fs.mkdirSync(dir, { recursive: true });
// // //     fs.writeFileSync(path.join(dir, `${cfg.name}.html`), await page.content(), "utf8");
// // //     await page.screenshot({ path: path.join(dir, `${cfg.name}.png`), fullPage: true });

// // //     const itemCandidates = Array.isArray(cfg.item) ? cfg.item : [cfg.item];
// // //     const report = await page.evaluate(
// // //       ({ itemCandidates, fields, info }) => {
// // //         const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]);
// // //         const safeAll = (root: ParentNode, sel: string) => {
// // //           try { return Array.from(root.querySelectorAll(sel)); } catch { return null; }
// // //         };
// // //         const snippet = (el: Element | undefined) =>
// // //           el ? ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) : "";

// // //         const items = itemCandidates.map((sel) => {
// // //           const found = safeAll(document, sel);
// // //           return { sel, count: found ? found.length : -1 };
// // //         });
// // //         const chosen = itemCandidates.find((s) => (safeAll(document, s)?.length ?? 0) > 0);
// // //         const root = chosen ? safeAll(document, chosen)![0] : null;

// // //         const fieldReport: { field: string; sel: string; count: number; text: string }[] = [];
// // //         if (root) {
// // //           const all: [string, string | string[] | null | undefined][] = [
// // //             ...Object.entries(fields as Record<string, string | string[]>),
// // //             ["(info)", info],
// // //           ];
// // //           for (const [name, sels] of all) {
// // //             if (!sels) continue;
// // //             for (const s of list(sels)) {
// // //               if (s === ":self") {
// // //                 fieldReport.push({ field: name, sel: s, count: 1, text: snippet(root) });
// // //                 continue;
// // //               }
// // //               const f = safeAll(root, s);
// // //               fieldReport.push({ field: name, sel: s, count: f ? f.length : -1, text: snippet(f?.[0]) });
// // //             }
// // //           }
// // //         }
// // //         return { items, chosen: chosen ?? null, fieldReport };
// // //       },
// // //       { itemCandidates, fields: cfg.fields, info: cfg.info ?? null }
// // //     );

// // //     console.log("\n--- item selectors (count, -1 = invalid selector) ---");
// // //     for (const i of report.items) console.log(`${String(i.count).padStart(4)}  ${i.sel}`);
// // //     console.log(`\nUsing item selector: ${report.chosen ?? "NONE MATCHED"}`);

// // //     if (report.fieldReport.length) {
// // //       console.log("\n--- fields inside the first item ---");
// // //       for (const f of report.fieldReport) {
// // //         console.log(`${f.count > 0 ? "OK  " : "MISS"} ${f.field.padEnd(12)} ${f.sel.padEnd(40)} ${f.count > 0 ? f.text : ""}`);
// // //       }
// // //     }

// // //     const hrefs: string[] = await page.evaluate(() =>
// // //       Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href)
// // //     );
// // //     const parsed = hrefs.flatMap((h) => { try { return [new URL(h)]; } catch { return []; } });
// // //     const follow = parsed.filter((u) => cfg.follow(u));
// // //     const content = parsed.filter((u) => cfg.isContent(u));
// // //     console.log(`\n--- links --- total ${parsed.length}, follow ${follow.length}, content ${content.length}`);
// // //     console.log("sample follow:", follow.slice(0, 5).map((u) => u.href));
// // //     console.log(`this page isContent: ${cfg.isContent(new URL(page.url()))}`);
// // //     console.log(`\nSaved ${path.join(dir, cfg.name)}.html / .png`);
// // //   } finally {
// // //     await browser.close();
// // //   }
// // // }

// // // main();

// // /// <reference lib="dom" />
// // import { chromium } from "playwright";
// // import * as fs from "fs";
// // import * as path from "path";
// // import { SITES, SITE_NAMES } from "./sites";

// // /*
// //   Probe one page and see which selectors actually match.
// //     npx tsx scripts/scrapers/test-scraper.ts sunnah https://sunnah.com/bukhari/1
// //     npx tsx scripts/scrapers/test-scraper.ts dorar            (uses first seed)
// //   Writes data/debug/<site>.html and <site>.png so you can inspect the DOM.
// // */
// // async function main() {
// //   const [siteName, urlArg] = process.argv.slice(2);
// //   const cfg = SITES[siteName];
// //   if (!cfg) {
// //     console.error(`Usage: test-scraper.ts <${SITE_NAMES.join("|")}> [url]`);
// //     process.exit(1);
// //   }
// //   const url = urlArg ?? cfg.seeds[0];

// //   const browser = await chromium.launch({ headless: false, channel: "chrome" });
// //   try {
// //     const ctx = await browser.newContext();
// //     await ctx.addInitScript("window.__name = (fn) => fn;"); // tsx/esbuild helper missing in the page
// //     const page = await ctx.newPage();
// //     console.log(`Opening ${url}`);
// //     await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
// //     await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
// //     // JS-rendered sites: wait until real text is on the page
// //     await page.waitForFunction(() => document.body.innerText.length > 400, null, { timeout: 15000 }).catch(() => {});
// //     await page.waitForTimeout(1500);

// //     const dir = path.join("data", "debug");
// //     fs.mkdirSync(dir, { recursive: true });
// //     fs.writeFileSync(path.join(dir, `${cfg.name}.html`), await page.content(), "utf8");
// //     await page.screenshot({ path: path.join(dir, `${cfg.name}.png`), fullPage: true });

// //     const itemCandidates = Array.isArray(cfg.item) ? cfg.item : [cfg.item];
// //     const report = await page.evaluate(
// //       ({ itemCandidates, fields, info }) => {
// //         const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]);
// //         const safeAll = (root: ParentNode, sel: string) => {
// //           try { return Array.from(root.querySelectorAll(sel)); } catch { return null; }
// //         };
// //         const snippet = (el: Element | undefined) =>
// //           el ? ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) : "";

// //         const items = itemCandidates.map((sel) => {
// //           const found = safeAll(document, sel);
// //           return { sel, count: found ? found.length : -1 };
// //         });
// //         const chosen = itemCandidates.find((s) => (safeAll(document, s)?.length ?? 0) > 0);
// //         const root = chosen ? safeAll(document, chosen)![0] : null;

// //         const fieldReport: { field: string; sel: string; count: number; text: string }[] = [];
// //         if (root) {
// //           const all: [string, string | string[] | null | undefined][] = [
// //             ...Object.entries(fields as Record<string, string | string[]>),
// //             ["(info)", info],
// //           ];
// //           for (const [name, sels] of all) {
// //             if (!sels) continue;
// //             for (const s of list(sels)) {
// //               if (s === ":self") {
// //                 fieldReport.push({ field: name, sel: s, count: 1, text: snippet(root) });
// //                 continue;
// //               }
// //               const f = safeAll(root, s);
// //               fieldReport.push({ field: name, sel: s, count: f ? f.length : -1, text: snippet(f?.[0]) });
// //             }
// //           }
// //         }
// //         return { items, chosen: chosen ?? null, fieldReport };
// //       },
// //       { itemCandidates, fields: cfg.fields, info: cfg.info ?? null }
// //     );

// //     console.log("\n--- item selectors (count, -1 = invalid selector) ---");
// //     for (const i of report.items) console.log(`${String(i.count).padStart(4)}  ${i.sel}`);
// //     console.log(`\nUsing item selector: ${report.chosen ?? "NONE MATCHED"}`);

// //     if (report.fieldReport.length) {
// //       console.log("\n--- fields inside the first item ---");
// //       for (const f of report.fieldReport) {
// //         console.log(`${f.count > 0 ? "OK  " : "MISS"} ${f.field.padEnd(12)} ${f.sel.padEnd(40)} ${f.count > 0 ? f.text : ""}`);
// //       }
// //     }

// //     const hrefs: string[] = await page.evaluate(() =>
// //       Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href)
// //     );
// //     const parsed = hrefs.flatMap((h) => { try { return [new URL(h)]; } catch { return []; } });
// //     const follow = parsed.filter((u) => cfg.follow(u));
// //     const content = parsed.filter((u) => cfg.isContent(u));
// //     console.log(`\n--- links --- total ${parsed.length}, follow ${follow.length}, content ${content.length}`);
// //     console.log("sample follow:", follow.slice(0, 5).map((u) => u.href));
// //     console.log(`this page isContent: ${cfg.isContent(new URL(page.url()))}`);
// //     // ---- link groups: shows what URL patterns the site really uses ----
// //     const groups = new Map<string, number>();
// //     for (const u of parsed) {
// //       const k = `${u.hostname}/${u.pathname.split("/")[1] ?? ""}`;
// //       groups.set(k, (groups.get(k) ?? 0) + 1);
// //     }
// //     console.log("\n--- link groups (host/first-path-segment: count) ---");
// //     for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(4), k);
// //     console.log("\nsample paths:", [...new Set(parsed.map((u) => u.pathname + u.search))].slice(0, 25));
// //     console.log(
// //       "pagination-looking links:",
// //       [...new Set(parsed.filter((u) => /page=|\/page\//i.test(u.href)).map((u) => u.href))].slice(0, 5)
// //     );

// //     // ---- DOM outline: where the real text lives (paste this if selectors miss) ----
// //     const outline: string[] = await page.evaluate(() => {
// //       const skip = ["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "HEAD", "NAV", "FOOTER"];
// //       const label = (el: Element) => {
// //         const id = el.id ? "#" + el.id : "";
// //         const cn = typeof el.className === "string" ? el.className.trim() : "";
// //         const cls = cn ? "." + cn.split(/\s+/).slice(0, 3).join(".") : "";
// //         return el.tagName.toLowerCase() + id + cls;
// //       };
// //       const seen = new Map<string, { count: number; sample: string }>();
// //       const order: string[] = [];
// //       const walk = (el: Element) => {
// //         if (skip.includes(el.tagName.toUpperCase())) return;
// //         const own = Array.from(el.childNodes)
// //           .filter((n) => n.nodeType === 3)
// //           .map((n) => n.textContent || "")
// //           .join(" ")
// //           .trim()
// //           .replace(/\s+/g, " ");
// //         if (own.length >= 20) {
// //           const chain: string[] = [];
// //           let cur: Element | null = el;
// //           for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
// //             chain.unshift(label(cur));
// //             cur = cur.parentElement;
// //           }
// //           const key = chain.join(" > ");
// //           const e = seen.get(key);
// //           if (e) e.count++;
// //           else {
// //             seen.set(key, { count: 1, sample: own.slice(0, 50) });
// //             order.push(key);
// //           }
// //         }
// //         for (const k of Array.from(el.children)) walk(k);
// //       };
// //       walk(document.body);
// //       return order.slice(0, 40).map((k) => `${String(seen.get(k)!.count).padStart(3)}x  ${k}   "${seen.get(k)!.sample}"`);
// //     });
// //     console.log(`\n--- DOM outline (count x selector-path "text sample") ---`);
// //     for (const l of outline) console.log(l);

// //     console.log(`\nSaved ${path.join(dir, cfg.name)}.html / .png`);
// //   } finally {
// //     await browser.close();
// //   }
// // }

// // main();

// /// <reference lib="dom" />
// import { chromium } from "playwright";
// import * as fs from "fs";
// import * as path from "path";
// import * as readline from "readline";
// import { SITES, SITE_NAMES } from "./sites";

// /*
//   Probe one page and see which selectors actually match.
//     npx tsx scripts/scrapers/test-scraper.ts sunnah https://sunnah.com/bukhari/1
//     npx tsx scripts/scrapers/test-scraper.ts dorar            (uses first seed)
//   Writes data/debug/<site>.html and <site>.png so you can inspect the DOM.
// */
// async function main() {
//   const [siteName, urlArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
//   const login = process.argv.includes("--login");
//   const cfg = SITES[siteName];
//   if (!cfg) {
//     console.error(`Usage: test-scraper.ts <${SITE_NAMES.join("|")}> [url]`);
//     process.exit(1);
//   }
//   const url = urlArg ?? cfg.seeds[0];

//   const ctx = await chromium.launchPersistentContext(path.join(".browser-profile", cfg.name), {
//     headless: false,
//     channel: "chrome",
//   });
//   try {
//     await ctx.addInitScript("window.__name = (fn) => fn;"); // tsx/esbuild helper missing in the page
//     const page = await ctx.newPage();
//     console.log(`Opening ${url}`);
//     await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
//     if (login) {
//       await new Promise<void>((res) => {
//         const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
//         rl.question("Log in / solve any check in the browser window, then press Enter here... ", () => {
//           rl.close();
//           res();
//         });
//       });
//       await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
//     }
//     await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
//     // JS-rendered sites: wait until real text is on the page
//     await page.waitForFunction(() => document.body.innerText.length > 400, null, { timeout: 15000 }).catch(() => {});
//     await page.waitForTimeout(1500);

//     const dir = path.join("data", "debug");
//     fs.mkdirSync(dir, { recursive: true });
//     fs.writeFileSync(path.join(dir, `${cfg.name}.html`), await page.content(), "utf8");
//     await page.screenshot({ path: path.join(dir, `${cfg.name}.png`), fullPage: true });

//     const itemCandidates = Array.isArray(cfg.item) ? cfg.item : [cfg.item];
//     const report = await page.evaluate(
//       ({ itemCandidates, fields, info }) => {
//         const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]);
//         const safeAll = (root: ParentNode, sel: string) => {
//           try { return Array.from(root.querySelectorAll(sel)); } catch { return null; }
//         };
//         const snippet = (el: Element | undefined) =>
//           el ? ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) : "";

//         const items = itemCandidates.map((sel) => {
//           const found = safeAll(document, sel);
//           return { sel, count: found ? found.length : -1 };
//         });
//         const chosen = itemCandidates.find((s) => (safeAll(document, s)?.length ?? 0) > 0);
//         const root = chosen ? safeAll(document, chosen)![0] : null;

//         const fieldReport: { field: string; sel: string; count: number; text: string }[] = [];
//         if (root) {
//           const all: [string, string | string[] | null | undefined][] = [
//             ...Object.entries(fields as Record<string, string | string[]>),
//             ["(info)", info],
//           ];
//           for (const [name, sels] of all) {
//             if (!sels) continue;
//             for (const s of list(sels)) {
//               if (s === ":self") {
//                 fieldReport.push({ field: name, sel: s, count: 1, text: snippet(root) });
//                 continue;
//               }
//               const f = safeAll(root, s);
//               fieldReport.push({ field: name, sel: s, count: f ? f.length : -1, text: snippet(f?.[0]) });
//             }
//           }
//         }
//         return { items, chosen: chosen ?? null, fieldReport };
//       },
//       { itemCandidates, fields: cfg.fields, info: cfg.info ?? null }
//     );

//     console.log("\n--- item selectors (count, -1 = invalid selector) ---");
//     for (const i of report.items) console.log(`${String(i.count).padStart(4)}  ${i.sel}`);
//     console.log(`\nUsing item selector: ${report.chosen ?? "NONE MATCHED"}`);

//     if (report.fieldReport.length) {
//       console.log("\n--- fields inside the first item ---");
//       for (const f of report.fieldReport) {
//         console.log(`${f.count > 0 ? "OK  " : "MISS"} ${f.field.padEnd(12)} ${f.sel.padEnd(40)} ${f.count > 0 ? f.text : ""}`);
//       }
//     }

//     const hrefs: string[] = await page.evaluate(() =>
//       Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href)
//     );
//     const parsed = hrefs.flatMap((h) => { try { return [new URL(h)]; } catch { return []; } });
//     const follow = parsed.filter((u) => cfg.follow(u));
//     const content = parsed.filter((u) => cfg.isContent(u));
//     console.log(`\n--- links --- total ${parsed.length}, follow ${follow.length}, content ${content.length}`);
//     console.log("sample follow:", follow.slice(0, 5).map((u) => u.href));
//     console.log(`this page isContent: ${cfg.isContent(new URL(page.url()))}`);
//     // ---- link groups: shows what URL patterns the site really uses ----
//     const groups = new Map<string, number>();
//     for (const u of parsed) {
//       const k = `${u.hostname}/${u.pathname.split("/")[1] ?? ""}`;
//       groups.set(k, (groups.get(k) ?? 0) + 1);
//     }
//     console.log("\n--- link groups (host/first-path-segment: count) ---");
//     for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(4), k);
//     console.log("\nsample paths:", [...new Set(parsed.map((u) => u.pathname + u.search))].slice(0, 25));
//     console.log(
//       "pagination-looking links:",
//       [...new Set(parsed.filter((u) => /page=|\/page\//i.test(u.href)).map((u) => u.href))].slice(0, 5)
//     );

//     // ---- --link=/h/ : walk up from the first links containing that text to find the result container ----
//     const linkArg = process.argv.find((a) => a.startsWith("--link="))?.slice(7);
//     if (linkArg) {
//       const chain: string[] = await page.evaluate((frag) => {
//         const out: string[] = [];
//         const label = (el: Element) => {
//           const id = el.id ? "#" + el.id : "";
//           const cn = typeof el.className === "string" ? el.className.trim() : "";
//           return el.tagName.toLowerCase() + id + (cn ? "." + cn.split(/\s+/).slice(0, 3).join(".") : "");
//         };
//         const els = Array.from(document.querySelectorAll(`a[href*="${frag}"]`)).slice(0, 2);
//         out.push(`links containing "${frag}": ${document.querySelectorAll(`a[href*="${frag}"]`).length}`);
//         for (const el of els) {
//           out.push(`match: ${el.outerHTML.slice(0, 120).replace(/\s+/g, " ")}`);
//           let cur: Element | null = el;
//           for (let d = 0; cur && cur !== document.body && d < 9; d++) {
//             const node: Element = cur;
//             const same = node.parentElement
//               ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName && c.className === node.className).length
//               : 1;
//             out.push(`  ${"^".repeat(d)} ${label(node)}  textLen=${(node.textContent || "").trim().length}  sameSiblings=${same}`);
//             cur = node.parentElement;
//           }
//         }
//         return out;
//       }, linkArg);
//       console.log(`\n--- ancestors of first links containing "${linkArg}" ---`);
//       for (const l of chain) console.log(l);
//     }

//     // ---- DOM outline: where the real text lives (paste this if selectors miss) ----
//     const outline: string[] = await page.evaluate(() => {
//       const skip = ["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "HEAD", "NAV", "FOOTER", "SELECT", "OPTION", "FORM", "LABEL", "BUTTON"];
//       const junkClass = /dropdown|modal|collapse|navbar|select-wrapper|cookie|survey/;
//       const label = (el: Element) => {
//         const id = el.id ? "#" + el.id : "";
//         const cn = typeof el.className === "string" ? el.className.trim() : "";
//         const cls = cn ? "." + cn.split(/\s+/).slice(0, 3).join(".") : "";
//         return el.tagName.toLowerCase() + id + cls;
//       };
//       const seen = new Map<string, { count: number; sample: string }>();
//       const order: string[] = [];
//       const walk = (el: Element) => {
//         if (skip.includes(el.tagName.toUpperCase())) return;
//         if (typeof el.className === "string" && junkClass.test(el.className)) return;
//         const own = Array.from(el.childNodes)
//           .filter((n) => n.nodeType === 3)
//           .map((n) => n.textContent || "")
//           .join(" ")
//           .trim()
//           .replace(/\s+/g, " ");
//         if (own.length >= 20) {
//           const chain: string[] = [];
//           let cur: Element | null = el;
//           for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
//             chain.unshift(label(cur));
//             cur = cur.parentElement;
//           }
//           const key = chain.join(" > ");
//           const e = seen.get(key);
//           if (e) e.count++;
//           else {
//             seen.set(key, { count: 1, sample: own.slice(0, 50) });
//             order.push(key);
//           }
//         }
//         for (const k of Array.from(el.children)) walk(k);
//       };
//       walk(document.body);
//       return order.slice(0, 40).map((k) => `${String(seen.get(k)!.count).padStart(3)}x  ${k}   "${seen.get(k)!.sample}"`);
//     });
//     console.log(`\n--- DOM outline (count x selector-path "text sample") ---`);
//     for (const l of outline) console.log(l);

//     console.log(`\nSaved ${path.join(dir, cfg.name)}.html / .png`);
//   } finally {
//     await ctx.close();
//   }
// }

// main();

/// <reference lib="dom" />
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { buildHadiths } from "./hadith-scraper";
import { SITES, SITE_NAMES } from "./sites";

/*
  Probe one page and see which selectors actually match.
    npx tsx scripts/scrapers/test-scraper.ts sunnah https://sunnah.com/bukhari/1
    npx tsx scripts/scrapers/test-scraper.ts dorar            (uses first seed)
    npx tsx scripts/scrapers/test-scraper.ts dorar "https://dorar.net/hadith/search?q=الوحي" --extract
  Writes data/debug/<site>.html and <site>.png so you can inspect the DOM.
  --extract  print the first 2 final Hadith records as pretty JSON
*/
async function main() {
  const [siteName, urlArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const login = process.argv.includes("--login");
  const doExtract = process.argv.includes("--extract");
  const cfg = SITES[siteName];
  if (!cfg) {
    console.error(`Usage: test-scraper.ts <${SITE_NAMES.join("|")}> [url] [--extract] [--login]`);
    process.exit(1);
  }
  const url = urlArg ?? cfg.seeds[0];

  const ctx = await chromium.launchPersistentContext(path.join(".browser-profile", cfg.name), {
    headless: false,
    channel: "chrome",
  });
  try {
    await ctx.addInitScript("window.__name = (fn) => fn;"); // tsx/esbuild helper missing in the page
    const page = await ctx.newPage();
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (login) {
      await new Promise<void>((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("Log in / solve any check in the browser window, then press Enter here... ", () => {
          rl.close();
          res();
        });
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    // JS-rendered sites: wait until real text is on the page
    await page.waitForFunction(() => document.body.innerText.length > 400, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const dir = path.join("data", "debug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${cfg.name}.html`), await page.content(), "utf8");
    await page.screenshot({ path: path.join(dir, `${cfg.name}.png`), fullPage: true });

    if (doExtract) {
      const hadiths = await buildHadiths(page, cfg, page.url());
      console.log(`\n--- --extract: ${hadiths.length} Hadith record(s), showing first 2 ---`);
      console.log(JSON.stringify(hadiths.slice(0, 2), null, 2));
      if (hadiths.length === 0) console.warn("(none extracted — check item/field selectors)");
    }

    const itemCandidates = Array.isArray(cfg.item) ? cfg.item : [cfg.item];
    const report = await page.evaluate(
      ({ itemCandidates, fields, info }) => {
        const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]);
        const safeAll = (root: ParentNode, sel: string) => {
          try { return Array.from(root.querySelectorAll(sel)); } catch { return null; }
        };
        const snippet = (el: Element | undefined) =>
          el ? ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) : "";

        const items = itemCandidates.map((sel: string) => {
          const found = safeAll(document, sel);
          return { sel, count: found ? found.length : -1 };
        });
        const chosen = itemCandidates.find((s) => (safeAll(document, s)?.length ?? 0) > 0);
        const root = chosen ? safeAll(document, chosen)![0] : null;

        const fieldReport: { field: string; sel: string; count: number; text: string }[] = [];
        if (root) {
          const all: [string, string | string[] | null | undefined][] = [
            ...Object.entries(fields as Record<string, string | string[]>),
            ["(info)", info],
          ];
          for (const [name, sels] of all) {
            if (!sels) continue;
            for (const s of list(sels)) {
              if (s === ":self") {
                fieldReport.push({ field: name, sel: s, count: 1, text: snippet(root) });
                continue;
              }
              const at = s.match(/^(.*)@(\d+)$/);
              let f: Element[] | null;
              if (at) {
                const all = safeAll(root, at[1]);
                const x = all ? all[Number(at[2])] : undefined;
                f = x ? [x] : [];
              } else {
                f = safeAll(root, s);
              }
              fieldReport.push({ field: name, sel: s, count: f ? f.length : -1, text: snippet(f?.[0]) });
            }
          }
        }
        return { items, chosen: chosen ?? null, fieldReport };
      },
      { itemCandidates, fields: cfg.fields, info: cfg.info ?? null }
    );

    console.log("\n--- item selectors (count, -1 = invalid selector) ---");
    for (const i of report.items) console.log(`${String(i.count).padStart(4)}  ${i.sel}`);
    console.log(`\nUsing item selector: ${report.chosen ?? "NONE MATCHED"}`);

    if (report.fieldReport.length) {
      console.log("\n--- fields inside the first item ---");
      for (const f of report.fieldReport) {
        console.log(`${f.count > 0 ? "OK  " : "MISS"} ${f.field.padEnd(12)} ${f.sel.padEnd(40)} ${f.count > 0 ? f.text : ""}`);
      }
    }

    const hrefs: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href)
    );
    const parsed = hrefs.flatMap((h) => { try { return [new URL(h)]; } catch { return []; } });
    const follow = parsed.filter((u) => cfg.follow(u));
    const content = parsed.filter((u) => cfg.isContent(u));
    console.log(`\n--- links --- total ${parsed.length}, follow ${follow.length}, content ${content.length}`);
    console.log("sample follow:", follow.slice(0, 5).map((u) => u.href));
    console.log(`this page isContent: ${cfg.isContent(new URL(page.url()))}`);
    // ---- link groups: shows what URL patterns the site really uses ----
    const groups = new Map<string, number>();
    for (const u of parsed) {
      const k = `${u.hostname}/${u.pathname.split("/")[1] ?? ""}`;
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    console.log("\n--- link groups (host/first-path-segment: count) ---");
    for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(4), k);
    console.log("\nsample paths:", [...new Set(parsed.map((u) => u.pathname + u.search))].slice(0, 25));
    console.log(
      "pagination-looking links:",
      [...new Set(parsed.filter((u) => /page=|\/page\//i.test(u.href)).map((u) => u.href))].slice(0, 5)
    );

    // ---- --link=/h/ : walk up from the first links containing that text to find the result container ----
    const linkArg = process.argv.find((a) => a.startsWith("--link="))?.slice(7);
    if (linkArg) {
      const chain: string[] = await page.evaluate((frag) => {
        const out: string[] = [];
        const label = (el: Element) => {
          const id = el.id ? "#" + el.id : "";
          const cn = typeof el.className === "string" ? el.className.trim() : "";
          return el.tagName.toLowerCase() + id + (cn ? "." + cn.split(/\s+/).slice(0, 3).join(".") : "");
        };
        const els = Array.from(document.querySelectorAll(`a[href*="${frag}"]`)).slice(0, 2);
        out.push(`links containing "${frag}": ${document.querySelectorAll(`a[href*="${frag}"]`).length}`);
        for (const el of els) {
          out.push(`match: ${el.outerHTML.slice(0, 120).replace(/\s+/g, " ")}`);
          let cur: Element | null = el;
          for (let d = 0; cur && cur !== document.body && d < 9; d++) {
            const node: Element = cur;
            const same = node.parentElement
              ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName && c.className === node.className).length
              : 1;
            out.push(`  ${"^".repeat(d)} ${label(node)}  textLen=${(node.textContent || "").trim().length}  sameSiblings=${same}`);
            cur = node.parentElement;
          }
        }
        return out;
      }, linkArg);
      console.log(`\n--- ancestors of first links containing "${linkArg}" ---`);
      for (const l of chain) console.log(l);
    }

    // ---- DOM outline: where the real text lives (paste this if selectors miss) ----
    const outline: string[] = await page.evaluate(() => {
      const skip = ["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "HEAD", "NAV", "FOOTER", "SELECT", "OPTION", "FORM", "LABEL", "BUTTON"];
      const junkClass = /dropdown|modal|collapse|navbar|select-wrapper|cookie|survey/;
      const label = (el: Element) => {
        const id = el.id ? "#" + el.id : "";
        const cn = typeof el.className === "string" ? el.className.trim() : "";
        const cls = cn ? "." + cn.split(/\s+/).slice(0, 3).join(".") : "";
        return el.tagName.toLowerCase() + id + cls;
      };
      const seen = new Map<string, { count: number; sample: string }>();
      const order: string[] = [];
      const walk = (el: Element) => {
        if (skip.includes(el.tagName.toUpperCase())) return;
        if (typeof el.className === "string" && junkClass.test(el.className)) return;
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent || "")
          .join(" ")
          .trim()
          .replace(/\s+/g, " ");
        if (own.length >= 20) {
          const chain: string[] = [];
          let cur: Element | null = el;
          for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
            chain.unshift(label(cur));
            cur = cur.parentElement;
          }
          const key = chain.join(" > ");
          const e = seen.get(key);
          if (e) e.count++;
          else {
            seen.set(key, { count: 1, sample: own.slice(0, 50) });
            order.push(key);
          }
        }
        for (const k of Array.from(el.children)) walk(k);
      };
      walk(document.body);
      return order.slice(0, 40).map((k) => `${String(seen.get(k)!.count).padStart(3)}x  ${k}   "${seen.get(k)!.sample}"`);
    });
    console.log(`\n--- DOM outline (count x selector-path "text sample") ---`);
    for (const l of outline) console.log(l);

    console.log(`\nSaved ${path.join(dir, cfg.name)}.html / .png`);
  } finally {
    await ctx.close();
  }
}

main();