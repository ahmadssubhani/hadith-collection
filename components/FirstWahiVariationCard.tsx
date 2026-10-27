import { Suspense } from "react";
import { one } from "@/lib/format";
import { NarratorChainStrip } from "@/components/NarratorChainStrip";
import type { EligibleFirstWahiVariation } from "@/lib/first-wahi-queries";

function sortKey(variation: EligibleFirstWahiVariation) {
  const n = Number(variation.hadith_number);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** Sort eligible First Wahi variations by Bukhari hadith number ascending. */
export function sortFirstWahiByHadithNumber(variations: EligibleFirstWahiVariation[]) {
  return [...variations].sort((a, b) => sortKey(a) - sortKey(b) || a.id - b.id);
}

export function firstWahiJumpLabel(variation: EligibleFirstWahiVariation) {
  const book = variation.books?.title ?? "Source";
  const num = variation.hadith_number?.trim();
  return num ? `${book.replace(/^Sahih al-/, "")} ${num}` : book;
}

export function firstWahiAnchorId(variation: EligibleFirstWahiVariation) {
  const num = variation.hadith_number?.trim() || String(variation.id);
  return `bukhari-${num}`;
}

export function FirstWahiVariationCard({ variation }: { variation: EligibleFirstWahiVariation }) {
  const book = variation.books;
  const bookTitle = book?.title?.trim() || null;
  const hadithNumber = variation.hadith_number?.trim() || null;
  const heading =
    bookTitle && hadithNumber
      ? `${bookTitle} ${hadithNumber}`
      : bookTitle || (hadithNumber ? `Hadith ${hadithNumber}` : null);
  const chapter = variation.chapter?.trim() || null;
  // Skip placeholder chapter labels like "باب"
  const chapterDisplay = chapter && chapter !== "باب" ? chapter : null;

  // Highest chain position is the Companion who narrated the report (not the book collector).
  const companion = variation.eligibleChains[0]
    ? [...variation.eligibleChains[0].nodes].sort((a, b) => b.position - a.position)[0]
    : null;
  const narratedBy = (companion?.name || companion?.arabicName)?.trim() || null;

  const grades = (variation.hadith_assessments ?? []).filter((row) => {
    const scholar = one(row.scholars);
    return Boolean(row.original_grade?.trim() && (scholar?.name || scholar?.arabic_name));
  });

  const continuationNotes = variation.eligibleChains
    .map((c) => c.notes?.trim() || "")
    .filter((n) => /continuation/i.test(n));

  const anchorId = firstWahiAnchorId(variation);

  return (
    <article className="variant first-wahi-card" id={anchorId}>
      <div className="variant-body first-wahi-card-body">
        <header className="first-wahi-card-header">
          {heading ? <h3 className="first-wahi-card-title">{heading}</h3> : null}
          {chapterDisplay ? <p className="meta">{chapterDisplay}</p> : null}
          {narratedBy ? <p className="meta">Narrated by {narratedBy}</p> : null}
        </header>

        {variation.arabic_text?.trim() ? (
          <div className="arabic first-wahi-arabic" lang="ar" dir="rtl">
            {variation.arabic_text}
          </div>
        ) : null}

        {variation.english_text?.trim() ? (
          <div className="first-wahi-english">
            <p className="serif">{variation.english_text}</p>
            {variation.translator?.trim() ? (
              <p className="meta">Translator: {variation.translator.trim()}</p>
            ) : null}
          </div>
        ) : null}

        {grades.length ? (
          <div className="first-wahi-grades">
            <div className="label">Hadith grading</div>
            {grades.map((row) => {
              const scholar = one(row.scholars);
              const scholarName = scholar?.arabic_name || scholar?.name || "Scholar";
              return (
                <div className="fact" key={row.id}>
                  <span className="label">{scholarName}</span>
                  <b lang={scholar?.arabic_name ? "ar" : undefined}>{row.original_grade}</b>
                </div>
              );
            })}
          </div>
        ) : null}

        {continuationNotes.length ? (
          <p className="notice first-wahi-continuation">
            {continuationNotes.map((n) => {
              const match = n.match(/Continuation of[^|]+/i);
              return match ? match[0].trim() : n;
            }).join(" · ")}
          </p>
        ) : null}

        <div className="section-head" style={{ marginTop: 20 }}>
          <div>
            <div className="eyebrow">Isnad</div>
            <h4 className="title" style={{ fontSize: 18, margin: 0 }}>
              Narrator chain{variation.eligibleChains.length > 1 ? "s" : ""}
            </h4>
          </div>
          <p>Click a narrator for evidence</p>
        </div>

        <Suspense fallback={<p className="meta">Loading chain…</p>}>
          <NarratorChainStrip chains={variation.eligibleChains} alwaysLabelChains />
        </Suspense>
      </div>
    </article>
  );
}
