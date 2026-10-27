/**
 * Repair chain_narrators for the 7 Sahih al-Bukhari First-Wahi variations.
 * Default: dry-run only. Pass --apply to write chains/nodes/narrators.
 * Does not touch assessments.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeArabic } from "../lib/normalization";

const VARIATION_IDS = [271, 273, 275, 276, 279, 280, 282];
const MAX_NAME_CHARS = 60;

/** Optional Arabic diacritics allowed inside separators (e.g. وَحَدَّثَنَا). */
const SEP = String.raw`(?:^|[و\s،,.:؛\u064B-\u065F]+)`;
const TRANSMISSION_SPLIT = new RegExp(
  `${SEP}(?:حَدَّثَنَا|حَدَّثَنِي|أَخْبَرَنَا|أَخْبَرَنِي|حَدَّثَنَاهُ|أَنْبَأَنَا|أَنْبَأَنِي|سَمِعْتُ|سَمِعَ|حدثنا|حدثني|أخبرنا|أخبرني|سمعت|سمع|عَنِ|عَنْ(?!ه)|عن(?![ههاهم])|أَنَّ(?!ه))(?=[\\s\\u0600-\\u06FF])`,
  "g",
);

/** End of isnad / start of matn (or narrative body). */
const MATN_CUT =
  /(?:أَنَّهَا\s+قَالَتْ|أَنَّهُ\s+قَالَ|أَنَّ\s+رَسُولَ|أَنَّ\s+النَّبِيَّ|سَمِعْتُ\s+رَسُولَ|قَالَ\s*:\s*سَمِعْتُ\s+رَسُولَ|قَالَ\s+رَسُولُ|قَالَ\s+النَّبِيُّ|قَالَتْ\s+عَائِشَة|قَالَ\s+كَانَ|فِي\s+قَوْلِهِ|نَحْوَهُ\s+قَالَ|أَنَّ\s+هِرَقْلَ|أَنَّ\s+الْحَارِثَ|وَهُوَ\s+يُحَدِّثُ\s+عَنْ|فِي\s+حَدِيثِهِ|عَلَى\s+الْمِنْبَرِ)/;

const HA_SEPARATOR = /(?:^|[\s،,])ح(?:\s+|$)/;

/** Bukhari 4 continues Bukhari 3's Zuhri path (قال ابن شهاب وأخبرني…). */
const CONTINUATION: Record<string, { ofHadith: string; ofVariationId: number }> = {
  "4": { ofHadith: "3", ofVariationId: 275 },
};

/**
 * Known same-person aliases (normalized Arabic → canonical identity key / slug).
 * ابن شهاب and الزهري are one person.
 */
const IDENTITY_ALIASES: Array<{ patterns: RegExp[]; key: string; display: string }> = [
  {
    key: "ibn-shihab-al-zuhri",
    display: "ابن شهاب الزهري",
    patterns: [/^ابن شهاب$/, /^الزهري$/, /^ابن شهاب الزهري$/, /^محمد بن مسلم الزهري$/],
  },
  {
    key: "aisha-umm-al-muminin",
    display: "عائشة أم المؤمنين",
    patterns: [/^عايشه/, /^عائشه/],
  },
  {
    key: "urwah-ibn-al-zubayr",
    display: "عروة بن الزبير",
    patterns: [/^عروه بن الزبير$/],
  },
  {
    key: "uqayl-ibn-khalid",
    display: "عقيل",
    patterns: [/^عقيل$/, /^عقيل بن خالد$/],
  },
  {
    key: "al-layth-ibn-sad",
    display: "الليث",
    patterns: [/^الليث$/, /^الليث بن سعد$/],
  },
  {
    key: "yahya-ibn-bukayr",
    display: "يحيى بن بكير",
    patterns: [/^يحيى بن بكير$/, /^يحيى بن عبد الله بن بكير$/],
  },
  {
    key: "yunus-ibn-yazid",
    display: "يونس",
    patterns: [/^يونس$/, /^يونس بن يزيد$/],
  },
  {
    key: "mammar-ibn-rashid",
    display: "معمر",
    patterns: [/^معمر$/, /^معمر بن راشد$/],
  },
  {
    key: "abdullah-ibn-abbas",
    display: "عبد الله بن عباس",
    patterns: [/^عبد الله بن عباس$/, /^ابن عباس$/],
  },
  {
    key: "jabir-ibn-abdullah",
    display: "جابر بن عبد الله الأنصاري",
    patterns: [/^جابر بن عبد الله/, /^جابر بن عبدالله/],
  },
  {
    key: "abu-salama-ibn-abd-al-rahman",
    display: "أبو سلمة بن عبد الرحمن",
    patterns: [/^ابو سلمه بن عبد الرحمن$/],
  },
];

