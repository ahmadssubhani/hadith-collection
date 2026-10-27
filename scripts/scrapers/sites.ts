import type { SiteConfig } from "./hadith-scraper";

/* Edit these to change what you pull from dorar.net */
export const DORAR_QUERIES = ["بدء الوحي", "نزول الوحي", "كيف كان يأتيه الوحي", "الوحي"];

/* sunnah.com collections to crawl */
const SUNNAH_COLLECTIONS = [
  "bukhari", "muslim", "nasai", "abudawud", "tirmidhi", "ibnmajah",
  "malik", "riyadussalihin", "adab", "bulugh", "nawawi40", "qudsi40",
];
const sunnahBookPath = new RegExp(`^/(${SUNNAH_COLLECTIONS.join("|")})/[^/:]+$`);
const host = (u: URL, re: RegExp) => re.test(u.hostname);

/* ------------------------------ sunnah.com ------------------------------ */
const sunnah: SiteConfig = {
  name: "sunnah",
  seeds: SUNNAH_COLLECTIONS.map((c) => `https://sunnah.com/${c}`),
  // book pages: /bukhari/1, /bukhari/1?page=2 ...
  follow: (u) => host(u, /^(www\.)?sunnah\.com$/) && sunnahBookPath.test(u.pathname),
  isContent: (u) => host(u, /^(www\.)?sunnah\.com$/) && sunnahBookPath.test(u.pathname),
  item: [".actualHadithContainer"],
  fields: {
    reference: [".hadith_reference_sticky", ".hadith_reference"],
    narrator: [".hadith_narrated"],
    english: [".english_hadith_full .text_details", ".text_details", ".englishcontainer"],
    arabic: [".arabic_hadith_full", ".arabic_text_details", ".arabic"],
    // value cell only — avoid "Grade: Sahih (Darussalam)" from the whole table
    grade: [
      ".gradetable td.english_grade:not(.grade_label)",
      ".gradetable .english_grade:not(.grade_label)",
      ".gradetable td.arabic_grade:not(.grade_label)",
    ],
  },
  delayMs: [2000, 4500], // sunnah.com rate-limits aggressively
};

/* ------------------------------ dorar.net ------------------------------ */
const dorarQueryOk = (u: URL) =>
  host(u, /(^|\.)dorar\.net$/) &&
  u.pathname.startsWith("/hadith/search") &&
  DORAR_QUERIES.includes(u.searchParams.get("q") ?? "");

const dorar: SiteConfig = {
  name: "dorar",
  seeds: DORAR_QUERIES.map((q) => `https://dorar.net/hadith/search?q=${encodeURIComponent(q)}`),
  follow: dorarQueryOk, // only pagination of our own queries
  isContent: dorarQueryOk,
  // results live in the "general" tab (#home); #specialist repeats the same hadiths, so it's excluded
  item: ["div#home > div.border-bottom", "div#home div.border-bottom.py-4"],
  waitFor: "div#home div.border-bottom",
  fields: {
    arabic: ["article h5.h5-responsive", "article h5"],
  },
  arabicStripPrefix: /^\s*\d+\s*[-–]\s*/, // result numbering "1 - "
  // narrator / source / grade rows are parsed from the whole result block by their Arabic labels
  info: [":self"],
  labels: {
    "الراوي": "narrator",
    "المصدر": "book",
    "الصفحة أو الرقم": "reference",
    "خلاصة حكم المحدث": "grade",
    // "المحدث" (the grader) is kept in meta automatically
  },
};

