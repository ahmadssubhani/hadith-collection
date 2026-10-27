-- Migration: 005_daily_hadith_batch.sql
-- Single-row per topic live batch tracking for manual on-demand publishing.

create table if not exists public.daily_hadith_batch (
  id bigint generated always as identity primary key,
  topic_id bigint not null references public.daily_topics(id) on delete cascade,
  day_number integer not null default 1,
  hadith_identifiers text[] not null default '{}',
  variation_ids bigint[] not null default '{}',
  hadith_ids bigint[] not null default '{}',
  published_at timestamptz not null default now(),
  unique (topic_id)
);

alter table public.daily_hadith_batch enable row level security;

-- Allow public read access to current live batch
create policy "Public daily hadith batch" on public.daily_hadith_batch for select using (true);
