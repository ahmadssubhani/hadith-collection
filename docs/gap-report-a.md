# Gap report A — knowledge graph completeness (read-only)

Generated: 2026-10-19T08:51:24.359Z

## Summary

| Table | Rows |
|---|---|
| `hadiths` | 5 |
| `source_variations` | 1067 |
| `narrators` | 1128 |
| `chains` | 822 |
| `chain_narrators` | 1826 |
| `scholars` | 112 |
| `books` | 109 |
| `hadith_assessments` | 39 |
| `chain_assessments` | 0 |
| `narrator_assessments` | 414 |
| `name_aliases` | 3 |
| `narrator_relations` | 0 |
| `categories` | 8 |
| `hadith_categories` | 1 |
| `grade_lookup` | 7 |
| `hadith_type_lookup` | 4 |
| `chain_status_lookup` | 5 |
| `transmission_scope_lookup` | 3 |
| `import_batches` | 6 |
| `raw_import_records` | 1274 |

## Entity coverage

### Canonical hadiths vs variations
- Canonical `hadiths`: **5**
- `source_variations`: **1067** (≈213× per hadith)

| hadith_id | slug | variations | books | traditions |
|---|---|---|---|---|
| 4 | scraped-inbox-sunnah | 616 | 1 | Sunni |
| 1 | first-revelation-at-hira | 428 | 61 | Sunni, Twelver Shia |
| 2 | scraped-inbox-dorar | 15 | 11 | Sunni |
| 3 | scraped-inbox-hadeethenc | 6 | 1 | Sunni |
| 5 | combined-847 | 2 | 2 | Sunni |

**Problem:** Nearly all variations (~1067) hang off ~5 canonical hadiths. That collapses distinct matns into topic buckets (e.g. first-wahi), so get_hadith_full cannot mean 'this narration and its true parallels'.

**Proposed grouping:**
- **step1_text_fingerprint:** Compute normalized Arabic fingerprint (unaccent, strip honorifics/tashkeel) per variation; cluster near-duplicates as parallel narrations of one matn.
- **step2_cross_book_parallels:** Within a fingerprint cluster, keep one canonical_hadith row; link all book occurrences as source_variations of that hadith.
- **step3_topic_vs_matn:** Move current topic buckets to categories/hadith_categories (e.g. first-wahi). Do not use hadiths.id as a topic folder.
- **step4_manual_review:** Ambiguous clusters (shared only short phrases) go to data/unmatched/hadith-grouping-review.csv — never auto-merge across Shia/Sunni without shared Arabic core.
- **migration_hint:** 017+: add source_variations.matn_fingerprint + hadiths.grouping_method; backfill fingerprints; create new hadith rows for distinct clusters; re-point variation.hadith_id; preserve old topic via hadith_categories.

### Narrators
- Total: **1128** (clean 59 / fragment 341 / needs_review 728)
- With Arabic-script `arabic_name`: 61
- With `narrator_assessments`: 31
- With biography: 923 (source URL: 0)
- With death_year_ah: 923; generation: 923

### Suspicious bio/death/generation population
- Rows with any of bio/death/generation: **923**
- biography without source URL: see `missing_both_bio_provenance_fields` = **923**
- death_year_ah without biography_source_url: **923**
- generation without biography_source_url: **923**
- biography_source value counts: `{"(null)":923}`
- **Verdict:** If biography_source_url is empty for rows with biography/death/generation, treat as UNSOURCED placeholders until a collector attaches provenance. Do not treat identity_status=verified alone as source-backed bio.

### Chains / assessments / books / scholars / graph
- Chains: 822 (with nodes 789, empty 33); nodes 1826 (linked 1826, orphan 0)
- Hadith assessments: 39; narrator assessments: 414; chain assessments: 0
- Scholars: 112; Books: 109
- name_aliases: 3; narrator_relations: 0
- Categories: 8; grade_lookup codes: sahih, hasan, hasan_sahih, daif, mawdu, munkar, not_graded

## Column fill (selected critical gaps)

### source_variations
| column | filled | empty | % |
|---|---|---|---|
| translator | 428 | 639 | 40.1% |
| volume | 428 | 639 | 40.1% |
| page | 428 | 639 | 40.1% |
| hadith_type | 0 | 1067 | 0% |
| transmission_scope | 0 | 1067 | 0% |
| grade_code | 0 | 1067 | 0% |
| source_url | 1067 | 0 | 100% |

### narrators
| column | filled | empty | % |
|---|---|---|---|
| arabic_name | 61 | 1067 | 5.4% |
| kunya | 0 | 1128 | 0% |
| nisba | 0 | 1128 | 0% |
| laqab | 0 | 1128 | 0% |
| tradition | 0 | 1128 | 0% |
| biography_source_url | 0 | 1128 | 0% |
| tabaqah | 0 | 1128 | 0% |
| gender | 0 | 1128 | 0% |