/** Bare / relational forms that must stay unresolved (no narrator_id). */
function isUnresolvedBare(normalized: string): boolean {
  if (normalized === "ابيه" || normalized === "ابيها" || normalized === "ابوه") return true;
  // Bare "عبد الله" with no further qualification
  if (normalized === "عبد الله" || normalized === "عبدالله") return true;
  return false;
}

function resolveIdentity(rawName: string): { key: string | null; slug: string | null; note: string | null } {
  const n = normalizeArabic(rawName);
  if (isUnresolvedBare(n)) {
    return {
      key: null,
      slug: null,
      note: "Unresolved bare/relational name — left without narrator_id (no guessing)",
    };
  }
  for (const alias of IDENTITY_ALIASES) {
    if (alias.patterns.some((re) => re.test(n))) {
      return {
        key: alias.key,
        slug: alias.key,
        note: `Canonical identity ${alias.key} (aliases merged, e.g. ابن شهاب ↔ الزهري)`,
      };
    }
  }
  const slug = slugifyArabic(rawName);
  return { key: `person:${slug}`, slug, note: null };
}

type NarratorRow = {
  id: number;
  slug: string;
  name: string;
  arabic_name: string | null;
  alternative_names: string[] | null;
};

type ParsedNode = {
  position: number;
  raw_name: string;
  transmission_word: string | null;
  normalized: string;
  /** Stable key for one person across chains; null = leave narrator_id unresolved. */
  identity_key: string | null;
  match: "exact" | "create" | "ambiguous" | "unresolved" | "reject";
  narrator_id: number | null;
  narrator_slug: string | null;
  note: string | null;
  parallel_with?: string[];
  candidates?: Array<{ id: number; slug: string; name: string }>;
};

type ParsedChain = {
  chain_number: number;
  raw_chain_text: string;
  nodes: ParsedNode[];
  notes: string | null;
  /** Parallel tahwil siblings share the same group id. */
  parallel_group: string | null;
};

type VariationPlan = {
  variation_id: number;
  hadith_number: string;
  source_url: string | null;
  arabic_source: "variation.arabic_text" | "local_bukhari.json";
  arabic_len: number;
  chains: ParsedChain[];
  existing_chain_ids: number[];
  continuation_of_variation_id: number | null;
  continuation_of_hadith_number: string | null;
};

function getClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function loadLocalArabicByHadithNumber(): Map<string, string> {
  const candidates = [
    path.join(process.env.USERPROFILE || "", "Downloads", "bukhari.json"),
    path.join(process.cwd(), "bukhari.json"),
  ];
  const map = new Map<string, string>();
  for (const file of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const raw = require("fs").readFileSync(file, "utf8");
      const data = JSON.parse(raw);
      const hadiths = Array.isArray(data.hadiths) ? data.hadiths : [];
      for (const h of hadiths) {
        if (h?.id != null && typeof h.arabic === "string") {
          map.set(String(h.id), h.arabic);
        }
      }
      if (map.size) {
        console.log(`[source] Loaded ${map.size} Arabic texts from ${file}`);
        return map;
      }
    } catch {
      // try next
    }
  }
  console.warn("[source] Local bukhari.json not found; using variation.arabic_text only");
  return map;
}

