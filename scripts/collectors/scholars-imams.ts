/**
 * Collector D — Scholars / imams / compilers from Wikidata-verified reference JSON.
 * Apply path requires provenance.verified_via === "wikidata_search_human_death_year"
 * and a non-null wikidata_qid. Untrusted v1 file is quarantined under _untrusted/.
 *
 * Tradition/madhhab: NULL from Wikidata. Overlay curated_seed ONLY for the approved
 * 12 Imams + 4 Sunni imams (decision 5). verified=false for curated tradition fields.
 *
 *   npx tsx scripts/collectors/scholars-imams.ts
 *   npx tsx scripts/collectors/scholars-imams.ts --apply
 */
import {
  APPLY,
  adminClient,
  ensureImportBatch,
  insertRawRecord,
  logMode,
  writeUnmatchedCsv,
} from "./_shared";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REQUIRED_VERIFIED_VIA = "wikidata_search_human_death_year";

/** Decision 5: curated tradition/madhhab for 12 Imams + 4 Sunni imams only. */
const CURATED_SEED: Record<
  string,
  { tradition: string; madhhab: string | null; source_url: string; name?: string; arabic_name?: string }
> = {
  "abu-hanifa": {
    tradition: "Sunni",
    madhhab: "Hanafi",
    source_url: "https://www.wikidata.org/wiki/Q190896",
  },
  "malik-ibn-anas": {
    tradition: "Sunni",
    madhhab: "Maliki",
    source_url: "https://www.wikidata.org/wiki/Q312299",
  },
  "al-shafii": {
    tradition: "Sunni",
    madhhab: "Shafi'i",
    source_url: "https://www.wikidata.org/wiki/Q294281",
  },
  "ahmad-ibn-hanbal": {
    tradition: "Sunni",
    madhhab: "Hanbali",
    source_url: "https://www.wikidata.org/wiki/Q194442",
  },
  "ali-ibn-abi-talib": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q39619",
  },
  "al-hasan-ibn-ali": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q182914",
  },
  "al-husayn-ibn-ali": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q112128",
  },
  "ali-zayn-al-abidin": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q314978",
  },
  "muhammad-al-baqir": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q311153",
  },
  "jafar-al-sadiq": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q170046",
  },
  "musa-al-kazim": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q315031",
  },
  "ali-al-rida": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q25105",
  },
  "muhammad-al-jawad": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q25088",
  },
  "ali-al-hadi": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q315377",
  },
  "al-hasan-al-askari": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://www.wikidata.org/wiki/Q315920",
  },
  // No accepted Wikidata QID in rebuild — curated identity + tradition only
  "muhammad-al-mahdi": {
    tradition: "Twelver Shia",
    madhhab: null,
    source_url: "https://en.wikipedia.org/wiki/Muhammad_al-Mahdi",
    name: "Muhammad al-Mahdi",
    arabic_name: "محمد المهدي",
  },
};

type ScholarRef = {
  slug: string;
  name: string | null;
  arabic_name?: string | null;
  kunya?: string | null;
  laqab?: string | null;
  tradition?: string | null;
  madhhab?: string | null;
  birth_year_ah?: number | null;
  death_year_ah?: number | null;
  region?: string | null;
  source_url?: string | null;
  source_name?: string | null;
  wikidata_qid?: string | null;
};

async function upsertScholar(
  sb: ReturnType<typeof adminClient>,
  row: Record<string, unknown>,
  unmatched: (string | null)[][]
): Promise<boolean> {
  const slug = row.slug as string;
  const { data: existing } = await sb.from("scholars").select("id").eq("slug", slug).maybeSingle();
  if (existing) {
    const { error } = await sb.from("scholars").update(row).eq("id", existing.id);
    if (error) {
      unmatched.push([slug, error.message]);
      return false;
    }
  } else {
    const { error } = await sb.from("scholars").insert(row);
    if (error) {
      unmatched.push([slug, error.message]);
      return false;
    }
  }
  return true;
}

