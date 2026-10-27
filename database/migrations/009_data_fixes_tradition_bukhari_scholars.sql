-- Migration 009: tradition corrections, Bukhari stub repoint (with collision abort), Ibn Hajar merge
-- No deletes. Logs: docs/tradition-fixes.md, docs/bukhari-repoint-log.md
-- Requires 007 + 008.

begin;

-- ---------------------------------------------------------------------------
-- A) Books 7–16 → Twelver Shia
-- ---------------------------------------------------------------------------
update public.books
set tradition = 'Twelver Shia'
where id between 7 and 16
  and tradition is distinct from 'Twelver Shia';

-- ---------------------------------------------------------------------------
-- B) Majlisi + Behbudi → Twelver Shia
-- ---------------------------------------------------------------------------
update public.scholars
set tradition = 'Twelver Shia'
where id in (2, 3)
  and tradition is distinct from 'Twelver Shia';

-- ---------------------------------------------------------------------------
-- C) Clear Sunni scholars only (ids from pre-apply review). Ambiguous left NULL.
-- Flagged leave-null: 43, 44, 85, 86, 88, 89, 112
-- ---------------------------------------------------------------------------
update public.scholars
set tradition = 'Sunni'
where tradition is null
  and id between 12 and 112
  and id not in (43, 44, 85, 86, 88, 89, 112)
  and slug like 'sunnah-%';

-- ---------------------------------------------------------------------------
-- D) Ibn Hajar merge: NO DELETE
--    - id 7 = canonical (kept)
--    - id 1 kept as row; only sets canonical_scholar_id = 7
--    - repoint FKs: hadith_assessments, narrator_assessments, chain_assessments
-- ---------------------------------------------------------------------------
update public.scholars
set canonical_scholar_id = 7
where id = 1
  and (canonical_scholar_id is null or canonical_scholar_id is distinct from 7);

update public.hadith_assessments ha
set scholar_id = 7
where ha.scholar_id = 1
  and not exists (
    select 1 from public.hadith_assessments x
    where x.variation_id = ha.variation_id
      and x.scholar_id = 7
      and x.original_grade = ha.original_grade
  );

update public.narrator_assessments na
set scholar_id = 7
where na.scholar_id = 1
  and not exists (
    select 1 from public.narrator_assessments x
    where x.narrator_id = na.narrator_id
      and x.scholar_id = 7
      and x.original_term = na.original_term
  );

update public.chain_assessments ca
set scholar_id = 7
where ca.scholar_id = 1
  and not exists (
    select 1 from public.chain_assessments x
    where x.chain_id = ca.chain_id
      and x.scholar_id = 7
  );

insert into public.name_aliases (entity_type, entity_id, alias, alias_normalized, script, source_name)
values
  ('scholar', 7, 'Ibn Hajar al-Asqalani', lower('Ibn Hajar al-Asqalani'), 'en', 'merge:scholar-1'),
  ('scholar', 7, 'ibn-hajar', 'ibn-hajar', 'en', 'merge:scholar-1-slug'),
  ('scholar', 7, 'ابن حجر العسقلاني', 'ابن حجر العسقلاني', 'ar', 'scholar-7')
on conflict (entity_type, entity_id, alias) do nothing;

-- ---------------------------------------------------------------------------
-- E) Bukhari stub → canonical book 27, with collision pre-check ABORT
-- ---------------------------------------------------------------------------
do $$
declare
  collision_count int;
  collision_sample text;
begin
  select count(*)::int, string_agg(fmt, '; ' order by fmt)
  into collision_count, collision_sample
  from (
    select format(
      'stub_book=%s var=%s proposed_number=%s collides_with_var=%s',
      b.id,
      sv.id,
      coalesce(nullif(trim(sv.hadith_number), ''), nullif(trim(both ',' from substring(b.title from 'Sahih al-Bukhari\s+(.+)$')), '')),
      existing.id
    ) as fmt
    from public.source_variations sv
    join public.books b on b.id = sv.book_id
    join public.source_variations existing
      on existing.book_id = 27
     and existing.id <> sv.id
     and trim(coalesce(existing.hadith_number, '')) =
         trim(coalesce(
           nullif(trim(sv.hadith_number), ''),
           nullif(trim(both ',' from substring(b.title from 'Sahih al-Bukhari\s+(.+)$')), '')
         ))
    where b.book_kind = 'hadith_number_stub'
      and b.title ~* '^Sahih al-Bukhari [0-9]'
  ) x;

  if coalesce(collision_count, 0) > 0 then
    raise exception
      'ABORT Bukhari repoint: % (book_id, hadith_number) collision(s) against canonical book 27. Sample: %',
      collision_count,
      left(coalesce(collision_sample, ''), 500);
  end if;
end $$;

update public.source_variations sv
set
  attribution_text = coalesce(sv.attribution_text, b.title),
  hadith_number = coalesce(
    nullif(trim(sv.hadith_number), ''),
    nullif(trim(both ',' from substring(b.title from 'Sahih al-Bukhari\s+(.+)$')), '')
  ),
  book_id = 27
from public.books b
where sv.book_id = b.id
  and b.book_kind = 'hadith_number_stub'
  and b.title ~* '^Sahih al-Bukhari [0-9]'
  and sv.book_id is distinct from 27;

update public.books
set canonical_book_id = 27
where book_kind = 'hadith_number_stub'
  and title ~* '^Sahih al-Bukhari [0-9]'
  and (canonical_book_id is null or canonical_book_id is distinct from 27);

update public.source_variations sv
set
  attribution_text = coalesce(sv.attribution_text, b.title),
  attribution_book_id = b.id
from public.books b
where sv.book_id = b.id
  and b.book_kind = 'attribution_string'
  and sv.attribution_text is null;

commit;
