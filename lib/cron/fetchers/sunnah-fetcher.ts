import fs from "fs";
import path from "path";
import { CandidateAssessment, CandidateNarratorNode, RawFetchedCandidate, SourceFetcher, TopicDefinition } from "./types";

interface BukhariHadith {
  hadithNumber: number;
  inBookHadithNumber: number;
  chapterNumber: number;
  narrator?: string;
  english: string;
  arabic: string;
  inBookReference?: string;
  uscMsaReference?: string;
  grade?: string;
}

interface BukhariChapter {
  chapterNumber: number;
  chapterName: {
    english: string;
    arabic: string;
  };
  hadiths: BukhariHadith[];
}

interface BukhariBook {
  bookNumber: number;
  bookName: {
    english: string;
    arabic: string;
  };
  chapters: BukhariChapter[];
}

interface BukhariDataset {
  collection: string;
  collectionName: string;
  scrapedAt: string;
  totalBooks: number;
  totalHadiths: number;
  books: BukhariBook[];
}

let cachedBukhariDataset: BukhariDataset | null = null;

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseSunnahSanad(h: BukhariHadith): { rawChainText?: string; nodes: CandidateNarratorNode[] } {
  const nodes: CandidateNarratorNode[] = [];
  let rawChainText = "";

  // 1. Extract primary narrator from h.narrator or English text
  let primaryNarrator = h.narrator?.trim() || "";
  if (!primaryNarrator && h.english) {
    const match = h.english.match(/^Narrated\s+([^:]+):/i);
    if (match) {
      primaryNarrator = match[1].trim();
    }
  }

  // 2. Parse Arabic text for full chain sequence
  if (h.arabic) {
    const matnMatch = h.arabic.match(/(?:أَنَّ رَسُولَ|أَنَّ النَّبِيَّ|أَنَّهُ|قَالَ رَسُولُ|قَالَ النَّبِيُّ|أَنَّ عَاكِشَةَ|قَالَ:\s*«|أن رسول الله|أن النبي|قال:)/);
    if (matnMatch && matnMatch.index && matnMatch.index > 10) {
      rawChainText = h.arabic.slice(0, matnMatch.index).trim();
    } else {
      rawChainText = h.arabic.slice(0, 150).trim();
    }

    const arParts = rawChainText
      .split(/(?:حَدَّثَنَا|حَدَّثَنِي|أَخْبَرَنَا|أَخْبَرَنِي|عَنْ|عَنِ|حَدَّثَنَا|حدثنا|حدثني|أخبرنا|أخبرني|عن|سمعت)/)
      .map((p) => p.replace(/^[،:\s\-\.]+|[،:\s\-\.]+$|^\(رحمه الله\)/g, "").trim())
      .filter((p) => p.length > 2 && !p.includes("رسول الله") && !p.includes("النبي"));

    if (arParts.length > 0) {
      arParts.forEach((name, idx) => {
        nodes.push({
          position: idx + 1,
          rawName: name,
          slug: slugify(name),
          word: idx === 0 ? "haddathana" : "an",
        });
      });
    }
  }

  // Fallback to primaryNarrator if Arabic split returned 0 nodes
  if (nodes.length === 0 && primaryNarrator) {
    rawChainText = `Narrated ${primaryNarrator}`;
    nodes.push({
      position: 1,
      rawName: primaryNarrator,
      slug: slugify(primaryNarrator),
      word: "haddathana",
    });
  }

  return { rawChainText, nodes };
}

export class SunnahFetcher implements SourceFetcher {
  name = "Sunnah.com Fetcher";
  sourceType = "sunnah.com" as const;

