/**
 * Collector E — Book metadata from Wikidata-verified reference JSON only.
 * Apply path requires provenance.verified_via starting with "wikidata_search_".
 * Untrusted v1 file quarantined under _untrusted/. Does not invent tradition/category.
 *
 *   npx tsx scripts/collectors/books-metadata.ts
 *   npx tsx scripts/collectors/books-metadata.ts --apply
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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type BookRef = {
  match_titles: string[];
  tradition?: string | null;
  category?: string | null;
  author?: string | null;
  arabic_title?: string | null;
  volumes?: number;
  edition?: string;
  wikidata_qid?: string | null;
  author_wikidata_qid?: string | null;
  source_url?: string | null;
};

async function main() {
  logMode("collect:books-metadata (E)");
  const sb = adminClient();
  const file = path.join("data", "collectors", "books-reference.json");
  if (!existsSync(file)) throw new Error(`Missing ${file}`);
  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    provenance: { license: string; notes: string; verified_via?: string };
    books: BookRef[];
  };

  if (!doc.provenance.verified_via?.startsWith("wikidata_search_")) {
    throw new Error(
      `Refuse: books-reference.json missing Wikidata verified_via. ` +
        `Rebuild with: npx tsx scripts/collectors/rebuild-wikidata-references.ts`
    );
  }

  const books = await fetchAll<{
    id: number;
    title: string;
    arabic_title: string | null;
    author: string | null;
    tradition: string;
    book_kind: string;
    category: string | null;
  }>(sb, "books", "id,title,arabic_title,author,tradition,book_kind,category");

  const unmatched: (string | number | null)[][] = [];
  const plans: { id: number; patch: Record<string, unknown>; matchedBy: string }[] = [];

  for (const ref of doc.books) {
    // Only apply rows with a verified book or author QID
    if (!ref.wikidata_qid && !ref.author_wikidata_qid) {
      unmatched.push(["unverified_skip", ref.match_titles.join("|"), "", ""]);
      continue;
    }
    const matches = books.filter((b) =>
      ref.match_titles.some(
        (t) =>
          b.title.toLowerCase() === t.toLowerCase() ||
          (b.arabic_title && b.arabic_title.toLowerCase() === t.toLowerCase())
      )
    );
    if (!matches.length) {
      unmatched.push(["no_match", ref.match_titles.join("|"), ref.tradition ?? "", ref.category ?? ""]);
      continue;
    }
    for (const b of matches) {
      const patch: Record<string, unknown> = {};
      // Never invent tradition/category from unverified memory — only if ref has non-null sourced value
      if (ref.tradition && b.tradition !== ref.tradition) patch.tradition = ref.tradition;
      if (ref.category && !b.category) patch.category = ref.category;
      if (ref.author && (!b.author || b.author === "-" || b.author === "Canonical Compiler")) {
        patch.author = ref.author;
      }
      if (!b.arabic_title && ref.arabic_title) patch.arabic_title = ref.arabic_title;
      if (ref.volumes != null) patch.volumes = ref.volumes;
      if (ref.edition) patch.edition = ref.edition;
      if (Object.keys(patch).length) {
        plans.push({ id: b.id, patch, matchedBy: ref.match_titles[0] });
      }
    }
  }

  // Gap: collection books still without tradition / with unclassified
  for (const b of books) {
    if (b.book_kind === "collection" && (!b.tradition || b.tradition === "unclassified")) {
      unmatched.push(["no_tradition", b.id, b.title, b.book_kind]);
    }
  }

  writeUnmatchedCsv("books-metadata.csv", ["kind", "a", "b", "c"], unmatched);
  console.log(`Update plans=${plans.length} unmatched/gap rows=${unmatched.length}`);

  const batchId = await ensureImportBatch(
    sb,
    "collector:books-metadata",
    "data/collectors/books-reference.json",
    doc.provenance.notes,
    doc.provenance.license,
    "public-reference"
  );

  let n = 0;
  for (const p of plans) {
    await insertRawRecord(sb, batchId, `book-${p.id}`, p);
    if (!APPLY) continue;
    const { error } = await sb.from("books").update(p.patch).eq("id", p.id);
    if (error) throw new Error(error.message);
    n++;
  }
  console.log(APPLY ? `Updated ${n} books` : `Dry-run: ${plans.length} plans`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
