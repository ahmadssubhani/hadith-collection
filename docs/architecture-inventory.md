# Architecture inventory

Read-only snapshot of this repository for diagramming. Generated from source files, `package.json`, `database/`, `app/`, `scripts/`, and `lib/cron/`. No secrets are included (env **names** only).

---

## 1. Languages and frameworks

| Item | Detail |
|------|--------|
| Primary language | TypeScript / TSX |
| Other JS | One legacy Node script: `scripts/map-hadiths.js` (CommonJS) |
| Python | None in-repo |
| UI framework | **Next.js** `^15.5.2` (App Router) + **React** `^19.1.1` / `react-dom` |
| Language tooling | TypeScript `^5.9.2`, ESLint 9 + `eslint-config-next` |
| Database client | `@supabase/supabase-js`, `@supabase/ssr`, optional `pg` for transactional scripts |
| HTML/CSV tooling | `cheerio`, `csv-parse` |
| Icons | `lucide-react` |
| Script runner | `tsx` |
| Browser automation (dev) | `playwright` (scrapers / optional Sunnah fetch fallback) |
| Node version observed locally | **v24.15.0** (no `engines` / `.nvmrc` pinned in repo) |

**Runtime dependencies (`package.json`):** `@supabase/ssr`, `@supabase/supabase-js`, `cheerio`, `cookie`, `csv-parse`, `lucide-react`, `next`, `pg`, `react`, `react-dom`.

**Dev dependencies:** `@eslint/eslintrc`, `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom`, `eslint`, `eslint-config-next`, `playwright`, `tsx`, `typescript`.

---

## 2. Folder tree (2 levels) and purpose

```text
hadith-collection/
├── app/                 Next.js App Router pages + API routes
├── components/          React UI (hadith cards, chains, auth, First Wahi, etc.)
├── data/                Local review CSVs/JSON, Dorar dumps, screenshots, allowlists
├── data-templates/      CSV templates for bulk ingest (hadiths, chains, assessments…)
├── database/            schema.sql, migrations/, seed SQL
├── docs/                Architecture / project docs (this inventory)
├── lib/                 Shared server logic (queries, eligibility, cron, supabase, ingest)
├── public/              Static assets (images/)
├── scratch/             Ad-hoc dry-run stubs (empty / experimental)
├── scripts/             CLI ingestion, repair, eligibility, scrapers
├── .next/               Build output (generated; not source of truth)
└── node_modules/        Dependencies (generated)
```

**Top-level docs / config (files):** `README.md`, `TECH_STACK.md`, `DATA_INGESTION.md`, `DB_SETUP.md`, `package.json`, `next.config.ts`, `middleware.ts`, `vercel.json`, `eslint.config.mjs`, `tsconfig.json`, `.env.example`, `.env.local` (local only; not committed secrets for inventory).

---

## 3. Scripts and `lib/cron/` inventory

### 3.1 `scripts/`

