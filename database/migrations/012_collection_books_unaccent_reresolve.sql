-- Migration 012: missing Sunni collection books, unaccent normalisation, re-resolve attributions
-- Additive. Does not edit 006–011 logic beyond replacing the two resolve helpers.
-- Apply manually after 011.

begin;

create extension if not exists unaccent;

-- ---------------------------------------------------------------------------
-- A) Ensure canonical Sunni collection books exist (idempotent by title)
-- ---------------------------------------------------------------------------
insert into public.books (title, arabic_title, author, tradition, book_type, book_kind, category, source_url)
select v.title, v.arabic_title, v.author, v.tradition, 'hadith_collection', 'collection', v.category, v.source_url
from (values
  (
    'Sunan Abu Dawud',
    'سنن أبي داود',
    'Abu Dawud al-Sijistani',
    'Sunni',
    'Sunan',
    'https://sunnah.com/abudawud'
  ),
  (
    'Sunan Ibn Majah',
    'سنن ابن ماجه',
    'Ibn Majah',
    'Sunni',
    'Sunan',
    'https://sunnah.com/ibnmajah'
  ),
  (
    'Sunan al-Nasa''i',
    'سنن النسائي',
    'al-Nasa''i',
    'Sunni',
    'Sunan',
    'https://sunnah.com/nasai'
  ),
  (
    'Musnad Ahmad',
    'مسند أحمد',
    'Ahmad ibn Hanbal',
    'Sunni',
    'Musnad',
    'https://sunnah.com/ahmad'
  ),
  (
    'Sunan al-Darimi',
    'سنن الدارمي',
    'al-Darimi',
    'Sunni',
    'Sunan',
    'https://sunnah.com/darimi'
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
-- B) unaccent() normalisation in resolve helpers
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

  select b.id into bid
  from books b
  where b.book_kind in ('collection', 'commentary', 'other')
    and (
      lower(unaccent(b.title)) = a
      or lower(unaccent(coalesce(b.arabic_title, ''))) = a
      or (
        a ~ '(bukhari|البخاري)' and unaccent(b.title) ~* '^(Sahih al-Bukhari|صحيح البخاري)$'
      )
      or (
        a ~ '(muslim|مسلم)' and unaccent(b.title) ~* '^(Sahih Muslim|Sahih Muslim|صحيح مسلم)$'
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
        a ~ '(nasa.?i|nasaa.?i|النسائي)' and unaccent(b.title) ~* 'nasa|نسائي'
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
        a ~ '(darimi|الدارمي)' and unaccent(b.title) ~* 'darimi|دارمي'
      )
      or (
        a ~ '(tabarani|الطبراني)' and unaccent(b.title) ~* 'tabarani|طبراني'
      )
      or (
        a ~ '(ibn\s*hibban|ibn\s*hebban|ابن حبان)' and unaccent(b.title) ~* 'hibban|hebban|حبان'
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
  t := regexp_replace(t, '\s*-\s*Narrated by\s+', '|', 'gi');
  t := regexp_replace(t, '\s+and\s+', '|', 'gi');
  t := regexp_replace(t, '\s*&\s*', '|', 'g');
  t := regexp_replace(t, '\s*,\s*', '|', 'g');
  t := regexp_replace(t, '\s+with\s+.*$', '', 'i');

  foreach part in array string_to_array(t, '|') loop
    part := trim(both from unaccent(part));
    if part = '' then continue; end if;
    if part ~* '^(with a similar wording|as Mu.?allaq|hanging)' then continue; end if;
    fragment := part;
    role := 'attributed_source';
    return next;
  end loop;
end;
$$;

-- Keep #variable_conflict use_column (synced with live 011)
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
          r.vid, bid, frag.role, frag.fragment, 0.8500, 'migration-012-parse', false
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
    n := n + 1;
  end loop;
end;
$$;

revoke all on function public.resolve_variation_attributions(integer) from public, anon, authenticated;
grant execute on function public.resolve_variation_attributions(integer) to service_role;

-- Re-run resolution after new books + unaccent
select public.resolve_variation_attributions(null);

commit;
