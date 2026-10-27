# Backup before applying migrations 006–010

`apply-migrations.ts --apply` **refuses to run** unless backup evidence exists under `data/backups/` (or you pass `--skip-backup-check`).

**Current status:** no `data/backups/` directory and `DATABASE_URL` unset — take a backup before apply.

## Option A — Supabase database branch (recommended)

1. Open [Supabase Dashboard](https://supabase.com/dashboard/project/ggmqufghubpgsquldjdx) → **Branches** (or **Project Settings → Database**).
2. Create a preview/persistent branch from production (or enable PITR if on Pro).
3. Note the branch name / restore point.
4. Locally:

```powershell
mkdir data\backups
Set-Content data\backups\BACKUP_OK.txt "Supabase branch: <branch-name-or-PITR-timestamp> $(Get-Date -Format o)"
```

## Option B — `pg_dump`

1. Put the Postgres connection string in `.env.local` as `DATABASE_URL` (Supabase → Project Settings → Database → URI; use the **direct** or session pooler URI with password).
2. Dump:

```powershell
mkdir data\backups
pg_dump $env:DATABASE_URL --format=custom --file="data/backups/ggmqufghubpgsquldjdx-pre-006-010.dump"
```

Or plain SQL:

```powershell
pg_dump $env:DATABASE_URL --format=plain --file="data/backups/ggmqufghubpgsquldjdx-pre-006-010.sql"
```

## Then apply

```powershell
npx tsx scripts/record-migration-counts.ts --label before-006-010
npx tsx scripts/apply-migrations.ts --from 006 --to 010 --apply
npx tsx scripts/record-migration-counts.ts --label after-006-010
```
