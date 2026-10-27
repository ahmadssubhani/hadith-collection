/**
 * Stage-only English isnad re-splitter. Does NOT write chain_narrators.
 *
 * Separators: quoted, that, from, narrated, reported, told, commas
 * (+ "on the authority of", "has narrated", "narrated to me/from")
 *
 * Relational references ("his father", "his grandfather", "my father", …) are NOT
 * narrator rows. They are marked as relational_ref → preceding narrator token.
 *
 * Outputs:
 *   data/unmatched/chain-reparse-staging.csv
 *   data/unmatched/chain-reparse-samples.json
 *   data/unmatched/chain-reparse-relational-stats.json
 *
 *   npx tsx scripts/collectors/reparse-chains-staging.ts
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { adminClient, fetchAll, csvEscape } from "./_shared";

const HONORIFIC =
  /\s*[-–—,]?\s*(may\s+(god|allah)\s+be\s+pleased\s+with\s+him(?:\s+and\s+his\s+father)?|peace\s+be\s+upon\s+him|\(a\.?s\.?\)|\(ra\)|\(as\)|\(mgb\))\s*[-–—]*/gi;

const LEADING_REF =
  /^(?:hadith\.\s*\d+\s*[-–—:]?\s*|\(?\d+(?:[.\-]\d+)*\)?[.\-]?\s*|\(\s*\d+\s*\)\s*)/i;

const RELATIONAL_RE =
  /^(?:his|her|their|my|our)\s+(father|grandfather|forefathers|forefather|son|mother|brother|uncle|teachers?|shaykhs?)\b/i;

export type SplitToken =
  | { kind: "narrator"; text: string }
  | { kind: "relational_ref"; text: string; relation: string; precedes_narrator_text: string | null };

function relationOf(text: string): string {
  const m = text.match(RELATIONAL_RE);
  return m ? m[1].toLowerCase() : "relational";
}

export function isRelationalRef(text: string): boolean {
  const t = text.trim();
  if (RELATIONAL_RE.test(t)) return true;
  if (/^(his|her|their|my)\s+father\b/i.test(t)) return true;
  return false;
}

