const fs = require('fs');
const path = require('path');

// Folder where the 9 book JSON files live
const BOOKS_DIR = 'C:/Users/Mirza Ahmad/Downloads/hadith-json-main/hadith-json-main/db/by_book/the_9_books';

// Where to write the mapped output (one JSON file per book)
const OUTPUT_DIR = path.join(__dirname, 'mapped-output');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

function normalizeWhitespace(str) {
  if (!str) return str;
  return str.replace(/\s+/g, ' ').trim();
}

function mapBookFile(filePath, bookSlug) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const chapterById = new Map(raw.chapters.map(ch => [ch.id, ch]));

  const mapped = raw.hadiths.map(h => {
    const chapter = chapterById.get(h.chapterId);
    return {
      bookSlug,
      bookId: h.bookId,
      chapterId: h.chapterId,
      chapterTitleEn: chapter?.english ?? null,
      chapterTitleAr: chapter?.arabic ?? null,
      hadithNumber: h.idInBook,
      globalId: h.id,
      arabic: h.arabic,
      narrator: h.english?.narrator ?? null,
      englishText: normalizeWhitespace(h.english?.text),
    };
  });

  return mapped;
}

// Loop through every .json file in the folder
const files = fs.readdirSync(BOOKS_DIR).filter(f => f.endsWith('.json'));

let totalMapped = 0;
const summary = [];

for (const file of files) {
  const bookSlug = path.basename(file, '.json'); // e.g. "bukhari"
  const filePath = path.join(BOOKS_DIR, file);

  try {
    const mapped = mapBookFile(filePath, bookSlug);
    const outPath = path.join(OUTPUT_DIR, `${bookSlug}.json`);
    fs.writeFileSync(outPath, JSON.stringify(mapped, null, 2));

    totalMapped += mapped.length;
    summary.push({ book: bookSlug, count: mapped.length });
    console.log(`✔ ${bookSlug}: ${mapped.length} hadiths mapped`);
  } catch (err) {
    console.error(`✘ ${bookSlug}: FAILED — ${err.message}`);
    summary.push({ book: bookSlug, count: 0, error: err.message });
  }
}

console.log('\n--- Summary ---');
console.table(summary);
console.log(`Total hadiths mapped across all books: ${totalMapped}`);