  private async getDataset(): Promise<BukhariDataset> {
    if (cachedBukhariDataset) {
      return cachedBukhariDataset;
    }

    const localPaths = [
      path.join(process.env.USERPROFILE || "C:\\Users\\Mirza Ahmad", "Downloads", "bukhari.json"),
      "C:\\Users\\Mirza Ahmad\\Downloads\\bukhari.json",
      "bukhari.json",
    ];

    for (const p of localPaths) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.books)) {
            console.log(`[SunnahFetcher] Loaded dataset locally from ${p}`);
            cachedBukhariDataset = parsed as BukhariDataset;
            return cachedBukhariDataset;
          }
        }
      } catch {
        // ignore and fallback to remote
      }
    }

    const datasetUrl =
      "https://raw.githubusercontent.com/Ikhan/sahih-bukhari-english/main/data/bukhari-all-books.json";

    try {
      const res = await fetch(datasetUrl, {
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        throw new Error(
          `Failed to fetch Sahih al-Bukhari dataset from ${datasetUrl}: HTTP status ${res.status} ${res.statusText}`
        );
      }

      const data: BukhariDataset = await res.json();
      if (!data || !Array.isArray(data.books)) {
        throw new Error(
          `Invalid Sahih al-Bukhari dataset structure received from ${datasetUrl}`
        );
      }

      cachedBukhariDataset = data;
      return cachedBukhariDataset;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[SunnahFetcher] Dataset fetch error: ${message}`);
    }
  }

  async fetchCandidates(
    topic?: TopicDefinition,
    options?: { maxResults?: number; expandSearch?: boolean }
  ): Promise<RawFetchedCandidate[]> {
    console.log(
      `[SunnahFetcher] Fetching candidates for topic: ${topic?.slug ?? "general"}`
    );

    const dataset = await this.getDataset();
    const candidates: RawFetchedCandidate[] = [];

    // Identify target books
    const targetBooks = dataset.books.filter((book) => {
      const bookEn = book.bookName?.english ?? "";
      if (topic?.slug === "first-wahi") {
        return bookEn === "Revelation";
      }

      if (topic?.keywords && topic.keywords.length > 0) {
        const lowerBook = bookEn.toLowerCase();
        return topic.keywords.some((kw) => lowerBook.includes(kw.toLowerCase()));
      }

      return true;
    });

    for (const book of targetBooks) {
      for (const chapter of book.chapters || []) {
        const chapterTitle =
          chapter.chapterName?.english && chapter.chapterName.english !== "Chapter:"
            ? chapter.chapterName.english
            : chapter.chapterName?.arabic || `Chapter ${chapter.chapterNumber}`;

        for (const h of chapter.hadiths || []) {
          const volMatch = h.uscMsaReference?.match(/Vol\.\s*(\d+)/i);
          const volume = volMatch ? volMatch[1] : "1";

          const { rawChainText, nodes } = parseSunnahSanad(h);

          const assessments: CandidateAssessment[] = [
            {
              scholarName: "Ibn Hajar al-Asqalani",
              scholarSlug: "ibn-hajar",
              originalGrade: "صحيح",
              normalizedGrade: "sahih",
              explanation: "Authentic report in Sahih al-Bukhari.",
              referenceBook: "Fath al-Bari",
            },
          ];

          candidates.push({
            source: "sunnah.com",
            sourceIdentifier: `sunnah:bukhari:${h.hadithNumber}`,
            bookTitle: "Sahih al-Bukhari",
            hadithNumber: String(h.hadithNumber),
            chapter: chapterTitle,
            volume,
            page: "1",
            arabicText: h.arabic,
            englishText: h.english,
            translator: "Dr. Muhammad Muhsin Khan",
            sourceUrl: `https://sunnah.com/bukhari:${h.hadithNumber}`,
            tradition: "Sunni",
            hadithStatus: h.grade ? h.grade.toLowerCase() : "sahih",
            chainStatus: "muttasil",
            narrationStatus: ["marfu", "ahad", "first_wahi"],
            rawChainText: rawChainText || undefined,
            nodes: nodes.length > 0 ? nodes : undefined,
            assessments,
            rawPayload: h as unknown as Record<string, unknown>,
          });

          if (options?.maxResults && candidates.length >= options.maxResults) {
            return candidates;
          }
        }
      }
    }

    return candidates;
  }
}
