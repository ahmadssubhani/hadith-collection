# Database audit (Step 1 — read-only)

**Project:** `ggmqufghubpgsquldjdx`  
**Generated:** 2026-10-16T11:11:05Z (live Supabase via service role)  
**Scope:** Inspect only. No schema or data changes.  
**Raw dump:** `data/db-audit-raw.json` (from `scripts/_db-audit.ts`)

---

## Executive summary

| Signal | Finding |
|--------|---------|
| Core content tables | Present and populated for First Wahi + scrape inboxes |
| Canonical “one hadith = one topic page” | Only **5** `hadiths` rows; **1,067** `source_variations` hang off them |
| `chain_assessments` | **0 rows** (empty) |
| Narrator jarh wa taʿdīl coverage | **31 / 1,128** narrators have any assessment (**1,097** with none) |
| Tradition hygiene | **~10** clear Twelver Shia books tagged `Sunni`; **2** Shia scholars tagged `Sunni`; **101/112** scholars have `tradition = null` |
| HadeethEnc “books” | **~44** titles are attribution strings (`Narrated by…`), not real books |
| Sunnah scrape book pollution | **~28** “books” are single-hadith titles like `Sahih al-Bukhari 7387,` |
| Lookup / category / alias tables | **Missing** (`categories`, `hadith_categories`, `name_aliases`, teacher/student graphs, grade lookup, etc.) |
| One-lookup RPCs | `get_hadith_full` / `get_narrator_full` **do not exist** |
| Search helpers | `pg_trgm` indexes exist on some text columns; migration `002` (`arabic_search_text`, `unaccent`) **not applied** live |
| Duplicates | **2** `(book_id, hadith_number)` dup groups; **14** repeated `source_url` groups (many are chapter URLs, not per-hadith) |

**Verdict:** The graph for First Wahi is partially connected (variations → chains → narrators → some assessments), but the DB is **not** complete for “give a name → return everything.” Category taxonomy, classification lookups, aliases, scholar/narrator bios, chain assessments, and unified search/RPC layers are largely absent or empty. Data quality issues (wrong tradition, attribution-as-book, scholar null tradition) should be fixed additively before bulk collectors.

---

## 1. Row counts (live)

| Table | Rows | Notes |
|-------|------|-------|
| `books` | 101 | Almost all `tradition=Sunni`; see §4 |
| `hadiths` | 5 | 1 curated + 3 scrape inboxes + 1 combine buffer |
| `source_variations` | 1,067 | 1,066 `verified=true` |
| `narrators` | 1,128 | 954 `identity_status=verified` |
| `chains` | 822 | 183 `verified=true` |
| `chain_narrators` | 1,826 | All have `transmission_word` filled (0 null) |
| `scholars` | 112 | Only 11 with non-null tradition |
| `hadith_assessments` | 39 | All verified |
| `chain_assessments` | **0** | Empty |
| `narrator_assessments` | 414 | All verified; cover only ~31 narrators |
| `import_batches` | 6 | All scrape imports; `permission_status=unknown` |
| `raw_import_records` | 1,274 | Dorar/HadeethEnc/Sunnah JSONL imports (duplicated batches) |
| `daily_topics` | 1 | `first-wahi` |
| `daily_hadith_logs` | 5 | Linked to daily topic runs |
| `daily_hadith_batch` | 1 | Present |
| `profiles` | 0 | Empty |
| `hadith_merge_backup` | 0 | Empty |

### Variations by parent hadith

| hadith_id | slug | variations |
|-----------|------|------------|
| 1 | `first-revelation-at-hira` | 428 |
| 2 | `scraped-inbox-dorar` | 15 |
| 3 | `scraped-inbox-hadeethenc` | 6 |
| 4 | `scraped-inbox-sunnah` | 616 |
| 5 | `combined-847` | 2 |

---

## 2. What each table holds (and emptiness)

### `books`
Canonical / pseudo-canonical collection titles used by variations.

| Column / aspect | Status |
|-----------------|--------|
| `title` | Always filled |
| `arabic_title` | **40 / 101** missing |
| `author` | **40 / 101** missing (many `-` or `Canonical Compiler`) |
| `tradition` | Filled, but often **wrong** (see §4) |
| `book_type` | Always `hadith_collection` — no Sahih/Sunan/Musnad/rijal/sharh taxonomy |
| `publisher` / `edition` / `volumes` / `hadith_count` / `category` | **Columns do not exist** |