/** Split English isnad into narrator tokens + relational refs (not narrator rows). */
export function splitEnglishIsnad(raw: string): SplitToken[] {
  let text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  text = text.replace(/\([^)]*compiler[^)]*\)/gi, " ");
  text = text.replace(LEADING_REF, "");
  text = text.replace(/\bwho has said the following\b[\s\S]*$/i, "");
  text = text.replace(/\bsaid:\s*["“][\s\S]*$/i, "");
  text = text.replace(/:\s*["“][\s\S]*$/i, "");
  text = text.replace(/\bsaying\b[\s\S]*$/i, "");

  const seps: RegExp[] = [
    /\bon the authority of\b/gi,
    /\bhas narrated\b/gi,
    /\bnarrated to me\b/gi,
    /\bnarrated from\b/gi,
    /\bnarrated that\b/gi,
    /\bnarrated\b/gi,
    /\breported that\b/gi,
    /\breported\b/gi,
    /\btold by\b/gi,
    /\btold\b/gi,
    /\bquoted\b/gi,
    /\bthat\b/gi,
    /\bfrom\b/gi,
    /\s*,\s*/g,
  ];

  let parts = [text];
  for (const sep of seps) {
    parts = parts.flatMap((p) => p.split(sep));
  }

  const cleaned = parts
    .map((p) =>
      p
        .replace(HONORIFIC, " ")
        .replace(/^[\s"'“”‘’\-–—:;.]+|[\s"'“”‘’\-–—:;.]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((p) => p.length >= 2)
    .filter((p) => !/^(me|him|her|them|someone|following|said)$/i.test(p));

  const tokens: SplitToken[] = [];
  let lastNarrator: string | null = null;
  for (const p of cleaned) {
    // Strip trailing "said" debris from narrator names
    const cleanedName = p.replace(/\s+said$/i, "").trim();
    if (!cleanedName) continue;

    if (isRelationalRef(cleanedName)) {
      tokens.push({
        kind: "relational_ref",
        text: cleanedName,
        relation: relationOf(cleanedName),
        precedes_narrator_text: lastNarrator,
      });
      continue;
    }

    // Drop pure matn bleed that still looks like a sentence
    if (/\b(wrote to|explain to me|difference between)\b/i.test(cleanedName)) continue;
    if (/^he heard\b/i.test(cleanedName)) {
      // "he heard his father X" — try to peel relational
      const m = cleanedName.match(/^he heard\s+((?:his|her|my)\s+\w+)\s+(.+)$/i);
      if (m) {
        const rel = m[1].trim();
        const rest = m[2].trim();
        if (rest) {
          tokens.push({ kind: "narrator", text: rest });
          lastNarrator = rest;
        }
        tokens.push({
          kind: "relational_ref",
          text: rel,
          relation: relationOf(rel),
          precedes_narrator_text: lastNarrator,
        });
        continue;
      }
    }

    tokens.push({ kind: "narrator", text: cleanedName });
    lastNarrator = cleanedName;
  }
  return tokens;
}

function looksEnglishIsnad(s: string): boolean {
  if (!s || s.length < 12) return false;
  if (/[\u0600-\u06FF]/.test(s) && !/[A-Za-z]{3,}/.test(s)) return false;
  return /\b(narrated|quoted|from|that|reported|told|authority)\b/i.test(s) || s.includes(",");
}

function formatTokens(tokens: SplitToken[]): string {
  return tokens
    .map((t) =>
      t.kind === "narrator"
        ? `N:${t.text}`
        : `REL:${t.text}→${t.precedes_narrator_text ?? "∅"}`
    )
    .join(" | ");
}

async function main() {
  console.log("Chain re-parse staging (relational refs; no chain_narrators writes)");
  const sb = adminClient();

  const rawRecords = await fetchAll<{
    id: number;
    batch_id: number;
    external_id: string | null;
    raw_payload: Record<string, unknown>;
  }>(sb, "raw_import_records", "id,batch_id,external_id,raw_payload");

  const chains = await fetchAll<{
    id: number;
    variation_id: number;
    raw_chain_text: string | null;
  }>(sb, "chains", "id,variation_id,raw_chain_text");

  const nodes = await fetchAll<{
    id: number;
    chain_id: number;
    position: number;
    raw_name: string;
  }>(sb, "chain_narrators", "id,chain_id,position,raw_name");

  const nodesByChain = new Map<number, { position: number; raw_name: string }[]>();
  for (const n of nodes) {
    if (!nodesByChain.has(n.chain_id)) nodesByChain.set(n.chain_id, []);
    nodesByChain.get(n.chain_id)!.push({ position: n.position, raw_name: n.raw_name });
  }
  for (const arr of nodesByChain.values()) arr.sort((a, b) => a.position - b.position);

  type StageRow = {
    source: "raw_import_records" | "chains.raw_chain_text";
    raw_import_id: number | null;
    batch_id: number | null;
    chain_id: number | null;
    variation_id: number | null;
    input_text: string;
    before_nodes: string;
    after_tokens: string;
    narrator_count: number;
    relational_count: number;
    before_count: number;
  };

  const staged: StageRow[] = [];

  for (const r of rawRecords) {
    const narrator = String(r.raw_payload?.narrator ?? "").trim();
    if (!looksEnglishIsnad(narrator)) continue;
    const tokens = splitEnglishIsnad(narrator);
    staged.push({
      source: "raw_import_records",
      raw_import_id: r.id,
      batch_id: r.batch_id,
      chain_id: null,
      variation_id: null,
      input_text: narrator,
      before_nodes: "(payload-only)",
      after_tokens: formatTokens(tokens),
      narrator_count: tokens.filter((t) => t.kind === "narrator").length,
      relational_count: tokens.filter((t) => t.kind === "relational_ref").length,
      before_count: 0,
    });
  }

  let chainsWithRelational = 0;
  const relationalByRelation: Record<string, number> = {};

  for (const c of chains) {
    const raw = (c.raw_chain_text ?? "").trim();
    if (!looksEnglishIsnad(raw)) continue;
    const before = nodesByChain.get(c.id) ?? [];
    const tokens = splitEnglishIsnad(raw);
    const rels = tokens.filter((t) => t.kind === "relational_ref") as Extract<
      SplitToken,
      { kind: "relational_ref" }
    >[];
    if (rels.length) {
      chainsWithRelational++;
      for (const r of rels) {
        relationalByRelation[r.relation] = (relationalByRelation[r.relation] ?? 0) + 1;
      }
    }
    staged.push({
      source: "chains.raw_chain_text",
      raw_import_id: null,
      batch_id: null,
      chain_id: c.id,
      variation_id: c.variation_id,
      input_text: raw,
      before_nodes: before.map((n) => n.raw_name).join(" | "),
      after_tokens: formatTokens(tokens),
      narrator_count: tokens.filter((t) => t.kind === "narrator").length,
      relational_count: rels.length,
      before_count: before.length,
    });
  }

  const dir = path.join("data", "unmatched");
  mkdirSync(dir, { recursive: true });

  const csvPath = path.join(dir, "chain-reparse-staging.csv");
  const headers = [
    "source",
    "raw_import_id",
    "batch_id",
    "chain_id",
    "variation_id",
    "before_count",
    "narrator_count",
    "relational_count",
    "input_text",
    "before_nodes",
    "after_tokens",
  ];
  const lines = [headers.join(",")];
  for (const row of staged) {
    lines.push(
      [
        row.source,
        row.raw_import_id,
        row.batch_id,
        row.chain_id,
        row.variation_id,
        row.before_count,
        row.narrator_count,
        row.relational_count,
        row.input_text,
        row.before_nodes,
        row.after_tokens,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  writeFileSync(csvPath, lines.join("\n") + "\n", "utf8");

  const chainRows = staged.filter((s) => s.chain_id != null);
  const withRel = chainRows.filter((s) => s.relational_count > 0);
  const samplePool = (withRel.length >= 10 ? withRel : chainRows).slice(0, 20);
  const samples = samplePool.map((s) => ({
    chain_id: s.chain_id,
    variation_id: s.variation_id,
    input_text: s.input_text.slice(0, 400),
    before: s.before_nodes.split(" | ").filter(Boolean),
    after_narrators: s.after_tokens
      .split(" | ")
      .filter((t) => t.startsWith("N:"))
      .map((t) => t.slice(2)),
    after_relational: s.after_tokens
      .split(" | ")
      .filter((t) => t.startsWith("REL:"))
      .map((t) => t.slice(4)),
  }));

  const stats = {
    generated_at: new Date().toISOString(),
    mode: "staging_only",
    policy:
      "Relational refs (his/my father, grandfather, …) are not narrator rows; they point at the preceding narrator token.",
    counts: {
      staged_total: staged.length,
      from_raw_import_records: staged.filter((s) => s.source === "raw_import_records").length,
      from_chains_raw_text: chainRows.length,
      chains_with_relational_refs: chainsWithRelational,
      total_relational_ref_tokens: Object.values(relationalByRelation).reduce((a, b) => a + b, 0),
      relational_by_relation: relationalByRelation,
    },
  };

  writeFileSync(path.join(dir, "chain-reparse-relational-stats.json"), JSON.stringify(stats, null, 2), "utf8");
  writeFileSync(
    path.join(dir, "chain-reparse-samples.json"),
    JSON.stringify({ ...stats, samples }, null, 2),
    "utf8"
  );

  console.log(JSON.stringify(stats.counts, null, 2));
  console.log("Wrote", csvPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
