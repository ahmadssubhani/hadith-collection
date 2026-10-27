# Collectors (Steps 4)

Dry-run by default. Pass `--apply` to write. Every write goes through `import_batches` + `raw_import_records` when possible; assessments / relations stay `verified=false` until you review.

## Migrations to apply first (your side)

1. Confirm **011** matches live (synced in repo: `#variable_conflict use_column`, service_role-only grants).
2. Apply **012**: `database/migrations/012_collection_books_unaccent_reresolve.sql`  
3. Apply **013**: `database/migrations/013_attribution_parse_fixes.sql`  
   (Ad-Daarimi match, ` - ` split, skip non-book noise, Kubra/Khuzaymah/Daraqutni books; re-resolve).  
   Then: `npm run collect:attribution-gaps` → `data/unmatched/attribution-fragments.csv`.

## npm scripts

| Script | Collector |
|--------|-----------|
| `npm run collect:rijal` / `:apply` | A — jarh wa taʿdīl + bio from CSVs |
| `npm run collect:relations` / `:apply` | B — teacher/student edges |
| `npm run collect:chains` / `:apply` | C — empty chains + chain_assessments |
| `npm run collect:scholars` / `:apply` | D — madhhab imams, 12 Imams, compilers |
| `npm run collect:books` / `:apply` | E — book tradition/category metadata |
| `npm run collect:gaps` | Refresh `docs/db-gaps.md` |

## Source drop folders

| Path | Used by |
|------|---------|
| `data/collectors/rijal/*.csv` | A (+ existing appraisal CSVs) |
| `data/collectors/relations/*.csv` | B |
| `data/collectors/chain-assessments/*.csv` | C |
| `data/collectors/scholars-reference.json` | D |
| `data/collectors/books-reference.json` | E |

Unmatched → `data/unmatched/*.csv`.

## Priority after 012

1. Fill jarh wa taʿdīl for narrators with none (~1,097).
2. Chains with no nodes (~33) and variations with no chain (~247).
3. `chain_assessments` (still empty until sourced CSV/Dorar import).
