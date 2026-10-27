/**
 * Map Sahih al-Bukhari variations 1,2,4,5,6,7 to Sunnah.com narrator IDs.
 * Fetches https://sunnah.com/bukhari:N (cached), matches /narrator/<id> links
 * to chain_narrators by position. Does NOT write appraisals or change the DB.
 *
 * Usage: npx tsx scripts/map-bukhari-sunnah-isnads.ts
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as cheerio from "cheerio";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const USER_AGENT =
  "HadithCollectionResearchBot/1.0 (+local dry-run; maps Bukhari isnads to /narrator IDs; no write)";
const REQUEST_GAP_MS = 2000;
const RAW_DIR = path.join(process.cwd(), "data", "raw");

/** variation_id → Bukhari hadith number on sunnah.com */
const VARIATIONS: Array<{ variationId: number; bukhariN: number; label: string }> = [
  { variationId: 271, bukhariN: 1, label: "Sahih al-Bukhari #1" },
  { variationId: 273, bukhariN: 2, label: "Sahih al-Bukhari #2" },
  { variationId: 276, bukhariN: 4, label: "Sahih al-Bukhari #4" },
  { variationId: 279, bukhariN: 5, label: "Sahih al-Bukhari #5" },
  { variationId: 280, bukhariN: 6, label: "Sahih al-Bukhari #6" },
  { variationId: 282, bukhariN: 7, label: "Sahih al-Bukhari #7" },
];

const NEED_ASSESSMENTS = new Set([
  954, 955, 956, 957, 958, 959, // #1
  960, 961, 962, // #2
  969, 970, // #4
  971, 972, 973, 974, 975, // #5 (+975 in #7)
  976, 977, 978, 979, // #6
  980, 981, 982, 983, // #7
]);

type SunnahLink = {
  sunnahId: string;
  linkText: string;
  titleName: string;
};

type DbNode = {
  chainNarratorId: number;
  chainId: number;
  chainNumber: number;
  position: number;
  narratorId: number | null;
  rawName: string;
  arabicName: string | null;
  slug: string | null;
};

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function hadithCachePath(n: number) {
  return path.join(RAW_DIR, `sunnah-bukhari-${n}.html`);
}

async function loadHadithHtml(bukhariN: number): Promise<string> {
  const file = hadithCachePath(bukhariN);
  if (existsSync(file) && readFileSync(file, "utf8").length > 1000) {
    console.log(`  cache hit  ${file}`);
    return readFileSync(file, "utf8");
  }
  const url = `https://sunnah.com/bukhari:${bukhariN}`;
  console.log(`  fetching   ${url}`);
  mkdirSync(RAW_DIR, { recursive: true });
  await execFileAsync(
    "curl.exe",
    ["-sS", "-L", "-A", USER_AGENT, "-H", "Accept: text/html", "-o", file, url],
    { timeout: 60000 },
  );
  if (!existsSync(file) || readFileSync(file, "utf8").length < 500) {
    throw new Error(`Empty download for ${url}`);
  }
  await delay(REQUEST_GAP_MS);
  return readFileSync(file, "utf8");
}

function parseHrefTitle(href: string, text: string, title: string): SunnahLink | null {
  const m = href.match(/\/narrator\/(\d+)/);
  if (!m) return null;
  return {
    sunnahId: m[1],
    linkText: normalizeWs(text),
    titleName: normalizeWs(title),
  };
}

function linksFromHtmlChunk(chunkHtml: string): SunnahLink[] {
  const $ = cheerio.load(`<div id="root">${chunkHtml}</div>`);
  const links: SunnahLink[] = [];
  $("#root a[href*='/narrator/']").each((_, el) => {
    const parsed = parseHrefTitle($(el).attr("href") ?? "", $(el).text(), $(el).attr("title") ?? "");
    if (parsed) links.push(parsed);
  });
  return links;
}

function stripHarakat(s: string): string {
  return s.normalize("NFD").replace(/[\u064B-\u065F\u0670]/g, "");
}

/**
 * When a branch has peers joined by "و" (e.g. يونس ومعمر عن الزهري),
 * expand into two linear chains sharing prefix/suffix.
 * Sunnah often puts the و inside the second link text: وَمَعْمَرٌ
 */