async function main() {
  logMode("collect:scholars-imams (D)");
  const sb = adminClient();
  const file = path.join("data", "collectors", "scholars-reference.json");
  if (!existsSync(file)) throw new Error(`Missing ${file}`);
  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    provenance: {
      source_name: string;
      license: string;
      notes: string;
      verified_via?: string;
    };
    scholars: ScholarRef[];
    null_tradition_candidates: { id: number; name: string; reason: string }[];
  };

  if (doc.provenance.verified_via !== REQUIRED_VERIFIED_VIA) {
    throw new Error(
      `Refuse apply/dry-run: scholars-reference.json missing verified_via=${REQUIRED_VERIFIED_VIA}. ` +
        `Rebuild with: npx tsx scripts/collectors/rebuild-wikidata-references.ts ` +
        `(untrusted prior file is under data/collectors/_untrusted/).`
    );
  }

  writeUnmatchedCsv(
    "scholars-null-tradition.csv",
    ["id", "name", "reason"],
    doc.null_tradition_candidates.map((c) => [c.id, c.name, c.reason])
  );

  const batchId = await ensureImportBatch(
    sb,
    "collector:scholars-imams",
    "data/collectors/scholars-reference.json",
    doc.provenance.notes,
    doc.provenance.license,
    "public-reference"
  );

  let upserted = 0;
  const unmatched: (string | null)[][] = [];
  const applyable = doc.scholars.filter((s) => s.wikidata_qid && s.name);
  const skippedNoQid = doc.scholars.filter((s) => !s.wikidata_qid || !s.name);
  if (skippedNoQid.length) {
    writeUnmatchedCsv(
      "scholars-imams-no-qid.csv",
      ["slug", "reason"],
      skippedNoQid.map((s) => [s.slug, "wikidata_qid_null_or_name_null"])
    );
  }

  const retrievedAt = new Date().toISOString();

  for (const s of applyable) {
    await insertRawRecord(sb, batchId, s.slug, s);
    if (!APPLY) {
      upserted++;
      continue;
    }
    const curated = CURATED_SEED[s.slug];
    const row: Record<string, unknown> = {
      slug: s.slug,
      name: s.name!,
      arabic_name: s.arabic_name ?? null,
      kunya: s.kunya ?? null,
      laqab: s.laqab ?? null,
      birth_year_ah: s.birth_year_ah ?? null,
      death_year_ah: s.death_year_ah ?? null,
      region: s.region ?? null,
      wikidata_qid: s.wikidata_qid,
      source_url: curated?.source_url ?? s.source_url ?? null,
      source_name: curated ? "curated_seed+wikidata" : s.source_name ?? "Wikidata",
      provenance: curated ? "curated_seed" : "wikidata_search_human_death_year",
      // Identity verified via Wikidata; tradition curated_seed is not Wikidata-verified
      verified: curated ? false : true,
      retrieved_at: retrievedAt,
    };
    // Only write tradition/madhhab for approved curated_seed overlays — never invent or wipe others
    if (curated) {
      row.tradition = curated.tradition;
      row.madhhab = curated.madhhab;
    }
    const ok = await upsertScholar(sb, row, unmatched);
    if (!ok) continue;

    if (s.source_url && s.name) {
      const { data: sch } = await sb.from("scholars").select("id").eq("slug", s.slug).single();
      if (sch) {
        await sb.from("name_aliases").upsert(
          {
            entity_type: "scholar",
            entity_id: sch.id,
            alias: s.name,
            alias_normalized: s.name.toLowerCase(),
            script: "en",
            source_name: "scholars-reference.json",
            source_url: s.source_url,
          },
          { onConflict: "entity_type,entity_id,alias" }
        );
      }
    }
    upserted++;
  }

  // Curated-only rows without Wikidata QID (e.g. muhammad-al-mahdi)
  for (const [slug, curated] of Object.entries(CURATED_SEED)) {
    if (!curated.name) continue;
    const already = applyable.some((s) => s.slug === slug);
    if (already) continue;
    await insertRawRecord(sb, batchId, slug, { slug, ...curated, provenance: "curated_seed" });
    if (!APPLY) {
      upserted++;
      continue;
    }
    const ok = await upsertScholar(
      sb,
      {
        slug,
        name: curated.name,
        arabic_name: curated.arabic_name ?? null,
        tradition: curated.tradition,
        madhhab: curated.madhhab,
        source_url: curated.source_url,
        source_name: "curated_seed",
        provenance: "curated_seed",
        verified: false,
        wikidata_qid: null,
        retrieved_at: retrievedAt,
      },
      unmatched
    );
    if (ok) upserted++;
  }

  if (unmatched.length) {
    writeUnmatchedCsv("scholars-imams-errors.csv", ["slug", "error"], unmatched);
  }
  console.log(
    APPLY
      ? `Upserted ${upserted} scholars (verified Wikidata + curated_seed overlays); skipped ${skippedNoQid.length} without QID (except curated-only)`
      : `Dry-run: ${applyable.length} Wikidata plans + curated-only; skipped ${skippedNoQid.length} without QID`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
