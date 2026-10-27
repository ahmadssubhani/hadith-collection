/**
 * Wikidata scholars/imams exact-label compare for the 24 reference entries.
 * No narrator matching. No DB writes (report only — user applies later).
 *
 *   npx tsx scripts/collectors/wikidata-scholars-exact.ts
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const UA = "HadithResearchDB/0.1 (research; scholars exact-label compare)";

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

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`'’ʻʾʿ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function fetchEntity(qid: string): Promise<{
  labels: Record<string, { value: string }>;
  aliases: Record<string, { value: string }[]>;
} | null> {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${qid}: HTTP ${res.status}`);
  const json = (await res.json()) as any;
  const ent = json.entities?.[qid];
  if (!ent) return null;
  return { labels: ent.labels ?? {}, aliases: ent.aliases ?? {} };
}

function collectLabels(ent: {
  labels: Record<string, { value: string }>;
  aliases: Record<string, { value: string }[]>;
}): string[] {
  const out: string[] = [];
  for (const lang of ["en", "ar"]) {
    if (ent.labels[lang]?.value) out.push(ent.labels[lang].value);
    for (const a of ent.aliases[lang] ?? []) out.push(a.value);
  }
  return out;
}

async function main() {
  const refPath = path.join("data", "collectors", "scholars-reference.json");
  if (!existsSync(refPath)) throw new Error(`Missing ${refPath}`);
  const doc = JSON.parse(readFileSync(refPath, "utf8")) as { scholars: ScholarRef[] };
  console.log(`Scholars in reference: ${doc.scholars.length}`);

  const results: {
    slug: string;
    our_name: string;
    our_arabic_name: string | null;
    qid: string | null;
    status:
      | "exact_label_match"
      | "no_exact_label_match"
      | "qid_not_live"
      | "no_qid";
    wikidata_en: string | null;
    wikidata_ar: string | null;
    matched_on: string | null;
    would_apply: boolean;
  }[] = [];

  for (const s of doc.scholars) {
    const qid = qidFromUrl(s.source_url);
    if (!qid) {
      results.push({
        slug: s.slug,
        our_name: s.name,
        our_arabic_name: s.arabic_name ?? null,
        qid: null,
        status: "no_qid",
        wikidata_en: null,
        wikidata_ar: null,
        matched_on: null,
        would_apply: false,
      });
      continue;
    }

    let ent: Awaited<ReturnType<typeof fetchEntity>>;
    try {
      ent = await fetchEntity(qid);
    } catch (e) {
      console.warn(s.slug, (e as Error).message);
      ent = null;
    }
    await new Promise((r) => setTimeout(r, 400));

    if (!ent) {
      results.push({
        slug: s.slug,
        our_name: s.name,
        our_arabic_name: s.arabic_name ?? null,
        qid,
        status: "qid_not_live",
        wikidata_en: null,
        wikidata_ar: null,
        matched_on: null,
        would_apply: false,
      });
      continue;
    }

    const en = ent.labels.en?.value ?? null;
    const ar = ent.labels.ar?.value ?? null;
    const candidates = collectLabels(ent);
    const ourNames = [s.name, s.arabic_name].filter(Boolean) as string[];
    let matchedOn: string | null = null;
    for (const ours of ourNames) {
      for (const theirs of candidates) {
        if (norm(ours) === norm(theirs)) {
          matchedOn = `${ours} == ${theirs}`;
          break;
        }
      }
      if (matchedOn) break;
    }

    const exact = matchedOn != null;
    results.push({
      slug: s.slug,
      our_name: s.name,
      our_arabic_name: s.arabic_name ?? null,
      qid,
      status: exact ? "exact_label_match" : "no_exact_label_match",
      wikidata_en: en,
      wikidata_ar: ar,
      matched_on: matchedOn,
      would_apply: exact,
    });
  }

  const counts = {
    reference_total: doc.scholars.length,
    with_qid: results.filter((r) => r.qid).length,
    no_qid: results.filter((r) => r.status === "no_qid").length,
    qid_not_live: results.filter((r) => r.status === "qid_not_live").length,
    exact_label_match_would_apply: results.filter((r) => r.would_apply).length,
    no_exact_label_match: results.filter((r) => r.status === "no_exact_label_match").length,
  };

  const dir = path.join("data", "unmatched");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "wikidata-scholars-exact.json");
  writeFileSync(
    out,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        mode: "report_only_no_db_writes",
        policy: "Exact label/alias match on en|ar only. No narrator matching. No --apply.",
        counts,
        no_qid: results.filter((r) => r.status === "no_qid"),
        qid_not_live_or_fail: results.filter(
          (r) => r.status === "qid_not_live" || r.status === "no_exact_label_match"
        ),
        would_apply: results.filter((r) => r.would_apply),
        all: results,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(JSON.stringify(counts, null, 2));
  console.log(
    "no_qid:",
    results.filter((r) => r.status === "no_qid").map((r) => r.slug)
  );
  console.log(
    "not exact / not live:",
    results
      .filter((r) => r.status === "qid_not_live" || r.status === "no_exact_label_match")
      .map((r) => `${r.slug} (${r.status}) q=${r.qid} en=${r.wikidata_en}`)
  );
  console.log("Wrote", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
