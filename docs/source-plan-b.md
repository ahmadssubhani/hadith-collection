# Source plan B — fill gaps for complete knowledge graph

Generated: 2026-10-19  
Depends on: Gap report A accepted; decisions 1–5 recorded below.  
**No collectors run. No DB apply in this step.**

---

## Decisions recorded

| # | Decision | Status |
|---|---|---|
| 1 | Matn regrouping with Arabic normalize + same-tradition auto-cluster; cross-tradition → review CSV; `first-revelation-at-hira` → category; `old_hadith_id→new` map; backup; variations stay draft | **APPROVED** (implement in 018+, not 017) |
| 2 | **Commercial app: no** (project framed as non-commercial research in permission drafts). Reconfirm if monetization starts. | **FILLED: no** |
| 3 | Dorar/Sunnah scrape: hold unpublished (hadiths 2, 4, 5 → draft by you) | **APPROVED** |
| 4 | 922 boilerplate NULL via migration 017; keep id 764 | **017 drafted** |
| 5 | Scholar tradition/madhhab NULL unless sourced; curated seed OK for 12 Imams + 4 Sunni imams with `provenance=curated_seed`, `verified=false`, `source_url` | **APPROVED** |
| — | OpenITI | **Still paused** until you say otherwise |

---

## HadeethEnc vs decision 2 (commercial = no)

HadeethEnc Terms (home modal) allow download/republish if:

1. No modify/add/delete  
2. Clear attribution to HadeethEnc.com  
3. Cite edition/version  
4. Keep in-document translation version info  
5. Report translation issues  
6. Follow new source editions  
7. No unsuitable ads  

**No non-commercial restriction** appears in those terms. With commercial = **no**, conditions still apply and are compatible. Batches 2/5 stay `allowed_with_conditions`. Before any new HadeethEnc import/publish: store attribution + edition version on each variation; do not alter translation text.

Thaqalayn CC BY 4.0 explicitly allows commercial use; still fine for non-commercial.

OpenITI (CC BY-NC-SA) remains **paused** regardless (your instruction).

---

## Where the 105 scholar `tradition` values came from

Live: **105 / 112** scholars have `tradition` (Sunni **100**, Twelver Shia **5**); **7** null (`sunnah-*` slugs).

| Origin | What it set |
|---|---|
| Early seed / appraisal imports | Initial scholar rows (e.g. Majlisi, Behbudi, Ibn Hajar, Albani, grading scholars from sunnah.com imports) often inserted with a tradition guess |
| **Migration 009** (applied) | (B) ids 2, 3 → `Twelver Shia`; (C) ids 12–112 with `slug like 'sunnah-%'` and `tradition is null`, except leave-null set → `Sunni` |
| Migration 009 leave-null | Ambiguous Arabic-name scholars left null (documented in `docs/tradition-fixes.md`) — current nulls are seven `sunnah-*` hashes |

**None of these 105 values carry per-row `source_url` / Wikidata verification.** Under decision 5 they should be treated as **unsourced** going forward: leave as historical until replaced by Wikidata-verified or `curated_seed` rows for the 12+4 imams only; do not expand tradition from memory.

---

## Gap → source → method (priority order)

### 1. Hadith texts / numbers / translations

| Gap | Source | License | Method |
|---|---|---|---|
| Sunni edition text + numbers | fawazahmed0/hadith-api | allow_with_conditions (Unlicense) | CDN/GitHub JSON; provenance per edition file |
| Shia Four Books text/grades | thaqalayn-api.net | allow_with_conditions (CC BY 4.0) | REST/GQL ≤1 req/s; attribution |
| Translations | hadeethenc.com | allow_with_conditions | Official download/API; no text modify; attribute + version |
| Sunni UI parity | sunnah.com **API only** | needs_permission until API | Hold HTML scrape unpublished; request/use API key |
| Grades (Arabic encyclopedic) | dorar.net **API** | needs_permission | Token + archive exception; hold scrape unpublished |

### 2. Matn regrouping (decision 1) — migration **018+**

| Step | Action |
|---|---|
| Backup | Snapshot `hadiths`, `source_variations` |
| Normalize | Strip tashkeel; unify alef / ya / ta marbuta; store `matn_fingerprint` |
| Cluster | Auto only **within** book.tradition (Sunni vs Twelver Shia separate) |
| Topic | Move `first-revelation-at-hira` to `categories`; cluster matns inside that topic |
| Map | Table `hadith_id_remap (old_hadith_id, new_hadith_id, method, created_at)` |
| Cross-tradition | Review CSV only — no auto-merge |
| Publish | New clusters stay `review_status=draft` |

### 3. Narrators / rijal

