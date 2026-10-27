/**
 * Read-only narrator quality audit.
 * Writes data/unmatched/narrator-quality.json
 * Does NOT delete, rewrite name, or relink chain_narrators.
 *
 *   npx tsx scripts/collectors/narrator-quality-audit.ts
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { adminClient, fetchAll } from "./_shared";

export type QualityClass = "clean" | "fragment" | "needs_review";

/** Transmission/function words that indicate English-isnad split debris (not a personal name). */
const FRAGMENT_WORDS =
  /\b(that|quoted|said|heard|narrated|reported|told|telling|on the authority of|someone who)\b/i;

const HONORIFIC_TRAIL =
  /\s*[-–—,]?\s*(may\s+(god|allah)\s+be\s+pleased\s+with\s+him(?:\s+and\s+his\s+father)?|peace\s+be\s+upon\s+him|\(a\.?s\.?\)|\(ra\)|\(as\)|رضي\s*الله\s*عن[هها]|عليه\s*السلام)\s*$/i;

const LEADING_NUMBERING =
  /^(?:hadith\.\s*\d+\s*[-–—:]?\s*|\(?\d+(?:[.\-]\d+)*\)?[.\-]?\s*)/i;

function hasArabicScript(s: string): boolean {
  return /[\u0600-\u06FF]/.test(s);
}

function hasDigit(s: string): boolean {
  return /\d/.test(s);
}

/** Documented classification rules — first matching fragment rule wins priority order. */
export function classifyNarrator(row: {
  id: number;
  name: string;
  arabic_name: string | null;
  identity_status: string;
}): {
  class: QualityClass;
  rules_triggered: string[];
  arabic_is_latin_copy: boolean;
  has_arabic_script_in_arabic_name: boolean;
} {
  const name = (row.name ?? "").trim();
  const arabic = (row.arabic_name ?? "").trim();
  const rules: string[] = [];
  const hasArScript = arabic.length > 0 && hasArabicScript(arabic);
  const arabicIsLatinCopy =
    arabic.length > 0 &&
    !hasArScript &&
    arabic.toLowerCase() === name.toLowerCase();

  // --- fragment rules (hard) ---
  if (FRAGMENT_WORDS.test(name)) {
    rules.push("fragment_word:contains_transmission_or_function_word");
  }
  if (hasDigit(name)) {
    rules.push("fragment_digit:name_contains_digit");
  }
  if (name.length > 60) {
    rules.push("fragment_length:name_len_gt_60");
  }
  if (HONORIFIC_TRAIL.test(name)) {
    rules.push("fragment_honorific:trailing_honorific");
  }
  if (LEADING_NUMBERING.test(name) && /hadith\.|^\(?\d/i.test(name)) {
    rules.push("fragment_leading_numbering:hadith_or_numeric_prefix");
  }
  // quote debris / matn bleed
  if (/^["“]|["”]$/.test(name) || /said:\s*$/i.test(name) || /who has said/i.test(name)) {
    rules.push("fragment_quote_or_matn_bleed");
  }
  // pronouns / relational stubs alone or dominant
  if (/^(his|her|their)\s+(father|forefathers|son|mother)\b/i.test(name) || /^(to me|someone)\b/i.test(name)) {
    rules.push("fragment_relational_stub");
  }

  const isFragment = rules.some((r) => r.startsWith("fragment_"));

  // --- needs_review (soft; only if not already fragment) ---
  if (!isFragment) {
    if (arabicIsLatinCopy) {
      rules.push("needs_review:arabic_name_copies_non_arabic_name");
    }
    if (!arabic && !hasArabicScript(name)) {
      rules.push("needs_review:missing_arabic_name");
    }
    if (row.identity_status === "verified" && name.length < 3) {
      rules.push("needs_review:verified_but_name_too_short");
    }
  } else if (arabicIsLatinCopy) {
    // still record the latin-copy fact on fragments for audit stats
    rules.push("note:arabic_name_copies_non_arabic_name");
  }

  let cls: QualityClass = "clean";
  if (isFragment) cls = "fragment";
  else if (rules.some((r) => r.startsWith("needs_review:"))) cls = "needs_review";

  return {
    class: cls,
    rules_triggered: rules,
    arabic_is_latin_copy: arabicIsLatinCopy,
    has_arabic_script_in_arabic_name: hasArScript,
  };
}

/** Deterministic normalized_name preview (same rules as migration 015). */
export function normalizeNarratorName(name: string): string {
  let s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(HONORIFIC_TRAIL, "");
  s = s.replace(LEADING_NUMBERING, "");
  s = s.replace(/[“”"']/g, "");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

async function main() {
  console.log("Narrator quality audit (read-only)");
  const sb = adminClient();
  const narrators = await fetchAll<{
    id: number;
    name: string;
    arabic_name: string | null;
    identity_status: string;
    slug: string | null;
  }>(sb, "narrators", "id,name,arabic_name,identity_status,slug");

  const rows = narrators.map((n) => {
    const c = classifyNarrator(n);
    return {
      id: n.id,
      slug: n.slug,
      name: n.name,
      arabic_name: n.arabic_name,
      identity_status: n.identity_status,
      class: c.class,
      rules_triggered: c.rules_triggered,
      arabic_is_latin_copy: c.arabic_is_latin_copy,
      has_arabic_script_in_arabic_name: c.has_arabic_script_in_arabic_name,
      normalized_name_preview: normalizeNarratorName(n.name),
    };
  });

  const counts = {
    total: rows.length,
    clean: rows.filter((r) => r.class === "clean").length,
    fragment: rows.filter((r) => r.class === "fragment").length,
    needs_review: rows.filter((r) => r.class === "needs_review").length,
    arabic_is_latin_copy: rows.filter((r) => r.arabic_is_latin_copy).length,
    has_arabic_script_in_arabic_name: rows.filter((r) => r.has_arabic_script_in_arabic_name).length,
    identity_verified: rows.filter((r) => r.identity_status === "verified").length,
    fragment_and_verified: rows.filter(
      (r) => r.class === "fragment" && r.identity_status === "verified"
    ).length,
  };

  const ruleFreq: Record<string, number> = {};
  for (const r of rows) {
    for (const rule of r.rules_triggered) {
      ruleFreq[rule] = (ruleFreq[rule] ?? 0) + 1;
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    mode: "read_only",
    policy:
      "No deletes, no name rewrites, no chain_narrators relinks. Classification only.",
    rules_documented: {
      fragment_word: "name matches transmission/function words (that/quoted/said/heard/narrated/...)",
      fragment_digit: "name contains a digit",
      fragment_length: "name length > 60",
      fragment_honorific: "trailing honorific e.g. may God be pleased with him",
      fragment_leading_numbering: "leading Hadith.N or numeric ref like 7-43",
      fragment_quote_or_matn_bleed: "quote marks or 'who has said' matn bleed",
      fragment_relational_stub: "his father / to me / someone stubs",
      needs_review_arabic_copy: "arabic_name equals name and has no Arabic script",
      needs_review_missing_arabic: "no arabic_name and name has no Arabic script",
    },
    counts,
    rule_frequency: ruleFreq,
    narrators: rows,
  };

  const dir = path.join("data", "unmatched");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "narrator-quality.json");
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify(counts, null, 2));
  console.log("rule_frequency", ruleFreq);
  console.log("Wrote", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
