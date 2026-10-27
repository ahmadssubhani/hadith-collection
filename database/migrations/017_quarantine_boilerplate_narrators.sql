-- Migration 017: quarantine 922 boilerplate narrator bios; provenance guard; data_change_log
-- APPLIED BY USER after review. Do not auto-apply.
--
-- Boilerplate fingerprint (from live audit 2026-10-19):
--   biography = 'Transmitter recorded in early Hadith chains. Verified in classical Rijal registries.'
--   death_year_ah = 150
--   generation = 'Tabi''i'
-- Source of pollution: scripts/enrich-narrators-rijal.ts defaults (not classical registries).
-- KEEP id 764 (Al-Husayn b. Ahmad b. Idris) — distinct bio / death 330 / generation 'Shia Narrator'.
--
-- Also: data_change_log table for future data migrations.
-- Does NOT touch chain_narrators, does NOT delete narrators, does NOT rewrite name.

begin;

-- ---------------------------------------------------------------------------
-- 0) data_change_log (append-only audit of data migrations / bulk edits)
-- ---------------------------------------------------------------------------
create table if not exists public.data_change_log (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  migration_id text,
  table_name text not null,
  row_pk text not null,
  column_name text,
  old_value text,
  new_value text,
  reason text not null,
  actor text not null default 'migration'
);

create index if not exists data_change_log_table_idx
  on public.data_change_log (table_name, changed_at desc);

create index if not exists data_change_log_migration_idx
  on public.data_change_log (migration_id);

comment on table public.data_change_log is
  'Append-only log of bulk data changes. Prefer writing here before NULL/update in migrations.';

-- ---------------------------------------------------------------------------
-- 1) Quarantine backup of boilerplate rows (full snapshot of bio fields)
-- ---------------------------------------------------------------------------
create table if not exists public.narrator_boilerplate_quarantine_017 (
  narrator_id bigint primary key references public.narrators(id),
  name text,
  biography text,
  death_year_ah integer,
  generation text,
  identity_status text,
  name_quality text,
  quarantined_at timestamptz not null default now(),
  fingerprint text not null
);

comment on table public.narrator_boilerplate_quarantine_017 is
  'Backup of 922 placeholder bios before 017 NULL. Restore from here if needed.';

insert into public.narrator_boilerplate_quarantine_017 (
  narrator_id, name, biography, death_year_ah, generation, identity_status, name_quality, fingerprint
)
select
  n.id,
  n.name,
  n.biography,
  n.death_year_ah,
  n.generation,
  n.identity_status,
  n.name_quality,
  'bio=Transmitter recorded…; death=150; gen=Tabi''i'
from public.narrators n
where n.biography = 'Transmitter recorded in early Hadith chains. Verified in classical Rijal registries.'
  and n.death_year_ah = 150
  and n.generation = 'Tabi''i'
on conflict (narrator_id) do nothing;

-- Expect ~922 rows. Abort if surprise count.
do $$
declare
  n int;
begin
  select count(*)::int into n from public.narrator_boilerplate_quarantine_017;
  if n < 900 or n > 950 then
    raise exception
      'ABORT 017: quarantine count % outside expected ~922 window — review fingerprint before NULL',
      n;
  end if;
end $$;

-- Log quarantine inserts
insert into public.data_change_log (migration_id, table_name, row_pk, column_name, old_value, new_value, reason)
select
  '017',
  'narrators',
  q.narrator_id::text,
  'biography+death_year_ah+generation',
  left(coalesce(q.biography, ''), 200) || ' | death=' || coalesce(q.death_year_ah::text, '') || ' | gen=' || coalesce(q.generation, ''),
  'QUARANTINED',
  'boilerplate placeholder from enrich-narrators-rijal.ts defaults'
from public.narrator_boilerplate_quarantine_017 q;

-- ---------------------------------------------------------------------------
-- 2) NULL boilerplate bio fields (keep name, assessments, chain links)
-- ---------------------------------------------------------------------------
update public.narrators n
set
  biography = null,
  death_year_ah = null,
  generation = null
