/**
 * Step 2 dry-run: Wikidata coverage for scholars/imams + how many narrators
 * match Wikidata labels (exact ar/en label). Never writes DB. No --apply path.
 *
 *   npx tsx scripts/collectors/wikidata-coverage.ts
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { adminClient, fetchAll } from "./_shared";

const UA =
  "HadithResearchDB/0.1 (research; contact: local-dev; https://github.com/) WikidataCoverage/1.0";
const SPARQL = "https://query.wikidata.org/sparql";

type ScholarRef = {
  slug: string;
  name: string;
  arabic_name?: string;
  source_url?: string;
  source_name?: string;
};

function qidFromUrl(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/wikidata\.org\/wiki\/(Q\d+)/i);
  return m ? m[1] : null;
}

async function sparqlJson(query: string): Promise<any> {
  const res = await fetch(SPARQL, {
    method: "POST",
    headers: {
      Accept: "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({ query }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`SPARQL ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

function escapeSparqlString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r|\n|\t/g, " ")
    .replace(/`/g, "")
    .trim();
}

function looksArabic(s: string): boolean {
  return /[\u0600-\u06FF]/.test(s);
}

function looksLatinName(s: string): boolean {
  return /[A-Za-z]/.test(s) && s.length >= 3 && s.length <= 80;
}

async function matchLabels(
  names: { id: number; label: string; lang: "ar" | "en" }[]
): Promise<Map<number, { qid: string; matchedLabel: string }>> {
  const out = new Map<number, { qid: string; matchedLabel: string }>();
  const batchSize = 40;
  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize);
    const values = batch
      .map((n) => {
        const lit = escapeSparqlString(n.label);
        if (lit.length < 3) return null;
        return `(${n.id} "${lit}"@${n.lang})`;
      })
      .filter(Boolean)
      .join("\n");
    if (!values) continue;
    const query = `
SELECT ?nid ?item ?label WHERE {
  VALUES (?nid ?label) {
    ${values}
  }
  ?item rdfs:label|skos:altLabel ?label .
  ?item wdt:P31 wd:Q5 .
  FILTER(STRLEN(STR(?label)) >= 8 || CONTAINS(STR(?label), " ") || CONTAINS(STR(?label), " بن ") || CONTAINS(STR(?label), " ابن "))
}
`;
    try {
      const json = await sparqlJson(query);
      for (const b of json.results?.bindings ?? []) {
        const nid = Number(b.nid.value);
        const qid = String(b.item.value).replace(/^.*\//, "");
        if (!out.has(nid)) {
          out.set(nid, { qid, matchedLabel: b.label.value });
        }
      }
    } catch (e) {
      console.warn(`Batch ${i}-${i + batch.length} failed:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return out;
}

async function main() {
  console.log("Wikidata Step 2 coverage (dry-run, no DB writes)");
  const refPath = path.join("data", "collectors", "scholars-reference.json");
  if (!existsSync(refPath)) throw new Error(`Missing ${refPath}`);
  const doc = JSON.parse(readFileSync(refPath, "utf8")) as {
    scholars: ScholarRef[];
  };

  const withQid = doc.scholars.filter((s) => qidFromUrl(s.source_url));
  const wikiNamed = doc.scholars.filter(
    (s) => (s.source_name || "").toLowerCase() === "wikidata" || qidFromUrl(s.source_url)
  );

  // Resolve QIDs still live (entity exists)
  const qids = withQid.map((s) => qidFromUrl(s.source_url)!);
  const valuesQ = qids.map((q) => `wd:${q}`).join(" ");
  let liveQids = new Set<string>();
  if (qids.length) {
    const q = `
SELECT ?item WHERE {
  VALUES ?item { ${valuesQ} }
  ?item wikibase:sitelinks ?sl .
}
`;
    try {
      const json = await sparqlJson(q);
      for (const b of json.results?.bindings ?? []) {
        liveQids.add(String(b.item.value).replace(/^.*\//, ""));
      }
    } catch (e) {
      console.warn("Scholar QID live-check failed:", (e as Error).message);
      liveQids = new Set(qids);
    }
  }

  const sb = adminClient();
  const narrators = await fetchAll<{
    id: number;
    name: string | null;
    arabic_name: string | null;
    slug: string | null;
  }>(sb, "narrators", "id,name,arabic_name,slug");

  const arNames = narrators
    .filter((n) => n.arabic_name && looksArabic(n.arabic_name) && n.arabic_name.trim().length >= 3)
    .map((n) => ({ id: n.id, label: n.arabic_name!.trim(), lang: "ar" as const }));
  // Prefer true Latin `name`; also try latin-looking arabic_name values as en labels
  const enNames = narrators
    .filter((n) => {
      const primary = n.name?.trim();
      const fallback = n.arabic_name?.trim();
      return (primary && looksLatinName(primary)) || (fallback && looksLatinName(fallback) && !looksArabic(fallback));
    })
    .map((n) => {
      const primary = n.name?.trim();
      const fallback = n.arabic_name?.trim();
      const label =
        primary && looksLatinName(primary)
          ? primary
          : fallback!;
      return { id: n.id, label, lang: "en" as const };
    });

  console.log(`Narrators total: ${narrators.length}`);
  console.log(`Matching Arabic labels (${arNames.length}) against Wikidata…`);
  const arHits = await matchLabels(arNames);
  console.log(`Arabic exact-label hits: ${arHits.size}`);

  // Only try English for narrators not already matched via Arabic
  const enTodo = enNames.filter((n) => !arHits.has(n.id));
  console.log(`Matching English labels for unmatched (${enTodo.length})…`);
  const enHits = await matchLabels(enTodo);
  console.log(`Additional English exact-label hits: ${enHits.size}`);

  const covered = new Set([...arHits.keys(), ...enHits.keys()]);

  // Overlap: narrators whose arabic_name equals a scholar-reference arabic_name with Wikidata QID
  const scholarAr = new Set(
    wikiNamed.map((s) => (s.arabic_name || "").trim()).filter(Boolean)
  );
  const scholarEn = new Set(wikiNamed.map((s) => s.name.trim().toLowerCase()).filter(Boolean));
  let narratorOverlapsScholarRef = 0;
  for (const n of narrators) {
    const ar = (n.arabic_name || "").trim();
    const en = (n.name || "").trim().toLowerCase();
    if ((ar && scholarAr.has(ar)) || (en && scholarEn.has(en))) {
      narratorOverlapsScholarRef++;
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: "dry-run",
    scholars_imams: {
      reference_total: doc.scholars.length,
      with_wikidata_qid: withQid.length,
      live_qid_resolved: liveQids.size,
      source_named_wikidata: wikiNamed.length,
      note: "Step 2 primary path: enrich scholars/imams from these Wikidata QIDs first.",
    },
    narrators: {
      total: narrators.length,
      with_arabic_name: arNames.length,
      exact_ar_label_match: arHits.size,
      exact_en_label_match_additional: enHits.size,
      covered_exact_label: covered.size,
      coverage_pct: narrators.length
        ? Number(((100 * covered.size) / narrators.length).toFixed(2))
        : 0,
      overlap_name_with_wikidata_scholar_ref: narratorOverlapsScholarRef,
      method:
        "Exact rdfs:label|skos:altLabel on Wikidata humans (P31=Q5); multi-token or len>=8. Arabic-script @ar then Latin @en. No fuzzy; no writes.",
    },
    sample_matches: [...covered].slice(0, 25).map((id) => {
      const n = narrators.find((x) => x.id === id)!;
      const hit = arHits.get(id) ?? enHits.get(id)!;
      return {
        narrator_id: id,
        name: n.name,
        arabic_name: n.arabic_name,
        qid: hit.qid,
        matched_label: hit.matchedLabel,
      };
    }),
  };

  const dir = path.join("data", "unmatched");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "wikidata-step2-coverage.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report.scholars_imams, null, 2));
  console.log(JSON.stringify(report.narrators, null, 2));
  console.log(`Wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