function expandWawPeers(links: SunnahLink[]): SunnahLink[][] {
  if (links.length < 3) return [links];
  const peerIdxs: number[] = [];
  links.forEach((l, idx) => {
    const t = stripHarakat(l.linkText).replace(/\s+/g, "");
    if (/^و/.test(t) && idx > 0) peerIdxs.push(idx);
  });
  if (!peerIdxs.length) return [links];

  const forkAt = peerIdxs[0];
  const peerPrev = forkAt - 1;
  if (peerPrev < 0 || forkAt >= links.length) return [links];

  const suffixStart = forkAt + 1;
  const prefix = links.slice(0, peerPrev);
  const peers = [links[peerPrev], links[forkAt]].map((p) => ({
    ...p,
    // Strip leading و from display text for the peer link
    linkText: stripHarakat(p.linkText).replace(/^\s*و\s*/, "").trim() || p.linkText,
  }));
  const suffix = links.slice(suffixStart);
  return peers.map((peer) => [...prefix, peer, ...suffix]);
}

/**
 * Truncate a tahwil branch before matn-continuation "نحوه" only.
 * Do NOT cut on ordinary "قال أخبرني" — that is real isnad wording.
 */
function truncateBranchAtNahwahu(inner: string): string {
  const plain = stripHarakat(inner);
  const idx = plain.indexOf("نحوه");
  if (idx <= 0) return inner;
  let strippedLen = 0;
  for (let i = 0; i < inner.length; i++) {
    if (!/[\u064B-\u065F\u0670]/.test(inner[i])) strippedLen += 1;
    if (strippedLen >= idx) return inner.slice(0, i);
  }
  return inner;
}

/**
 * Extract ordered narrator links from arabic_sanad.
 * Splits on tahwil "ح"; trims متابعات / نحوه; expands وَ peers.
 */
function extractSunnahLinks(html: string): {
  all: SunnahLink[];
  branches: SunnahLink[][];
} {
  const $ = cheerio.load(html);
  const sanad = $("span.arabic_sanad, .arabic_sanad").first();
  let inner = sanad.html() ?? "";

  // Trim متابعات (تابعه…) at top level; per-branch نحوه handled in the loop
  {
    const plain = stripHarakat(inner);
    const idx = plain.indexOf("تابعه");
    if (idx > 0) {
      let strippedLen = 0;
      for (let i = 0; i < inner.length; i++) {
        if (!/[\u064B-\u065F\u0670]/.test(inner[i])) strippedLen += 1;
        if (strippedLen >= idx) {
          inner = inner.slice(0, i);
          break;
        }
      }
    }
  }

  const all = linksFromHtmlChunk(inner);
  const branchHtmls = inner.split(/\sح\s+/);
  const branches: SunnahLink[][] = [];
  for (const chunk of branchHtmls) {
    // Stop before matn continuation "نحوه…" inside a tahwil branch (Bukhari 6)
    const trimmed = truncateBranchAtNahwahu(chunk);
    const rawLinks = linksFromHtmlChunk(trimmed);
    const expanded = expandWawPeers(rawLinks);
    for (const b of expanded) {
      if (b.length) branches.push(b);
    }
  }
  if (!branches.length) return { all, branches: [all] };
  return { all, branches };
}
/**
 * For unresolved text nodes: scan arabic_sanad for bare text segments
 * between links that might correspond to unlinked names. Returns whether
 * a given DB raw_name appears as an <a> link; if not, whether any nearby
 * text matches without a link.
 */
function findUnlinkedMentions(html: string, rawName: string): { linked: boolean; note: string } {
  const $ = cheerio.load(html);
  const sanad = $("span.arabic_sanad, .arabic_sanad").first();
  const htmlInner = sanad.html() ?? "";
  // Strip diacritics lightly for containment checks
  const strip = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u064B-\u065F\u0670]/g, "")
      .replace(/\s+/g, "");
  const target = strip(rawName);
  let linked = false;
  sanad.find('a[href*="/narrator/"]').each((_, el) => {
    if (strip($(el).text()).includes(target) || target.includes(strip($(el).text()))) {
      linked = true;
    }
  });
  if (linked) return { linked: true, note: "appears inside a /narrator/ link" };
  const plain = strip(sanad.text());
  if (target && plain.includes(target)) {
    return { linked: false, note: "appears as plain text in isnad — no /narrator/ link" };
  }
  // Specific patterns
  if (/أبيه|ابيه/.test(rawName) || /أبيه|ابيه/.test(sanad.text())) {
    const hasFatherLink = sanad.find('a[href*="/narrator/"]').toArray().some((el) => {
      const t = $(el).text() + ($(el).attr("title") ?? "");
      return /أب|ابي|ابيه|أبيه/.test(t);
    });
    if (!hasFatherLink && /عن\s*أبيه|عن أبيه/.test(sanad.text())) {
      return { linked: false, note: `"عن أبيه" present as unlinked text in isnad` };
    }
  }
  if (/عبد\s*الل/.test(rawName)) {
    return {
      linked: false,
      note: htmlInner.includes(rawName) || plain.includes(strip(rawName))
        ? "عبد الله segment not wrapped in /narrator/ link (or only partial)"
        : "no matching unlinked عبد الله text found next to this slot",
    };
  }
  return { linked: false, note: "no /narrator/ link for this raw_name on the hadith page" };
}

