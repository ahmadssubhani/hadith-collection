-- Migration 011: RPC dedupe + pagination, category/FTS search, attribution M2M
-- Additive only. Does NOT re-run 006–010. No deletes of books/variations.
-- Apply manually (no DATABASE_URL required for authoring).

begin;

-- ===========================================================================
-- A) Variation ↔ book attributions (many-to-many for "Narrated by X & Y")
-- ===========================================================================
create table if not exists public.variation_book_attributions (
  id bigint generated always as identity primary key,
  variation_id bigint not null references public.source_variations(id) on delete cascade,
  book_id bigint not null references public.books(id),
  role text not null default 'attributed_source'
    check (role in ('attributed_source', 'agreed_upon', 'primary', 'secondary')),
  attribution_fragment text,
  parse_confidence numeric(5,4) check (parse_confidence is null or parse_confidence between 0 and 1),
  source_name text,
  notes text,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique (variation_id, book_id, role)
);

create index if not exists variation_book_attributions_variation_idx
  on public.variation_book_attributions(variation_id);
create index if not exists variation_book_attributions_book_idx
  on public.variation_book_attributions(book_id);

alter table public.variation_book_attributions enable row level security;
do $$ begin
  create policy "Public variation_book_attributions"
    on public.variation_book_attributions for select using (true);
exception when duplicate_object then null;
end $$;

-- Helper: resolve a known collection book id by aliases (existing rows only)
create or replace function public.resolve_collection_book_id(alias text)
returns bigint
language plpgsql
stable
set search_path = public
as $$
declare
  a text := lower(trim(both from coalesce(alias, '')));
  bid bigint;
begin
  if a = '' then return null; end if;

  -- Prefer real collections / Arabic titles, never attribution_string / stubs
  select b.id into bid
  from books b
  where b.book_kind in ('collection', 'commentary', 'other')
    and (
      lower(b.title) = a
      or lower(coalesce(b.arabic_title, '')) = a
      or (
        a ~ '(bukhari|البخاري)' and b.title ~* '^(Sahih al-Bukhari|صحيح البخاري)$'
      )
      or (
        a ~ '(muslim|مسلم)' and b.title ~* '^(Sahih Muslim|Sahīh Muslim|صحيح مسلم)$'
      )
      or (
        a ~ '(tirmidh|termedh|الترمذي)' and (
          b.title ~* 'tirmidh' or b.title ~* 'الترمذي' or b.title = 'صحيح الترمذي'
        )
      )
      or (
        a ~ '(abu\s*dawud|abu\s*daoud|ابو داود|أبو داود)' and b.title ~* 'dawud|daoud|داود'
        and b.book_kind = 'collection'
      )
      or (
        a ~ '(nasa.?i|nasaa.?i|النسائي)' and b.title ~* 'nasa|نسائي'
      )
      or (
        a ~ '(ibn\s*majah|ibn\s*maajah|ابن ماجه)' and b.title ~* 'majah|ماجه'
      )
      or (
        a ~ '(ahmad|أحمد)' and (b.title ~* '^musnad' or b.title ilike '%ahmad%' or b.title = 'مسند أحمد')
      )
      or (
        a ~ '(bayhaqi|البيهقي)' and b.title ~* 'bayhaqi|بيهقي'
      )
      or (
        a ~ '(darimi|الدارمي)' and b.title ~* 'darimi|دارمي'
      )
      or (
        a ~ '(tabarani|الطبراني)' and b.title ~* 'tabarani|طبراني'
      )
      or (
        a ~ '(ibn\s*hibban|ibn\s*hebban|ابن حبان)' and b.title ~* 'hibban|hebban|حبان'
      )
      or (
        a ~ '(hakim|الحاكم)' and b.title ~* 'hakim|مستدرك|حاكم'
      )
    )
  order by
    case when b.canonical_book_id is null then 0 else 1 end,
    b.id
  limit 1;

  return bid;
end;
$$;

-- Parse one attribution title into book fragments
create or replace function public.parse_attribution_fragments(attr text)
returns table (fragment text, role text)
language plpgsql
immutable
as $$
declare
  t text := coalesce(attr, '');
  part text;
