-- Migration 008: lookup tables, bio columns, aliases, teacher/student graph, weak-link, FTS
-- Additive only. Seed lookups with known values; no invented scholarly rulings.

begin;

-- ---------------------------------------------------------------------------
-- Categories (topics) + M2M with hadiths
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id bigint generated always as identity primary key,
  slug text unique not null,
  title text not null,
  arabic_title text,
  description text,
  keywords text[] not null default '{}',
  parent_id bigint references public.categories(id),
  tradition text, -- null = cross-traditional topic
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.hadith_categories (
  hadith_id bigint not null references public.hadiths(id) on delete cascade,
  category_id bigint not null references public.categories(id) on delete cascade,
  primary key (hadith_id, category_id)
);

create index if not exists categories_parent_idx on public.categories(parent_id);
create index if not exists hadith_categories_category_idx on public.hadith_categories(category_id);

-- Seed core categories (idempotent)
insert into public.categories (slug, title, arabic_title, description, keywords, sort_order)
values
  ('first-wahi', 'First Revelation (Wahi)', 'بدء الوحي', 'Commencement of revelation at Cave Hira', array['first-wahi','revelation','hira','iqra'], 10),
  ('prayer', 'Prayer', 'الصلاة', 'Salat and related rulings', array['prayer','salat','salah'], 20),
  ('fasting', 'Fasting', 'الصيام', 'Sawm and Ramadan', array['fasting','sawm','ramadan'], 30),
  ('zakat', 'Zakat', 'الزكاة', 'Obligatory charity', array['zakat','charity'], 40),
  ('hajj', 'Hajj', 'الحج', 'Pilgrimage', array['hajj','pilgrimage','umrah'], 50),
  ('marriage', 'Marriage', 'النكاح', 'Nikah and family', array['marriage','nikah','family'], 60),
  ('ethics', 'Ethics / Adab', 'الآداب والأخلاق', 'Character and manners', array['ethics','adab','akhlaq'], 70),
  ('creed', 'Creed / Aqidah', 'العقيدة', 'Belief and theology', array['creed','aqidah','tawhid'], 80)
on conflict (slug) do nothing;

-- Link First Wahi hadith if present
insert into public.hadith_categories (hadith_id, category_id)
select h.id, c.id
from public.hadiths h
cross join public.categories c
where h.slug = 'first-revelation-at-hira'
  and c.slug = 'first-wahi'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Classification lookups
-- ---------------------------------------------------------------------------
create table if not exists public.grade_lookup (
  code text primary key,
  title text not null,
  arabic_title text,
  description text,
  sort_order integer not null default 0
);

create table if not exists public.hadith_type_lookup (
  code text primary key,
  title text not null,
  arabic_title text,
  description text
);

create table if not exists public.chain_status_lookup (
  code text primary key,
  title text not null,
  arabic_title text,
  description text
);

create table if not exists public.transmission_scope_lookup (
  code text primary key,
  title text not null,
  arabic_title text,
  description text
);

insert into public.grade_lookup (code, title, arabic_title, description, sort_order) values
  ('sahih', 'Sahih', 'صحيح', 'Sound', 10),
  ('hasan', 'Hasan', 'حسن', 'Good', 20),
  ('hasan_sahih', 'Hasan-Sahih', 'حسن صحيح', 'Good-sound (Tirmidhi usage)', 25),
  ('daif', 'Da''if', 'ضعيف', 'Weak', 30),
  ('mawdu', 'Mawdu''', 'موضوع', 'Fabricated', 40),
  ('munkar', 'Munkar', 'منكر', 'Rejected / munkar', 50),
  ('not_graded', 'Not graded', 'غير محكوم', 'No grade recorded', 90)
on conflict (code) do nothing;

insert into public.hadith_type_lookup (code, title, arabic_title, description) values
  ('marfu', 'Marfu''', 'مرفوع', 'Attributed to the Prophet'),
  ('mawquf', 'Mawquf', 'موقوف', 'Stopped at a Companion'),
  ('maqtu', 'Maqtu''', 'مقطوع', 'Stopped at a Successor'),
  ('qudsi', 'Qudsi', 'قدسي', 'Divine meaning, Prophetic wording')
