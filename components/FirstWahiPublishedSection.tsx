import {
  FirstWahiVariationCard,
  firstWahiAnchorId,
  firstWahiJumpLabel,
  sortFirstWahiByHadithNumber,
} from "@/components/FirstWahiVariationCard";
import { EmptyState, ErrorState } from "@/components/States";
import {
  FIRST_WAHI_EMPTY_MESSAGE,
  FIRST_WAHI_SOURCE_CREDIT,
} from "@/lib/first-wahi-eligibility";
import type { EligibleFirstWahiVariation } from "@/lib/first-wahi-queries";

export function FirstWahiPublishedSection({
  variations,
  error,
}: {
  variations: EligibleFirstWahiVariation[];
  error: Error | null;
}) {
  const ordered = sortFirstWahiByHadithNumber(variations);

  return (
    <div className="first-wahi-published">
      {error ? <ErrorState message={error.message} /> : null}
      {!error && !ordered.length ? <EmptyState message={FIRST_WAHI_EMPTY_MESSAGE} /> : null}
      {ordered.length ? (
        <>
          <nav className="first-wahi-jump" aria-label="Jump to Bukhari hadith">
            {ordered.map((variation) => (
              <a key={variation.id} className="first-wahi-jump-link" href={`#${firstWahiAnchorId(variation)}`}>
                {firstWahiJumpLabel(variation)}
              </a>
            ))}
          </nav>
          <div className="variant-list first-wahi-card-list">
            {ordered.map((variation) => (
              <FirstWahiVariationCard key={variation.id} variation={variation} />
            ))}
          </div>
          <p className="meta first-wahi-credit">{FIRST_WAHI_SOURCE_CREDIT}</p>
        </>
      ) : null}
    </div>
  );
}
