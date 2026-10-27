import Link from "next/link";
import {
  FIRST_WAHI_EMPTY_MESSAGE,
  FIRST_WAHI_PUBLISHED_PATH,
} from "@/lib/first-wahi-eligibility";

export function FirstWahiClusterCard({ count }: { count: number }) {
  const ariaLabel =
    count > 0
      ? `Open the ${count} published First Wahi hadith`
      : "First Wahi cluster — no published hadith yet";

  return (
    <div className="card first-wahi-cluster-card" aria-label={ariaLabel}>
      <h3 className="first-wahi-cluster-title">The Beginning of Revelation (First Wahi)</h3>
      {count > 0 ? (
        <>
          <p className="meta first-wahi-cluster-subtitle">
            {count} hadith · full chains · sourced narrator assessments
          </p>
          <Link
            href={FIRST_WAHI_PUBLISHED_PATH}
            className="first-wahi-cluster-cta"
            aria-label={ariaLabel}
          >
            Read the hadith
          </Link>
        </>
      ) : (
        <p className="meta">{FIRST_WAHI_EMPTY_MESSAGE}</p>
      )}
    </div>
  );
}
