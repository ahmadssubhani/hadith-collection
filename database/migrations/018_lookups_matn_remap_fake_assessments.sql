-- Migration 018: expand lookups/categories; matn fingerprint + remap tables;
-- quarantine enrich-script fake narrator_assessments; topic link for first-wahi.
-- Additive. Variations stay draft. Does not regroup hadith_id yet (fingerprint backfill
-- is done by scripts/collectors/matn-fingerprint.ts).

begin;

-- ---------------------------------------------------------------------------
-- A) data helpers already from 017: data_change_log
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- B) Matn fingerprint + remap scaffolding (regrouping apply is scripted)
-- ---------------------------------------------------------------------------
alter table public.source_variations
  add column if not exists matn_fingerprint text;

alter table public.source_variations
  add column if not exists matn_fingerprint_norm text;

create index if not exists source_variations_matn_fp_idx
  on public.source_variations (matn_fingerprint_norm);

create table if not exists public.hadith_id_remap (
  id bigint generated always as identity primary key,
  old_hadith_id bigint not null references public.hadiths(id),
  new_hadith_id bigint not null references public.hadiths(id),
  method text not null,
  notes text,
  created_at timestamptz not null default now(),
  unique (old_hadith_id, new_hadith_id, method)
);

comment on table public.hadith_id_remap is
  'Maps topic-bucket hadith ids to matn-cluster hadith ids after regrouping.';

alter table public.hadiths
  add column if not exists grouping_method text;

alter table public.hadiths
  add column if not exists matn_fingerprint_norm text;

-- ---------------------------------------------------------------------------
-- C) Expand grade_lookup (Sunni + Shia common terms)
-- ---------------------------------------------------------------------------
insert into public.grade_lookup (code, title, arabic_title, description, sort_order)
values
  ('muwaththaq', 'Muwaththaq', 'موثق', 'Shia: reliable though non-Imami narrator', 40),
  ('qawi', 'Qawi', 'قوي', 'Shia: strong', 45),
  ('hasan_kalam', 'Hasan (kalam)', 'حسن', 'Acceptable / fair (context-dependent)', 50),
  ('thiqa', 'Thiqa', 'ثقة', 'Trustworthy (rijal term)', 15),
  ('saduq', 'Saduq', 'صدوق', 'Truthful', 25),
  ('majhul', 'Majhul', 'مجهول', 'Unknown narrator', 70),
  ('layyin', 'Layyin', 'لين', 'Soft / weakish', 75),
  ('matruk', 'Matruk', 'متروك', 'Abandoned', 85),
  ('daif_jiddan', 'Very weak', 'ضعيف جدا', 'Severely weak', 88),
  ('mawdu', 'Fabricated', 'موضوع', 'Fabricated (alias of mawdu if present)', 95)
on conflict (code) do nothing;

-- hadith types
insert into public.hadith_type_lookup (code, title, arabic_title, description)
values
  ('marfu', 'Marfu', 'مرفوع', 'Raised to the Prophet'),
  ('mawquf', 'Mawquf', 'موقوف', 'Stopped at Companion'),
  ('maqtu', 'Maqtu', 'مقطوع', 'Stopped at Successor'),
  ('qudsi', 'Hadith Qudsi', 'قدسي', 'Divine speech via Prophet'),
  ('athar', 'Athar', 'أثر', 'Report / remnant')
on conflict (code) do nothing;

-- transmission scope
insert into public.transmission_scope_lookup (code, title, arabic_title, description)
values
  ('mutawatir', 'Mutawatir', 'متواتر', 'Mass-transmitted'),
  ('ahad', 'Ahad', 'آحاد', 'Solitary / limited paths'),
  ('aziz', 'Aziz', 'عزيز', 'Rare (two paths)'),
  ('gharib', 'Gharib', 'غريب', 'Singular path'),
  ('mashhur', 'Mashhur', 'مشهور', 'Well-known')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- D) Expand category tree (tradition-aware where relevant)