async function loadDbNodes(supabase: SupabaseClient, variationId: number): Promise<DbNode[]> {
  const { data: chains, error } = await supabase
    .from("chains")
    .select(
      "id, chain_number, chain_narrators(id, position, narrator_id, raw_name, narrators(id, slug, name, arabic_name))",
    )
    .eq("variation_id", variationId)
    .order("chain_number");
  if (error) throw new Error(error.message);
  const nodes: DbNode[] = [];
  for (const chain of chains ?? []) {
    const cns = [...((chain as { chain_narrators?: Array<Record<string, unknown>> }).chain_narrators ?? [])].sort(
      (a, b) => Number(a.position) - Number(b.position),
    );
    for (const n of cns) {
      const narr = Array.isArray(n.narrators) ? n.narrators[0] : n.narrators;
      const narrObj = narr as { id?: number; slug?: string; name?: string; arabic_name?: string | null } | null;
      nodes.push({
        chainNarratorId: Number(n.id),
        chainId: Number((chain as { id: number }).id),
        chainNumber: Number((chain as { chain_number: number }).chain_number),
        position: Number(n.position),
        narratorId: n.narrator_id == null ? null : Number(n.narrator_id),
        rawName: String(n.raw_name ?? ""),
        arabicName: narrObj?.arabic_name ?? narrObj?.name ?? null,
        slug: narrObj?.slug ?? null,
      });
    }
  }
  return nodes;
}