where exists (
  select 1 from public.narrator_boilerplate_quarantine_017 q where q.narrator_id = n.id
);

insert into public.data_change_log (migration_id, table_name, row_pk, column_name, old_value, new_value, reason)
select
  '017',
  'narrators',
  q.narrator_id::text,
  'biography',
  left(coalesce(q.biography, ''), 200),
  null,
  'NULL boilerplate biography'
from public.narrator_boilerplate_quarantine_017 q;

insert into public.data_change_log (migration_id, table_name, row_pk, column_name, old_value, new_value, reason)
select
  '017',
  'narrators',
  q.narrator_id::text,
  'death_year_ah',
  q.death_year_ah::text,
  null,
  'NULL boilerplate death_year_ah'
from public.narrator_boilerplate_quarantine_017 q;

insert into public.data_change_log (migration_id, table_name, row_pk, column_name, old_value, new_value, reason)
select
  '017',
  'narrators',
  q.narrator_id::text,
  'generation',
  q.generation,
  null,
  'NULL boilerplate generation'
from public.narrator_boilerplate_quarantine_017 q;

-- ---------------------------------------------------------------------------
-- 3) identity_status → unverified where there is no sourced identity
--    Rule: no biography_source_url => identity is not source-backed.
--    Keeps rows that already have a non-empty biography_source_url as-is.
--    Note: id 764 keeps distinctive biography/death/generation but still has no
--    biography_source_url, so identity_status becomes unverified until sourced.
-- ---------------------------------------------------------------------------
insert into public.data_change_log (migration_id, table_name, row_pk, column_name, old_value, new_value, reason)
select
  '017',
  'narrators',
  '*',
  'identity_status',
  count(*)::text || ' rows were not unverified',
  'unverified',
  'bulk: no biography_source_url — identity not sourced'
from public.narrators n
where (n.biography_source_url is null or trim(n.biography_source_url) = '')
  and n.identity_status is distinct from 'unverified';

update public.narrators n
set identity_status = 'unverified'
where (n.biography_source_url is null or trim(n.biography_source_url) = '')
  and n.identity_status is distinct from 'unverified';

-- ---------------------------------------------------------------------------
-- 4) Guard: biography requires biography_source_url (trigger; existing 764 allowed
--    until biography is edited without a URL)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_narrator_biography_provenance()
returns trigger
language plpgsql
as $$
begin
  if new.biography is not null and trim(new.biography) <> '' then
    if new.biography_source_url is null or trim(new.biography_source_url) = '' then
      raise exception
        'narrators.biography requires biography_source_url (migration 017 provenance guard)';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_narrator_biography_provenance on public.narrators;
create trigger trg_narrator_biography_provenance
  before insert or update of biography, biography_source_url
  on public.narrators
  for each row
  execute function public.enforce_narrator_biography_provenance();

comment on function public.enforce_narrator_biography_provenance() is
  'Rejects biography text without biography_source_url. Added in migration 017.';

-- ---------------------------------------------------------------------------
-- 5) Sanity: boilerplate bios gone; real row 764 still present
-- ---------------------------------------------------------------------------
do $$
declare
  leftover int;
  keep_bio text;
begin
  select count(*)::int into leftover
  from public.narrators
  where biography = 'Transmitter recorded in early Hadith chains. Verified in classical Rijal registries.'
    and death_year_ah = 150
    and generation = 'Tabi''i';
  if leftover <> 0 then
    raise exception 'ABORT 017: % boilerplate rows still present after NULL', leftover;
  end if;

  select biography into keep_bio from public.narrators where id = 764;
  if keep_bio is null or keep_bio not like 'Al-Husayn ibn Ahmad ibn Idris%' then
    raise exception 'ABORT 017: narrator 764 real biography missing or unexpected';
  end if;
end $$;

commit;
