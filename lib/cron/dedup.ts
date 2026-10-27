import { HadithCandidate } from "./topics-registry";

export interface DuplicateRecord {
  kept: HadithCandidate;
  droppedIdentifier: string;
  matchReason: string;
}

export interface DeduplicateResult {
  unique: HadithCandidate[];
  duplicatesRemoved: DuplicateRecord[];
}

function stripDiacriticsAndPunctuation(str: string): string {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[^\w\s]/gi, "") // Remove punctuation
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim()
    .toLowerCase();
}

/**
 * Computes Jaccard similarity over character 3-grams (trigrams) for two strings.
 */
function computeTrigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (a.length < 3 || b.length < 3) return a === b ? 1.0 : 0;

  const getTrigrams = (str: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= str.length - 3; i++) {
      set.add(str.substring(i, i + 3));
    }
    return set;
  };

  const setA = getTrigrams(a);
  const setB = getTrigrams(b);

  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) {
      intersection++;
    }
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Calculates a candidate metadata richness score for tie-breaking:
 * Score 3: Has chain nodes AND assessments
 * Score 2: Has chain nodes only
 * Score 1: Has neither
 */
function getMetadataScore(cand: HadithCandidate): number {
  const hasNodes = Boolean(cand.nodes && cand.nodes.length > 0);
  const hasAssessments = Boolean(cand.assessments && cand.assessments.length > 0);
  if (hasNodes && hasAssessments) return 3;
  if (hasNodes) return 2;
  return 1;
}

/**
 * Pure deduplication function for hadith candidates across sources.
 * Stage A: EXACT match on normalized (bookTitle, hadithNumber).
 * Stage B: FUZZY match on first narrator rawName AND englishText start similarity > 0.82.
 */
export function deduplicateCandidates(candidates: HadithCandidate[]): DeduplicateResult {
  const duplicatesRemoved: DuplicateRecord[] = [];
  const stageAUnique: HadithCandidate[] = [];
  const exactSeenKeys = new Map<string, HadithCandidate>();

  // Stage A: EXACT MATCHING (normalized bookTitle + hadithNumber)
  for (const cand of candidates) {
    const normBook = stripDiacriticsAndPunctuation(cand.bookTitle);
    const normNum = cand.hadithNumber ? cand.hadithNumber.trim().toLowerCase() : "";
    const key = `${normBook}:${normNum}`;

    if (normBook && normNum && exactSeenKeys.has(key)) {
      const kept = exactSeenKeys.get(key)!;
      duplicatesRemoved.push({
        kept,
        droppedIdentifier: cand.identifier,
        matchReason: `Exact match: bookTitle '${cand.bookTitle}' and hadithNumber '${cand.hadithNumber}'`,
      });
    } else {
      if (normBook && normNum) {
        exactSeenKeys.set(key, cand);
      }
      stageAUnique.push(cand);
    }
  }

  // Stage B: FUZZY MATCHING (cross-source)
  const finalUnique: HadithCandidate[] = [];

  for (const cand of stageAUnique) {
    const candNarrator = cand.nodes && cand.nodes.length > 0
      ? stripDiacriticsAndPunctuation(cand.nodes[0].rawName)
      : "";
    const candTextStart = stripDiacriticsAndPunctuation(cand.englishText.slice(0, 80));

    let matchedIndex = -1;
    let matchedReason = "";

    for (let i = 0; i < finalUnique.length; i++) {
      const existing = finalUnique[i];
      const existingNarrator = existing.nodes && existing.nodes.length > 0
        ? stripDiacriticsAndPunctuation(existing.nodes[0].rawName)
        : "";
      const existingTextStart = stripDiacriticsAndPunctuation(existing.englishText.slice(0, 80));

      // Narrators must be non-empty and match
      if (candNarrator && existingNarrator && candNarrator === existingNarrator) {
        const similarity = computeTrigramSimilarity(candTextStart, existingTextStart);
        if (similarity > 0.82) {
          matchedIndex = i;
          matchedReason = `Fuzzy match: same narrator ('${cand.nodes![0].rawName}') and text similarity ${similarity.toFixed(3)} > 0.82`;
          break;
        }
      }
    }

    if (matchedIndex !== -1) {
      const existing = finalUnique[matchedIndex];
      const candScore = getMetadataScore(cand);
      const existingScore = getMetadataScore(existing);

      if (candScore > existingScore) {
        // Candidate has better metadata richness; replace existing with cand
        finalUnique[matchedIndex] = cand;
        duplicatesRemoved.push({
          kept: cand,
          droppedIdentifier: existing.identifier,
          matchReason: `${matchedReason} (replaced candidate with richer metadata score ${candScore} vs ${existingScore})`,
        });
      } else {
        // Existing is kept; drop candidate
        duplicatesRemoved.push({
          kept: existing,
          droppedIdentifier: cand.identifier,
          matchReason: `${matchedReason} (kept existing with metadata score ${existingScore} vs ${candScore})`,
        });
      }
    } else {
      finalUnique.push(cand);
    }
  }

  return {
    unique: finalUnique,
    duplicatesRemoved,
  };
}
