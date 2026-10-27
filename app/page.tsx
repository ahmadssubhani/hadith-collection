import Link from "next/link";
import { FeaturedHadith } from "@/components/FeaturedHadith";
import { HadithCard } from "@/components/HadithCard";
import { HadithCollectionCard } from "@/components/HadithCollectionCard";
import { HeroSection } from "@/components/HeroSection";
import { EmptyState, ErrorState } from "@/components/States";
import { FirstWahiClusterCard } from "@/components/FirstWahiClusterCard";
import { DEMO_HADITHS, HOME_COLLECTIONS, HOME_REASONS, HOME_TOPICS } from "@/lib/content/home";
import { getBooks, getEligibleCorpusSnapshot, getFeaturedHadiths } from "@/lib/queries";
import { getEligibleFirstWahiVariations } from "@/lib/first-wahi-queries";
import { FIRST_WAHI_HADITH_SLUG } from "@/lib/first-wahi-eligibility";

export const revalidate = 30;

export default async function HomePage() {
  const [corpus, featured, books, firstWahi] = await Promise.all([
    // Live bar = First Wahi quality: a–d AND multi-node isnad (not "Narrated X" stubs)
    getEligibleCorpusSnapshot({ publishedOnly: true, minChainNodes: 2 }),
    getFeaturedHadiths(8),
    getBooks(),
    getEligibleFirstWahiVariations(),
  ]);

  const eligibleStats = corpus.stats;
  const collections = books.length
    ? books.slice(0, 6).map((book) => ({ title: book.title, query: book.title, note: book.tradition }))
    : HOME_COLLECTIONS;

  const liveFeatured = featured.hadiths.filter(
    (h) => h.slug !== FIRST_WAHI_HADITH_SLUG && h.slug !== "first-wahi"
  );
  const firstWahiCount = firstWahi.variations.length;
  const liveTopics =
    corpus.byTopic.length > 0
      ? corpus.byTopic
          .filter((t) => !t.topic.startsWith("Chapter:") && t.topic !== "باب")
          .slice(0, 16)
      : HOME_TOPICS.map((t) => ({
          topic: t.label,
          variationCount: 0,
          hadithCount: 0,
          hadithIds: [] as number[],
          variationIds: [] as number[],
        }));

  return (
    <>
      <HeroSection />
      <section className="shell home-sections">
        <div className="stats">
          <div className="stat">
            <b>{eligibleStats.hadiths}</b>
            <span>Full-isnad clusters (2+ rawis)</span>
          </div>
          <div className="stat">
            <b>{eligibleStats.variations}</b>
            <span>Full-isnad variations</span>
          </div>
          <div className="stat">
            <b>{eligibleStats.chains}</b>
            <span>Complete verified chains</span>
          </div>
          <div className="stat">
            <b>{firstWahiCount}</b>
            <span>Eligible First Wahi variations</span>
          </div>
        </div>

        <div className="section-head">
          <div>
            <div className="eyebrow">Featured hadith</div>
            <h2 className="title">A few reports to begin with</h2>
          </div>
          <p>Layout samples — open Published clusters for verified source text</p>
        </div>
        <FeaturedHadith hadith={DEMO_HADITHS[0]} featured />
        <div className="cards" style={{ marginTop: 16 }}>
          {DEMO_HADITHS.slice(1).map((hadith) => (
            <FeaturedHadith key={hadith.id} hadith={hadith} />
          ))}
        </div>

        <div className="section-head">
          <div>
            <div className="eyebrow">Collections</div>
            <h2 className="title">Explore Hadith collections</h2>
          </div>
          <Link href="/collections">View all</Link>
        </div>
        <div className="cards">
          {collections.map((collection) => (
            <HadithCollectionCard
              key={collection.title}
              title={collection.title}
              note={collection.note}
              href={`/search?q=${encodeURIComponent(collection.query)}`}
            />
          ))}
        </div>

        <div className="section-head">
          <div>
            <div className="eyebrow">Topics</div>
            <h2 className="title">Browse eligible by topic</h2>
          </div>
          <p className="meta">Only clusters that pass the live bar (AR+EN, verified chain, cited narrator evidence)</p>
        </div>
        <div className="pills topic-row">
          {liveTopics.map((topic) => (
            <Link
              className="pill topic-pill"
              key={topic.topic}
              href={`/search?q=${encodeURIComponent(topic.topic)}`}
            >
              {topic.topic}
              {"variationCount" in topic && topic.variationCount > 0 ? ` (${topic.variationCount})` : ""}
            </Link>
          ))}
        </div>

        <div className="section-head">
          <div>
            <div className="eyebrow">Why this platform</div>
            <h2 className="title">Research without collapsing the evidence</h2>
          </div>
        </div>
        <div className="cards">
          {HOME_REASONS.map((reason) => (
            <div className="card" key={reason.title}>
              <h3>{reason.title}</h3>
              <p className="meta">{reason.text}</p>
            </div>
          ))}
        </div>

        <div id="published-clusters" className="published-clusters-section">
          <div className="section-head">
            <div>
              <div className="eyebrow">Published clusters</div>
              <h2 className="title">Continue researching</h2>
            </div>
          </div>
          {corpus.error ? <ErrorState message={corpus.error.message} /> : null}
          {firstWahi.error ? <ErrorState message={firstWahi.error.message} /> : null}
          <div className="cards" style={{ marginBottom: 24 }}>
            <FirstWahiClusterCard count={firstWahiCount} />
          </div>
        </div>

        {featured.error ? <ErrorState message={featured.error} /> : null}
        {liveFeatured.length ? (
          <div className="cards" style={{ marginTop: 24, marginBottom: 40 }}>
            {liveFeatured.map((hadith) => (
              <HadithCard key={hadith.id} hadith={hadith} variationCount={hadith.variation_count} />
            ))}
          </div>
        ) : !firstWahiCount && !featured.error ? (
          <EmptyState message="No published hadith clusters are visible yet. After review, publish a pilot of 25 clusters." />
        ) : null}
      </section>
    </>
  );
}
