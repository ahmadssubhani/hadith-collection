-- Migration 007: provenance / data_origin, book_kind, attribution, import supersession, scholar canonical_id
-- Does NOT bulk-change verified or review_status. New rows default to draft / unverified.

begin;

-- ---------------------------------------------------------------------------
-- Provenance (separates curated vs scraped inbox without touching verified flags)
-- ---------------------------------------------------------------------------
alter table public.hadiths
  add column if not exists data_origin text not null default 'curated'
    check (data_origin in ('curated', 'scraped_inbox', 'combined', 'collector', 'import'));

alter table public.source_variations
  add column if not exists data_origin text not null default 'import'
    check (data_origin in ('curated', 'scraped_inbox', 'combined', 'collector', 'import'));

alter table public.source_variations
  add column if not exists review_status text not null default 'draft'
    check (review_status in ('draft', 'in_review', 'published', 'rejected'));

-- Attribution metadata (for HadeethEnc-style "Narrated by…" strings moved off books)
alter table public.source_variations
  add column if not exists attribution_text text;

alter table public.source_variations
  add column if not exists attribution_book_id bigint references public.books(id);

-- Backfill data_origin from known inbox/combine/curated hadiths (no verified/review_status flips)
update public.hadiths
set data_origin = 'scraped_inbox'
where slug like 'scraped-inbox-%'
  and data_origin = 'curated';

update public.hadiths
set data_origin = 'combined'
where slug like 'combined-%'
  and data_origin = 'curated';

update public.hadiths
set data_origin = 'curated'
where slug = 'first-revelation-at-hira';

update public.source_variations sv
set data_origin = h.data_origin
from public.hadiths h
where h.id = sv.hadith_id
  and sv.data_origin = 'import';

-- NOTE: existing variations keep review_status='draft' (column default).
-- We do NOT bulk-promote them to published. Parent hadiths.review_status and
-- source_variations.verified are left unchanged. New inserts should use draft.

-- ---------------------------------------------------------------------------
-- Books: kind, category, edition metadata, canonical pointer
-- ---------------------------------------------------------------------------
alter table public.books
  add column if not exists book_kind text not null default 'collection'
    check (book_kind in (
      'collection',
      'attribution_string',
      'hadith_number_stub',
      'commentary',
      'rijal',
      'other'
    ));

alter table public.books
  add column if not exists category text;

alter table public.books
  add column if not exists publisher text;

alter table public.books
  add column if not exists edition text;

alter table public.books
  add column if not exists volumes integer;

alter table public.books
  add column if not exists hadith_count integer;

alter table public.books
  add column if not exists canonical_book_id bigint references public.books(id);

create index if not exists books_canonical_idx on public.books(canonical_book_id);
create index if not exists books_book_kind_idx on public.books(book_kind);

-- Mark attribution-string books (do not delete)
update public.books
set book_kind = 'attribution_string'
where book_kind = 'collection'
  and (
    title ~* '^Narrated by '
    or title ~* 'Agreed upon'
    or title like '% - Narrated%'
  );

-- Mark per-number Bukhari stubs (repoint happens in 009)
update public.books
set book_kind = 'hadith_number_stub'
where book_kind = 'collection'
  and title ~* '^Sahih al-Bukhari [0-9]';

-- Arabic Sahih al-Bukhari points at English canonical (id 27), no delete
update public.books
set canonical_book_id = 27
where id = 67
  and canonical_book_id is null;

-- ---------------------------------------------------------------------------
-- Import batches: supersession (batches 4–6 duplicate 1–3)
-- ---------------------------------------------------------------------------
alter table public.import_batches
  add column if not exists superseded_by bigint references public.import_batches(id);

alter table public.import_batches
  add column if not exists is_superseded boolean not null default false;

update public.import_batches set superseded_by = 1, is_superseded = true, notes = coalesce(notes, '') || ' [superseded duplicate of batch 1]'
where id = 4 and not is_superseded;

update public.import_batches set superseded_by = 2, is_superseded = true, notes = coalesce(notes, '') || ' [superseded duplicate of batch 2]'
where id = 5 and not is_superseded;

update public.import_batches set superseded_by = 3, is_superseded = true, notes = coalesce(notes, '') || ' [superseded duplicate of batch 3]'
where id = 6 and not is_superseded;

-- ---------------------------------------------------------------------------
-- Scholars: canonical merge support (Ibn Hajar 1 → 7 applied in 009)
-- ---------------------------------------------------------------------------
alter table public.scholars
  add column if not exists canonical_scholar_id bigint references public.scholars(id);

create index if not exists scholars_canonical_idx on public.scholars(canonical_scholar_id);

commit;