### `hadiths`
Logical works / topic pages.

| Column | Status |
|--------|--------|
| `slug`, `title` | Filled |
| `arabic_title` | Only on First Wahi; null on 4 inbox/combine rows |
| `topics` | `text[]` only — **no** normalized category table / M2M |
| `review_status` | All 5 = `published` |

Topics today are ad-hoc arrays (`first-wahi`, `scraped`, `inbox`, …), not a controlled vocabulary.

### `source_variations`
Concrete citations (book + number + text + URL).

| Column | Empty / weak |
|--------|----------------|
| `hadith_number` | 0% empty |
| `source_url` | 0% empty |
| `arabic_text` | 0.1% empty (1 row) |
| `english_text` | 1.6% empty (17) |
| `chapter` | **59.3%** empty |
| `volume` / `page` / `translator` | **~60%** empty each |
| `status_notes` | 20.8% empty |
| `hadith_status` | **623** `not_graded`, **23** `sahih`, 0 hasan/daif/mawdu/munkar in enum counts |
| `tradition` column | **Does not exist** (tradition only via `books`) |
| `arabic_search_text` | **Column missing live** (migration `002` not applied) |

**247** variations have **no** chain row.

### `chains` / `chain_narrators`
Isnads linked to variations.

| Check | Count |
|-------|-------|
| Chains total | 822 |
| `continuity_status = muttasil` | 183 |
| `continuity_status = unverified` | 639 |
| Chains with **zero** `chain_narrators` nodes | **141** |
| Orphan chains (`variation_id` not in variations sample) | **67** (see method note below) |
| Unresolved nodes (`narrator_id` null) | 0 in sampled rows |
| Dangling `narrator_id` refs | **234** (method note: PostgREST 1000-row default may inflate) |
| `transmission_word` null | **0 / 1,826** |
| Chains with any `chain_assessments` | **0** |

Method note: several client-side orphan/dup scans used `.limit(1000–5000)` against PostgREST’s default max-rows (~1000). Exact `count` queries are authoritative; orphan/dangling figures should be re-verified with SQL `NOT EXISTS` in Step 3.

### `narrators`

| Column | Null / empty |
|--------|----------------|
| `arabic_name` | 12.8% null (144) |
| `birth_year_ah` | **100%** null |
| `death_year_ah` / `region` / `generation` / `biography` | **18.2%** null each (205) |
| `generation` values | Almost all non-null rows look like `Tabi'i`-style scrape tags; **0** Sahabi / Companion hits on simple probes |
| `alternative_names` | Nearly empty (~993/1000 sample empty) |
| `kunya`, `nisba`, `gender`, `tradition`, `normalized_name` | **Columns do not exist** |
| Teachers / students graph | **No tables** |

### `scholars`

| Aspect | Status |
|--------|--------|
| Seeded graders | Ibn Hajar (duped as id 1 + 7), Yahya ibn Maʿin, Abu Hatim, Nasaʾi, Dhahabi, Najashi, Tusi, Khoei |
| Mis-tagged | **Allamah al-Majlisi** and **Muhammad Baqir al-Behbudi** = `Sunni` (should be Twelver Shia) |
| `tradition` null | **101 / 112** (mostly sunnah.com-imported Arabic grader names) |
| `kunya`, `laqab`, `madhhab`, `region`, Gregorian dates, teachers/students/works | **Missing columns / tables** |
| Birth/death AH | Filled for curated rows 4–11; null for scrape imports |

### Assessments

| Table | Rows | Gap |
|-------|------|-----|
| `hadith_assessments` | 39 | Sparse vs 1,067 variations; grades not merged (good); no classification taxonomy table |
| `chain_assessments` | **0** | Entire category empty |
| `narrator_assessments` | 414 | Only **31** narrators covered; no page/volume on many; no separate “computed summary” field (only `display_score` / unused `narrators.summary_score`) |

### Import / daily

