-- Migration 013: attribution parse/match fixes + missing collections
-- Additive. Re-runs resolve_variation_attributions at end.
-- Apply manually after 012.

begin;

create extension if not exists unaccent;

-- ---------------------------------------------------------------------------
-- A) Collections with clear public sources
-- ---------------------------------------------------------------------------
insert into public.books (title, arabic_title, author, tradition, book_type, book_kind, category, source_url)
select v.title, v.arabic_title, v.author, v.tradition, 'hadith_collection', 'collection', v.category, v.source_url
from (values
  (
    'Sunan al-Kubra (al-Nasa''i)',
    'السنن الكبرى للنسائي',
    'al-Nasa''i',
    'Sunni',
    'Sunan',
    'https://en.wikipedia.org/wiki/Al-Sunan_al-Kubra_(al-Nasa%27i)'
  ),
  (
    'Sahih Ibn Khuzaymah',
    'صحيح ابن خزيمة',
    'Ibn Khuzaymah',
    'Sunni',
    'Sahih collection',
    'https://en.wikipedia.org/wiki/Sahih_Ibn_Khuzaymah'
  ),
  (
    'Sunan al-Daraqutni',
    'سنن الدارقطني',
    'al-Daraqutni',
    'Sunni',
    'Sunan',
    'https://en.wikipedia.org/wiki/Al-Daraqutni'
  )
) as v(title, arabic_title, author, tradition, category, source_url)
where not exists (
  select 1 from public.books b
  where b.book_kind = 'collection'
    and (
      lower(b.title) = lower(v.title)
      or lower(coalesce(b.arabic_title, '')) = lower(v.arabic_title)
    )
);

-- ---------------------------------------------------------------------------
-- B) resolve_collection_book_id — Ad-Daarimi / Kubra / Khuzaymah / Daraqutni
-- ---------------------------------------------------------------------------
create or replace function public.resolve_collection_book_id(alias text)
returns bigint
language plpgsql
stable
set search_path = public
as $$
declare
  a text := lower(trim(both from unaccent(coalesce(alias, ''))));
  bid bigint;
begin
  if a = '' then return null; end if;

  -- Normalise article prefixes for matching
  a := regexp_replace(a, '^(al|ad|ar|as|at|an)-', '', 'i');

  select b.id into bid
  from books b
  where b.book_kind in ('collection', 'commentary', 'other')
    and (
      lower(unaccent(b.title)) = a
      or lower(unaccent(coalesce(b.arabic_title, ''))) = a
      or lower(regexp_replace(unaccent(b.title), '^(al|ad|ar|as|at|an)-', '', 'i')) = a
      or (
        a ~ '(bukhari|البخاري)' and unaccent(b.title) ~* '^(Sahih al-Bukhari|صحيح البخاري)$'
      )
      or (
        a ~ '(muslim|مسلم)' and unaccent(b.title) ~* '^(Sahih Muslim|صحيح مسلم)$'
      )
      or (
        a ~ '(tirmidh|termedh|الترمذي)' and (
          unaccent(b.title) ~* 'tirmidh' or b.title ~* 'الترمذي' or b.title = 'صحيح الترمذي'
        )
      )
      or (
        a ~ '(abu\s*dawud|abu\s*daoud|ابو داود|أبو داود)'
        and unaccent(b.title) ~* 'dawud|daoud|ابي داود|أبي داود'
        and b.book_kind = 'collection'
      )
      or (
        -- Nasa'i Sughra (avoid catching Kubra title unless fragment says kubra)
        a ~ '(nasa.?i|nasaa.?i|النسائي)'
        and a !~ 'kubra|kubrá|الكبرى'
        and unaccent(b.title) ~* 'nasa|نسائي'
        and unaccent(b.title) !~* 'kubra|الكبرى'
      )
      or (
        a ~ '(kubra|الكبرى)' and a ~ '(nasa|نسائي)'
        and unaccent(b.title) ~* 'kubra|الكبرى'
      )
      or (
        a ~ '(ibn\s*majah|ibn\s*maajah|ابن ماجه)' and unaccent(b.title) ~* 'majah|ماجه'
      )
      or (
        a ~ '(ahmad|أحمد|احمد)' and (
          unaccent(b.title) ~* '^musnad' or unaccent(b.title) ~* 'ahmad' or b.title = 'مسند أحمد'
        )
      )
      or (
        a ~ '(bayhaqi|البيهقي)' and unaccent(b.title) ~* 'bayhaqi|بيهقي'
      )
      or (
        -- Ad-Daarimi / Al-Darimi / الدارمي (double-a transliteration)
        a ~ '(da+rimi|الدارمي)' and unaccent(b.title) ~* 'da+rimi|دارمي'
      )
      or (
        a ~ '(tabarani|الطبراني)' and unaccent(b.title) ~* 'tabarani|طبراني'
      )
      or (
        a ~ '(ibn\s*hibban|ibn\s*hebban|ابن حبان)' and unaccent(b.title) ~* 'hibban|hebban|حبان'
      )
      or (
        a ~ '(ibn\s*khuzaymah|ibn\s*khuzaima|ابن خزيمة)' and unaccent(b.title) ~* 'khuzaymah|khuzaima|خزيمة'
      )
      or (
        a ~ '(daraqutn|darqutn|الدارقطني)' and unaccent(b.title) ~* 'daraqutn|darqutn|دارقطني'
      )
      or (
        a ~ '(hakim|الحاكم)' and unaccent(b.title) ~* 'hakim|مستدرك|حاكم'
      )
    )
  order by
    case when b.canonical_book_id is null then 0 else 1 end,
    case when b.book_kind = 'collection' then 0 else 1 end,
    b.id
  limit 1;

  return bid;
