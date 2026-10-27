-- Migration 006: search extensions + arabic_search_text (applies pending 002 content + unaccent)
-- Additive only. Does not change verified/review_status flags.
-- Record counts before/after via scripts/record-migration-counts.ts

begin;

create extension if not exists pg_trgm;
create extension if not exists unaccent;

alter table public.source_variations
  add column if not exists arabic_search_text text;

create or replace function public.refresh_arabic_search_text()
returns trigger
language plpgsql
as $$
begin
  new.arabic_search_text :=
    regexp_replace(
      regexp_replace(
        translate(coalesce(new.arabic_text, ''), 'إأآٱةى', 'ااااهي'),
        '[\u064B-\u065F\u0670]',
        '',
        'g'
      ),
      '\s+',
      ' ',
      'g'
    );
  return new;
end;
$$;

drop trigger if exists source_variations_arabic_search on public.source_variations;
create trigger source_variations_arabic_search
before insert or update of arabic_text on public.source_variations
for each row execute function public.refresh_arabic_search_text();

-- Backfill derived search text without changing arabic_text meaning
update public.source_variations
set arabic_text = arabic_text
where arabic_text is not null
  and arabic_search_text is null;

create index if not exists source_arabic_search_trgm_idx
  on public.source_variations using gin (arabic_search_text gin_trgm_ops);

create index if not exists hadiths_title_trgm_idx
  on public.hadiths using gin (title gin_trgm_ops);

create index if not exists source_arabic_trgm_idx
  on public.source_variations using gin (arabic_text gin_trgm_ops);

create index if not exists source_english_trgm_idx
  on public.source_variations using gin (english_text gin_trgm_ops);

create index if not exists narrator_name_trgm_idx
  on public.narrators using gin (name gin_trgm_ops);

commit;