-- ---------------------------------------------------------------------------
insert into public.categories (slug, title, arabic_title, description, keywords, tradition, sort_order)
values
  ('aqidah', 'Creed / Aqidah', 'العقيدة', 'Belief and theology', array['aqidah','creed','tawhid'], null, 5),
  ('imamate', 'Imamate / Wilayah', 'الإمامة', 'Imamate and wilayah topics', array['imamate','wilayah'], 'Twelver Shia', 15),
  ('virtues', 'Virtues / Fada''il', 'الفضائل', 'Virtues of persons and acts', array['fadail','virtues'], null, 25),
  ('tafsir', 'Tafsir', 'التفسير', 'Quranic exegesis reports', array['tafsir','quran'], null, 35),
  ('akhlaq', 'Ethics / Akhlaq', 'الأخلاق', 'Character and manners', array['akhlaq','ethics'], null, 45),
  ('fiqh-ibadat', 'Fiqh — Ibadat', 'فقه العبادات', 'Worship rulings', array['fiqh','ibadat'], null, 55),
  ('fiqh-muamalat', 'Fiqh — Muamalat', 'فقه المعاملات', 'Transactions', array['fiqh','muamalat'], null, 60),
  ('seerah', 'Seerah / Maghazi', 'السيرة', 'Prophetic biography and campaigns', array['seerah','maghazi'], null, 65),
  ('rijal-topic', 'Rijal / narrators', 'الرجال', 'Reports about narrators', array['rijal'], null, 90)
on conflict (slug) do nothing;

-- Ensure first-wahi category exists (seeded in 008 as first-wahi)
insert into public.categories (slug, title, arabic_title, description, keywords, tradition, sort_order)
values (
  'first-wahi',
  'First Revelation (Wahi)',
  'بدء الوحي',
  'Topic bucket: commencement of revelation — matns clustered separately',
  array['first-wahi','revelation','hira','iqra'],
  null,
  12
)
on conflict (slug) do nothing;

-- Link canonical hadith id=1 (first-revelation-at-hira) to first-wahi category as TOPIC
insert into public.hadith_categories (hadith_id, category_id)
select h.id, c.id
from public.hadiths h
cross join public.categories c
where h.slug = 'first-revelation-at-hira'
  and c.slug = 'first-wahi'
on conflict do nothing;

update public.hadiths
set grouping_method = 'topic_bucket_pending_matn_split'
where slug = 'first-revelation-at-hira'
  and (grouping_method is null or grouping_method = '');

-- ---------------------------------------------------------------------------
-- E) Quarantine enrich-script fake narrator_assessments
-- ---------------------------------------------------------------------------
create table if not exists public.narrator_assessment_quarantine_018 (
  assessment_id bigint primary key,
  narrator_id bigint,
  scholar_id bigint,
  original_term text,
  normalized_term text,
  explanation text,
  reference_book text,
  source_url text,
  verified boolean,
  quarantined_at timestamptz not null default now(),
  reason text not null
);

insert into public.narrator_assessment_quarantine_018 (
  assessment_id, narrator_id, scholar_id, original_term, normalized_term,
  explanation, reference_book, source_url, verified, reason
)
select
  na.id, na.narrator_id, na.scholar_id, na.original_term, na.normalized_term,
  na.explanation, na.reference_book, na.source_url, na.verified,
  'enrich-narrators-rijal.ts default boilerplate assessment'
from public.narrator_assessments na
where na.explanation in (
    'Verified transmitter recorded in classical Hadith compilations.',
    'Reliable Hadith transmitter with acceptable narration path.'
  )
   or na.original_term in (
    'ثقة · Trustworthy',
    'صدوق · Truthful'
  )
on conflict (assessment_id) do nothing;

insert into public.data_change_log (migration_id, table_name, row_pk, column_name, old_value, new_value, reason)
select
  '018',
  'narrator_assessments',
  q.assessment_id::text,
  '*',
  left(coalesce(q.original_term, ''), 80),
  'QUARANTINED_DELETED',
  q.reason
from public.narrator_assessment_quarantine_018 q;

delete from public.narrator_assessments na
where exists (
  select 1 from public.narrator_assessment_quarantine_018 q where q.assessment_id = na.id
);

-- ---------------------------------------------------------------------------
-- F) Scholar provenance columns for curated_seed / wikidata
-- ---------------------------------------------------------------------------
alter table public.scholars
  add column if not exists provenance text;

alter table public.scholars
  add column if not exists source_url text;

alter table public.scholars
  add column if not exists source_name text;

alter table public.scholars
  add column if not exists verified boolean not null default false;

alter table public.scholars
  add column if not exists wikidata_qid text;

alter table public.scholars
  add column if not exists retrieved_at timestamptz;

comment on column public.scholars.provenance is
  'e.g. wikidata_search_human_death_year | curated_seed | import';

commit;