on conflict (code) do nothing;

insert into public.chain_status_lookup (code, title, arabic_title, description) values
  ('muttasil', 'Muttasil', 'متصل', 'Connected chain'),
  ('mursal', 'Mursal', 'مرسل', 'Missing Companion link'),
  ('munqati', 'Munqati''', 'منقطع', 'Broken chain'),
  ('muallaq', 'Mu''allaq', 'معلق', 'Hanging / omitted start'),
  ('unverified', 'Unverified', 'غير محقق', 'Not yet classified')
on conflict (code) do nothing;

insert into public.transmission_scope_lookup (code, title, arabic_title, description) values
  ('mutawatir', 'Mutawatir', 'متواتر', 'Massively transmitted'),
  ('ahad', 'Ahad', 'آحاد', 'Solitary / limited paths'),
  ('unknown', 'Unknown', 'غير معروف', 'Not classified')
on conflict (code) do nothing;

alter table public.source_variations
  add column if not exists hadith_type text references public.hadith_type_lookup(code);

alter table public.source_variations
  add column if not exists transmission_scope text references public.transmission_scope_lookup(code);

-- Optional FK from free-text hadith_status → grade_lookup (no rewrite of existing values)
-- Existing hadith_status values stay; new column for normalized code when known
alter table public.source_variations
  add column if not exists grade_code text references public.grade_lookup(code);

-- ---------------------------------------------------------------------------
-- Name aliases (hadiths, narrators, scholars) + normalized_name
-- ---------------------------------------------------------------------------
create table if not exists public.name_aliases (
  id bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('hadith', 'narrator', 'scholar', 'book')),
  entity_id bigint not null,
  alias text not null,
  alias_normalized text,
  script text check (script is null or script in ('ar', 'en', 'transliteration', 'other')),
  source_name text,
  source_url text,
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, alias)
);

create index if not exists name_aliases_normalized_trgm_idx
  on public.name_aliases using gin (alias_normalized gin_trgm_ops);

create index if not exists name_aliases_alias_trgm_idx
  on public.name_aliases using gin (alias gin_trgm_ops);

create index if not exists name_aliases_entity_idx
  on public.name_aliases(entity_type, entity_id);

alter table public.hadiths
  add column if not exists normalized_name text;

alter table public.narrators
  add column if not exists normalized_name text;

alter table public.scholars
  add column if not exists normalized_name text;

-- ---------------------------------------------------------------------------
-- Narrator bio columns + teacher/student graph
-- ---------------------------------------------------------------------------
alter table public.narrators
  add column if not exists kunya text;

alter table public.narrators
  add column if not exists nisba text;

alter table public.narrators
  add column if not exists laqab text;

alter table public.narrators
  add column if not exists gender text check (gender is null or gender in ('male', 'female', 'unknown'));

alter table public.narrators
  add column if not exists tradition text;

alter table public.narrators
  add column if not exists birth_year_ce integer;

alter table public.narrators
  add column if not exists death_year_ce integer;

alter table public.narrators
  add column if not exists biography_source text;

alter table public.narrators
  add column if not exists biography_source_url text;

alter table public.narrators
  add column if not exists tabaqah text; -- Sahabi, Tabi'i, etc. (generation remains for legacy)

create table if not exists public.narrator_relations (
  id bigint generated always as identity primary key,
  from_narrator_id bigint not null references public.narrators(id) on delete cascade,
  to_narrator_id bigint not null references public.narrators(id) on delete cascade,
  relation_type text not null check (relation_type in ('teacher', 'student')),
  source_name text,
  source_url text,
  notes text,
  verified boolean not null default false,
  unique (from_narrator_id, to_narrator_id, relation_type),
  check (from_narrator_id <> to_narrator_id)
);

