import { readFileSync, writeFileSync } from "node:fs";

const scholarsPath = "data/collectors/scholars-reference.json";
const s = JSON.parse(readFileSync(scholarsPath, "utf8"));
s.scholars = s.scholars.map((row: Record<string, unknown>) => {
  const url = String(row.source_url ?? "");
  const source_name =
    (row.source_name as string) ||
    (url.includes("wikidata") ? "Wikidata" : url.includes("wikipedia") ? "Wikipedia" : "curated-reference-list");
  return { ...row, source_name, source_url: row.source_url ?? null };
});
writeFileSync(scholarsPath, JSON.stringify(s, null, 2) + "\n");

const booksPath = "data/collectors/books-reference.json";
const b = JSON.parse(readFileSync(booksPath, "utf8"));

const urlByTitle: Record<string, string> = {
  "Sahih al-Bukhari": "https://sunnah.com/bukhari",
  "Sahih Muslim": "https://sunnah.com/muslim",
  "Sunan Abu Dawud": "https://sunnah.com/abudawud",
  "Sunan Ibn Majah": "https://sunnah.com/ibnmajah",
  "Sunan al-Nasa'i": "https://sunnah.com/nasai",
  "Musnad Ahmad": "https://sunnah.com/ahmad",
  "Sunan al-Darimi": "https://sunnah.com/darimi",
  "صحيح الترمذي": "https://sunnah.com/tirmidhi",
  "Al-Kāfi": "https://thaqalayn.net/",
  "Man Lā Yaḥḍuruh al-Faqīh": "https://thaqalayn.net/",
  "Nahj al-Balāgha": "https://en.wikipedia.org/wiki/Nahj_al-Balagha",
  "Sunan al-Kubra (al-Nasa'i)": "https://en.wikipedia.org/wiki/Al-Sunan_al-Kubra_(al-Nasa%27i)",
  "Sahih Ibn Khuzaymah": "https://en.wikipedia.org/wiki/Sahih_Ibn_Khuzaymah",
  "Sunan al-Daraqutni": "https://en.wikipedia.org/wiki/Al-Daraqutni",
};

const extra = [
  {
    match_titles: ["Sunan al-Kubra (al-Nasa'i)", "السنن الكبرى للنسائي"],
    tradition: "Sunni",
    category: "Sunan",
    author: "al-Nasa'i",
    arabic_title: "السنن الكبرى للنسائي",
  },
  {
    match_titles: ["Sahih Ibn Khuzaymah", "صحيح ابن خزيمة"],
    tradition: "Sunni",
    category: "Sahih collection",
    author: "Ibn Khuzaymah",
    arabic_title: "صحيح ابن خزيمة",
  },
  {
    match_titles: ["Sunan al-Daraqutni", "سنن الدارقطني"],
    tradition: "Sunni",
    category: "Sunan",
    author: "al-Daraqutni",
    arabic_title: "سنن الدارقطني",
  },
];

const existingKeys = new Set(b.books.flatMap((x: { match_titles: string[] }) => x.match_titles));
for (const e of extra) {
  if (!e.match_titles.some((t) => existingKeys.has(t))) b.books.push(e);
}

b.books = b.books.map((row: { match_titles: string[]; source_name?: string; source_url?: string }) => {
  const key = row.match_titles[0];
  const url = row.source_url || urlByTitle[key] || null;
  const source_name =
    row.source_name ||
    (url?.includes("thaqalayn")
      ? "Thaqalayn"
      : url?.includes("sunnah.com")
        ? "sunnah.com"
        : url?.includes("wikipedia")
          ? "Wikipedia"
          : "curated-book-metadata");
  return { ...row, source_name, source_url: url };
});

writeFileSync(booksPath, JSON.stringify(b, null, 2) + "\n");
console.log("scholars sourced:", s.scholars.length);
console.log("books sourced:", b.books.length);