end;
$$;

-- ---------------------------------------------------------------------------
-- C) parse_attribution_fragments — split on " - ", skip non-book noise
-- ---------------------------------------------------------------------------
create or replace function public.parse_attribution_fragments(attr text)
returns table (fragment text, role text)
language plpgsql
stable
as $$
declare
  t text := unaccent(coalesce(attr, ''));
  part text;
begin
  if trim(both from t) = '' then
    return;
  end if;

  if t ~* '^(Agreed upon|متفق عليه)' or t ~* 'agreed upon' then
    fragment := 'bukhari'; role := 'agreed_upon'; return next;
    fragment := 'muslim'; role := 'agreed_upon'; return next;
    return;
  end if;

  t := regexp_replace(t, '^\s*Narrated by\s+', '', 'i');
  -- Prefer explicit " - Narrated by ", then any " - " hyphen separator
  t := regexp_replace(t, '\s*-\s*Narrated by\s+', '|', 'gi');
  t := regexp_replace(t, '\s+-\s+', '|', 'g');
  t := regexp_replace(t, '\s+and\s+', '|', 'gi');
  t := regexp_replace(t, '\s*&\s*', '|', 'g');
  t := regexp_replace(t, '\s*,\s*', '|', 'g');

  foreach part in array string_to_array(t, '|') loop
    part := trim(both from unaccent(part));
    if part = '' then continue; end if;

    -- Non-book / commentary noise — skip (do not invent links)
    if part ~* '^(with a similar wording|with a decisive form|as Mu.?allaq|hanging|this is the wording of|with its two versions|in Al-Kubra and by)' then
      continue;
    end if;
    if part ~* '^(with\s+)' then
      continue;
    end if;
    -- Pure hanging/muallaq descriptors without a compiler name
    if part ~* 'mu.?allaq' and part !~* '(bukhari|muslim|nasa|tirmidh|dawud|ahmad|bayhaqi|darimi|daarimi)' then
      continue;
    end if;

    -- Strip trailing "in Al-Kubra" qualifier into kubra+nasa hint when present
    if part ~* 'in Al-Kubra' and part ~* 'Nasa' then
      fragment := 'Sunan al-Kubra (al-Nasa''i)';
      role := 'attributed_source';
      return next;
      continue;
    end if;

    fragment := part;
    role := 'attributed_source';
    return next;
  end loop;
end;
$$;

-- Keep resolve wrapper with #variable_conflict (same as 012)
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
begin
  for r in
    select sv.id as vid,
           coalesce(sv.attribution_text, b.title) as attr
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
          r.vid, bid, frag.role, frag.fragment, 0.9000, 'migration-013-parse', false
        )
        on conflict (variation_id, book_id, role) do update
          set attribution_fragment = excluded.attribution_fragment,
              parse_confidence = greatest(
                coalesce(variation_book_attributions.parse_confidence, 0),
                excluded.parse_confidence
              ),
              source_name = excluded.source_name;

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
  end loop;
end;
$$;

revoke all on function public.resolve_variation_attributions(integer) from public, anon, authenticated;
grant execute on function public.resolve_variation_attributions(integer) to service_role;

-- Re-resolve all attribution_string variations
select public.resolve_variation_attributions(null);

commit;