begin
  if t = '' then
    return;
  end if;

  -- "Agreed upon" / متفق عليه → Bukhari + Muslim
  if t ~* '^(Agreed upon|متفق عليه)' or t ~* 'agreed upon' then
    fragment := 'bukhari'; role := 'agreed_upon'; return next;
    fragment := 'muslim'; role := 'agreed_upon'; return next;
    return;
  end if;

  -- Normalize separators: " - Narrated by", commas, "and", "&"
  t := regexp_replace(t, '^\s*Narrated by\s+', '', 'i');
  t := regexp_replace(t, '\s*-\s*Narrated by\s+', '|', 'gi');
  t := regexp_replace(t, '\s+and\s+', '|', 'gi');
  t := regexp_replace(t, '\s*&\s*', '|', 'g');
  t := regexp_replace(t, '\s*,\s*', '|', 'g');
  t := regexp_replace(t, '\s+with\s+.*$', '', 'i'); -- drop "with its two versions" tails for fragment split

  foreach part in array string_to_array(t, '|') loop
    part := trim(both from part);
    if part = '' then continue; end if;
    -- Skip pure commentary noise
    if part ~* '^(with a similar wording|as Mu.?allaq|hanging)' then continue; end if;
    fragment := part;
    role := 'attributed_source';
    return next;
  end loop;
end;
$$;

-- Resolve attribution_string books → variation_book_attributions (+ attribution_book_id = first)
-- Idempotent. Never deletes books or variations.
create or replace function public.resolve_variation_attributions(p_limit int default null)
returns table (
  variation_id bigint,
  attribution_book_id_set bigint,
  linked_book_ids bigint[],
  unmatched_fragments text[]
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  r record;
  frag record;
  bid bigint;
  first_bid bigint;
  linked bigint[];
  unmatched text[];
  n int := 0;
begin
  for r in
    select sv.id as vid,
           coalesce(sv.attribution_text, b.title) as attr,
           b.id as attr_book_row_id
    from source_variations sv
    join books b on b.id = sv.book_id
    where b.book_kind = 'attribution_string'
    order by sv.id
    limit coalesce(p_limit, 100000)
  loop
    first_bid := null;
    linked := '{}';
    unmatched := '{}';

    for frag in select * from public.parse_attribution_fragments(r.attr) loop
      bid := public.resolve_collection_book_id(frag.fragment);
      if bid is null then
        unmatched := array_append(unmatched, frag.fragment);
      else
        insert into variation_book_attributions (
          variation_id, book_id, role, attribution_fragment, parse_confidence, source_name, verified
        ) values (
          r.vid, bid, frag.role, frag.fragment, 0.8000, 'migration-011-parse', false
        )
        on conflict (variation_id, book_id, role) do update
          set attribution_fragment = excluded.attribution_fragment,
              parse_confidence = excluded.parse_confidence;

        if first_bid is null then first_bid := bid; end if;
        if not (bid = any (linked)) then
          linked := array_append(linked, bid);
        end if;
      end if;
    end loop;

    if first_bid is not null then
      update source_variations sv
      set
        attribution_text = coalesce(sv.attribution_text, r.attr),
        attribution_book_id = coalesce(sv.attribution_book_id, first_bid)
      where sv.id = r.vid;
    else
      update source_variations sv
      set attribution_text = coalesce(sv.attribution_text, r.attr)
      where sv.id = r.vid;
    end if;

    variation_id := r.vid;
    attribution_book_id_set := first_bid;
    linked_book_ids := linked;
    unmatched_fragments := unmatched;
    return next;

    n := n + 1;
  end loop;
end;
$$;

-- Run parse once for all attribution_string variations
select public.resolve_variation_attributions(null);

-- ===========================================================================
-- B) Hadith-level search vector (title / summary / topics / arabic_title)
-- ===========================================================================
alter table public.hadiths
  add column if not exists search_tsv tsvector;

