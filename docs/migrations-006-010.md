# Migrations 006–010 (Steps 2–3) — review before apply

**Not applied.** Requires `DATABASE_URL` (direct Postgres). Collectors are out of scope.

## Exact integrity re-check (before any migration)

| Metric | Exact count |
|--------|-------------|
| Orphan chains | **0** |
| Dangling narrator refs | **0** |
| Orphan chain_narrators | **0** |
| Chains with no nodes | **33** (priority after jarh wa taʿdīl) |
| Variations with no chain | **247** |
| Narrators with no assessment | **1,097** (priority #1 for collectors) |

Audit’s 67 / 234 / 141 figures were PostgREST 1000-row skew — do not base migrations on them.

## Files (apply in order)

| # | File | Purpose |
|---|------|---------|
| 006 | `database/migrations/006_search_extensions.sql` | `pg_trgm`, `unaccent`, `arabic_search_text` + triggers/indexes (pending 002) |
| 007 | `database/migrations/007_provenance_book_kind.sql` | `data_origin`, variation `review_status` (existing stay draft), `attribution_*`, `book_kind` + metadata cols, import supersession 4–6, `canonical_scholar_id` |
| 008 | `database/migrations/008_lookups_bio_aliases.sql` | categories M2M, grade/type/chain/mutawatir lookups, `name_aliases`, narrator/scholar bio cols, teacher/student graph, `is_weak_link`, `computed_summary`, FTS |
| 009 | `database/migrations/009_data_fixes_tradition_bukhari_scholars.sql` | tradition fixes, Ibn Hajar merge, Bukhari stub repoint |
| 010 | `database/migrations/010_get_full_rpcs.sql` | `get_hadith_full(text)`, `get_narrator_full(text)` |

## Hard rules honored

- No truncate / drop / delete of existing rows  
- No bulk change of `verified` or hadith `review_status=published`  
- New variation `review_status` defaults to **draft** for existing rows  
- Conflicting grades stay as separate assessment rows  
- Rows marked superseded / stub / alias instead of deleted  

## How to apply (when approved)

```bash
# 1) Snapshot counts
npx tsx scripts/record-migration-counts.ts --label before-006

# 2) Apply one file at a time (or use helper)
npx tsx scripts/apply-migrations.ts --file database/migrations/006_search_extensions.sql --apply
npx tsx scripts/record-migration-counts.ts --label after-006

# … repeat for 007–010 …

# Or all pending:
npx tsx scripts/apply-migrations.ts --from 006 --to 010 --apply
```

Dry-run (prints SQL paths only):

```bash
npx tsx scripts/apply-migrations.ts --from 006 --to 010
```

## Post-apply priority (Step 4 collectors — later)

1. Narrator jarh wa taʿdīl for **1,097** without assessments  
2. Fill **33** chains with no nodes  
3. Chains for **247** variations without chains  

## Logs

- `docs/tradition-fixes.md`  
- `docs/bukhari-repoint-log.md`  
- `data/migration-counts/*.json` (created on apply)
