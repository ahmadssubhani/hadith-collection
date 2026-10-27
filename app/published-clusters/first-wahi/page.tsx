import type { Metadata } from "next";
import Link from "next/link";
import { FirstWahiPublishedSection } from "@/components/FirstWahiPublishedSection";
import { getEligibleFirstWahiVariations } from "@/lib/first-wahi-queries";
import { FIRST_WAHI_PUBLISHED_PATH } from "@/lib/first-wahi-eligibility";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "First Wahi - Published hadith",
  description:
    "Published Sahih al-Bukhari reports on the Beginning of Revelation (First Wahi), with complete chains and sourced narrator assessments.",
  alternates: {
    canonical: FIRST_WAHI_PUBLISHED_PATH,
  },
};

export default async function FirstWahiPublishedPage() {
  const { variations, error } = await getEligibleFirstWahiVariations();
  const count = variations.length;
  const countLine =
    count === 0
      ? null
      : `${count} hadith with complete chains and sourced narrator assessments`;

  return (
    <section>
      <div className="pagehead">
        <div className="shell">
          <p className="meta" style={{ marginBottom: 12 }}>
            <Link href="/#published-clusters">← Back to Published clusters</Link>
          </p>
          <div className="eyebrow">Published clusters</div>
          <h1 className="title">The Beginning of Revelation (First Wahi)</h1>
          {countLine ? <p>{countLine}</p> : null}
        </div>
      </div>
      <div className="shell" style={{ paddingBottom: 48 }}>
        <FirstWahiPublishedSection variations={variations} error={error} />
      </div>
    </section>
  );
}