### scholars
| column | filled | empty | % |
|---|---|---|---|
| arabic_name | 112 | 0 | 100% |
| madhhab | 0 | 112 | 0% |
| region | 0 | 112 | 0% |
| works | 0 | 112 | 0% |
| teachers | 0 | 112 | 0% |
| students | 0 | 112 | 0% |

### books
| column | filled | empty | % |
|---|---|---|---|
| arabic_title | 69 | 40 | 63.3% |
| author | 69 | 40 | 63.3% |
| category | 8 | 101 | 7.3% |
| publisher | 0 | 109 | 0% |
| edition | 0 | 109 | 0% |
| volumes | 0 | 109 | 0% |
| hadith_count | 0 | 109 | 0% |
| canonical_book_id | 29 | 80 | 26.6% |

### hadith_assessments
| column | filled | empty | % |
|---|---|---|---|
| normalized_grade | 39 | 0 | 100% |
| explanation | 39 | 0 | 100% |
| reference_book | 39 | 0 | 100% |
| source_url | 0 | 39 | 0% |
| verified | 39 | 0 | 100% |

### narrator_assessments
| column | filled | empty | % |
|---|---|---|---|
| normalized_term | 0 | 414 | 0% |
| explanation | 0 | 414 | 0% |
| reference_book | 69 | 345 | 16.7% |
| source_url | 414 | 0 | 100% |
| computed_summary | 0 | 414 | 0% |

### chain_narrators
| column | filled | empty | % |
|---|---|---|---|
| narrator_id | 1826 | 0 | 100% |
| transmission_word | 1826 | 0 | 100% |
| weak_link_reason | 0 | 1826 | 0% |

### narrator_relations
| column | filled | empty | % |
|---|---|---|---|
| source_url | 0 | 0 | 0% |
| verified | 0 | 0 | 0% |

## Source candidates (high level)

### hadith_text_and_numbering
- **fawazahmed0/hadith-api** (allow_with_conditions (Unlicense)): Sunni editions, numbers, grades in API
- **thaqalayn-api / thaqalayn.net** (allow_with_conditions (CC BY 4.0)): Shia Four Books texts/grades
- **hadeethenc.com** (allow_with_conditions): multi-language translations
- **sunnah.com API** (needs_permission until API key (HTML scrape forbidden)): Sunni text/numbering/grades
- **dorar.net API** (needs_permission): grades + Arabic snippets (cache TTL issue)

### narrator_rijal
- **Wikidata** (allow (CC0)): names, death/birth where P569/P570 exist — human+label+death gate
- **Sanadset 650K** (allow (CC BY 4.0)): missing chains only (exact book+number); NO auto aliases
- **Hawramani transmitters** (needs_permission): bio + jarh snippets
- **muslimscholars.info** (needs_permission): bio, teachers/students, grades
- **OpenITI rijal texts** (paused (NC until commercial clarified)): quoted classical rulings
- **Shamela / library PDFs (Tahdhib, Najashi, Tusi…)** (per-work check): narrator_assessments with book/vol/page

### scholars_imams
- **Wikidata verified rebuild** (allow): 23 accepted QIDs; fields from entity only

### books
- **Wikidata works + verified authors** (allow): title/author QID where accepted
- **thaqalayn / hadith-api info.json** (allow_with_conditions): edition metadata

### categories_lookups
- **curated lookup seeds + classical taxonomies** (project-curated with citation): grade/chain/type/scope codes; category tree

## Import permission status

- batch 1: `playwright-scrape:dorar` → **needs_permission**
- batch 3: `playwright-scrape:sunnah` → **needs_permission**
- batch 4: `playwright-scrape:dorar` → **needs_permission** (superseded)
- batch 6: `playwright-scrape:sunnah` → **needs_permission** (superseded)
- batch 2: `playwright-scrape:hadeethenc` → **allowed_with_conditions**
- batch 5: `playwright-scrape:hadeethenc` → **allowed_with_conditions** (superseded)

## Decisions needed

- Approve splitting topic-bucket hadiths into matn-fingerprint clusters (migration 017 proposal).
- Confirm commercial status before any OpenITI use.
- Decide unpublish vs keep-unpublished for Dorar (17) + Sunnah scrape (~623) variations under needs_permission batches.
- Treat unsourced narrator bio/death/generation as NULL-candidates in a later migration, or require source attach first?
- madhhab/tradition on scholars: leave null until Wikidata/source provides, or allow curated seed with provenance?

## Not done (this step)

- No migrations written (B/C next).
- No collectors applied.
- No RPC changes.
- No chain_narrators rewrites.

Full machine-readable dump: `data/unmatched/gap-report-a.json`.