| File | Purpose | Inputs | Outputs | Tables R/W | Dry-run default? | Status |
|------|---------|--------|---------|------------|------------------|--------|
| `load-env.ts` | Load `.env.local` / `.env` into `process.env` | Env files | — | — | N/A (helper) | **Used** by most scripts |
| `import-source.ts` | Validate + import CSV templates into corpus | `data-templates/*.csv` | Console; DB on `--apply` | R: scholars; W: books, hadiths, variations, narrators, chains, assessments, batches | **Yes** (unless `--apply`) | **Used** (`ingest`, `ingest:dry-run`) |
| `seed-first-wahi.ts` | Seed First Wahi books/scholars/narrators/variations | In-script seeds | Console; DB on `--apply` | W: books, scholars, hadiths, narrators, variations, chains, assessments | **Yes**; `--apply` needs `ALLOW_DAILY_PUBLISH=1` | **Used** (`seed:wahi`) |
| `daily-hadith-cron.ts` | CLI for daily batch preview/publish/status/topic | CLI flags; cron modules | Console; DB on `--apply` | R/W via `lib/cron/daily-ingest` (`daily_*`, hadiths, variations…) | **Yes** (preview); `--apply` needs `ALLOW_DAILY_PUBLISH=1` | **Used** |
| `ingest-all-first-wahi.ts` | Bulk fetch+dedupe+persist topic candidates | Topic slug; network fetchers | Console; DB on `--apply` | W via `persist-candidate` | **Yes**; `--apply` needs `ALLOW_BROAD_INGEST=1` | **Used** |
| `enrich-narrators-rijal.ts` | Deprecated seeded rijāl upsert | — | Exits immediately with deprecation message | None (guard before DB) | N/A | **Deprecated** (use Sunnah appraisal importers) |
| `check-first-wahi-eligibility.ts` | Print eligibility a–d; `--groups` uses merge plan | Supabase; optional `data/merge-plan.json` | Console | R: hadiths, source_variations, chains, chain_narrators, narrators, narrator_assessments | Read-only | **Used** |
| `dedupe-hadith.ts` | Matn duplicate detect + merge plan; `--apply` re-points `hadith_id` | Supabase; writes `data/duplicate-*.csv`, `merge-plan.json` | Reports + optional DB | R: variations, books, chains, assessments; W on apply: hadiths, source_variations, `hadith_merge_backup` | **Yes** | **Used** |
| `import-dorar-gradings.ts` | Parse local Dorar JSON → hadith_assessments | `data/dorar/*.json`, `scholar-aliases.csv` | `dorar-unmatched.csv`; DB on `--apply` | R: scholars, hadith_assessments; W: scholars, import_batches, raw_import_records, hadith_assessments | **Yes** | **Used** |
| `import-sunnah-appraisals-dry-run.ts` | Fetch Sunnah Critical Appraisals → review CSVs | Network / cached HTML in `data/raw` | `data/narrator-appraisals-review*.csv` | R: scholars, chains (mapping check) | Always dry (no assessment writes) | **Used** |
| `apply-sunnah-appraisals.ts` | Apply review CSV for Bukhari #3 (var 275) | CSV + aliases | Console; DB on `--apply --mapping-approved` | W: scholars, narrator_assessments | **Yes** | **Used** |
| `apply-sunnah-appraisals-batch2.ts` | Batch 2 appraisals Bukhari 1,2,4–7 + Ibn al-Mubarak | Network/raw HTML, CSVs | Review sheets; DB on apply | W: narrators, scholars, narrator_assessments | **Yes** | **Used** (not in package.json; run via `tsx`) |
| `map-bukhari-sunnah-isnads.ts` | Map Sunnah narrator links ↔ chain nodes | Sunnah pages / cache | Mapping JSON/CSV under `data/` | R: chains, narrators, assessments | Primarily report | **Used** (ad-hoc) |
| `publish-first-wahi.ts` | Publish allowlisted First Wahi variations | `publish-allowlist.json`, `hold-rows.json` | Console; DB on `--apply` | W: variations, chains, narrators, assessments (+ optional deploy hook) | **Yes** | **Used** |
| `repair-bukhari-chains.ts` | Rebuild Bukhari chain nodes from Arabic | Supabase + optional local bukhari.json | Console; DB on `--apply` | W: chains, chain_narrators, narrators | **Yes** | **Used** (ad-hoc repair) |
| `normalize-arabic.ts` | Demo Arabic search normalization | CLI strings | Console | — | N/A | **Used** (utility) |
| `match-narrators.ts` | Propose narrator matches | Supabase | Console | R: narrators, chain_narrators; W on `--apply` | **Yes** | **Used** |
| `propose-clusters.ts` | Propose cross-hadith cluster overlaps | Supabase (sample variations) | Console JSON | R: source_variations | Read-only | **Used** (heuristic helper) |
| `map-hadiths.js` | Map offline “9 books” JSON → `mapped-output/` | Hardcoded Downloads path + JSON books | `scripts/mapped-output/*.json` | — | N/A (offline transform) | **Legacy / local-path dependent** |
| `scrapers/hadith-scraper.ts` | Playwright scrape experiments (HadeethEnc / commented Sunnah) | Live URLs | Console | — | N/A | **Experimental / partially commented** |
| `scrapers/hadeethenc-scraper.ts` | Playwright HadeethEnc home scrape | Live URL | Console | — | N/A | **Experimental** |
| `scrapers/test-scraper.ts` | Playwright smoke (`example.com`) | Live URL | Console | — | N/A | **Dev smoke only** |

### 3.2 `lib/cron/`