function stripHonorifics(text: string): string {
  return text
    .replace(/رَضِيَ\s*اللَّهُ\s*عَنْ[^\s،,]*/g, " ")
    .replace(/رضى\s*الله\s*عن[^\s،,]*/gi, " ")
    .replace(/رضي\s*الله\s*عن[^\s،,]*/gi, " ")
    .replace(/صَلَّى\s*اللَّهُ\s*عَلَيْهِ\s*وَسَلَّمَ/g, " ")
    .replace(/صلى\s*الله\s*عليه\s*وسلم/g, " ")
    .replace(/عَلَيْهِ\s*السَّلَامُ/g, " ")
    .replace(/ـ+/g, " ")
    .replace(/[‏‎]/g, "")
    .replace(/["«»]/g, " ")
    .trim();
}

function extractIsnad(arabic: string): string {
  // Strip honorifics first so "عنه/عنها" cannot be mistaken for transmission "عن"
  const cleaned = stripHonorifics(arabic.replace(/\s+/g, " ").trim());
  const cut = cleaned.match(MATN_CUT);
  if (cut?.index != null && cut.index > 10) {
    return cleaned.slice(0, cut.index).trim();
  }
  const soft = cleaned.search(/أَوَّلُ\s+مَا|بَيْنَا\s+أَنَا|كَانَ\s+رَسُولُ/);
  if (soft > 10) return cleaned.slice(0, soft).trim();
  return cleaned.slice(0, Math.min(280, cleaned.length)).trim();
}

/** Handle openings like "قال ابن شهاب وأخبرني ..." */
function prependLeadingSaidName(isnad: string): { prefixName: string | null; rest: string } {
  const m = isnad.match(/^قَالَ\s+(.+?)(?=\s+وَ?(?:أَخْبَرَ|حَدَّثَ|عَن))/);
  if (!m) return { prefixName: null, rest: isnad };
  const name = cleanName(m[1]);
  if (!name || name.length > MAX_NAME_CHARS) return { prefixName: null, rest: isnad };
  return {
    prefixName: name,
    rest: isnad.slice(m[0].length).trim(),
  };
}

function detectWord(prefix: string): string | null {
  const p = normalizeArabic(prefix);
  if (p.includes("حدثنا") || p.includes("حدثني")) return "haddathana";
  if (p.includes("اخبرنا") || p.includes("اخبرني") || p.includes("انبانا") || p.includes("انباني")) return "akhbarana";
  if (p.includes("سمعت") || p.includes("سمع")) return "sami'tu";
  if (/(^|[^ا-ي])عن([^ا-ي]|$)/.test(p) || p.trim() === "عن" || p.includes(" عن")) return "an";
  if (p.includes("ان")) return "anna";
  return null;
}

function cleanName(segment: string): string {
  let name = stripHonorifics(segment);
  name = name
    .replace(/^[\s،,.:؛\-–—]+/, "")
    .replace(/[\s،,.:؛\-–—]+$/, "")
    // Drop trailing speech verbs / formula bits (with optional diacritics)
    .replace(/^(?:ق[\u064B-\u065F]*ال[\u064B-\u065F]*ت?|يقول|يَقُولُ|وَ)[\u064B-\u065F]*\s+/u, "")
    .replace(/[\s،,]*ق[\u064B-\u065F]*ال[\u064B-\u065F]*ت?[\u064B-\u065F]*\s*$/u, "")
    .replace(/[\s،,]*يَ?قُ?و?لُ?[\u064B-\u065F]*\s*$/u, "")
    .replace(/[\s،,]*أَ?خْ?بَ?رَ?هُ?[\u064B-\u065F]*\s*$/u, "")
    .replace(/\s+(?:قَالَ|قَالَتْ|يقول|يَقُولُ).*$/u, "")
    .replace(/\s*أخبرهُ?.*$/u, "")
    .replace(/\s*أَخْبَرَهُ?.*$/u, "")
    .replace(/[،,.;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  name = name.replace(/\s+أَنَّهُ?\s*$/u, "").replace(/\s+أنه?\s*$/u, "").trim();
  return name;
}

/** Expand "يونس، ومعمر" only when comma+waw separates two names — not و inside وقاص. */
function expandPairedNames(name: string): string[] {
  const parts = name
    .split(/\s*،\s*وَ/)
    .map((p) => cleanName(p))
    .filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => p.length >= 2 && normalizeArabic(p).length <= MAX_NAME_CHARS)) {
    return parts;
  }
  // Also "يونس ومعمر" without comma
  const waParts = name.split(/\s+وَ(?=[\u0600-\u06FF])/).map((p) => cleanName(p)).filter(Boolean);
  if (
    waParts.length === 2 &&
    waParts.every((p) => p.length >= 2 && normalizeArabic(p).length <= MAX_NAME_CHARS) &&
    !normalizeArabic(name).includes("بن و")
  ) {
    // Avoid splitting names that contain "بن و…" wrongly — only short peer pairs
    if (waParts.every((p) => !normalizeArabic(p).includes("بن") || normalizeArabic(p).split(" ").length <= 4)) {
      return waParts;
    }
  }
  return [name];
}

function makeNode(raw: string, word: string | null, note: string | null = null): ParsedNode | null {
  const name = cleanName(raw);
  if (!name) return null;
  const n = normalizeArabic(name);
  if (n.length > MAX_NAME_CHARS) {
    return {
      position: 0,
      raw_name: name.slice(0, 80) + "…",
      transmission_word: word,
      normalized: n,
      identity_key: null,
      match: "reject",
      narrator_id: null,
      narrator_slug: null,
      note: `Rejected: normalized name length ${n.length} > ${MAX_NAME_CHARS}`,
    };
  }
  if (n.length < 2) return null;
  if (n.includes("رسول الله") || n.includes("النبي") || n === "الله") return null;
  if (n.includes("فتره الوحي") || n.includes("في حديثه") || n.includes("على المنبر") || n === "ه" || n === "ها" || n === "هم") {
    return null;
  }

  const identity = resolveIdentity(name);
  if (!identity.key) {
    return {
      position: 0,
      raw_name: name,
      transmission_word: word,
      normalized: n,
      identity_key: null,
      match: "unresolved",
      narrator_id: null,
      narrator_slug: null,
      note: identity.note,
    };
  }

  return {
    position: 0,
    raw_name: name,
    transmission_word: word,
    normalized: n,
    identity_key: identity.key,
    match: "create",
    narrator_id: null,
    narrator_slug: identity.slug,
    note: identity.note ?? note,
  };
}

function pushName(
  nodes: ParsedNode[],
  raw: string,
  word: string | null,
  note: string | null = null,
  opts?: { expandPairs?: boolean },
): void {
  const expand = opts?.expandPairs !== false;
  const names = expand ? expandPairedNames(raw) : [raw];
  for (const name of names) {
    const node = makeNode(name, word, note);
    if (!node || node.match === "reject") {
      if (node?.match === "reject") nodes.push(node);
      continue;
    }
    nodes.push(node);
  }
}

/**
 * If segment is "يونس، ومعمر" (or similar) immediately before عن الزهري,
 * return the peer names for parallel branches — do not treat as a sequence.
 */
function detectParallelPeers(segment: string): string[] | null {
  const cleaned = cleanName(segment);
  const peers = expandPairedNames(cleaned);
  if (peers.length < 2) return null;
  // Only treat short peer lists (2–3) as parallel transmitters
  if (peers.length > 3) return null;
  if (peers.some((p) => normalizeArabic(p).split(/\s+/).length > 5)) return null;
  return peers;
}

function parseChainText(isnad: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  const { prefixName, rest } = prependLeadingSaidName(isnad);
  if (prefixName) {
    const node = makeNode(prefixName, "qala", "Leading قال NAME before first transmission verb");
    if (node && node.match !== "reject") nodes.push(node);
  }

  const text = rest
    .replace(/أَنَّهُ\s+سَمِعَ/g, " سَمِعَ ")
    .replace(/انه\s+سمع/g, " سمع ");
  const matches = [...text.matchAll(TRANSMISSION_SPLIT)];
  if (!matches.length) {
    const whole = cleanName(text);
    if (whole) pushName(nodes, whole, null, "No transmission verb found; kept as single node candidate");
    nodes.forEach((n, idx) => {
      n.position = idx + 1;
    });
    return nodes;
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const word = detectWord(m[0]);
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    let segment = text.slice(start, end);
    const matnInSeg = segment.match(MATN_CUT);
    if (matnInSeg?.index != null && matnInSeg.index >= 0) {
      segment = segment.slice(0, matnInSeg.index);
    }
    const name = cleanName(segment);
    if (!name) continue;

    // Look-ahead: if next verb is عن and this segment is a peer pair, do not expand here —
    // caller (buildChainsFromIsnad) handles parallel forks. Mark with parallel_with for now.
    const nextWord = i + 1 < matches.length ? detectWord(matches[i + 1][0]) : null;
    const peers = nextWord === "an" ? detectParallelPeers(name) : null;
    if (peers && peers.length >= 2) {
      // Placeholder: store peers as a single synthetic marker node list for forking
      for (const peer of peers) {
        const node = makeNode(peer, word, "Parallel peer transmitter (forked into sibling chains)");
        if (node && node.match !== "reject") {
          node.parallel_with = peers.filter((p) => p !== peer);
          nodes.push(node);
        }
      }
      continue;
    }

    pushName(nodes, name, word, null, { expandPairs: true });
  }

  nodes.forEach((n, idx) => {
    n.position = idx + 1;
  });
  return nodes;
}

/**
 * Build one or more chains from an isnad string.
 * When يونس/معمر (etc.) appear as peers before عن الزهري, emit parallel sibling chains
 * that share the prefix and each take one peer → shared source.
 */
function buildChainsFromIsnad(isnad: string, startChainNumber: number): ParsedChain[] {
  const linear = parseChainText(isnad);

  // Find a run of nodes that all have parallel_with set (peer group)
  const peerStart = linear.findIndex((n) => (n.parallel_with?.length ?? 0) > 0);
  if (peerStart < 0) {
    return [
      {
        chain_number: startChainNumber,
        raw_chain_text: isnad,
        nodes: linear.filter((n) => n.match !== "reject"),
        notes: null,
        parallel_group: null,
      },
    ];
  }

  // Collect contiguous peer nodes
  let peerEnd = peerStart;
  while (peerEnd < linear.length && (linear[peerEnd].parallel_with?.length ?? 0) > 0) {
    peerEnd++;
  }
  const peers = linear.slice(peerStart, peerEnd);
  const prefix = linear.slice(0, peerStart).filter((n) => n.match !== "reject");
  const suffix = linear.slice(peerEnd).filter((n) => n.match !== "reject");

  // Expected shape: … → [peers] → الزهري (suffix starts with zuhri)
  const groupId = `parallel-${startChainNumber}`;
  return peers.map((peer, idx) => {
    const nodes = [
      ...prefix.map((n) => ({ ...n })),
      { ...peer, parallel_with: peers.filter((p) => p !== peer).map((p) => p.raw_name) },
      ...suffix.map((n) => ({ ...n })),
    ];
    nodes.forEach((n, i) => {
      n.position = i + 1;
    });
    return {
      chain_number: startChainNumber + idx,
      raw_chain_text: isnad,
      nodes,
      notes: `Parallel branch ${idx + 1}/${peers.length} via ${peer.raw_name}; peers share transmission from the following source (e.g. الزهري)`,
      parallel_group: groupId,
    };
  });
}

function splitHaChains(isnad: string): string[] {
  // Split on standalone ح used as tahwil marker
  const parts = isnad.split(HA_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [isnad.trim()];
  // Re-join if accidental tiny fragments
  return parts.filter((p) => p.length > 8);
}

const AR_MAP: Record<string, string> = {
  ا: "a",
  أ: "a",
  إ: "i",
  آ: "a",
  ب: "b",
  ت: "t",
  ث: "th",
  ج: "j",
  ح: "h",
  خ: "kh",
  د: "d",
  ذ: "dh",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "q",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  و: "w",
  ي: "y",
  ى: "y",
  ة: "h",
  ء: "",
  ئ: "y",
  ؤ: "w",
};

function slugifyArabic(name: string): string {
  const n = normalizeArabic(name);
  let out = "";
  for (const ch of n) {
    if (ch === " ") out += "-";
    else if (AR_MAP[ch]) out += AR_MAP[ch];
    else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
  }
  out = out.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (out.length >= 3) return out.slice(0, 80);
  return `ar-${Buffer.from(n).toString("hex").slice(0, 16)}`;
}

function matchNarrator(node: ParsedNode, _byNorm: Map<string, NarratorRow[]>): void {
  // Never link to legacy narrator rows. Fresh identities only (or unresolved bare names).
  if (node.match === "reject" || node.match === "unresolved") return;
  if (!node.identity_key) {
    node.match = "unresolved";
    return;
  }
  node.match = "create";
  if (!node.narrator_slug) node.narrator_slug = slugifyArabic(node.raw_name);
  if (!node.note) {
    node.note = `Would create new unverified narrator ${node.narrator_slug} (no legacy link)`;
  } else if (!node.note.includes("no legacy")) {
    node.note = `${node.note} | new unverified row (no legacy link)`;
  }
}

function buildNormIndex(narrators: NarratorRow[]): Map<string, NarratorRow[]> {
  const map = new Map<string, NarratorRow[]>();
  const add = (key: string, row: NarratorRow) => {
    const k = key.trim();
    if (!k) return;
    const list = map.get(k) ?? [];
    if (!list.some((x) => x.id === row.id)) list.push(row);
    map.set(k, list);
  };
  for (const row of narrators) {
    if (row.arabic_name) add(normalizeArabic(row.arabic_name), row);
    if (row.name) add(normalizeArabic(row.name), row);
    add(row.slug, row);
    for (const alt of row.alternative_names ?? []) {
      if (alt) add(normalizeArabic(alt), row);
    }
  }
  return map;
}

/** One narrators row per identity_key across the whole repair batch. */
function collectDistinctIdentities(plans: VariationPlan[]): Map<
  string,
  { slug: string; display_name: string; raw_names: string[]; node_count: number }
> {
  const map = new Map<string, { slug: string; display_name: string; raw_names: string[]; node_count: number }>();
  for (const plan of plans) {
    for (const chain of plan.chains) {
      for (const node of chain.nodes) {
        if (!node.identity_key || node.match === "unresolved" || node.match === "reject") continue;
        const slug = node.narrator_slug ?? slugifyArabic(node.raw_name);
        const existing = map.get(node.identity_key);
        if (!existing) {
          map.set(node.identity_key, {
            slug,
            display_name: node.raw_name,
            raw_names: [node.raw_name],
            node_count: 1,
          });
        } else {
          existing.node_count += 1;
          if (!existing.raw_names.includes(node.raw_name)) existing.raw_names.push(node.raw_name);
          // Prefer longer/more complete display name
          if (node.raw_name.length > existing.display_name.length) existing.display_name = node.raw_name;
        }
      }
    }
  }
  return map;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sb = getClient();
  const localArabic = loadLocalArabicByHadithNumber();

  const { data: vars, error } = await sb
    .from("source_variations")
    .select("id, hadith_number, source_url, arabic_text")
    .in("id", VARIATION_IDS);
  if (error) throw error;

  const { data: existingChains } = await sb
    .from("chains")
    .select("id, variation_id, chain_number")
    .in("variation_id", VARIATION_IDS);

  const { data: narrators } = await sb
    .from("narrators")
    .select("id, slug, name, arabic_name, alternative_names");
  const byNorm = buildNormIndex((narrators ?? []) as NarratorRow[]);
  const takenSlugs = new Set((narrators ?? []).map((n) => n.slug));

  const plans: VariationPlan[] = [];
  const varsSorted = [...(vars ?? [])].sort(
    (a, b) => Number(a.hadith_number) - Number(b.hadith_number) || a.id - b.id,
  );

  for (const v of varsSorted) {
    const num = String(v.hadith_number);
    const fromLocal = localArabic.get(num);
    const arabic =
      (fromLocal && fromLocal.length >= (v.arabic_text?.length ?? 0) ? fromLocal : v.arabic_text) ?? "";
    const arabic_source = fromLocal && fromLocal === arabic ? "local_bukhari.json" : "variation.arabic_text";
    const isnadFull = extractIsnad(arabic);
    const chainTexts = splitHaChains(isnadFull);

    const chains: ParsedChain[] = [];
    let nextChainNumber = 1;
    for (const text of chainTexts) {
      const built = buildChainsFromIsnad(text, nextChainNumber);
      for (const chain of built) {
        for (const node of chain.nodes) matchNarrator(node, byNorm);
        chains.push(chain);
      }
      nextChainNumber = Math.max(nextChainNumber, ...built.map((c) => c.chain_number)) + 1;
    }

    const cont = CONTINUATION[num] ?? null;
    plans.push({
      variation_id: v.id,
      hadith_number: num,
      source_url: v.source_url,
      arabic_source,
      arabic_len: arabic.length,
      chains,
      existing_chain_ids: (existingChains ?? []).filter((c) => c.variation_id === v.id).map((c) => c.id),
      continuation_of_variation_id: cont?.ofVariationId ?? null,
      continuation_of_hadith_number: cont?.ofHadith ?? null,
    });
  }

  // Stamp continuation notes onto Bukhari 4 chains
  for (const plan of plans) {
    if (!plan.continuation_of_hadith_number) continue;
    for (const chain of plan.chains) {
      const contNote = `Continuation of Bukhari ${plan.continuation_of_hadith_number} (variation ${plan.continuation_of_variation_id}): resumes from ابن شهاب / الزهري path`;
      chain.notes = chain.notes ? `${chain.notes}; ${contNote}` : contNote;
    }
  }

  const distinct = collectDistinctIdentities(plans);

  console.log("\n=================================================================");
  console.log(apply ? "  APPLY MODE — writing chains/narrators" : "  DRY-RUN — no database writes");
  console.log("  Repair Bukhari isnads for variations:", VARIATION_IDS.join(", "));
  console.log("=================================================================\n");

  console.log("Distinct narrator identities (one row each):");
  for (const [key, info] of distinct) {
    console.log(
      `  • ${info.slug}  [${key}]  raw forms: ${info.raw_names.join(" | ")}  (${info.node_count} node links)`,
    );
  }
  console.log("");

  for (const plan of plans) {
    console.log(`--- Bukhari ${plan.hadith_number} (variation ${plan.variation_id}) ---`);
    console.log(`URL: ${plan.source_url}`);
    console.log(`Arabic source: ${plan.arabic_source} (${plan.arabic_len} chars)`);
    if (plan.continuation_of_hadith_number) {
      console.log(
        `CONTINUATION OF Bukhari ${plan.continuation_of_hadith_number} (variation ${plan.continuation_of_variation_id})`,
      );
    }
    for (const chain of plan.chains) {
      const parallel = chain.parallel_group ? ` [parallel group ${chain.parallel_group}]` : "";
      console.log(`  Chain #${chain.chain_number}${parallel} (${chain.raw_chain_text.length} chars isnad):`);
      if (chain.notes) console.log(`    notes: ${chain.notes}`);
      console.log(`    isnad: ${chain.raw_chain_text}`);
      for (const n of chain.nodes) {
        const peers = n.parallel_with?.length ? ` ‖ parallel with ${n.parallel_with.join(", ")}` : "";
        const link =
          n.match === "create"
            ? `→ CREATE NEW ${n.narrator_slug}`
            : n.match === "unresolved"
              ? `→ UNRESOLVED (raw only)`
              : `→ ${n.match}`;
        console.log(`    ${n.position}. [${n.transmission_word ?? "?"}] ${n.raw_name}${peers}  ${link}`);
      }
    }
    console.log("");
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    variations: plans.length,
    totalChains: plans.reduce((s, p) => s + p.chains.length, 0),
    totalNodes: plans.reduce((s, p) => s + p.chains.reduce((a, c) => a + c.nodes.length, 0), 0),
    distinctIdentities: distinct.size,
    toCreateNew: plans.reduce(
      (s, p) => s + p.chains.reduce((a, c) => a + c.nodes.filter((n) => n.match === "create").length, 0),
      0,
    ),
    unresolved: plans.reduce(
      (s, p) => s + p.chains.reduce((a, c) => a + c.nodes.filter((n) => n.match === "unresolved").length, 0),
      0,
    ),
    legacyLinks: 0,
  };
  console.log("Summary:", summary);

  writeFileSync(
    "scripts/_bukhari7-repair.dry-run.json",
    JSON.stringify(
      {
        summary,
        distinctIdentities: Object.fromEntries(distinct),
        plans,
      },
      null,
      2,
    ),
  );
  console.log("\nWrote scripts/_bukhari7-repair.dry-run.json");

  if (!apply) {
    console.log("\nReview the narrator lists above. To apply:");
    console.log("  npx tsx scripts/repair-bukhari-chains.ts --apply");
    return;
  }

  // APPLY: always create NEW narrator rows (never reuse legacy ids/slugs).
  function allocateFreshSlug(preferred: string): string {
    let slug = preferred;
    let n = 2;
    while (takenSlugs.has(slug)) {
      slug = `${preferred}-isnad-repair`;
      if (takenSlugs.has(slug)) {
        slug = `${preferred}-isnad-repair-${n}`;
        n += 1;
      } else {
        break;
      }
    }
    takenSlugs.add(slug);
    return slug;
  }

  const identityToId = new Map<string, number>();
  const createdNarratorIds: number[] = [];
  for (const [key, info] of distinct) {
    const slug = allocateFreshSlug(info.slug);
    // Keep plan nodes pointing at the slug we actually insert
    for (const plan of plans) {
      for (const chain of plan.chains) {
        for (const node of chain.nodes) {
          if (node.identity_key === key) node.narrator_slug = slug;
        }
      }
    }
    const { data: created, error: nErr } = await sb
      .from("narrators")
      .insert({
        slug,
        name: info.display_name,
        arabic_name: info.display_name,
        alternative_names: info.raw_names.filter((n) => n !== info.display_name),
        biography: null,
        summary_score: null,
        identity_status: "unverified",
      })
      .select("id")
      .single();
    if (nErr) throw nErr;
    identityToId.set(key, created.id);
    createdNarratorIds.push(created.id);
  }

  const createdChainIds: number[] = [];
  let createdNodeCount = 0;

  for (const plan of plans) {
    if (plan.existing_chain_ids.length) {
      await sb.from("chain_narrators").delete().in("chain_id", plan.existing_chain_ids);
      await sb.from("chains").delete().in("id", plan.existing_chain_ids);
    }

    for (const chain of plan.chains) {
      const notesParts = [
        "Repaired from full Arabic isnad; awaiting human review before verified=true",
        chain.notes,
      ].filter(Boolean);
      const { data: inserted, error: chainErr } = await sb
        .from("chains")
        .insert({
          variation_id: plan.variation_id,
          chain_number: chain.chain_number,
          raw_chain_text: chain.raw_chain_text,
          continuity_status: "muttasil",
          quality_status: "unverified",
          verified: false,
          notes: notesParts.join(" | "),
        })
        .select("id")
        .single();
      if (chainErr) throw chainErr;
      createdChainIds.push(inserted.id);

      for (const node of chain.nodes) {
        const narratorId =
          node.identity_key && identityToId.has(node.identity_key)
            ? identityToId.get(node.identity_key)!
            : null;

        const { error: nodeErr } = await sb.from("chain_narrators").insert({
          chain_id: inserted.id,
          position: node.position,
          raw_name: node.raw_name,
          narrator_id: narratorId,
          transmission_word: node.transmission_word,
          match_confidence: narratorId != null ? 0.85 : null,
          match_notes: [
            node.note,
            node.parallel_with?.length ? `parallel_with=${node.parallel_with.join("|")}` : null,
            plan.continuation_of_variation_id
              ? `continuation_of_variation=${plan.continuation_of_variation_id}`
              : null,
          ]
            .filter(Boolean)
            .join(" | "),
        });
        if (nodeErr) throw nodeErr;
        createdNodeCount += 1;
      }
    }
  }

  const { count: nullNarratorIdCount, error: nullCountErr } = await sb
    .from("chain_narrators")
    .select("*", { count: "exact", head: true })
    .in("chain_id", createdChainIds)
    .is("narrator_id", null);
  if (nullCountErr) throw nullCountErr;

  console.log("\n=================================================================");
  console.log("  APPLY COMPLETE");
  console.log("=================================================================");
  console.log(`  chains created:           ${createdChainIds.length}`);
  console.log(`  chain_narrators created:  ${createdNodeCount}`);
  console.log(`  narrators created:        ${createdNarratorIds.length}`);
  console.log(`  chain_narrators.narrator_id IS NULL: ${nullNarratorIdCount ?? 0} (expected 4)`);
  console.log("  All new narrators: identity_status=unverified, summary_score=NULL");
  console.log("  No assessments written. Chains left verified=false.");
  console.log("=================================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
