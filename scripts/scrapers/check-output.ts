/**
 * Summarize data/raw/*.jsonl quality.
 *   npx tsx scripts/scrapers/check-output.ts
 *   npx tsx scripts/scrapers/check-output.ts data/raw
 */
import * as fs from "fs";
import * as path from "path";

const FIELDS = ["arabic", "english", "reference", "narrator", "grade", "book", "chapter"] as const;

type Rec = Record<string, unknown> & { id?: string; source?: string };

function nullCount(r: Rec): number {
  return FIELDS.reduce((n, f) => n + (r[f] == null || r[f] === "" ? 1 : 0), 0);
}

function main() {
  const dir = process.argv[2] ?? path.join("data", "raw");
  if (!fs.existsSync(dir)) {
    console.error(`No directory: ${dir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f !== "all.jsonl");
  if (!files.length) {
    console.error(`No .jsonl files in ${dir}`);
    process.exit(1);
  }

  for (const file of files.sort()) {
    const records: Rec[] = [];
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* skip bad line */
      }
    }
    const source = file.replace(/\.jsonl$/, "");
    const ids = new Map<string, number>();
    for (const r of records) {
      const id = String(r.id ?? "");
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    const dupIds = [...ids.values()].filter((c) => c > 1).length;
    const dupRecords = records.length - ids.size;

    console.log(`\n===== ${source} (${file}) =====`);
    console.log(`records: ${records.length}`);
    console.log(`duplicate ids: ${dupIds} (extra rows: ${dupRecords})`);
    console.log("% non-null:");
    for (const f of FIELDS) {
      const filled = records.filter((r) => r[f] != null && r[f] !== "").length;
      const pct = records.length ? ((100 * filled) / records.length).toFixed(1) : "0.0";
      console.log(`  ${f.padEnd(12)} ${pct}%  (${filled}/${records.length})`);
    }

    const samples = [...records].sort((a, b) => nullCount(b) - nullCount(a)).slice(0, 3);
    console.log("3 samples with most null fields:");
    for (const r of samples) {
      const missing = FIELDS.filter((f) => r[f] == null || r[f] === "");
      console.log(
        JSON.stringify(
          {
            id: r.id,
            url: r.url,
            nullFields: missing,
            reference: r.reference,
            narrator: r.narrator,
            grade: r.grade,
            arabic: typeof r.arabic === "string" ? r.arabic.slice(0, 80) : r.arabic,
            english: typeof r.english === "string" ? r.english.slice(0, 80) : r.english,
          },
          null,
          2
        )
      );
    }
  }
}

main();
