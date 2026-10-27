/**
 * Finish scraped-inbox rows for localhost visibility:
 *  1) Ensure a chain exists; link the primary narrator when we can match one
 *  2) Verify chains only when the linked narrator already has a cited assessment
 *  3) Set variation.verified=true + hadith review_status=published (RLS live)
 *
 * Does NOT invent grades or assessments.
 *
 *   npx tsx scripts/publish-scraped-inbox.ts           # dry-run
 *   npx tsx scripts/publish-scraped-inbox.ts --apply
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hasCitedAssessmentCitation } from "../lib/first-wahi-eligibility";

const APPLY = process.argv.includes("--apply");
const INBOX_SLUGS = [
  "scraped-inbox-sunnah",
  "scraped-inbox-dorar",
  "scraped-inbox-hadeethenc",
  "combined-847",
];

type Narrator = { id: number; slug: string; name: string; arabic_name: string | null };
type Assessment = {
  narrator_id: number;
  verified: boolean;
  source_url: string | null;
  reference_book: string | null;
  page: string | null;
};

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[`'’ʿʾ]/g, "")
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, " ")
    .replace(/\b(bin|ibn|bint|al|the|ra|rnh|pbuh)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(s: string): string {
  return normName(s)
    .replace(/[^\w\u0600-\u06ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown-narrator";
}

function parseNarratorName(raw: string | null | undefined, english: string | null | undefined): string | null {
  const fromChain = (raw ?? "").trim();
  const m1 = fromChain.match(/^narrated(?:\s+by)?\s+(.+?)(?:\s*\(|:|$)/i);
  if (m1?.[1]) return m1[1].replace(/[`']/g, "'").trim();

  const en = (english ?? "").trim();
  const m2 = en.match(/^(?:narrated(?:\s+by)?|it is narrated)\s+(.+?)(?:\s*\(|:|\s+said)/i);
  if (m2?.[1]) return m2[1].replace(/[`']/g, "'").trim();

  // Arabic-only: take first "عن NAME" if short
  const arLead = fromChain.match(/^عن\s+([^\n،,]{2,60})/);
  if (arLead?.[1]) return arLead[1].trim();

  return null;
}

function buildNarratorIndex(narrators: Narrator[]) {
  const byNorm = new Map<string, Narrator>();
  for (const n of narrators) {
    const keys = [n.name, n.arabic_name, n.slug.replace(/-/g, " ")].filter(Boolean) as string[];
    for (const k of keys) {
      const nk = normName(k);
      if (nk && !byNorm.has(nk)) byNorm.set(nk, n);
    }
  }
  return byNorm;
}

function matchNarrator(name: string, index: Map<string, Narrator>, narrators: Narrator[]): Narrator | null {
  const nk = normName(name);
  if (!nk) return null;
  if (index.has(nk)) return index.get(nk)!;

  // containment: "ibn umar" inside "abdullah ibn umar"
  let best: Narrator | null = null;
  let bestScore = 0;
  for (const n of narrators) {
    const nn = normName(n.name);
    if (!nn) continue;
    if (nn.includes(nk) || nk.includes(nn)) {
      const score = Math.min(nk.length, nn.length) / Math.max(nk.length, nn.length);
      if (score > bestScore && score >= 0.55) {
        best = n;
        bestScore = score;
      }
    }
  }
  return best;
}

async function fetchAll<T>(sb: SupabaseClient, table: string, select: string): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as T[]));
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function main() {
  console.log(`\n=== Publish scraped inbox (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);
  const sb = admin();

  const { data: hadiths, error: hErr } = await sb.from("hadiths").select("id, slug, review_status").in("slug", INBOX_SLUGS);
  if (hErr) throw hErr;
  if (!hadiths?.length) {
    console.log("No scraped-inbox hadiths found.");
    return;
  }

  const narrators = await fetchAll<Narrator>(sb, "narrators", "id, slug, name, arabic_name");
  const assessments = await fetchAll<Assessment>(
    sb,
    "narrator_assessments",
    "narrator_id, verified, source_url, reference_book, page"
  );
  const citedByNarrator = new Set<number>();
  for (const a of assessments) {
    if (a.verified && hasCitedAssessmentCitation(a)) citedByNarrator.add(a.narrator_id);
  }
  const index = buildNarratorIndex(narrators);
  console.log(`Narrators loaded: ${narrators.length}; with cited verified assessments: ${citedByNarrator.size}`);

  const hadithIds = hadiths.map((h) => h.id);
  const variations: Array<{
    id: number;
    hadith_id: number;
    arabic_text: string | null;
    english_text: string | null;
    status_notes: string | null;
    verified: boolean;
  }> = [];
  for (let i = 0; i < hadithIds.length; i++) {
    const { data, error } = await sb
      .from("source_variations")
      .select("id, hadith_id, arabic_text, english_text, status_notes, verified")
      .eq("hadith_id", hadithIds[i]);
    if (error) throw error;
    variations.push(...((data ?? []) as typeof variations));
  }

  // skip ignored duplicates
  const active = variations.filter((v) => !v.status_notes?.includes("merged_duplicate_of:"));
  console.log(`Variations in inboxes: ${variations.length} (active after de-dupe tag: ${active.length})`);

  const varIds = active.map((v) => v.id);
  const chainsByVar = new Map<
    number,
    { id: number; raw_chain_text: string | null; verified: boolean }
  >();
  for (let i = 0; i < varIds.length; i += 200) {
    const chunk = varIds.slice(i, i + 200);
    const { data, error } = await sb
      .from("chains")
      .select("id, variation_id, raw_chain_text, verified")
      .in("variation_id", chunk)
      .eq("chain_number", 1);
    if (error) throw error;
    for (const c of data ?? []) {
      chainsByVar.set(c.variation_id as number, {
        id: c.id as number,
        raw_chain_text: c.raw_chain_text as string | null,
        verified: Boolean(c.verified),
      });
    }
  }

  let wouldVerifyVars = 0;
  let wouldLinkNarrator = 0;
  let wouldVerifyChain = 0;
  let contentReady = 0;
  let eligibilityReady = 0;

  type PlanItem = {
    variationId: number;
    chainId: number | null;
    rawChain: string | null;
    narratorId: number | null;
    narratorName: string | null;
    createNarrator?: { name: string; slug: string };
    verifyChain: boolean;
    verifyVariation: boolean;
  };
  const plans: PlanItem[] = [];

  for (const v of active) {
    const hasText = Boolean(v.arabic_text?.trim() || v.english_text?.trim());
    if (!hasText) continue;
    contentReady++;

    let chain = chainsByVar.get(v.id) ?? null;
    const raw = chain?.raw_chain_text ?? null;
    const parsed = parseNarratorName(raw, v.english_text);
    let narratorId: number | null = null;
    let createNarrator: PlanItem["createNarrator"];
    if (parsed) {
      const matched = matchNarrator(parsed, index, narrators);
      if (matched) {
        narratorId = matched.id;
        wouldLinkNarrator++;
      } else {
        createNarrator = { name: parsed, slug: slugify(parsed) };
        wouldLinkNarrator++;
      }
    }

    const canCite = narratorId != null && citedByNarrator.has(narratorId);
    const verifyChain = Boolean(narratorId && canCite);
    if (verifyChain) {
      wouldVerifyChain++;
      eligibilityReady++;
    }
    wouldVerifyVars++;

    plans.push({
      variationId: v.id,
      chainId: chain?.id ?? null,
      rawChain: raw || (parsed ? `Narrated ${parsed}:` : null),
      narratorId,
      narratorName: parsed,
      createNarrator,
      verifyChain,
      verifyVariation: true,
    });
  }

  console.log(`\nContent-ready (has text): ${contentReady}`);
  console.log(`Would verify variations (go live via RLS): ${wouldVerifyVars}`);
  console.log(`Would link/create primary narrator: ${wouldLinkNarrator}`);
  console.log(`Would verify chains (linked + cited assessment): ${wouldVerifyChain}`);
  console.log(`Likely pass full a–d after apply: ~${eligibilityReady} (single-node chains)`);

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to publish on localhost.");
    console.log("URLs after apply:");
    for (const h of hadiths) console.log(`  http://localhost:3001/hadiths/${h.slug}`);
    return;
  }

  // Publish parent clusters
  for (const h of hadiths) {
    const payload: Record<string, unknown> = {
      review_status: "published",
      updated_at: new Date().toISOString(),
      summary:
        "Auto-published scrape buffer for local review. Chains/narrator evidence are partial until fully curated.",
    };
    if (h.slug.startsWith("scraped-inbox-")) {
      payload.title = `Scraped collection — ${h.slug.replace("scraped-inbox-", "")}`;
    }
    await sb.from("hadiths").update(payload).eq("id", h.id);
  }

  let linked = 0;
  let chainsVerified = 0;
  let varsVerified = 0;
  let narratorsCreated = 0;

  for (const p of plans) {
    // ensure/create narrator
    let narratorId = p.narratorId;
    if (!narratorId && p.createNarrator) {
      const { data: existing } = await sb
        .from("narrators")
        .select("id")
        .eq("slug", p.createNarrator.slug)
        .maybeSingle();
      if (existing) {
        narratorId = existing.id;
      } else {
        const { data: created, error } = await sb
          .from("narrators")
          .insert({
            slug: p.createNarrator.slug,
            name: p.createNarrator.name,
            identity_status: "unverified",
            alternative_names: [],
          })
          .select("id")
          .single();
        if (error) {
          console.warn(`narrator create failed for ${p.createNarrator.name}: ${error.message}`);
        } else {
          narratorId = created.id;
          narratorsCreated++;
        }
      }
    }

    // ensure chain
    let chainId = p.chainId;
    if (!chainId) {
      const { data: ch, error } = await sb
        .from("chains")
        .upsert(
          {
            variation_id: p.variationId,
            chain_number: 1,
            raw_chain_text: p.rawChain,
            continuity_status: "unverified",
            quality_status: "unverified",
            verified: false,
            notes: "Auto from scrape publish-scraped-inbox",
          },
          { onConflict: "variation_id,chain_number" }
        )
        .select("id")
        .single();
      if (error) {
        console.warn(`chain upsert failed var=${p.variationId}: ${error.message}`);
        continue;
      }
      chainId = ch.id;
    } else if (p.rawChain) {
      await sb.from("chains").update({ raw_chain_text: p.rawChain }).eq("id", chainId);
    }

    if (narratorId && chainId) {
      const { error: cnErr } = await sb.from("chain_narrators").upsert(
        {
          chain_id: chainId,
          position: 1,
          narrator_id: narratorId,
          raw_name: p.narratorName || "Unknown",
          transmission_word: "an",
          match_confidence: p.narratorId ? 0.85 : 0.5,
        },
        { onConflict: "chain_id,position" }
      );
      if (!cnErr) linked++;
    }

    const canVerifyChain = Boolean(narratorId && citedByNarrator.has(narratorId));
    if (canVerifyChain && chainId) {
      await sb.from("chains").update({ verified: true }).eq("id", chainId);
      chainsVerified++;
    }

    await sb.from("source_variations").update({ verified: true }).eq("id", p.variationId);
    varsVerified++;
  }

  console.log("\nApplied:");
  console.log(`  hadiths published: ${hadiths.length}`);
  console.log(`  variations verified: ${varsVerified}`);
  console.log(`  narrators created: ${narratorsCreated}`);
  console.log(`  chain_narrators linked: ${linked}`);
  console.log(`  chains verified (with cited evidence): ${chainsVerified}`);
  console.log("\nOpen on localhost:");
  for (const h of hadiths) console.log(`  http://localhost:3001/hadiths/${h.slug}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