/* ------------------------------ thaqalayn.net ------------------------------ */
const thaqalayn: SiteConfig = {
  name: "thaqalayn",
  seeds: ["https://thaqalayn.com/"],
  // site lives on thaqalayn.com: book page /book/N lists chapters /chapter/book/section/chapter
  follow: (u) =>
    host(u, /(^|\.)thaqalayn\.(com|net)$/) && /^\/(book\/\d+|chapter\/\d+\/\d+\/\d+)$/.test(u.pathname),
  isContent: (u) =>
    host(u, /(^|\.)thaqalayn\.(com|net)$/) && /^\/chapter\/\d+\/\d+\/\d+$/.test(u.pathname),
  // chapter pages: each hadith is a .reading-item (Arabic + English + grading list)
  // Tailwind classes with colons need attribute selectors (e.g. [class*="xl:flex-row-reverse"])
  item: ['div.reading-item', 'div[class*="reading-item"]'],
  waitFor: "div.reading-item",
  strip: [
    "span.text-slate-400", // numbered isnad / English chain — kept separately as narrator
    'div[class*="md:hidden"]', // duplicate mobile grade badges
    ".grading-reference",
    ".sr-only",
    "[aria-hidden='true']",
  ],
  fields: {
    title: [":doc main h1", ":doc h1"],
    reference: ["a[href*='/hadith/']"],
    arabic: ['div[data-hl="ar"] > div.whitespace-pre-wrap', 'div[class*="tracking-arabic"] > div.whitespace-pre-wrap'],
    english: ['div[data-hl="en"] > div.whitespace-pre-wrap', "div.nassim.leading-normal > div.whitespace-pre-wrap"],
    narrator: ['div[data-hl="ar"] span.text-slate-400', 'div[class*="tracking-arabic"] span.text-slate-400'],
    // join every author row: "Author grade | Author grade"
    grade: [".grading-row@*"],
  },
};

/* ------------------------------ hadeethenc.com ------------------------------ */
const hadeethenc: SiteConfig = {
  name: "hadeethenc",
  seeds: ["https://hadeethenc.com/en/home", "https://hadeethenc.com/en/browse"],
  // categories: /en/browse/category/N ; hadith: /en/browse/hadith/N ; related hadiths link to each other
  follow: (u) =>
    host(u, /^(www\.)?hadeethenc\.com$/) && /^\/en\/(home|browse\/(category|hadith)\/\d+)$/.test(u.pathname),
  isContent: (u) =>
    host(u, /^(www\.)?hadeethenc\.com$/) && /^\/en\/browse\/hadith\/\d+$/.test(u.pathname),
  item: ["body"], // one hadith per page
  waitFor: "#h_matn", // English text node, present only once the JS has rendered
  // the grey bracket line "[ ] - [متفق عليه] - [صحيح مسلم: 1678]" is source info, not hadith text
  strip: ["span.text-gray"],
  fields: {
    title: ["section.page-header h5"],
    chapter: ["#categories li a"],
    arabic: ["p.rtl"],
    english: ["#h_matn"],
    explanation: ["#h_exp", "#hadith-explanation"],
    // two grey spans under the English text: "[Authentic] - [Agreed upon]" then "[Sahīh Muslim - 1678]"
    grade: ["p.en span.text-gray@0"],
    reference: ["p.en span.text-gray@1"],
  },
};

/* ------------------------------ al-islam.org ------------------------------ */
// TODO: al-islam.org requires login; data/debug/alislam.html is currently the login page.
// Do not tune selectors until a logged-in content page is saved under data/debug/.
const alislamBlock = /^\/(user|search|node|admin|print|printpdf|sites|files|contact|about|donate|shop|cart|login|register)(\/|$)/;
const alislamOk = (u: URL) =>
  host(u, /^(www\.)?al-islam\.org$/) &&
  !alislamBlock.test(u.pathname) &&
  u.pathname !== "/" &&
  u.pathname.split("/").filter(Boolean).length <= 3;

const alislam: SiteConfig = {
  name: "alislam",
  seeds: ["https://www.al-islam.org/books", "https://www.al-islam.org/articles"],
  follow: alislamOk,
  isContent: alislamOk,
  // only pages that actually have an article body are saved; listing pages yield nothing
  item: [".field--name-body", ".node__content .field--type-text-with-summary", "#block-system-main .content"],
  fields: {
    english: [":self"],
    title: ["h1"], // h1 is outside the body block on most Drupal themes, falls back to pageTitle in meta
  },
  maxPages: 400,
};

export const SITES: Record<string, SiteConfig> = { sunnah, dorar, thaqalayn, hadeethenc, alislam };
export const SITE_NAMES = Object.keys(SITES);