| Table | Status |
|-------|--------|
| `import_batches` | 6 batches; providers `playwright-scrape:{dorar,hadeethenc,sunnah}`; license/permission largely `unknown`; batches 1–3 duplicated by 4–6 |
| `raw_import_records` | 1,274 payloads retained |
| `daily_topics` | 1 active (`first-wahi`) with Arabic title, description, keywords |
| `daily_hadith_logs` / `daily_hadith_batch` | Present; keep and link — do not drop |

---

## 3. Duplicates

### `(book_id, hadith_number)` — exact collision groups: **2**

| Key | Variation IDs |
|-----|----------------|
| `70\|3318` (صحيح الترمذي) | 848, 1477 |
| `69\|6/373` (عارضة الأحوذي) | 847, 1476 |

These match the combine buffer title on hadith `combined-847`.

### Repeated `source_url` — **14** groups (examples)

Many are **chapter** URLs reused for many hadiths (not true per-hadith duplicates):

| URL | Approx. rows |
|-----|--------------|
| `https://sunnah.com/bukhari/97` | 183 |
| `https://sunnah.com/bukhari/92` | 81 |
| `https://sunnah.com/bukhari/96` | 77 |
| `https://sunnah.com/bukhari/93` | 56 |
| Dorar search URL (بدء الوحي) | 15 |
| Some HadeethEnc hadith URLs | 2 each |

Dedup key for future collectors should remain **`(source, source_url, hadith_number)`** (or book_id + number), not URL alone.

---

## 4. Wrong tradition labels

### Books titled as Twelver Shia / Thaqalayn corpus but tagged `Sunni` (at least 10)

| id | title | live tradition |
|----|-------|----------------|
| 7 | Man Lā Yaḥḍuruh al-Faqīh | Sunni |
| 8 | Al-Khiṣāl | Sunni |
| 9 | Al-Amālī | Sunni |
| 10 | Al-Kāfi | Sunni |
| 11 | Faḍaʾil al-Shīʿa | Sunni |
| 12 | Kitāb al-Ghayba | Sunni |
| 13 | Kāmil al-Ziyārāt | Sunni |
| 14 | ʿUyūn akhbār al-Riḍā | Sunni |
| 15 | Kitāb al-Muʾmin | Sunni |
| 16 | Maʿānī al-ʾAkhbār | Sunni |

Only **Nahj al-Balāgha** (id 17) is correctly `Twelver Shia` among this set.

**Books tradition buckets:** Sunni **100**, Twelver Shia **1**.

### Scholars mislabeled

| id | name | live | expected |
|----|------|------|----------|
| 2 | Allamah al-Majlisi | Sunni | Twelver Shia |
| 3 | Muhammad Baqir al-Behbudi | Sunni | Twelver Shia |

Also: duplicate Ibn Hajar rows (id **1** Latin-only vs id **7** with Arabic + years).

---

## 5. HadeethEnc / scrape “books” that are not books

### Attribution strings (~44) — examples

Titles like:

- `Narrated by Bukhari & Muslim`
- `Agreed upon`
- `Narrated by At-Tirmidhi and Ibn Mājah`
- `Al-Bukhari as Mu‘allaq/hanging… - Narrated by Muslim`

These should become **citation/attribution metadata on variations** (or a separate attribution field), not `books` rows.

### Single-hadith “books” from Sunnah scrape (~28)

Titles such as `Sahih al-Bukhari 7387,` — should collapse into book **Sahih al-Bukhari** + `hadith_number`.

### Rough split of 101 books

| Kind | Approx. count |
|------|----------------|
| Attribution strings | 44 |
| Per-number Bukhari titles | 28 |
| Real-ish collections / commentaries | ~29 (still includes some hybrid strings) |

---

## 6. Category checklist vs current state