| File | Purpose | Inputs | Outputs | Tables R/W | Dry-run? | Status |
|------|---------|--------|---------|------------|----------|--------|
| `daily-ingest.ts` | Orchestrate topic batch: fetch → rank → persist; status/topic helpers | Topic defs, env keys | Result objects; DB when apply | R/W: `daily_topics`, `daily_hadith_logs`, `daily_hadith_batch`, hadiths/variations via persist | Callers pass apply/dry | **Used** by CLI + API cron |
| `topics-registry.ts` | In-memory topic definitions + seeded candidates | Code constants | Topic / candidate structs | — | N/A | **Used** |
| `dedup.ts` | Deduplicate fetched candidates by text/id | Candidates | Unique list + drop log | — | N/A | **Used** |
| `persist-candidate.ts` | Upsert book/hadith/variation/chain/assessments for one candidate | Candidate + admin client | DB rows | W: books, hadiths, source_variations, chains, chain_narrators, narrators, assessments, import tables (as implemented) | When called with apply | **Used** |
| `relevance-ranker.ts` | Score candidates vs topic keywords | Raw candidates | Ranked list | — | N/A | **Used** |
| `fetchers/types.ts` | Shared fetcher/candidate TypeScript types | — | Types | — | N/A | **Used** |
| `fetchers/aggregator.ts` | Run all source fetchers | Topic | Aggregated candidates + health | — | N/A | **Used** |
| `fetchers/sunnah-fetcher.ts` | Bukhari candidates from local JSON or GitHub raw dataset | Local file paths / `raw.githubusercontent.com` | Candidates | — | N/A | **Used** (network or local) |
| `fetchers/dorar-fetcher.ts` | Dorar `dorar_api.json` search | `dorar.net` HTTP | Candidates | — | N/A | **Used** (often Cloudflare-blocked) |
| `fetchers/hadeethenc-fetcher.ts` | HadeethEnc public API search/detail | `hadeethenc.com/api/v1` | Candidates | — | N/A | **Used** (public API, no key) |
| `fetchers/thaqalayn-fetcher.ts` | Intended Thaqalayn fetch | Topic keywords | Empty / placeholder | — | N/A | **Stub / incomplete** |

---

## 4. Every npm script

| Script | Command |
|--------|---------|
| `dev` | `next dev` |
| `build` | `next build` |
| `start` | `next start` |
| `lint` | `eslint .` |
| `ingest` | `tsx scripts/import-source.ts` |
| `ingest:dry-run` | `tsx scripts/import-source.ts --dry-run` |
| `seed:wahi` | `tsx scripts/seed-first-wahi.ts` |
| `cron:daily` | `tsx scripts/daily-hadith-cron.ts` |
| `cron:status` | `tsx scripts/daily-hadith-cron.ts --status` |
| `cron:set-topic` | `tsx scripts/daily-hadith-cron.ts --set-topic` |
| `hadith:preview` | `tsx scripts/daily-hadith-cron.ts` |
| `cron:publish-daily` | `tsx scripts/daily-hadith-cron.ts --apply` (requires `ALLOW_DAILY_PUBLISH=1`) |
| `hadith:status` | `tsx scripts/daily-hadith-cron.ts --status` |
| `hadith:ingest-all` | `tsx scripts/ingest-all-first-wahi.ts` |
| `hadith:ingest-all:apply` | `tsx scripts/ingest-all-first-wahi.ts --apply` (requires `ALLOW_BROAD_INGEST=1`) |
| `hadith:eligibility` | `tsx scripts/check-first-wahi-eligibility.ts` |
| `hadith:eligibility:groups` | `tsx scripts/check-first-wahi-eligibility.ts --groups` |
| `hadith:dedupe` | `tsx scripts/dedupe-hadith.ts` |
| `hadith:dedupe:apply` | `tsx scripts/dedupe-hadith.ts --apply` |
| `hadith:dorar-import` | `tsx scripts/import-dorar-gradings.ts` |
| `hadith:dorar-import:apply` | `tsx scripts/import-dorar-gradings.ts --apply` |
| `hadith:sunnah-appraisals-dry` | `tsx scripts/import-sunnah-appraisals-dry-run.ts` |
| `hadith:sunnah-appraisals-apply` | `tsx scripts/apply-sunnah-appraisals.ts` |
| `hadith:publish-first-wahi` | `tsx scripts/publish-first-wahi.ts` |
| `hadith:publish-first-wahi:apply` | `tsx scripts/publish-first-wahi.ts --apply` |
| `normalize-arabic` | `tsx scripts/normalize-arabic.ts` |
| `match-narrators` | `tsx scripts/match-narrators.ts` |
| `propose-clusters` | `tsx scripts/propose-clusters.ts` |

---

## 5. Pages and API routes (`app/`)

### Pages

