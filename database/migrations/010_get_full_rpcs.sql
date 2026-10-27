-- Migration 010: get_hadith_full / get_narrator_full
-- Unique match → full JSON. Ambiguous → { error: 'ambiguous', candidates: [...] }.
-- Never silently picks among equally plausible names.

begin;

create or replace function public.normalize_search_key(q text)
returns text
language sql
immutable
as $$
  select lower(trim(both from regexp_replace(coalesce(q, ''), '\s+', ' ', 'g')));
$$;

-- ---------------------------------------------------------------------------
-- get_hadith_full
-- ---------------------------------------------------------------------------
create or replace function public.get_hadith_full(query text)
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
begin
  if q is null or q = '' then
    return jsonb_build_object('error', 'empty_query');
  end if;

  -- 1) Numeric id — unique by definition
  if q ~ '^\d+$' then
    select h.id into hid from hadiths h where h.id = q::bigint;
    if hid is null then
      return jsonb_build_object('error', 'not_found', 'query', query);
    end if;
  end if;

  -- 2) Exact matches (slug / title / arabic / normalized / alias)
  if hid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', x.id,
             'slug', x.slug,
             'title', x.title,
             'arabic_title', x.arabic_title,
             'match', x.match_kind,
             'score', 1.0
           ) order by x.id)
    into candidate_count, candidates
    from (
      select distinct h.id, h.slug, h.title, h.arabic_title, 'exact'::text as match_kind
      from hadiths h
      where h.slug = q
         or lower(h.title) = q
         or lower(coalesce(h.arabic_title, '')) = q
         or lower(coalesce(h.normalized_name, '')) = q
      union
      select h.id, h.slug, h.title, h.arabic_title, 'alias_exact'
      from name_aliases a
      join hadiths h on h.id = a.entity_id
      where a.entity_type = 'hadith'
        and (lower(a.alias) = q or lower(coalesce(a.alias_normalized, '')) = q)
    ) x;

    if candidate_count > 1 then
      return jsonb_build_object(
        'error', 'ambiguous',
        'query', query,
        'candidates', candidates
      );
    elsif candidate_count = 1 then
      hid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  -- 3) Fuzzy (only if no exact). Ambiguous if >1 above threshold.
  if hid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', x.id,
             'slug', x.slug,
             'title', x.title,
             'arabic_title', x.arabic_title,
             'match', 'fuzzy',
             'score', x.score
           ) order by x.score desc, x.id)
    into candidate_count, candidates
    from (
      select h.id, h.slug, h.title, h.arabic_title,
             greatest(
               similarity(h.title, query),
               similarity(coalesce(h.arabic_title, ''), query)
             ) as score
      from hadiths h
      where h.title % query
         or coalesce(h.arabic_title, '') % query
      union
      select h.id, h.slug, h.title, h.arabic_title,
             similarity(a.alias, query) as score
      from name_aliases a
      join hadiths h on h.id = a.entity_id
      where a.entity_type = 'hadith'
        and (a.alias % query or coalesce(a.alias_normalized, '') % query)
    ) x
    where x.score >= 0.3;

    if coalesce(candidate_count, 0) = 0 then
      return jsonb_build_object('error', 'not_found', 'query', query);
    elsif candidate_count > 1 then
      return jsonb_build_object(
        'error', 'ambiguous',
        'query', query,
        'candidates', candidates
      );
    else
      hid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  select jsonb_build_object(
    'hadith', (
      select jsonb_build_object(
        'id', h.id,
        'slug', h.slug,
        'title', h.title,
        'arabic_title', h.arabic_title,
        'summary', h.summary,
        'topics', h.topics,
        'review_status', h.review_status,
        'data_origin', h.data_origin,
        'normalized_name', h.normalized_name
      )
      from hadiths h where h.id = hid
    ),
    'aliases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'alias', a.alias,
        'script', a.script,
        'source_name', a.source_name
      ) order by a.id)
      from name_aliases a
      where a.entity_type = 'hadith' and a.entity_id = hid
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'slug', c.slug,
        'title', c.title,
        'arabic_title', c.arabic_title,
        'keywords', c.keywords
      ) order by c.sort_order, c.id)
      from hadith_categories hc
      join categories c on c.id = hc.category_id
      where hc.hadith_id = hid
    ), '[]'::jsonb),
    'source_variations', coalesce((
      select jsonb_agg(var_obj order by (var_obj->>'id')::bigint)
      from (
        select jsonb_build_object(
          'id', sv.id,
          'book', jsonb_build_object(
            'id', b.id,
            'title', b.title,
            'arabic_title', b.arabic_title,
            'author', b.author,
            'tradition', b.tradition,
            'book_kind', b.book_kind,
            'category', b.category,
            'canonical_book_id', b.canonical_book_id
          ),
          'hadith_number', sv.hadith_number,
          'chapter', sv.chapter,
          'volume', sv.volume,
          'page', sv.page,
          'arabic_text', sv.arabic_text,
          'english_text', sv.english_text,
          'translator', sv.translator,
          'source_url', sv.source_url,
          'hadith_status', sv.hadith_status,
          'grade_code', sv.grade_code,
          'hadith_type', sv.hadith_type,
          'transmission_scope', sv.transmission_scope,
          'chain_status', sv.chain_status,
          'attribution_text', sv.attribution_text,
          'verified', sv.verified,
          'review_status', sv.review_status,
          'data_origin', sv.data_origin,
          'status_notes', sv.status_notes,
          'assessments', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ha.id,
              'original_grade', ha.original_grade,
              'normalized_grade', ha.normalized_grade,
              'explanation', ha.explanation,
              'reference_book', ha.reference_book,
              'volume', ha.volume,
              'page', ha.page,
              'source_url', ha.source_url,
              'verified', ha.verified,
              'scholar', jsonb_build_object(
                'id', coalesce(s.canonical_scholar_id, s.id),
                'name', s.name,
                'arabic_name', s.arabic_name,
                'tradition', s.tradition,
                'slug', s.slug
              )
            ) order by ha.id)
            from hadith_assessments ha
            join scholars s on s.id = ha.scholar_id
            where ha.variation_id = sv.id
          ), '[]'::jsonb),
          'chains', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ch.id,
              'chain_number', ch.chain_number,
              'raw_chain_text', ch.raw_chain_text,
              'continuity_status', ch.continuity_status,
              'quality_status', ch.quality_status,
              'verified', ch.verified,
              'notes', ch.notes,
              'assessments', coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', ca.id,
                  'continuity_status', ca.continuity_status,
                  'quality_status', ca.quality_status,
                  'explanation', ca.explanation,
                  'reference_book', ca.reference_book,
                  'source_url', ca.source_url,
                  'verified', ca.verified,
                  'scholar_id', ca.scholar_id
                ) order by ca.id)
                from chain_assessments ca
                where ca.chain_id = ch.id
              ), '[]'::jsonb),
              'narrators', coalesce((
                select jsonb_agg(jsonb_build_object(
                  'position', cn.position,
                  'raw_name', cn.raw_name,
                  'transmission_word', cn.transmission_word,
                  'is_weak_link', cn.is_weak_link,
                  'weak_link_reason', cn.weak_link_reason,
                  'match_confidence', cn.match_confidence,
                  'narrator', case when n.id is null then null else jsonb_build_object(
                    'id', n.id,
                    'slug', n.slug,
                    'name', n.name,
                    'arabic_name', n.arabic_name,
                    'generation', n.generation,
                    'tabaqah', n.tabaqah,
                    'tradition', n.tradition
                  ) end
                ) order by cn.position)
                from chain_narrators cn
                left join narrators n on n.id = cn.narrator_id
                where cn.chain_id = ch.id
              ), '[]'::jsonb)
            ) order by ch.chain_number, ch.id)
            from chains ch
            where ch.variation_id = sv.id
          ), '[]'::jsonb)
        ) as var_obj
        from source_variations sv
        join books b on b.id = sv.book_id
        where sv.hadith_id = hid
      ) variations
    ), '[]'::jsonb),
    'provenance', jsonb_build_object(
      'matched_by', 'get_hadith_full',
      'query', query,
      'hadith_id', hid
    )
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_narrator_full
-- ---------------------------------------------------------------------------
create or replace function public.get_narrator_full(query text)
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

  if nid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', x.id,
             'slug', x.slug,
             'name', x.name,
             'arabic_name', x.arabic_name,
             'match', x.match_kind,
             'score', 1.0
           ) order by x.id)
    into candidate_count, candidates
    from (
      select distinct n.id, n.slug, n.name, n.arabic_name, 'exact'::text as match_kind
      from narrators n
      where n.slug = q
         or lower(n.name) = q
         or lower(coalesce(n.arabic_name, '')) = q
         or lower(coalesce(n.normalized_name, '')) = q
         or exists (
           select 1 from unnest(n.alternative_names) as alt where lower(alt) = q
         )
      union
      select n.id, n.slug, n.name, n.arabic_name, 'alias_exact'
      from name_aliases a
      join narrators n on n.id = a.entity_id
      where a.entity_type = 'narrator'
        and (lower(a.alias) = q or lower(coalesce(a.alias_normalized, '')) = q)
    ) x;

    if candidate_count > 1 then
      return jsonb_build_object(
        'error', 'ambiguous',
        'query', query,
        'candidates', candidates
      );
    elsif candidate_count = 1 then
      nid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  if nid is null then
    select count(*)::int,
           jsonb_agg(jsonb_build_object(
             'id', x.id,
             'slug', x.slug,
             'name', x.name,
             'arabic_name', x.arabic_name,
             'match', 'fuzzy',
             'score', x.score
           ) order by x.score desc, x.id)
    into candidate_count, candidates
    from (
      select n.id, n.slug, n.name, n.arabic_name,
             greatest(
               similarity(n.name, query),
               similarity(coalesce(n.arabic_name, ''), query)
             ) as score
      from narrators n
      where n.name % query
         or coalesce(n.arabic_name, '') % query
      union
      select n.id, n.slug, n.name, n.arabic_name,
             similarity(a.alias, query) as score
      from name_aliases a
      join narrators n on n.id = a.entity_id
      where a.entity_type = 'narrator'
        and (a.alias % query or coalesce(a.alias_normalized, '') % query)
    ) x
    where x.score >= 0.3;

    if coalesce(candidate_count, 0) = 0 then
      return jsonb_build_object('error', 'not_found', 'query', query);
    elsif candidate_count > 1 then
      return jsonb_build_object(
        'error', 'ambiguous',
        'query', query,
        'candidates', candidates
      );
    else
      nid := (candidates->0->>'id')::bigint;
    end if;
  end if;

  select jsonb_build_object(
    'narrator', (
      select jsonb_build_object(
        'id', n.id,
        'slug', n.slug,
        'name', n.name,
        'arabic_name', n.arabic_name,
        'alternative_names', n.alternative_names,
        'normalized_name', n.normalized_name,
        'kunya', n.kunya,
        'nisba', n.nisba,
        'laqab', n.laqab,
        'gender', n.gender,
        'tradition', n.tradition,
        'tabaqah', n.tabaqah,
        'generation', n.generation,
        'birth_year_ah', n.birth_year_ah,
        'death_year_ah', n.death_year_ah,
        'birth_year_ce', n.birth_year_ce,
        'death_year_ce', n.death_year_ce,
        'region', n.region,
        'biography', n.biography,
        'biography_source', n.biography_source,
        'biography_source_url', n.biography_source_url,
        'identity_status', n.identity_status
      )
      from narrators n where n.id = nid
    ),
    'aliases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'alias', a.alias,
        'script', a.script,
        'source_name', a.source_name
      ) order by a.id)
      from name_aliases a
      where a.entity_type = 'narrator' and a.entity_id = nid
    ), '[]'::jsonb),
    'teachers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'slug', t.slug,
        'name', t.name,
        'arabic_name', t.arabic_name,
        'source_name', r.source_name,
        'verified', r.verified
      ) order by t.name)
      from narrator_relations r
      join narrators t on t.id = r.to_narrator_id
      where r.from_narrator_id = nid and r.relation_type = 'teacher'
    ), '[]'::jsonb),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'slug', s.slug,
        'name', s.name,
        'arabic_name', s.arabic_name,
        'source_name', r.source_name,
        'verified', r.verified
      ) order by s.name)
      from narrator_relations r
      join narrators s on s.id = r.to_narrator_id
      where r.from_narrator_id = nid and r.relation_type = 'student'
    ), '[]'::jsonb),
    'jarh_wa_tadil', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', na.id,
        'original_term', na.original_term,
        'normalized_term', na.normalized_term,
        'explanation', na.explanation,
        'display_score', na.display_score,
        'computed_summary', na.computed_summary,
        'computed_summary_method', na.computed_summary_method,
        'reference_book', na.reference_book,
        'edition', na.edition,
        'volume', na.volume,
        'page', na.page,
        'source_url', na.source_url,
        'verified', na.verified,
        'scholar', jsonb_build_object(
          'id', coalesce(sc.canonical_scholar_id, sc.id),
          'slug', sc.slug,
          'name', sc.name,
          'arabic_name', sc.arabic_name,
          'tradition', sc.tradition
        )
      ) order by na.id)
      from narrator_assessments na
      join scholars sc on sc.id = na.scholar_id
      where na.narrator_id = nid
    ), '[]'::jsonb),
    'appearances', coalesce((
      select jsonb_agg(jsonb_build_object(
        'chain_id', cn.chain_id,
        'position', cn.position,
        'transmission_word', cn.transmission_word,
        'is_weak_link', cn.is_weak_link,
        'variation_id', ch.variation_id,
        'hadith_id', sv.hadith_id,
        'hadith_slug', h.slug,
        'hadith_title', h.title,
        'book_id', b.id,
        'book_title', b.title,
        'book_tradition', b.tradition,
        'hadith_number', sv.hadith_number,
        'source_url', sv.source_url
      ) order by h.id, sv.id, ch.id, cn.position)
      from chain_narrators cn
      join chains ch on ch.id = cn.chain_id
      join source_variations sv on sv.id = ch.variation_id
      join hadiths h on h.id = sv.hadith_id
      join books b on b.id = sv.book_id
      where cn.narrator_id = nid
    ), '[]'::jsonb),
    'books_cited', coalesce((
      select jsonb_agg(book_obj order by (book_obj->>'id')::bigint)
      from (
        select distinct on (b.id) jsonb_build_object(
          'id', b.id,
          'title', b.title,
          'tradition', b.tradition,
          'book_kind', b.book_kind
        ) as book_obj
        from chain_narrators cn
        join chains ch on ch.id = cn.chain_id
        join source_variations sv on sv.id = ch.variation_id
        join books b on b.id = sv.book_id
        where cn.narrator_id = nid
        order by b.id
      ) books_x
    ), '[]'::jsonb),
    'provenance', jsonb_build_object(
      'matched_by', 'get_narrator_full',
      'query', query,
      'narrator_id', nid
    )
  ) into result;

  return result;
end;
$$;

grant execute on function public.get_hadith_full(text) to anon, authenticated, service_role;
grant execute on function public.get_narrator_full(text) to anon, authenticated, service_role;

commit;