create or replace function public.refresh_hadith_search_tsv()
returns trigger
language plpgsql
as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.arabic_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.topics, ' '), '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.normalized_name, '')), 'B');
  return new;
end;
$$;

drop trigger if exists hadiths_search_tsv on public.hadiths;
create trigger hadiths_search_tsv
before insert or update of title, arabic_title, summary, topics, normalized_name
on public.hadiths
for each row execute function public.refresh_hadith_search_tsv();

update public.hadiths set title = title where search_tsv is null;

create index if not exists hadiths_search_tsv_idx on public.hadiths using gin (search_tsv);

create index if not exists categories_keywords_gin_idx
  on public.categories using gin (keywords);

-- ===========================================================================
-- C) Replace get_hadith_full / get_narrator_full
--     - dedupe candidates by id (max score)
--     - category + FTS topic search
--     - variation_limit / variation_offset / summary_mode
-- ===========================================================================
drop function if exists public.get_hadith_full(text);
drop function if exists public.get_hadith_full(text, integer, integer, boolean);
drop function if exists public.get_narrator_full(text);
drop function if exists public.get_narrator_full(text, integer, integer, boolean);

create or replace function public.get_hadith_full(
  query text,
  variation_limit integer default 25,
  variation_offset integer default 0,
  summary_mode boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := public.normalize_search_key(query);
  hid bigint;
  candidate_count int;
  candidates jsonb;
  result jsonb;
  v_limit int := greatest(coalesce(variation_limit, 25), 0);
  v_offset int := greatest(coalesce(variation_offset, 0), 0);
  v_total int;
begin
  if q is null or q = '' then
    return jsonb_build_object('error', 'empty_query');
  end if;

  -- 1) Numeric id
  if q ~ '^\d+$' then
    select h.id into hid from hadiths h where h.id = q::bigint;
    if hid is null then
      return jsonb_build_object('error', 'not_found', 'query', query);
    end if;
  end if;

  -- 2) Exact (deduped by id)
  if hid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', y.id,
             'slug', y.slug,
             'title', y.title,
             'arabic_title', y.arabic_title,
             'match', y.match_kind,
             'score', y.score
           ) order by y.score desc, y.id)
    into candidate_count, candidates
    from (
      select x.id, max(x.slug) as slug, max(x.title) as title,
             max(x.arabic_title) as arabic_title,
             max(x.match_kind) as match_kind,
             max(x.score) as score
      from (
        select h.id, h.slug, h.title, h.arabic_title, 'exact'::text as match_kind, 1.0::float as score
        from hadiths h
        where h.slug = q
           or lower(h.title) = q
           or lower(coalesce(h.arabic_title, '')) = q
           or lower(coalesce(h.normalized_name, '')) = q
        union all
        select h.id, h.slug, h.title, h.arabic_title, 'alias_exact', 1.0
        from name_aliases a
        join hadiths h on h.id = a.entity_id
        where a.entity_type = 'hadith'
          and (lower(a.alias) = q or lower(coalesce(a.alias_normalized, '')) = q)
      ) x
      group by x.id
    ) y;

    if candidate_count > 1 then
      return jsonb_build_object('error', 'ambiguous', 'query', query, 'candidates', candidates);
    elsif candidate_count = 1 then
      hid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  -- 3) Category / topic / FTS (before fuzzy name match)
  if hid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', y.id,
             'slug', y.slug,
             'title', y.title,
             'arabic_title', y.arabic_title,
             'match', y.match_kind,
             'score', y.score
           ) order by y.score desc, y.id)
    into candidate_count, candidates
    from (
      select x.id, max(x.slug) as slug, max(x.title) as title,
             max(x.arabic_title) as arabic_title,
             max(x.match_kind) as match_kind,
             max(x.score) as score
      from (
        -- category slug / title / keywords
        select h.id, h.slug, h.title, h.arabic_title, 'category'::text as match_kind, 0.95::float as score
        from categories c
        join hadith_categories hc on hc.category_id = c.id
        join hadiths h on h.id = hc.hadith_id
        where c.slug = q
           or lower(c.title) = q
           or lower(coalesce(c.arabic_title, '')) = q
           or exists (select 1 from unnest(c.keywords) k where lower(k) = q)
           or c.title % query
           or exists (select 1 from unnest(c.keywords) k where k % query)

        union all
        -- hadith topics[] / search_tsv
        select h.id, h.slug, h.title, h.arabic_title, 'topic_fts',
               greatest(
                 ts_rank(h.search_tsv, plainto_tsquery('english', query)),
                 case when exists (select 1 from unnest(h.topics) t where lower(t) = q or t % query)
                      then 0.9 else 0 end
               )
        from hadiths h
        where h.search_tsv @@ plainto_tsquery('english', query)
           or exists (select 1 from unnest(h.topics) t where lower(t) = q or t % query)

        union all
        -- variation text FTS → parent hadith
        select h.id, h.slug, h.title, h.arabic_title, 'variation_fts',
               max(ts_rank(sv.search_tsv, plainto_tsquery('english', query)))::float
        from source_variations sv
        join hadiths h on h.id = sv.hadith_id
        where sv.search_tsv @@ plainto_tsquery('english', query)
           or sv.search_tsv @@ plainto_tsquery('simple', query)
        group by h.id, h.slug, h.title, h.arabic_title
      ) x
      where x.score >= 0.05
      group by x.id
    ) y;

    if candidate_count > 1 then
      return jsonb_build_object('error', 'ambiguous', 'query', query, 'candidates', candidates);
    elsif candidate_count = 1 then
      hid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  -- 4) Fuzzy name/alias — DEDUPE by id, take max score
  if hid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', y.id,
             'slug', y.slug,
             'title', y.title,
             'arabic_title', y.arabic_title,
             'match', 'fuzzy',
             'score', y.score
           ) order by y.score desc, y.id)
    into candidate_count, candidates
    from (
      select x.id, max(x.slug) as slug, max(x.title) as title,
             max(x.arabic_title) as arabic_title,
             max(x.score) as score
      from (
        select h.id, h.slug, h.title, h.arabic_title,
               greatest(
                 similarity(h.title, query),
                 similarity(coalesce(h.arabic_title, ''), query)
               ) as score
        from hadiths h
        where h.title % query or coalesce(h.arabic_title, '') % query
        union all
        select h.id, h.slug, h.title, h.arabic_title,
               similarity(a.alias, query) as score
        from name_aliases a
        join hadiths h on h.id = a.entity_id
        where a.entity_type = 'hadith'
          and (a.alias % query or coalesce(a.alias_normalized, '') % query)
      ) x
      where x.score >= 0.3
      group by x.id
    ) y;

    if coalesce(candidate_count, 0) = 0 then
      return jsonb_build_object('error', 'not_found', 'query', query);
    elsif candidate_count > 1 then
      return jsonb_build_object('error', 'ambiguous', 'query', query, 'candidates', candidates);
    else
      hid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  select count(*)::int into v_total
  from source_variations sv where sv.hadith_id = hid;

  if summary_mode then
    select jsonb_build_object(
      'hadith', (
        select jsonb_build_object(
          'id', h.id, 'slug', h.slug, 'title', h.title, 'arabic_title', h.arabic_title,
          'summary', h.summary, 'topics', h.topics, 'review_status', h.review_status,
          'data_origin', h.data_origin
        ) from hadiths h where h.id = hid
      ),
      'categories', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'title', c.title)
          order by c.sort_order, c.id)
        from hadith_categories hc join categories c on c.id = hc.category_id
        where hc.hadith_id = hid
      ), '[]'::jsonb),
      'variation_total', v_total,
      'variation_limit', v_limit,
      'variation_offset', v_offset,
      'summary_mode', true,
      'source_variations_summary', coalesce((
        select jsonb_agg(row_obj order by (row_obj->>'id')::bigint)
        from (
          select jsonb_build_object(
            'id', sv.id,
            'book_id', sv.book_id,
            'book_title', b.title,
            'book_kind', b.book_kind,
            'tradition', b.tradition,
            'hadith_number', sv.hadith_number,
            'source_url', sv.source_url,
            'hadith_status', sv.hadith_status,
            'attribution_text', sv.attribution_text,
            'attribution_book_id', sv.attribution_book_id,
            'attributed_books', coalesce((
              select jsonb_agg(jsonb_build_object(
                'book_id', vba.book_id, 'title', ab.title, 'role', vba.role
              ) order by vba.id)
              from variation_book_attributions vba
              join books ab on ab.id = vba.book_id
              where vba.variation_id = sv.id
            ), '[]'::jsonb)
          ) as row_obj
          from source_variations sv
          join books b on b.id = sv.book_id
          where sv.hadith_id = hid
          order by sv.id
          limit v_limit offset v_offset
        ) page
      ), '[]'::jsonb),
      'provenance', jsonb_build_object('matched_by', 'get_hadith_full', 'query', query, 'hadith_id', hid)
    ) into result;
    return result;
  end if;

  select jsonb_build_object(
    'hadith', (
      select jsonb_build_object(
        'id', h.id, 'slug', h.slug, 'title', h.title, 'arabic_title', h.arabic_title,
        'summary', h.summary, 'topics', h.topics, 'review_status', h.review_status,
        'data_origin', h.data_origin, 'normalized_name', h.normalized_name
      ) from hadiths h where h.id = hid
    ),
    'aliases', coalesce((
      select jsonb_agg(jsonb_build_object('alias', a.alias, 'script', a.script, 'source_name', a.source_name) order by a.id)
      from name_aliases a where a.entity_type = 'hadith' and a.entity_id = hid
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'slug', c.slug, 'title', c.title, 'arabic_title', c.arabic_title, 'keywords', c.keywords
      ) order by c.sort_order, c.id)
      from hadith_categories hc join categories c on c.id = hc.category_id
      where hc.hadith_id = hid
    ), '[]'::jsonb),
    'variation_total', v_total,
    'variation_limit', v_limit,
    'variation_offset', v_offset,
    'summary_mode', false,
    'source_variations', coalesce((
      select jsonb_agg(var_obj order by (var_obj->>'id')::bigint)
      from (
        select jsonb_build_object(
          'id', sv.id,
          'book', jsonb_build_object(
            'id', b.id, 'title', b.title, 'arabic_title', b.arabic_title,
            'author', b.author, 'tradition', b.tradition, 'book_kind', b.book_kind,
            'category', b.category, 'canonical_book_id', b.canonical_book_id
          ),
          'hadith_number', sv.hadith_number,
          'chapter', sv.chapter, 'volume', sv.volume, 'page', sv.page,
          'arabic_text', sv.arabic_text, 'english_text', sv.english_text,
          'translator', sv.translator, 'source_url', sv.source_url,
          'hadith_status', sv.hadith_status, 'grade_code', sv.grade_code,
          'hadith_type', sv.hadith_type, 'transmission_scope', sv.transmission_scope,
          'chain_status', sv.chain_status,
          'attribution_text', sv.attribution_text,
          'attribution_book_id', sv.attribution_book_id,
          'attributed_books', coalesce((
            select jsonb_agg(jsonb_build_object(
              'book_id', vba.book_id, 'title', ab.title, 'tradition', ab.tradition,
              'role', vba.role, 'fragment', vba.attribution_fragment
            ) order by vba.id)
            from variation_book_attributions vba
            join books ab on ab.id = vba.book_id
            where vba.variation_id = sv.id
          ), '[]'::jsonb),
          'verified', sv.verified, 'review_status', sv.review_status,
          'data_origin', sv.data_origin, 'status_notes', sv.status_notes,
          'assessments', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ha.id, 'original_grade', ha.original_grade,
              'normalized_grade', ha.normalized_grade, 'explanation', ha.explanation,
              'reference_book', ha.reference_book, 'volume', ha.volume, 'page', ha.page,
              'source_url', ha.source_url, 'verified', ha.verified,
              'scholar', jsonb_build_object(
                'id', coalesce(s.canonical_scholar_id, s.id),
                'name', s.name, 'arabic_name', s.arabic_name,
                'tradition', s.tradition, 'slug', s.slug
              )
            ) order by ha.id)
            from hadith_assessments ha
            join scholars s on s.id = ha.scholar_id
            where ha.variation_id = sv.id
          ), '[]'::jsonb),
          'chains', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ch.id, 'chain_number', ch.chain_number,
              'raw_chain_text', ch.raw_chain_text,
              'continuity_status', ch.continuity_status,
              'quality_status', ch.quality_status,
              'verified', ch.verified, 'notes', ch.notes,
              'assessments', coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', ca.id, 'continuity_status', ca.continuity_status,
                  'quality_status', ca.quality_status, 'explanation', ca.explanation,
                  'reference_book', ca.reference_book, 'source_url', ca.source_url,
                  'verified', ca.verified, 'scholar_id', ca.scholar_id
                ) order by ca.id)
                from chain_assessments ca where ca.chain_id = ch.id
              ), '[]'::jsonb),
              'narrators', coalesce((
                select jsonb_agg(jsonb_build_object(
                  'position', cn.position, 'raw_name', cn.raw_name,
                  'transmission_word', cn.transmission_word,
                  'is_weak_link', cn.is_weak_link,
                  'weak_link_reason', cn.weak_link_reason,
                  'match_confidence', cn.match_confidence,
                  'narrator', case when n.id is null then null else jsonb_build_object(
                    'id', n.id, 'slug', n.slug, 'name', n.name,
                    'arabic_name', n.arabic_name, 'generation', n.generation,
                    'tabaqah', n.tabaqah, 'tradition', n.tradition
                  ) end
                ) order by cn.position)
                from chain_narrators cn
                left join narrators n on n.id = cn.narrator_id
                where cn.chain_id = ch.id
              ), '[]'::jsonb)
            ) order by ch.chain_number, ch.id)
            from chains ch where ch.variation_id = sv.id
          ), '[]'::jsonb)
        ) as var_obj
        from source_variations sv
        join books b on b.id = sv.book_id
        where sv.hadith_id = hid
        order by sv.id
        limit v_limit offset v_offset
      ) variations
    ), '[]'::jsonb),
    'provenance', jsonb_build_object('matched_by', 'get_hadith_full', 'query', query, 'hadith_id', hid)
  ) into result;

  return result;