type MappingRow = {
  variationId: number;
  bukhariN: number;
  chainNumber: number;
  position: number;
  chainNarratorId: number;
  narratorId: number | null;
  dbArabicName: string;
  rawName: string;
  sunnahId: string | null;
  sunnahPageName: string | null;
  sunnahLinkText: string | null;
  needsAssessment: boolean;
  unresolved: boolean;
  proposeUpdate: string | null;
  note: string;
};

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  console.log("Sunnah.com ↔ Bukhari chain mapping (read-only)\n");
  console.log("robots.txt: /narrator and /bukhari allowed (Disallow only /selectiondata/*).\n");

  const supabase = adminClient();
  const allRows: MappingRow[] = [];
  const proposedUpdates: string[] = [];
  const uniqueSunnahIds = new Set<string>();

  for (const v of VARIATIONS) {
    console.log(`\n=== ${v.label} (variation_id=${v.variationId}) ===`);
    const html = await loadHadithHtml(v.bukhariN);
    const { all: allLinks, branches } = extractSunnahLinks(html);
    const dbNodes = await loadDbNodes(supabase, v.variationId);

    console.log(`  Sunnah /narrator/ links in arabic_sanad (main): ${allLinks.length}`);
    console.log(`  Sunnah branches after ح / وَ expand: ${branches.length}`);
    branches.forEach((b, i) => {
      console.log(
        `    branch ${i + 1}: ${b.map((l) => `${l.sunnahId}:${l.titleName || l.linkText}`).join(" → ")}`,
      );
    });
    console.log(`  DB chain_narrators rows: ${dbNodes.length}`);

    const byChain = new Map<number, DbNode[]>();
    for (const n of dbNodes) {
      const list = byChain.get(n.chainNumber) ?? [];
      list.push(n);
      byChain.set(n.chainNumber, list);
    }

    const chainNumbers = [...byChain.keys()].sort((a, b) => a - b);

    // Zip each DB chain to the matching Sunnah branch by chain order.
    // Single-chain variations use branches[0] (already trimmed of متابعات).
    for (const chainNum of chainNumbers) {
      const nodes = byChain.get(chainNum)!;
      const branchIdx = chainNumbers.indexOf(chainNum);
      const branchLinks = branches[branchIdx] ?? (chainNumbers.length === 1 ? allLinks : []);

      console.log(`\n  --- Chain ${chainNum} (↔ Sunnah branch ${branchIdx + 1}) ---`);
      console.log(
        "  pos | cn_id | narrator_id | DB arabic / raw | Sunnah ID | Sunnah name | note",
      );
      console.log("  " + "-".repeat(100));

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        // Position-based zip within this chain ↔ this branch only (no name guessing).
        const link: SunnahLink | null = branchLinks[i] ?? null;

        const unresolved = node.narratorId == null;
        let proposeUpdate: string | null = null;
        let note = "";

        if (unresolved) {
          if (link) {
            note = `UNRESOLVED but Sunnah links to /narrator/${link.sunnahId} (${link.titleName || link.linkText})`;
            proposeUpdate = `-- PROPOSED (needs narrator_id for sunnah ${link.sunnahId}): UPDATE chain_narrators SET narrator_id = <id for sunnah ${link.sunnahId}> WHERE id = ${node.chainNarratorId}; -- was NULL, raw_name=${JSON.stringify(node.rawName)}`;
          } else {
            const mention = findUnlinkedMentions(html, node.rawName);
            note = `UNRESOLVED; ${mention.note}. Leave narrator_id NULL.`;
          }
        } else if (!link) {
          note = "no Sunnah link at this position index in this branch";
        } else {
          note = NEED_ASSESSMENTS.has(node.narratorId!)
            ? "needs appraisals"
            : "already had appraisals or outside target set";
        }

        const sunnahName = link ? link.titleName || link.linkText : null;
        if (link) uniqueSunnahIds.add(link.sunnahId);

        const row: MappingRow = {
          variationId: v.variationId,
          bukhariN: v.bukhariN,
          chainNumber: chainNum,
          position: node.position,
          chainNarratorId: node.chainNarratorId,
          narratorId: node.narratorId,
          dbArabicName: node.arabicName ?? "",
          rawName: node.rawName,
          sunnahId: link?.sunnahId ?? null,
          sunnahPageName: sunnahName,
          sunnahLinkText: link?.linkText ?? null,
          needsAssessment: node.narratorId != null && NEED_ASSESSMENTS.has(node.narratorId),
          unresolved,
          proposeUpdate,
          note,
        };
        allRows.push(row);
        if (proposeUpdate) proposedUpdates.push(proposeUpdate);

        const idCol = node.narratorId == null ? "NULL" : String(node.narratorId);
        const dbName = (node.arabicName || node.rawName || "").slice(0, 40);
        const sid = link?.sunnahId ?? "—";
        const sname = (sunnahName ?? "—").slice(0, 35);
        console.log(
          `  ${String(node.position).padStart(3)} | ${String(node.chainNarratorId).padStart(5)} | ${idCol.padStart(11)} | ${dbName.padEnd(40)} | ${sid.padStart(7)} | ${sname.padEnd(35)} | ${note}`,
        );
      }

      if (nodes.length !== branchLinks.length) {
        console.log(
          `  WARNING: branch link count (${branchLinks.length}) ≠ DB node count (${nodes.length})`,
        );
      }
    }
  }

  // Resolve proposed UPDATEs: same sunnah id on a resolved node in this batch,
  // or an existing narrators row / prior sunnah_com_import assessment.
  const sunnahToNarratorId = new Map<string, number>();
  for (const r of allRows) {
    if (r.sunnahId && r.narratorId != null) {
      sunnahToNarratorId.set(r.sunnahId, r.narratorId);
    }
  }

  const unresolvedSunnahIds = [
    ...new Set(allRows.filter((r) => r.unresolved && r.sunnahId).map((r) => r.sunnahId!)),
  ];
  for (const sid of unresolvedSunnahIds) {
    if (sunnahToNarratorId.has(sid)) continue;
    const { data: assess } = await supabase
      .from("narrator_assessments")
      .select("narrator_id, source_url")
      .eq("mapping_method", "sunnah_com_import")
      .like("source_url", `%/narrator/${sid}%`)
      .limit(1);
    if (assess?.[0]?.narrator_id != null) {
      sunnahToNarratorId.set(sid, Number(assess[0].narrator_id));
      const { data: narr } = await supabase
        .from("narrators")
        .select("id, arabic_name")
        .eq("id", assess[0].narrator_id)
        .maybeSingle();
      console.log(
        `  resolved sunnah/${sid} → narrators.id=${assess[0].narrator_id} (${narr?.arabic_name ?? ""}) via prior sunnah_com_import`,
      );
      continue;
    }
    // No prior import: look up by exact arabic page title against narrators.arabic_name / name
    // Only when Sunnah linked the node — still requires your approval (not auto-applied).
    const row = allRows.find((r) => r.sunnahId === sid && r.sunnahPageName);
    if (row?.sunnahPageName) {
      const pageName = row.sunnahPageName;
      const { data: byName } = await supabase
        .from("narrators")
        .select("id, arabic_name, name, slug")
        .or(`slug.ilike.%mubarak%,name.ilike.%mubarak%,arabic_name.ilike.%مبارك%`)
        .limit(10);
      // Prefer slug/name that clearly matches ابن المبارك when page title contains it
      if (/مبارك|mubarak/i.test(pageName) || /مبارك|mubarak/i.test(stripHarakat(pageName))) {
        const hit = (byName ?? []).find(
          (n) =>
            /mubarak/i.test(n.slug ?? "") ||
            /mubarak/i.test(n.name ?? "") ||
            /مبارك/.test(n.arabic_name ?? ""),
        );
        if (hit) {
          sunnahToNarratorId.set(sid, Number(hit.id));
          console.log(
            `  candidate sunnah/${sid} (${pageName}) → narrators.id=${hit.id} (${hit.arabic_name || hit.name}) — existing row matching linked Sunnah page identity; NEEDS YOUR APPROVAL`,
          );
        }
      }
    }
  }

  console.log("\n\n========== UNRESOLVED NODE PROPOSALS ==========");
  const unresolvedRows = allRows.filter((r) => r.unresolved);
  if (!unresolvedRows.length) {
    console.log("None.");
  } else {
    for (const r of unresolvedRows) {
      console.log(
        `\nBukhari ${r.bukhariN} chain ${r.chainNumber} pos ${r.position} cn_id=${r.chainNarratorId} raw=${r.rawName}`,
      );
      console.log(`  ${r.note}`);
      if (r.sunnahId) {
        const known = sunnahToNarratorId.get(r.sunnahId);
        if (known != null) {
          const sql = `UPDATE chain_narrators SET narrator_id = ${known} WHERE id = ${r.chainNarratorId} AND narrator_id IS NULL; -- sunnah ${r.sunnahId} (${r.sunnahPageName})`;
          console.log(`  PROPOSED SQL:\n  ${sql}`);
          r.proposeUpdate = sql;
        } else {
          console.log(
            `  PROPOSED: Sunnah links /narrator/${r.sunnahId}, but no existing narrator_id maps to that Sunnah ID yet.`,
          );
          console.log(
            `  Do NOT invent a narrator. After you confirm, we can link to an existing narrators row or create one explicitly.`,
          );
          console.log(
            `  Placeholder SQL:\n  UPDATE chain_narrators SET narrator_id = <existing_narrators.id for sunnah ${r.sunnahId}> WHERE id = ${r.chainNarratorId} AND narrator_id IS NULL;`,
          );
        }
      } else {
        console.log("  Leave narrator_id NULL — no /narrator/ link on the hadith page for this node.");
      }
    }
  }

  // Unique narrators needing import
  const toImport = new Map<string, { sunnahId: string; narratorIds: Set<number>; name: string }>();
  for (const r of allRows) {
    if (!r.sunnahId || r.narratorId == null || !r.needsAssessment) continue;
    const cur = toImport.get(r.sunnahId) ?? {
      sunnahId: r.sunnahId,
      narratorIds: new Set<number>(),
      name: r.sunnahPageName || r.dbArabicName,
    };
    cur.narratorIds.add(r.narratorId);
    toImport.set(r.sunnahId, cur);
  }

  console.log("\n\n========== NARRATORS TO IMPORT (after approval) ==========");
  console.log(`Unique Sunnah narrator pages to fetch: ${toImport.size}`);
  for (const [sid, info] of [...toImport.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(
      `  sunnah/${sid}  ${info.name}  → DB narrator_id(s): ${[...info.narratorIds].join(", ")}`,
    );
  }

  // Save mapping JSON for the apply step after approval
  const outPath = path.join(process.cwd(), "data", "bukhari-batch2-mapping.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        variations: VARIATIONS,
        rows: allRows,
        toImport: [...toImport.entries()].map(([sunnahId, info]) => ({
          sunnahId,
          name: info.name,
          narratorIds: [...info.narratorIds],
        })),
        proposedUpdates: unresolvedRows.map((r) => ({
          chainNarratorId: r.chainNarratorId,
          rawName: r.rawName,
          sunnahId: r.sunnahId,
          proposeUpdate: r.proposeUpdate,
          note: r.note,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nMapping written to ${outPath}`);
  console.log("\nSTOPPED for your approval. No appraisals imported. No DB writes.");
  console.log("Reply to approve the mapping (and any UPDATE statements) before import.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
