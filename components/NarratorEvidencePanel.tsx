"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatAhYear, one } from "@/lib/format";
import {
  CHAIN_ROLE_LABEL,
  type ChainRole,
  type NarratorPanelEvidence,
} from "@/lib/first-wahi-eligibility";

export type PanelTarget = {
  slug: string;
  name: string;
  arabicName?: string | null;
  chainId: number;
  role: ChainRole;
  position?: number;
};

type Props = {
  open: boolean;
  target: PanelTarget | null;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  panelId: string;
};

const PREVIEW_COUNT = 3;

export function NarratorEvidencePanel({ open, target, onClose, returnFocusRef, panelId }: Props) {
  const titleId = useId();
  const extraListId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<NarratorPanelEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const wasOpenRef = useRef(false);

  const load = useCallback(async (slug: string, chainId: number) => {
    setLoading(true);
    setError(null);
    setData(null);
    setExpanded(false);
    try {
      const res = await fetch(`/api/narrators/${encodeURIComponent(slug)}/panel?chainId=${chainId}`);
      const json = (await res.json()) as { data?: NarratorPanelEvidence | null; error?: string };
      if (!res.ok || json.error) {
        setError(json.error || "Could not load narrator evidence.");
        setData(null);
      } else {
        setData(json.data ?? null);
        if (!json.data) setError("No evidence is available for this narrator.");
      }
    } catch {
      setError("Could not load narrator evidence.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !target) return;
    void load(target.slug, target.chainId);
  }, [open, target, load]);

  useEffect(() => {
    if (!open || !target) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        returnFocusRef.current?.focus();
      }
      return;
    }
    wasOpenRef.current = true;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const focusTimer = window.setTimeout(() => {
      headingRef.current?.focus();
      if (!reduced) {
        panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 0);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(focusTimer);
    };
  }, [open, target, onClose, returnFocusRef]);

  if (!open || !target) return null;

  return (
    <div
      ref={panelRef}
      id={panelId}
      className="evidence-panel-inline is-open"
      role="region"
      aria-labelledby={titleId}
    >
      <div className="evidence-panel-inline-inner">
        <div className="evidence-panel-header">
          <div>
            <div className="label">{CHAIN_ROLE_LABEL[target.role]}</div>
            <h2
              ref={headingRef}
              id={titleId}
              className="title evidence-panel-heading"
              tabIndex={-1}
              style={{ fontSize: 22, margin: 0 }}
            >
              {target.arabicName || target.name}
            </h2>
          </div>
          <button type="button" className="evidence-panel-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="evidence-panel-body">
          {loading ? <p className="meta">Loading narrator evidence…</p> : null}
          {!loading && error ? <p className="notice">{error}</p> : null}
          {!loading && !error && data ? (
            <PanelContent
              data={data}
              role={target.role}
              expanded={expanded}
              onToggleExpanded={() => setExpanded((v) => !v)}
              extraListId={extraListId}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PanelContent({
  data,
  role,
  expanded,
  onToggleExpanded,
  extraListId,
}: {
  data: NarratorPanelEvidence;
  role: ChainRole;
  expanded: boolean;
  onToggleExpanded: () => void;
  extraListId: string;
}) {
  const { narrator, assessments, citedCount } = data;

  // Stable source/DB order by id — never by sentiment or score.
  const ordered = [...assessments].sort((a, b) => a.id - b.id);
  const total = ordered.length;
  const showToggle = total > PREVIEW_COUNT;
  const head = showToggle ? ordered.slice(0, PREVIEW_COUNT) : ordered;
  const rest = showToggle ? ordered.slice(PREVIEW_COUNT) : [];
  const remaining = rest.length;

  const scholarNames: string[] = [];
  const seenScholars = new Set<string>();
  for (const row of ordered) {
    const scholar = one(row.scholars);
    const label = (scholar?.arabic_name || scholar?.name || "").trim();
    if (!label || seenScholars.has(label)) continue;
    seenScholars.add(label);
    scholarNames.push(label);
  }
  const scholarCount = scholarNames.length;

  const arabicName = narrator.arabic_name?.trim() || null;
  const englishName = narrator.name?.trim() || null;
  const identityBits = [
    narrator.generation?.trim() || null,
    narrator.death_year_ah != null ? formatAhYear(narrator.death_year_ah) : null,
    narrator.region?.trim() || null,
  ].filter(Boolean) as string[];

  return (
    <>
      <div className="score-card evidence-panel-summary">
        {arabicName ? (
          <h3 className="evidence-rawi-ar" lang="ar">
            {arabicName}
          </h3>
        ) : null}
        {englishName && englishName !== arabicName ? (
          <p className="evidence-rawi-en">{englishName}</p>
        ) : null}
        <div className="meta" style={{ color: "#ffffffb8", marginTop: 8 }}>
          {CHAIN_ROLE_LABEL[role]}
        </div>
        {identityBits.length ? (
          <p className="meta" style={{ color: "#ffffffb8", marginTop: 6 }}>
            {identityBits.join(" · ")}
          </p>
        ) : null}
        <p className="evidence-count-line" style={{ color: "#fff", marginTop: 16, fontSize: 16 }}>
          {citedCount} cited assessment{citedCount === 1 ? "" : "s"} from {scholarCount} scholar
          {scholarCount === 1 ? "" : "s"}
        </p>
        {scholarNames.length ? (
          <div className="evidence-scholar-chips" aria-label="Scholars who assessed this narrator">
            {scholarNames.map((name) => (
              <span className="evidence-scholar-chip" key={name} lang="ar">
                {name}
              </span>
            ))}
          </div>
        ) : null}
        <p className="score-note" style={{ color: "#ffffffc8", marginTop: 14 }}>
          Scholars&apos; own wording is listed below. No score is computed.
        </p>
      </div>

      <div className="section-head" style={{ marginTop: 8 }}>
        <div>
          <div className="eyebrow">Rijal analysis</div>
          <h3 className="title" style={{ fontSize: 18 }}>
            What individual scholars said
          </h3>
        </div>
      </div>

      {total ? (
        <div className="assessment-list-block" style={{ marginBottom: 20 }}>
          {showToggle ? (
            <p className="meta assessment-order-note">
              Showing {expanded ? total : PREVIEW_COUNT} of {total}, in the order given by the source.
            </p>
          ) : null}
          <div className="card assessment-card">
            {head.map((assessment) => (
              <AssessmentRow key={assessment.id} assessment={assessment} />
            ))}
            {showToggle ? (
              <div id={extraListId} hidden={!expanded}>
                {rest.map((assessment) => (
                  <AssessmentRow key={assessment.id} assessment={assessment} />
                ))}
              </div>
            ) : null}
          </div>
          {showToggle ? (
            <button
              type="button"
              className="see-more-assessments"
              aria-expanded={expanded}
              aria-controls={extraListId}
              onClick={onToggleExpanded}
            >
              {expanded
                ? "Show fewer"
                : `See ${remaining} more assessment${remaining === 1 ? "" : "s"}`}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="notice">No verified cited assessments are attached to this narrator.</p>
      )}
    </>
  );
}

function AssessmentRow({ assessment }: { assessment: NarratorPanelEvidence["assessments"][number] }) {
  const scholar = one(assessment.scholars);
  const arabicScholar = scholar?.arabic_name?.trim() || null;
  const englishScholar = scholar?.name?.trim() || null;
  const book = assessment.reference_book?.trim() || "";
  return (
    <div className="assessment-row">
      <div>
        <span className="label assessment-scholar-heading">
          {arabicScholar ? <span lang="ar">{arabicScholar}</span> : null}
          {arabicScholar && englishScholar && englishScholar !== arabicScholar ? " · " : null}
          {englishScholar && englishScholar !== arabicScholar ? <span>{englishScholar}</span> : null}
          {!arabicScholar && !englishScholar ? "Unattributed scholar" : null}
        </span>
        <b style={{ display: "block" }} lang="ar">
          {assessment.original_term}
        </b>
        {book ? (
          <div className="meta assessment-row-cite" style={{ marginTop: 4 }}>
            {book}
          </div>
        ) : null}
      </div>
    </div>
  );
}