| Route | File | Data read |
|-------|------|-----------|
| `/` | `app/page.tsx` | `getEligibleFirstWahiStats`, `getFeaturedHadiths` → `hadiths` (+ variation counts), `getBooks` → `books`, `getEligibleFirstWahiVariations` → First Wahi cluster + variations/chains/assessments (eligibility filter); fallbacks from `lib/content/*` |
| `/published-clusters/first-wahi` | `app/published-clusters/first-wahi/page.tsx` | `getEligibleFirstWahiVariations` (eligible variations + chains + cited narrator assessments) |
| `/hadiths/[slug]` | `app/hadiths/[slug]/page.tsx` | `getHadithBySlug` → `hadiths`, `source_variations`, books, chains, assessments |
| `/hadiths/knowledge` | `app/hadiths/knowledge/page.tsx` | `getScholars` → `scholars` (+ static guide copy) |
| `/knowledge` | `app/knowledge/page.tsx` | Redirect → `/hadiths/knowledge` |
| `/search` | `app/search/page.tsx` | `getBooks`, `getScholars`, `searchHadiths` → hadiths/variations/filters |
| `/collections` | `app/collections/page.tsx` | `getBooks` → `books` (or static `HOME_COLLECTIONS`) |
| `/narrators` | `app/narrators/page.tsx` | Currently static / stub UI (original `getNarrators` path commented) |
| `/narrators/[slug]` | `app/narrators/[slug]/page.tsx` | `getNarratorBySlug` → `narrators`, `narrator_assessments`, chain appearances |
| `/about` | `app/about/page.tsx` | Static copy only |
| `/auth` | `app/auth/page.tsx` | Redirect → `/signin` |
| (layout/loading/404) | `layout.tsx`, `loading.tsx`, `not-found.tsx` | Layout chrome; no corpus queries |

Redirects in `next.config.ts`: `/hadiths/first-revelation-at-hira` and `/hadiths/first-wahi` → `/published-clusters/first-wahi`.

`middleware.ts`: refreshes Supabase auth session; allows listed public prefixes; protects non-public paths when session missing.

### API routes

| Route | File | Data / behavior |
|-------|------|-----------------|
| `GET /api/search` | `app/api/search/route.ts` | `searchHadiths` (same filters as search page) |
| `GET /api/narrators/[slug]/panel` | `app/api/narrators/[slug]/panel/route.ts` | `getNarratorPanelEvidence` (narrator + cited assessments + chain neighbors) |
| `GET|POST /api/cron/daily-hadith` | `app/api/cron/daily-hadith/route.ts` | Auth: `CRON_SECRET` or service role bearer / `?secret=`; runs `runDailyHadithIngest` / status |
| `GET|POST /api/cron/topic` | `app/api/cron/topic/route.ts` | List/register topics; POST needs cron auth; may update `daily_topics` via `setActiveTopic` |
| `GET /auth/callback` | `app/auth/callback/route.ts` | Supabase Auth code exchange (`auth.exchangeCodeForSession`); no scholarly tables |

---

## 6. Supabase

### Tables (from `database/schema.sql` + migrations)

| Table | Defined in | Notes |
|-------|------------|-------|
| `books` | schema.sql | RLS: public SELECT |
| `hadiths` | schema.sql | RLS: SELECT where `review_status = 'published'` |
| `source_variations` | schema.sql | RLS: SELECT where `verified = true`; migration 002 adds `arabic_search_text` |
| `narrators` | schema.sql | RLS: SELECT where `identity_status = 'verified'` |
| `chains` | schema.sql | RLS: SELECT where `verified = true` |
| `chain_narrators` | schema.sql | RLS: SELECT if parent chain verified |
| `scholars` | schema.sql | RLS: public SELECT |
| `hadith_assessments` | schema.sql | RLS: SELECT where `verified = true` |
| `chain_assessments` | schema.sql | RLS: SELECT where `verified = true` |
| `narrator_assessments` | schema.sql | RLS: SELECT where `verified = true` |
| `import_batches` | schema.sql | RLS on; **no** anon policies |
| `raw_import_records` | schema.sql | RLS on; **no** anon policies |
| `profiles` | migrations/003 | Auth-linked; own-row SELECT/INSERT/UPDATE |
| `daily_topics` | migrations/004 | Public SELECT |
| `daily_hadith_logs` | migrations/004 | Public SELECT |
| `daily_hadith_batch` | migrations/005 | Public SELECT |