end;
$$;

create or replace function public.get_narrator_full(
  query text,
  appearance_limit integer default 50,
  appearance_offset integer default 0,
  summary_mode boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := public.normalize_search_key(query);
  nid bigint;
  candidate_count int;
  candidates jsonb;
  result jsonb;
  a_limit int := greatest(coalesce(appearance_limit, 50), 0);
  a_offset int := greatest(coalesce(appearance_offset, 0), 0);
  a_total int;
begin
  if q is null or q = '' then
    return jsonb_build_object('error', 'empty_query');
  end if;

  if q ~ '^\d+$' then
    select n.id into nid from narrators n where n.id = q::bigint;
    if nid is null then
      return jsonb_build_object('error', 'not_found', 'query', query);
    end if;
  end if;

  -- Exact, deduped by id
  if nid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', y.id, 'slug', y.slug, 'name', y.name,
             'arabic_name', y.arabic_name, 'match', y.match_kind, 'score', y.score
           ) order by y.score desc, y.id)
    into candidate_count, candidates
    from (
      select x.id, max(x.slug) as slug, max(x.name) as name,
             max(x.arabic_name) as arabic_name, max(x.match_kind) as match_kind, max(x.score) as score
      from (
        select n.id, n.slug, n.name, n.arabic_name, 'exact'::text as match_kind, 1.0::float as score
        from narrators n
        where n.slug = q or lower(n.name) = q
           or lower(coalesce(n.arabic_name, '')) = q
           or lower(coalesce(n.normalized_name, '')) = q
           or exists (select 1 from unnest(n.alternative_names) alt where lower(alt) = q)
        union all
        select n.id, n.slug, n.name, n.arabic_name, 'alias_exact', 1.0
        from name_aliases a
        join narrators n on n.id = a.entity_id
        where a.entity_type = 'narrator'
          and (lower(a.alias) = q or lower(coalesce(a.alias_normalized, '')) = q)
      ) x
      group by x.id
    ) y;

    if candidate_count > 1 then
      return jsonb_build_object('error', 'ambiguous', 'query', query, 'candidates', candidates);
    elsif candidate_count = 1 then
      nid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  -- Fuzzy, deduped by id (max score)
  if nid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', y.id, 'slug', y.slug, 'name', y.name,
             'arabic_name', y.arabic_name, 'match', 'fuzzy', 'score', y.score
           ) order by y.score desc, y.id)
    into candidate_count, candidates
    from (
      select x.id, max(x.slug) as slug, max(x.name) as name,
             max(x.arabic_name) as arabic_name, max(x.score) as score
      from (
        select n.id, n.slug, n.name, n.arabic_name,
               greatest(similarity(n.name, query), similarity(coalesce(n.arabic_name, ''), query)) as score
        from narrators n
        where n.name % query or coalesce(n.arabic_name, '') % query
        union all
        select n.id, n.slug, n.name, n.arabic_name, similarity(a.alias, query) as score
        from name_aliases a
        join narrators n on n.id = a.entity_id
        where a.entity_type = 'narrator'
          and (a.alias % query or coalesce(a.alias_normalized, '') % query)
      ) x
      where x.score >= 0.3
      group by x.id
    ) y;

    if coalesce(candidate_count, 0) = 0 then
      return jsonb_build_object('error', 'not_found', 'query', query);
    elsif candidate_count > 1 then
      return jsonb_build_object('error', 'ambiguous', 'query', query, 'candidates', candidates);
    else
      nid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  select count(*)::int into a_total
  from chain_narrators cn where cn.narrator_id = nid;

  if summary_mode then
    return jsonb_build_object(
      'narrator', (
        select jsonb_build_object(
          'id', n.id, 'slug', n.slug, 'name', n.name, 'arabic_name', n.arabic_name,
          'kunya', n.kunya, 'nisba', n.nisba, 'tabaqah', n.tabaqah, 'tradition', n.tradition,
          'generation', n.generation, 'identity_status', n.identity_status
        ) from narrators n where n.id = nid
      ),
      'jarh_wa_tadil_count', (select count(*)::int from narrator_assessments where narrator_id = nid),
      'appearance_total', a_total,
      'appearance_limit', a_limit,
      'appearance_offset', a_offset,
      'summary_mode', true,
      'provenance', jsonb_build_object('matched_by', 'get_narrator_full', 'query', query, 'narrator_id', nid)
    );
  end if;

  select jsonb_build_object(
    'narrator', (
      select jsonb_build_object(
        'id', n.id, 'slug', n.slug, 'name', n.name, 'arabic_name', n.arabic_name,
        'alternative_names', n.alternative_names, 'normalized_name', n.normalized_name,
        'kunya', n.kunya, 'nisba', n.nisba, 'laqab', n.laqab, 'gender', n.gender,
        'tradition', n.tradition, 'tabaqah', n.tabaqah, 'generation', n.generation,
        'birth_year_ah', n.birth_year_ah, 'death_year_ah', n.death_year_ah,
        'birth_year_ce', n.birth_year_ce, 'death_year_ce', n.death_year_ce,
        'region', n.region, 'biography', n.biography,
        'biography_source', n.biography_source, 'biography_source_url', n.biography_source_url,
        'identity_status', n.identity_status
      ) from narrators n where n.id = nid
    ),
    'aliases', coalesce((
      select jsonb_agg(jsonb_build_object('alias', a.alias, 'script', a.script, 'source_name', a.source_name) order by a.id)
      from name_aliases a where a.entity_type = 'narrator' and a.entity_id = nid
    ), '[]'::jsonb),
    'teachers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'slug', t.slug, 'name', t.name, 'arabic_name', t.arabic_name,
        'source_name', r.source_name, 'verified', r.verified
      ) order by t.name)
      from narrator_relations r
      join narrators t on t.id = r.to_narrator_id
      where r.from_narrator_id = nid and r.relation_type = 'teacher'
    ), '[]'::jsonb),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'slug', s.slug, 'name', s.name, 'arabic_name', s.arabic_name,
        'source_name', r.source_name, 'verified', r.verified
      ) order by s.name)
      from narrator_relations r
      join narrators s on s.id = r.to_narrator_id
      where r.from_narrator_id = nid and r.relation_type = 'student'
    ), '[]'::jsonb),
    'jarh_wa_tadil', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', na.id, 'original_term', na.original_term, 'normalized_term', na.normalized_term,
        'explanation', na.explanation, 'display_score', na.display_score,
        'computed_summary', na.computed_summary, 'computed_summary_method', na.computed_summary_method,
        'reference_book', na.reference_book, 'edition', na.edition, 'volume', na.volume, 'page', na.page,
        'source_url', na.source_url, 'verified', na.verified,
        'scholar', jsonb_build_object(
          'id', coalesce(sc.canonical_scholar_id, sc.id), 'slug', sc.slug,
          'name', sc.name, 'arabic_name', sc.arabic_name, 'tradition', sc.tradition
        )
      ) order by na.id)
      from narrator_assessments na
      join scholars sc on sc.id = na.scholar_id
      where na.narrator_id = nid
    ), '[]'::jsonb),
    'appearance_total', a_total,
    'appearance_limit', a_limit,
    'appearance_offset', a_offset,
    'appearances', coalesce((
      select jsonb_agg(row_obj order by (row_obj->>'chain_id')::bigint, (row_obj->>'position')::int)
      from (
        select jsonb_build_object(
          'chain_id', cn.chain_id, 'position', cn.position,
          'transmission_word', cn.transmission_word, 'is_weak_link', cn.is_weak_link,
          'variation_id', ch.variation_id, 'hadith_id', sv.hadith_id,
          'hadith_slug', h.slug, 'hadith_title', h.title,
          'book_id', b.id, 'book_title', b.title, 'book_tradition', b.tradition,
          'hadith_number', sv.hadith_number, 'source_url', sv.source_url
        ) as row_obj
        from chain_narrators cn
        join chains ch on ch.id = cn.chain_id
        join source_variations sv on sv.id = ch.variation_id
        join hadiths h on h.id = sv.hadith_id
        join books b on b.id = sv.book_id
        where cn.narrator_id = nid
        order by h.id, sv.id, ch.id, cn.position
        limit a_limit offset a_offset
      ) page
    ), '[]'::jsonb),
    'books_cited', coalesce((
      select jsonb_agg(book_obj order by (book_obj->>'id')::bigint)
      from (
        select distinct on (b.id) jsonb_build_object(
          'id', b.id, 'title', b.title, 'tradition', b.tradition, 'book_kind', b.book_kind
        ) as book_obj
        from chain_narrators cn
        join chains ch on ch.id = cn.chain_id
        join source_variations sv on sv.id = ch.variation_id
        join books b on b.id = sv.book_id
        where cn.narrator_id = nid
        order by b.id
      ) books_x
    ), '[]'::jsonb),
    'provenance', jsonb_build_object('matched_by', 'get_narrator_full', 'query', query, 'narrator_id', nid)
  ) into result;

  return result;
end;
$$;

-- Live: service_role only (no anon/authenticated)
revoke all on function public.get_hadith_full(text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.get_narrator_full(text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.resolve_variation_attributions(integer) from public, anon, authenticated;
grant execute on function public.get_hadith_full(text, integer, integer, boolean) to service_role;
grant execute on function public.get_narrator_full(text, integer, integer, boolean) to service_role;
grant execute on function public.resolve_variation_attributions(integer) to service_role;

comment on function public.get_hadith_full(text, integer, integer, boolean) is
  'Unique match → full JSON (paginated variations). Ambiguous → candidates. summary_mode=true omits full texts/chains. Defaults: limit 25, offset 0.';

comment on function public.get_narrator_full(text, integer, integer, boolean) is
  'Unique match → full JSON (paginated appearances). Ambiguous → candidates deduped by id.';

commit;
