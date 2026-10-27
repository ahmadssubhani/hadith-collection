import Link from "next/link";
import { notFound } from "next/navigation";
import { SourceVariation } from "@/components/SourceVariation";
import { getHadithBySlug } from "@/lib/queries";

export const revalidate = 60;

export default async function HadithPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { hadith, variations, error } = await getHadithBySlug(slug);

  if (error) {
    return (
      <div className="shell">
        <p className="notice">{error.message}</p>
      </div>
    );
  }
  if (!hadith) notFound();

  return (
    <section>
      <div className="pagehead">
        <div className="shell">
          <div className="breadcrumbs">
            <Link href="/">Hadiths</Link> / {hadith.topics[0] ?? "Cluster"} / Report cluster
          </div>
          <div className="eyebrow">Hadith cluster · {hadith.slug}</div>
          <h1 className="title">{hadith.title}</h1>
          {hadith.arabic_title ? (
            <div className="arabic" lang="ar" style={{ fontSize: 22 }}>
              {hadith.arabic_title}
            </div>
          ) : null}
          <p>
            {variations.length} source variation{variations.length === 1 ? "" : "s"} · each with its own text, status, and
            chain
          </p>
        </div>
      </div>
      <div className="shell layout">
        <article>
          <div className="notice">
            This heading helps you find related accounts. It is not a new canonical hadith. Open any source below to inspect
            that source’s exact evidence. Scholarly grades are never averaged into a consensus.
          </div>
          {hadith.summary ? <p className="lead">{hadith.summary}</p> : null}
          <div className="section-head">
            <div>
              <div className="eyebrow">Compare the evidence</div>
              <h2 className="title">Source variants</h2>
            </div>
            <p>Open one at a time</p>
          </div>
          <div className="variant-list">
            {variations.map((variation, index) => (
              <SourceVariation key={variation.id} variation={variation} defaultOpen={index === 0} />
            ))}
          </div>
          {!variations.length ? (
            <p className="notice">This cluster has no verified source variations visible under current access rules.</p>
          ) : null}
        </article>
        <aside className="aside">
          <div className="card">
            <div className="label">Simple guide</div>
            <div className="fact">
              <b>1. Pick a source</b>
              <span className="meta">Exact wording stays with its book.</span>
            </div>
            <div className="fact">
              <b>2. Read its grade</b>
              <span className="meta">No grade is borrowed from another route.</span>
            </div>
            <div className="fact">
              <b>3. Inspect its chain</b>
              <span className="meta">Every narrator opens a profile.</span>
            </div>
          </div>
          <div className="card">
            <div className="label">Cluster context</div>
            <div className="fact">
              <span className="label">Topics</span>
              <b>{hadith.topics.join(" · ") || "Not recorded"}</b>
            </div>
            <div className="fact">
              <span className="label">Languages</span>
              <b>English · العربية</b>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
