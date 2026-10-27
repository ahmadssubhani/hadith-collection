"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CHAIN_ROLE_LABEL,
  displayOrderNodes,
  type EligibleChainView,
} from "@/lib/first-wahi-eligibility";
import { NarratorEvidencePanel, type PanelTarget } from "@/components/NarratorEvidencePanel";

export function NarratorChainStrip({
  chains,
  alwaysLabelChains = false,
}: {
  chains: EligibleChainView[];
  alwaysLabelChains?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const panelId = useId();
  const [target, setTarget] = useState<PanelTarget | null>(null);
  const lastButtonRef = useRef<HTMLElement | null>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const allNodes = chains.flatMap((chain) =>
    chain.nodes.map((node) => ({ ...node, chainId: chain.id })),
  );

  const setUrlNarrator = useCallback(
    (slug: string | null, chainId: number | null) => {
      const params = new URLSearchParams(
        typeof window !== "undefined" ? window.location.search : searchParams.toString(),
      );
      if (slug && chainId != null) {
        params.set("narrator", slug);
        params.set("chain", String(chainId));
      } else {
        params.delete("narrator");
        params.delete("chain");
      }
      const qs = params.toString();
      const href = qs ? `${pathname}?${qs}` : pathname;
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", href);
      }
      router.replace(href, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const closePanel = useCallback(() => {
    setTarget(null);
    setUrlNarrator(null, null);
  }, [setUrlNarrator]);

  const toggleNarrator = useCallback(
    (next: PanelTarget, button?: HTMLElement | null) => {
      const key = `${next.chainId}:${next.slug}`;
      const same = target && target.chainId === next.chainId && target.slug === next.slug;
      if (same) {
        lastButtonRef.current = button ?? buttonRefs.current.get(key) ?? null;
        closePanel();
        return;
      }
      lastButtonRef.current = button ?? buttonRefs.current.get(key) ?? null;
      setTarget(next);
      setUrlNarrator(next.slug, next.chainId);
    },
    [target, closePanel, setUrlNarrator],
  );

  useEffect(() => {
    const slug = searchParams.get("narrator");
    const chainParam = searchParams.get("chain");
    if (!slug) {
      setTarget(null);
      return;
    }
    const chainId = chainParam ? Number(chainParam) : NaN;
    const match = allNodes.find(
      (node) => node.slug === slug && (Number.isNaN(chainId) || node.chainId === chainId),
    );
    // Only open when this strip owns the chain; otherwise close local panel.
    if (!match) {
      setTarget(null);
      return;
    }
    setTarget({
      slug: match.slug,
      name: match.name,
      arabicName: match.arabicName,
      chainId: match.chainId,
      role: match.role,
      position: match.position,
    });
    lastButtonRef.current = buttonRefs.current.get(`${match.chainId}:${match.slug}`) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, chains]);

  if (!chains.length) {
    return <p className="meta">No complete verified chain is available for this source.</p>;
  }

  const labelChains = alwaysLabelChains || chains.length > 1;

  return (
    <div className="narrator-chain-strip">
      {chains.map((chain) => {
        const ordered = displayOrderNodes(chain.nodes);
        const panelOpenHere = Boolean(target && target.chainId === chain.id);

        return (
          <div key={chain.id} className="eligible-chain-block">
            {labelChains ? (
              <div className="chain-label">
                <div>
                  <b>Chain {chain.chainNumber}</b>
                </div>
              </div>
            ) : null}
            <div className="chain-wrap">
              <div className="chain compact chain-collector-first">
                {ordered.map((node, index) => {
                  const selected =
                    panelOpenHere && target?.slug === node.slug && target?.chainId === chain.id;
                  return (
                    <span key={node.chainNarratorId} className="chain-node-slot">
                      {index > 0 ? <span className="arrow arrow-left" aria-hidden="true" /> : null}
                      <span className={`node-with-caret${selected ? " is-selected" : ""}`}>
                        <button
                          type="button"
                          className={`node node-button narrator-node-card${selected ? " is-selected" : ""}`}
                          ref={(el) => {
                            if (el) buttonRefs.current.set(`${chain.id}:${node.slug}`, el);
                          }}
                          aria-expanded={selected}
                          aria-controls={selected ? panelId : undefined}
                          onClick={(event) =>
                            toggleNarrator(
                              {
                                slug: node.slug,
                                name: node.name,
                                arabicName: node.arabicName,
                                chainId: chain.id,
                                role: node.role,
                                position: node.position,
                              },
                              event.currentTarget,
                            )
                          }
                        >
                          <small className="node-role">{CHAIN_ROLE_LABEL[node.role]}</small>
                          {node.arabicName ? (
                            <b className="node-ar" lang="ar">
                              {node.arabicName}
                            </b>
                          ) : null}
                          <span className="node-en">{node.name}</span>
                          <small className="node-pos">Pos. {node.position}</small>
                        </button>
                        {selected ? <span className="node-panel-caret" aria-hidden="true" /> : null}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>

            {panelOpenHere ? (
              <NarratorEvidencePanel
                open
                target={target}
                onClose={closePanel}
                returnFocusRef={lastButtonRef}
                panelId={panelId}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
