-- Migration 014: align import_batches.permission_status with collectors manifest verdicts
-- APPLIED LIVE (2026-10-19). This file is the canonical sync of what is on the DB.
--
-- Live batch status (verified):
--   1, 3, 4, 6 → needs_permission   (Dorar scrape 1+4; Sunnah scrape 3+6)
--   2, 5       → allowed_with_conditions  (HadeethEnc)
--
-- Idempotent re-run is safe.

begin;

comment on column public.import_batches.permission_status is
  'Manifest-aligned: allowed | allowed_with_conditions | needs_permission | deny | unknown';

-- Dorar scrape batches → needs_permission
update public.import_batches
set permission_status = 'needs_permission',
    notes = case
      when coalesce(notes, '') like '%[014: dorar=needs_permission]%' then notes
      else coalesce(notes, '') || ' [014: dorar=needs_permission; ToS forbid scrape/bulk storage]'
    end
where id in (1, 4)
   or provider ilike '%dorar%'
   or coalesce(source_url, '') ilike '%dorar.net%';

-- Sunnah scrape batches → needs_permission (About §8: API required, HTML scrape forbidden)
update public.import_batches
set permission_status = 'needs_permission',
    notes = case
      when coalesce(notes, '') like '%[014: sunnah-scrape=needs_permission]%' then notes
      else coalesce(notes, '') || ' [014: sunnah-scrape=needs_permission; About §8 requires API, not HTML scrape]'
    end
where id in (3, 6)
   or provider ilike '%sunnah%'
   or coalesce(source_url, '') ilike '%sunnah.com%';

-- HadeethEnc → allowed_with_conditions
update public.import_batches
set permission_status = 'allowed_with_conditions',
    notes = case
      when coalesce(notes, '') like '%[014: hadeethenc=allowed_with_conditions]%' then notes
      else coalesce(notes, '') || ' [014: hadeethenc=allowed_with_conditions]'
    end
where id in (2, 5)
   or provider ilike '%hadeethenc%'
   or coalesce(source_url, '') ilike '%hadeethenc.com%';

-- Thaqalayn (if any batches) → allowed_with_conditions
update public.import_batches
set permission_status = 'allowed_with_conditions',
    notes = case
      when coalesce(notes, '') like '%[014: thaqalayn=allowed_with_conditions]%' then notes
      else coalesce(notes, '') || ' [014: thaqalayn=allowed_with_conditions; CC BY 4.0]'
    end
where provider ilike '%thaqalayn%'
   or coalesce(source_url, '') ilike '%thaqalayn%';

update public.import_batches
set permission_status = 'unknown'
where permission_status is null
   or trim(permission_status) = '';

commit;
