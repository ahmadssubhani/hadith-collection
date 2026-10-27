/**
 * Collector C — Fix empty chains / missing chain nodes; import chain_assessments from sourced data.
 *
 * 1) Chains with zero nodes: if raw_chain_text present, split on common transmission words
 *    into chain_narrators (raw_name only; narrator_id left null unless exact name match).
 * 2) Variations with no chain: create a draft chain shell only when raw isnad text exists
 *    on the variation (status_notes / english heuristics) — otherwise log gap (never invent).
 * 3) chain_assessments from data/collectors/chain-assessments/*.csv or Dorar local JSON.
 *
 *   npx tsx scripts/collectors/chains-and-assessments.ts
 *   npx tsx scripts/collectors/chains-and-assessments.ts --apply
 */
import {
  APPLY,
  adminClient,
  ensureImportBatch,
  fetchAll,
  insertRawRecord,
  logMode,
  writeUnmatchedCsv,
} from "./_shared";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TX_SPLIT =
  /\s*(?:حدّ?ثنا|أخبرنا|أنبأنا|عن|قال|سمعت|haddathana|akhbarana|an|qala)\s+/iu;

async function main() {
  logMode("collect:chains-and-assessments (C)");
  const sb = adminClient();

  const chains = await fetchAll<{
    id: number;
    variation_id: number;
    raw_chain_text: string | null;
    verified: boolean;
  }>(sb, "chains", "id,variation_id,raw_chain_text,verified");

  const cn = await fetchAll<{ chain_id: number }>(sb, "chain_narrators", "chain_id");
  const nodesByChain = new Map<number, number>();
  for (const r of cn) nodesByChain.set(r.chain_id, (nodesByChain.get(r.chain_id) ?? 0) + 1);

  const emptyChains = chains.filter((c) => !nodesByChain.has(c.id));
  console.log(`Chains with no nodes: ${emptyChains.length}`);

  const narrators = await fetchAll<{ id: number; name: string; arabic_name: string | null }>(
    sb,
    "narrators",
    "id,name,arabic_name"
  );
  const narrByName = new Map<string, number>();
  for (const n of narrators) {
    narrByName.set(n.name.toLowerCase(), n.id);
    if (n.arabic_name) narrByName.set(n.arabic_name.toLowerCase(), n.id);
  }

  const unmatched: (string | number | null)[][] = [];
  const nodePlans: {
    chainId: number;
    position: number;
    rawName: string;
    transmissionWord: string | null;
    narratorId: number | null;
  }[] = [];

  for (const c of emptyChains) {
    const raw = (c.raw_chain_text ?? "").trim();
    if (!raw) {
      unmatched.push(["empty-chain", c.id, c.variation_id, "", "no_raw_chain_text"]);
      continue;
    }
    const parts = raw
      .split(TX_SPLIT)
      .map((p) => p.replace(/^[\s،,;:]+|[\s،,;:]+$/g, "").trim())
      .filter(Boolean);
    if (parts.length < 2) {
      unmatched.push(["empty-chain", c.id, c.variation_id, raw.slice(0, 120), "split_too_short"]);
      continue;
    }
    // crude: keep transmission words by re-scanning
    const tokens = raw.split(/\s+/);
    let pos = 1;
    let buf: string[] = [];
    let lastTx: string | null = null;
    const flush = () => {
      const name = buf.join(" ").trim();
      if (!name) return;
      const nid = narrByName.get(name.toLowerCase()) ?? null;
      nodePlans.push({
        chainId: c.id,
        position: pos++,
        rawName: name,
        transmissionWord: lastTx,
        narratorId: nid,
      });
      buf = [];
      lastTx = null;
    };
    for (const tok of tokens) {
      if (/^(حدّ?ثنا|أخبرنا|أنبأنا|عن|قال|سمعت|haddathana|akhbarana|an|qala)$/i.test(tok)) {
        flush();
        lastTx = tok;
      } else {
        buf.push(tok);
      }
    }
    flush();
  }

  // Variations with no chain
  const vars = await fetchAll<{ id: number; status_notes: string | null; english_text: string | null }>(
    sb,
    "source_variations",
    "id,status_notes,english_text"
  );
  const varsWithChain = new Set(chains.map((c) => c.variation_id));
  const varsNoChain = vars.filter((v) => !varsWithChain.has(v.id));
  console.log(`Variations with no chain: ${varsNoChain.length}`);

  const newChainPlans: { variationId: number; raw: string }[] = [];
  for (const v of varsNoChain) {
    const notes = v.status_notes ?? "";
    const isnadMatch = notes.match(/(?:isnad|chain|سند)\s*[:：]\s*(.+)/i);
    if (isnadMatch?.[1]?.trim()) {
      newChainPlans.push({ variationId: v.id, raw: isnadMatch[1].trim() });
    } else {
      unmatched.push(["no-chain-variation", v.id, "", (notes || "").slice(0, 80), "no_sourced_isnad_text"]);
    }
  }

  // Chain assessments CSV
  const assessDir = path.join("data", "collectors", "chain-assessments");
  const assessFiles = existsSync(assessDir)
    ? readdirSync(assessDir).filter((f) => f.endsWith(".csv"))
    : [];
  const assessPlans: {
    chainId: number;
    scholarId: number | null;
    continuity: string | null;
    quality: string | null;
    explanation: string | null;
    referenceBook: string | null;
    sourceUrl: string | null;
  }[] = [];

  for (const f of assessFiles) {
    const text = readFileSync(path.join(assessDir, f), "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = (cols[i] ?? "").trim();
      });
      const chainId = Number(row.chain_id);
      if (!chainId) {
        unmatched.push(["chain-assessment", f, row.chain_id, "", "bad_chain_id"]);
        continue;
      }
      assessPlans.push({
        chainId,
        scholarId: row.scholar_id ? Number(row.scholar_id) : null,
        continuity: row.continuity_status || null,
        quality: row.quality_status || null,
        explanation: row.explanation || null,
        referenceBook: row.reference_book || null,
        sourceUrl: row.source_url || null,
      });
    }
  }

  writeUnmatchedCsv(
    "chains-and-assessments.csv",
    ["kind", "id_a", "id_b", "snippet", "reason"],
    unmatched
  );
  console.log(
    `nodePlans=${nodePlans.length} newChainPlans=${newChainPlans.length} assessPlans=${assessPlans.length}`
  );

  const batchId = await ensureImportBatch(
    sb,
    "collector:chains-and-assessments",
    null,
    `Empty-chain fill + assessments (${nodePlans.length} nodes, ${assessPlans.length} assessments)`,
    "local-parse+csv",
    "unknown"
  );

  if (!APPLY) {
    console.log("Dry-run complete.");
    return;
  }

  for (const p of newChainPlans) {
    await insertRawRecord(sb, batchId, `new-chain-${p.variationId}`, p);
    const { data: existing } = await sb
      .from("chains")
      .select("id")
      .eq("variation_id", p.variationId)
      .eq("chain_number", 1)
      .maybeSingle();
    if (existing) continue;
    const { error } = await sb.from("chains").insert({
      variation_id: p.variationId,
      chain_number: 1,
      raw_chain_text: p.raw,
      continuity_status: "unverified",
      quality_status: "unverified",
      verified: false,
      notes: "collector:chains-and-assessments draft shell",
    });
    if (error) throw new Error(error.message);
  }

  for (const n of nodePlans) {
    await insertRawRecord(sb, batchId, `node-${n.chainId}-${n.position}`, n);
    const { error } = await sb.from("chain_narrators").upsert(
      {
        chain_id: n.chainId,
        position: n.position,
        raw_name: n.rawName,
        transmission_word: n.transmissionWord,
        narrator_id: n.narratorId,
        match_confidence: n.narratorId ? 1 : null,
      },
      { onConflict: "chain_id,position" }
    );
    if (error) throw new Error(error.message);
  }

  for (const a of assessPlans) {
    await insertRawRecord(sb, batchId, `ca-${a.chainId}-${a.scholarId ?? "x"}`, a);
    const { error } = await sb.from("chain_assessments").insert({
      chain_id: a.chainId,
      scholar_id: a.scholarId,
      continuity_status: a.continuity,
      quality_status: a.quality,
      explanation: a.explanation,
      reference_book: a.referenceBook,
      source_url: a.sourceUrl,
      verified: false,
    });
    if (error && !/duplicate/i.test(error.message)) throw new Error(error.message);
  }

  console.log("Apply complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