**Row counts from schema files:** not available (DDL/seeds only). Seeds insert a small First Wahi sample set and one `daily_topics` row (`first-wahi`). Live corpus size is runtime/DB-only.

**Apply-time backup table (script-created, not in schema.sql):** `hadith_merge_backup` (from `dedupe-hadith.ts --apply`).

### RLS policy summary

- Anonymous read is gated by **published / verified** flags on scholarly content.
- Import tables are service-role only.
- Profiles are owner-scoped via `auth.uid()`.
- Daily cron tables are publicly readable.

### Edge functions

**None in this repository** (no `supabase/functions` or Edge Function sources). Auth uses hosted Supabase Auth from the Next.js app.

---

## 7. External sources (domains the code calls)

| Domain | Where | Auth method |
|--------|-------|-------------|
| `*.supabase.co` (project URL) | App + scripts via Supabase clients | Anon key (browser/SSR RLS); service-role key (scripts/admin); Auth session cookies |
| `sunnah.com` | Appraisal importers, `map-bukhari-sunnah-isnads`, scrapers (commented) | None (public HTTP); custom `User-Agent` bot string |
| `dorar.net` | `dorar-fetcher.ts` (`/dorar_api.json`) | None (public); browser-like headers; often Cloudflare 403 |
| `hadeethenc.com` | `hadeethenc-fetcher.ts` API `/api/v1/...`; scrapers | None (public JSON API / HTML) |
| `raw.githubusercontent.com` | `sunnah-fetcher.ts` Bukhari dataset fallback | None (public raw file) |
| `thaqalayn.net` | Cited in seeds/fallback URLs; fetcher is **stub** (no live API call implemented) | N/A |
| `example.com` | `scripts/scrapers/test-scraper.ts` | None |
| Deploy hook host (variable) | `publish-first-wahi.ts` POST `VERCEL_DEPLOY_HOOK_URL` | Hook URL itself is the secret |

Local-file-only paths (no network when used): `data/dorar/*.json` (Dorar import), optional local Bukhari JSON for Sunnah fetcher / repair scripts.

---

## 8. Env variable names and deployment

### Env names (values omitted)

| Name | Typical use |
|------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (public, RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server/scripts bypass RLS |
| `DATABASE_URL` | Direct Postgres for transactional `--apply` scripts |
| `CRON_SECRET` | Authorize `/api/cron/*` |
| `VERCEL_DEPLOY_HOOK_URL` | Optional redeploy after publish |
| `USERPROFILE` | Windows path helper in some scripts (local file lookup) |

Documented in `.env.example` / `DB_SETUP.md`: the first four names. Cron/deploy hook names appear in code only.

### Deployment configuration

| Item | Detail |
|------|--------|
| `vercel.json` | Present; `"crons": []` (no scheduled Vercel crons configured) |
| Git remote | `origin` → `https://github.com/ahmadssubhani/hadith-collection.git` |
| Hosting intent | Vercel + Supabase (see `TECH_STACK.md`) |

---

## 9. Cron / scheduled jobs

| Mechanism | Status |
|-----------|--------|
| Vercel Cron (`vercel.json`) | **Empty** — no schedules |
| GitHub Actions | **No `.github/workflows`** |
| App routes | `/api/cron/daily-hadith`, `/api/cron/topic` — intended for external schedulers (e.g. cron-job.org) or manual calls with `CRON_SECRET` |
| Local CLI | `npm run cron:*` / `hadith:preview` / `cron:publish-daily` (gated by `ALLOW_DAILY_PUBLISH=1`) |

---

## 10. Tests and CI

| Item | Status |
|------|--------|
| Automated unit/integration test suite | **None** (no Jest/Vitest/Playwright test runner config) |
| `scripts/scrapers/test-scraper.ts` | Manual Playwright smoke against `example.com` |
| CI (GitHub Actions / other) | **None in repo** |
| Quality gates locally | `npm run lint`, `npm run build` |

---

## Diagram-oriented summary

```text
Browser ──► Next.js (Vercel) ──► Supabase Postgres (RLS)
                │
                ├── lib/queries + first-wahi-eligibility (public reads)
                └── /api/cron/* (CRON_SECRET) ──► lib/cron/* ──► fetchers
                                                                  ├── sunnah (local/GitHub)
                                                                  ├── dorar.net
                                                                  ├── hadeethenc API
                                                                  └── thaqalayn (stub)

Local operator ──► scripts/* (tsx) ──► service role / DATABASE_URL
                     └── data/ + data-templates/ (offline review artifacts)
```
