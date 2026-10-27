/**
 * Collector B — Teacher/student relations into narrator_relations.
 * Reads data/collectors/relations/*.csv with columns:
 *   from_slug,to_slug,relation_type(teacher|student),source_name,source_url,notes
 * Never invents edges. Dry-run by default.
 *
 *   npx tsx scripts/collectors/narrator-relations.ts
 *   npx tsx scripts/collectors/narrator-relations.ts --apply
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

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = cols[i] ?? "";
    });
    return o;
  });
}

async function main() {
  logMode("collect:narrator-relations (B)");
  const sb = adminClient();
  const dir = path.join("data", "collectors", "relations");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".csv")) : [];
  if (!files.length) {
    console.log("No CSVs in data/collectors/relations/. Writing empty unmatched stub.");
    writeUnmatchedCsv("narrator-relations.csv", ["file", "from", "to", "reason"], [
      ["(none)", "", "", "no_source_files"],
    ]);
    return;
  }

  const narrators = await fetchAll<{ id: number; slug: string }>(sb, "narrators", "id,slug");
  const bySlug = new Map(narrators.map((n) => [n.slug, n.id]));
  const unmatched: (string | null)[][] = [];
  const plans: {
    from: number;
    to: number;
    relation_type: "teacher" | "student";
    source_name: string | null;
    source_url: string | null;
    notes: string | null;
  }[] = [];

  for (const f of files) {
    const rows = parseCsv(readFileSync(path.join(dir, f), "utf8"));
    for (const row of rows) {
      const fromSlug = row.from_slug || row.from || "";
      const toSlug = row.to_slug || row.to || "";
      const rt = (row.relation_type || "teacher").toLowerCase();
      if (rt !== "teacher" && rt !== "student") {
        unmatched.push([f, fromSlug, toSlug, "bad_relation_type"]);
        continue;
      }
      const fromId = bySlug.get(fromSlug);
      const toId = bySlug.get(toSlug);
      if (!fromId || !toId) {
        unmatched.push([f, fromSlug, toSlug, !fromId ? "from_unmatched" : "to_unmatched"]);
        continue;
      }
      plans.push({
        from: fromId,
        to: toId,
        relation_type: rt,
        source_name: row.source_name || null,
        source_url: row.source_url || null,
        notes: row.notes || null,
      });
    }
  }

  writeUnmatchedCsv("narrator-relations.csv", ["file", "from", "to", "reason"], unmatched);
  console.log(`Plans=${plans.length} unmatched=${unmatched.length}`);

  const batchId = await ensureImportBatch(
    sb,
    "collector:narrator-relations",
    null,
    `Teacher/student edges from ${files.join(", ")}`,
    "local-csv",
    "unknown"
  );

  let written = 0;
  for (const p of plans) {
    await insertRawRecord(sb, batchId, `rel-${p.from}-${p.to}-${p.relation_type}`, p);
    if (!APPLY) continue;
    const { error } = await sb.from("narrator_relations").upsert(
      {
        from_narrator_id: p.from,
        to_narrator_id: p.to,
        relation_type: p.relation_type,
        source_name: p.source_name,
        source_url: p.source_url,
        notes: p.notes,
        verified: false,
      },
      { onConflict: "from_narrator_id,to_narrator_id,relation_type" }
    );
    if (error) throw new Error(error.message);
    written++;
  }
  console.log(APPLY ? `Upserted ${written} relations` : `Dry-run: ${plans.length} plans`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