| Gap | Source | License | Method |
|---|---|---|---|
| Clear 922 placeholders | — | — | **017** (quarantine + NULL) |
| Names / death (structured) | Wikidata | allow (CC0) | human + label + death-year gate only |
| Missing chains | Sanadset 650K | allow (CC BY) | Exact book + number only; no auto aliases |
| Jarh/taʿdīl Sunni | Tahdhib / Taqrib / Mizan / Siyar (via Shamela/PDF or OpenITI later) | per-work / OpenITI paused | Quote with book/vol/page/URL; never invent |
| Jarh/taʿdīl Shia | Najashi, Tusi, Kashshi, Ghada'iri, Khoei Muʿjam | per-work | Same |
| Bio encyclopedias | Hawramani, muslimscholars.info | needs_permission | Permission drafts only; no scrape until approved |
| Relations | Same classical works + Wikidata P802/P1066 where verified | mixed | `narrator_relations` with source_url |

### 4. Empty chains (33)

| Subset | Count | Plan |
|---|---:|---|
| `raw_chain_text` looks like Dorar **attribution** (`راو \| المحدث \| المصدر`), not isnad | **26** | Do not split into `chain_narrators`. Parse into assessment/attribution fields or leave chain shell; log as `non_isnad_raw_text` |
| No `raw_chain_text` | **7** | Leave empty; fill only when Sanadset/API provides exact book+number chain — never invent |

Staging only until you approve (existing `reparse-chains-staging.ts` + relational refs).

### 5. Scholars / imams

| Gap | Source | Method |
|---|---|---|
| 12 Imams + 4 Sunni imams | Wikidata verified rebuild + optional `curated_seed` | Apply only accepted QIDs; curated seed: `provenance='curated_seed'`, `verified=false`, require `source_url` |
| Other 100 “Sunni” graders | — | Do not invent tradition; leave or NULL until sourced |
| Teachers/students/works | Wikidata claims / classical bios | Entity-linked when verified |

### 6. Books

| Gap | Source | Method |
|---|---|---|
| Author / Arabic title | Wikidata work + verified author human | Rebuilt `books-reference.json` only when `verified_via` present |
| Edition / volumes / counts | hadith-api info.json, Thaqalayn | Dry-run diffs first |
| `canonical_book_id` | Internal | Dedupe editions after titles verified |

### 7. Categories / lookups

| Gap | Source | Method |
|---|---|---|
| Category tree | Curated + cite classical topic schemes | Expand `categories.parent_id`; map hadiths after matn regroup |
| Grades (Shia + Sunni) | Extend `grade_lookup` | Add Muwaththaq, Qawi, Majhul, Thiqa, Saduq, Matruk, etc. with tradition scope notes |
| Hadith type / transmission | Curated lookup | Fill codes; backfill variations only with sourced labels |

### 8. Assessments provenance holes

| Table | Issue | Plan |
|---|---|---|
| `hadith_assessments` | `source_url` **0%** | Backfill from import payload / Dorar|sunnah URLs where legal; else NULL `verified` |
| `narrator_assessments` | Many from enrich script boilerplate “ثقة” | Quarantine/review fake assessments tied to boilerplate narrators in **018** dry-run (not 017) |
| `chain_assessments` | **0 rows** | Fill from sourced chain grades only |

---

## Suggested migration sequence (after you apply 017)

| ID | Purpose |
|---|---|
| **017** | Quarantine 922 + NULL + identity unverified + bio guard + `data_change_log` |
| **018** | Matn fingerprint + `hadith_id_remap` + topic move for first-wahi (draft variations) |
| **019** | Lookup expansions (grades/types); optional NULL unsourced scholar.tradition |
| later | RPC coverage object; verification suite |

---

## Coverage targets (post-plan, not yet done)

| Entity | Now | Near-term target after 017–018 + allow-listed collectors |
|---|---|---|
| Hadith (true matn clusters) | 5 topic buckets | 100s of draft clusters from fingerprint |
| Narrator bio sourced | 0 / 923 placeholders | 0 placeholders; bios only with URL |
| Narrator assessments real | ~31 narrators / 414 rows (many suspect) | Review boilerplate assessments |
| Chain assessments | 0% | Start from allow-listed grades only |
| Scholar tradition sourced | 0% provenance | 16 curated_seed/Wikidata imams first |

---

## Not done this step

- Collectors (dry-run or apply)  
- Applying 017  
- Matn regrouping SQL (018)  
- RPC / verification suite  
- Touching `chain_narrators`  

## Items needing your decision before C/D

1. Confirm commercial = **no** is correct.  
2. Apply 017 as drafted?  
3. After 017: quarantine/delete enrich-script narrator_assessments that used default “ثقة/صدوق” for the 922? (recommend yes in 018 dry-run)  
4. Proceed to matn regrouping migration 018 draft next?
