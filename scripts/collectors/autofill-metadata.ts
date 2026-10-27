/**
 * Auto-fill grades + categories from DB signals + HadeethEnc API;
 * verify chains only when every narrator has a cited verified assessment.
 *
 *   npx tsx scripts/collectors/autofill-metadata.ts
 *   npx tsx scripts/collectors/autofill-metadata.ts --apply
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const APPLY = process.argv.includes("--apply");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mapStatusToGrade(status: string | null): string | null {
  if (!status) return null;
  const s = status.trim().toLowerCase();
  if (!s || s === "unspecified") return "not_graded";
  const codes = new Set([
    "sahih",
    "hasan",
    "hasan_sahih",
    "daif",
    "mawdu",
    "munkar",
    "not_graded",
    "thiqa",
    "saduq",
    "muwaththaq",
    "qawi",
    "majhul",
    "layyin",
    "matruk",
    "daif_jiddan",
  ]);
  if (codes.has(s)) return s;
  if (/صحيح|sahih|authentic|muttafaq|متفق|agreed upon/.test(s)) return "sahih";
  if (/حسن\s*صحيح|hasan[-\s]?sahih/.test(s)) return "hasan_sahih";
  if (/حسن|hasan|fair|good/.test(s)) return "hasan";
  if (/ضعيف\s*جدا|very\s*weak|daif_jiddan/.test(s)) return "daif_jiddan";
  if (/ضعيف|da[ʿ'`]?if|weak/.test(s)) return "daif";
  if (/موضوع|fabricat|mawdu/.test(s)) return "mawdu";
  if (/منكر|munkar/.test(s)) return "munkar";
  if (/موثق|muwaththaq/.test(s)) return "muwaththaq";
  if (/قوي|qawi/.test(s)) return "qawi";
  return null;
}

function mapTopicTextToSlugs(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  if (/first\s*wahi|beginning of revelation|cave hira|iqra|commencement of revelation|بدء الوحي/.test(t)) {
    out.add("first-wahi");
  }
  if (/\baqidah\b|creed|belief|tawhid|faith\b|عقيد/.test(t)) out.add("aqidah");
  if (/imamate|wilayah|twelve imams|divine leadership|\bimam\b|أئم|ولاية/.test(t)) out.add("imamate");
  if (/prayer|salat|salah|صلاة|i.?tikaf|rows? of (men|women)/.test(t)) out.add("prayer");
  if (/fast|sawm|ramadan|صيام|laylat/.test(t)) out.add("fasting");
  if (/zakat|charity|زكاة/.test(t)) out.add("zakat");
  if (/hajj|umrah|pilgrim|حج/.test(t)) out.add("hajj");
  if (/marriage|nikah|wives|hijab|نكاح/.test(t)) out.add("marriage");
  if (/tafsir|qur.?an|تفسير/.test(t)) out.add("tafsir");
  if (/akhlaq|ethics|adab|manners|أخلاق|quarrels|animosity|honor/.test(t)) out.add("akhlaq");
  if (/virtue|fada.?il|فضائل|nobility/.test(t)) out.add("virtues");
  if (/seerah|maghazi|banner|battle|migration|hijra|سيرة/.test(t)) out.add("seerah");
  if (/fiqh|ibadat|worship|معامل|transaction|blood money|prisoner/.test(t)) {
    if (/transaction|muamal|بيع|trade/.test(t)) out.add("fiqh-muamalat");
    else out.add("fiqh-ibadat");
  }
  if (/rijal|narrator|رجال/.test(t)) out.add("rijal-topic");
  if (/ghayba|mahdi|qa.?im|signs preceding|غيبة/.test(t)) out.add("imamate");
  if (/ridha|rida|رضا|ziyarat/.test(t)) out.add("imamate");
  return [...out];
}

function isBogusFirstWahiOnlyChapter(chapter: string): boolean {
  return /^the beginning of revelation/i.test(chapter.trim());
}

async function pageFetch<T>(
  sb: ReturnType<typeof createClient>,
  table: string,
  select: string
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log("\n=== autofill-metadata ===");
  console.log(APPLY ? "MODE: APPLY" : "MODE: dry-run (pass --apply to write)");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const categories = await pageFetch<{ id: number; slug: string }>(sb, "categories", "id,slug");
  const catBySlug = new Map(categories.map((c) => [c.slug, c.id]));

  const variations = await pageFetch<{
    id: number;
    hadith_id: number;
    chapter: string | null;
    hadith_status: string | null;
    grade_code: string | null;
    source_url: string | null;
  }>(sb, "source_variations", "id,hadith_id,chapter,hadith_status,grade_code,source_url");

  const existingLinks = await pageFetch<{ hadith_id: number; category_id: number }>(
    sb,
    "hadith_categories",
    "hadith_id,category_id"
  );
  const linkSet = new Set(existingLinks.map((l) => `${l.hadith_id}:${l.category_id}`));

  // 1) Grades from hadith_status
  let gradePlans = 0;
  let gradeApplied = 0;
  const unmatchedGrades: (string | number)[][] = [];
  for (const v of variations) {
    if (v.grade_code) continue;
    const mapped = mapStatusToGrade(v.hadith_status);
    if (!mapped) {
      if (v.hadith_status) unmatchedGrades.push([v.id, v.hadith_status]);
      continue;
    }
    gradePlans++;
    if (!APPLY) continue;
    const { error } = await sb.from("source_variations").update({ grade_code: mapped }).eq("id", v.id);
    if (error) unmatchedGrades.push([v.id, error.message]);
    else {
      gradeApplied++;
      v.grade_code = mapped;
    }
  }
  console.log(`Grades from hadith_status: plans=${gradePlans} applied=${gradeApplied}`);

  // 2) Categories from real chapter titles
  const catInserts: { hadith_id: number; category_id: number }[] = [];
  let chapterSignals = 0;
  for (const v of variations) {
    const ch = (v.chapter || "").trim();
    if (!ch || isBogusFirstWahiOnlyChapter(ch)) continue;
    for (const slug of mapTopicTextToSlugs(ch)) {
      const cid = catBySlug.get(slug);
      if (!cid) continue;
      const key = `${v.hadith_id}:${cid}`;
      if (linkSet.has(key)) continue;
      linkSet.add(key);
      catInserts.push({ hadith_id: v.hadith_id, category_id: cid });
      chapterSignals++;
    }
  }

  // 3) HadeethEnc API
  let heFetched = 0;
  let heGrade = 0;
  let heCat = 0;
  let heFail = 0;
  let heTitles = 0;
  const heVars = variations.filter((v) => /hadeethenc\.com/i.test(v.source_url || ""));
  console.log(`HadeethEnc variations to fetch: ${heVars.length}`);

  const heCatTitles = new Map<string, string>();
  try {
    const catJson = await (await fetch("https://hadeethenc.com/api/v1/categories/list/?language=en")).json();
    for (const c of Array.isArray(catJson) ? catJson : []) {
      heCatTitles.set(String(c.id), String(c.title || ""));
    }
    console.log(`HadeethEnc categories loaded: ${heCatTitles.size}`);
  } catch (e) {
    console.warn("HadeethEnc categories list failed", e);
  }

  for (let i = 0; i < heVars.length; i++) {
    const v = heVars[i];
    const m = (v.source_url || "").match(/hadith\/(\d+)/i);
    if (!m) continue;
    try {
      await sleep(100);
      const en = await (
        await fetch(`https://hadeethenc.com/api/v1/hadeeths/one/?language=en&id=${m[1]}`)
      ).json();
      heFetched++;
      const grade = mapStatusToGrade(en.grade || null);
      if (grade && (!v.grade_code || v.grade_code === "not_graded")) {
        heGrade++;
        if (APPLY) {
          await sb.from("source_variations").update({ grade_code: grade }).eq("id", v.id);
          gradeApplied++;
          v.grade_code = grade;
        }
      }
      const titles = [
        ...(Array.isArray(en.categories) ? en.categories.map((id: string) => heCatTitles.get(String(id)) || "") : []),
        String(en.title || ""),
      ].filter(Boolean);
      for (const title of titles) {
        for (const slug of mapTopicTextToSlugs(title)) {
          const cid = catBySlug.get(slug);
          if (!cid) continue;
          const key = `${v.hadith_id}:${cid}`;
          if (linkSet.has(key)) continue;
          linkSet.add(key);
          catInserts.push({ hadith_id: v.hadith_id, category_id: cid });
          heCat++;
        }
      }
      if (APPLY && en.title) {
        const { data: h } = await sb
          .from("hadiths")
          .select("id,title,grouping_method")
          .eq("id", v.hadith_id)
          .maybeSingle();
        if (h?.grouping_method === "matn_fingerprint_v1" && /^Matn /i.test(h.title || "")) {
          await sb.from("hadiths").update({ title: String(en.title).slice(0, 200) }).eq("id", h.id);
          heTitles++;
        }
      }
    } catch {
      heFail++;
    }
    if (i % 40 === 0) console.log(`  HE progress ${i}/${heVars.length}`);
  }
  console.log(
    `HadeethEnc: fetched=${heFetched} grade=${heGrade} cat=${heCat} titles=${heTitles} fail=${heFail}`
  );

  try {
    const tq = await fetch(
      "https://www.thaqalayn-api.net/api/v2/query?q=" + encodeURIComponent("revelation")
    );
    console.log(
      `Thaqalayn API: ${tq.status} — ${tq.status === 200 ? "available" : "skipped (unavailable)"}`
    );
  } catch {
    console.log("Thaqalayn API unreachable — skipped");
  }

  console.log(`Category link plans: ${catInserts.length} (from chapters≈${chapterSignals}, rest HE)`);
  if (APPLY && catInserts.length) {
    for (let i = 0; i < catInserts.length; i += 100) {
      const { error } = await sb.from("hadith_categories").upsert(catInserts.slice(i, i + 100), {
        onConflict: "hadith_id,category_id",
      });
      if (error) console.warn("hadith_categories", error.message);
    }
  }

  // 4) Verify chains when every node has cited assessment
  const assessRows = await pageFetch<{
    narrator_id: number;
    verified: boolean;
    source_url: string | null;
    reference_book: string | null;
    page: string | null;
  }>(sb, "narrator_assessments", "narrator_id,verified,source_url,reference_book,page");

  const citedNarrators = new Set<number>();
  for (const a of assessRows) {
    if (
      a.verified &&
      (Boolean(a.source_url?.trim()) ||
        (Boolean(a.reference_book?.trim()) && Boolean(a.page?.trim())))
    ) {
      citedNarrators.add(a.narrator_id);
    }
  }
  console.log(`Narrators with cited verified assessments: ${citedNarrators.size}`);

  const chains = await pageFetch<{ id: number; verified: boolean }>(sb, "chains", "id,verified");
  const nodes = await pageFetch<{ chain_id: number; narrator_id: number | null }>(
    sb,
    "chain_narrators",
    "chain_id,narrator_id"
  );
  const nodesByChain = new Map<number, typeof nodes>();
  for (const n of nodes) {
    if (!nodesByChain.has(n.chain_id)) nodesByChain.set(n.chain_id, []);
    nodesByChain.get(n.chain_id)!.push(n);
  }

  let chainVerifyPlans = 0;
  let chainVerifyApplied = 0;
  for (const c of chains) {
    if (c.verified) continue;
    const ns = nodesByChain.get(c.id) || [];
    if (!ns.length || ns.some((n) => n.narrator_id == null)) continue;
    if (!ns.every((n) => citedNarrators.has(n.narrator_id as number))) continue;
    chainVerifyPlans++;
    if (!APPLY) continue;
    const { error } = await sb.from("chains").update({ verified: true }).eq("id", c.id);
    if (!error) chainVerifyApplied++;
  }
  console.log(`Chain verify plans=${chainVerifyPlans} applied=${chainVerifyApplied}`);

  mkdirSync(path.join("data", "unmatched"), { recursive: true });
  writeFileSync(
    path.join("data", "unmatched", "autofill-metadata-summary.json"),
    JSON.stringify(
      {
        apply: APPLY,
        grade_plans: gradePlans,
        grade_applied: gradeApplied,
        unmatched_grades: unmatchedGrades.length,
        category_link_plans: catInserts.length,
        hadeethenc_fetched: heFetched,
        chain_verify_plans: chainVerifyPlans,
        chain_verify_applied: chainVerifyApplied,
      },
      null,
      2
    ),
    "utf8"
  );

  if (!APPLY) console.log("\nDry-run complete. Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