create index if not exists narrator_relations_from_idx on public.narrator_relations(from_narrator_id);
create index if not exists narrator_relations_to_idx on public.narrator_relations(to_narrator_id);

-- Convenience views (not tables) for teachers / students direction
create or replace view public.narrator_teachers as
select
  r.from_narrator_id as narrator_id,
  r.to_narrator_id as teacher_id,
  r.source_name,
  r.source_url,
  r.notes,
  r.verified
from public.narrator_relations r
where r.relation_type = 'teacher';

create or replace view public.narrator_students as
select
  r.from_narrator_id as narrator_id,
  r.to_narrator_id as student_id,
  r.source_name,
  r.source_url,
  r.notes,
  r.verified
from public.narrator_relations r
where r.relation_type = 'student';

-- ---------------------------------------------------------------------------
-- Scholar bio columns
-- ---------------------------------------------------------------------------
alter table public.scholars
  add column if not exists kunya text;

alter table public.scholars
  add column if not exists laqab text;

alter table public.scholars
  add column if not exists madhhab text;

alter table public.scholars
  add column if not exists region text;

alter table public.scholars
  add column if not exists birth_year_ce integer;

alter table public.scholars
  add column if not exists death_year_ce integer;

alter table public.scholars
  add column if not exists works text[];

alter table public.scholars
  add column if not exists teachers text[]; -- free-text until entity-linked

alter table public.scholars
  add column if not exists students text[];

-- ---------------------------------------------------------------------------
-- Chain weak-link flag + narrator assessment computed summary
-- ---------------------------------------------------------------------------
alter table public.chain_narrators
  add column if not exists is_weak_link boolean not null default false;

alter table public.chain_narrators
  add column if not exists weak_link_reason text;

alter table public.narrator_assessments
  add column if not exists computed_summary text;

alter table public.narrator_assessments
  add column if not exists computed_summary_method text;

comment on column public.narrator_assessments.computed_summary is
  'Derived helper only — never a substitute for original_term / scholar ruling. Clearly labeled as computed.';

comment on column public.narrators.summary_score is
  'DEPRECATED product field. Prefer sourced assessments + computed_summary on narrator_assessments.';

-- ---------------------------------------------------------------------------
-- Full-text search vectors (Arabic + English)
-- ---------------------------------------------------------------------------
alter table public.source_variations
  add column if not exists search_tsv tsvector;

create or replace function public.refresh_variation_search_tsv()
returns trigger
language plpgsql
as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('simple', coalesce(new.arabic_search_text, new.arabic_text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.english_text, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(new.attribution_text, '')), 'C');
  return new;
end;
$$;

drop trigger if exists source_variations_search_tsv on public.source_variations;
create trigger source_variations_search_tsv
before insert or update of arabic_text, arabic_search_text, english_text, attribution_text
on public.source_variations
for each row execute function public.refresh_variation_search_tsv();

update public.source_variations
set english_text = english_text
where search_tsv is null;

create index if not exists source_variations_search_tsv_idx
  on public.source_variations using gin (search_tsv);

-- ---------------------------------------------------------------------------
-- RLS for new tables
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;
alter table public.hadith_categories enable row level security;
alter table public.grade_lookup enable row level security;
alter table public.hadith_type_lookup enable row level security;
alter table public.chain_status_lookup enable row level security;
alter table public.transmission_scope_lookup enable row level security;
alter table public.name_aliases enable row level security;
alter table public.narrator_relations enable row level security;

do $$ begin
  create policy "Public categories" on public.categories for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Public hadith_categories" on public.hadith_categories for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Public grade_lookup" on public.grade_lookup for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Public hadith_type_lookup" on public.hadith_type_lookup for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Public chain_status_lookup" on public.chain_status_lookup for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Public transmission_scope_lookup" on public.transmission_scope_lookup for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Public name_aliases" on public.name_aliases for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Verified narrator_relations" on public.narrator_relations for select using (verified = true);
exception when duplicate_object then null;
end $$;

commit;