| # | Category (from goal) | Status |
|---|----------------------|--------|
| 1 | Hadith categories/topics (Arabic title, description, keywords, parent, M2M) | **Missing tables.** Only `hadiths.topics text[]` + `daily_topics` (1 row). No parent tree, no M2M. |
| 2 | Classification: grade / type (marfūʿ…) / chain status / mutawātir·āḥād | **Partial enums as free text** on variations/chains; **no lookup tables**; type & mutawātir fields absent. |
| 3 | Imams/scholars (madhhab imams, compilers, 12 Imams, graders) with full bio fields | **Partial** scholars list; missing kunya/laqab/madhhab/region/Gregorian/teachers/students/works/aliases; many tradition null; Shia compilers incomplete. |
| 4 | Narrators (rawis) full bio + aliases + tradition | **Partial** names; birth AH always null; almost no aliases; no gender/tradition/kunya/nisba columns; no teacher/student tables. |
| 5 | Jarh wa taʿdīl per scholar | **Partial** (414 rows / 31 narrators); exact wording stored; source book/page often thin; no clearly labeled computed-summary field separate from display_score. |
| 6 | Chains with ordered links, link types, continuity, weak flags, variation FK | **Partial**: order + `transmission_word` present; continuity mostly `unverified`; **no** weak-link flag column; **no** chain assessments. |
| 7 | Books Sunni/Shia with category, volumes, counts, edition | **Partial titles**; wrong traditions; no category/volumes/edition/publisher columns; attribution pollution. |
| 8 | Hadith + chain assessments | Hadith assessments sparse; **chain_assessments empty**. |
| 9 | Daily topics / logs / batch / import tracking | **Present** — keep and link; do not drop. |

### Confirmed missing relations / objects (live PostgREST)

`categories`, `hadith_categories`, `topics` (normalized), `hadith_topics`, `name_aliases`, `narrator_teachers`, `narrator_students`, `grade_lookup`, RPCs `get_hadith_full` / `get_narrator_full`.

---

## 7. Search / one-lookup readiness

| Feature | Live? |
|---------|-------|
| `pg_trgm` on some `arabic_text` / `english_text` / `narrators.name` / (planned) titles | Indexes in `schema.sql`; title trgm + `arabic_search_text` from `002` **not confirmed live** |
| `unaccent` extension | Not confirmed |
| `normalized_name` on hadiths/narrators/scholars | Missing |
| `name_aliases` table | Missing |
| Full-text (tsvector) Arabic+English | Missing |
| `get_hadith_full(query)` / `get_narrator_full(query)` | Missing |
| API routes for slug/search | Not part of this audit (app code); RPC backend absent |

---

## 8. Provenance hygiene

| Issue | Detail |
|-------|--------|
| Import batches | Scrape-only; `permission_status=unknown`; duplicate batch pairs for same JSONL |
| New-row policy | Goal requires `verified=false` / `review_status=draft` until review — many scrape variations were later published/verified for inbox display |
| Gaps logging | No systematic `data/unmatched/*.csv` / `docs/db-gaps.md` yet (Step 4 deliverable) |

---

## 9. Recommended next steps (awaiting your approval — not started)

When you approve Step 1:

1. **Additive migrations only** — lookup tables, missing columns, FKs, indexes, aliases, search helpers; **no truncate/drop** of existing rows.
2. **Corrective updates** (still additive / non-destructive): fix tradition on known Shia books/scholars; reclassify attribution “books” into metadata without deleting historical FKs (e.g. soft `book_kind` + redirect).
3. **Collectors** under `scripts/collectors/` with dry-run default and `--apply`.
4. **RPCs + API + tests** for one-lookup access.
5. **`docs/db-gaps.md`** after first collector pass.

---

## Appendix A — Hadith rows (all)

1. `first-revelation-at-hira` — curated First Wahi  
2. `scraped-inbox-dorar`  
3. `scraped-inbox-hadeethenc`  
4. `scraped-inbox-sunnah`  
5. `combined-847` — combine/dedupe buffer  

## Appendix B — Audit tooling

```bash
npx tsx scripts/_db-audit.ts          # → data/db-audit-raw.json
npx tsx scripts/_probe-lookups.ts     # column / table existence
npx tsx scripts/_probe-lookups2.ts    # RPC + tradition samples
npx tsx scripts/_probe-counts.ts      # exact per-hadith counts
```

---

**Stop here.** No migrations, collectors, or data writes until you approve this audit.

---

## Addendum — exact orphan re-verify (2026-10-16, post-approval)

Paginated full-table reads (no PostgREST 1000-row skew) corrected:

| Metric | Original audit | Exact |
|--------|----------------|-------|
| Orphan chains | 67 | **0** |
| Dangling narrator refs | 234 | **0** |
| Chains with no nodes | 141 | **33** |
| Variations without chains | 247 | **247** |

See `docs/migrations-006-010.md` for Steps 2–3 SQL (not applied until you confirm).
