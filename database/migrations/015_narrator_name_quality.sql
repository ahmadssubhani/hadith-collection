-- Migration 015: narrator name_quality + normalized_name + latin-copy arabic null + fragment unverified
-- Additive schema + data fixes. Documented rules only (no invented identities).
-- Show/apply after reviewing data/unmatched/narrator-quality.json.
-- Does NOT delete narrators, rewrite name text, or touch chain_narrators.

begin;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.narrators
  add column if not exists name_quality text;

alter table public.narrators
  add column if not exists normalized_name text;

comment on column public.narrators.name_quality is
  'clean | fragment | needs_review — see rules in migration 015';

comment on column public.narrators.normalized_name is
  'Deterministic: unaccent(lower(name)), strip trailing honorifics and leading Hadith./numeric refs';

-- ---------------------------------------------------------------------------
-- Helper: deterministic normalized_name (immutable expression via update)
-- Rule N1: lower(unaccent(name))
-- Rule N2: strip trailing honorifics:
--          may god/allah be pleased with him [and his father]
--          peace be upon him / (a.s.) / (ra) / (as)
-- Rule N3: strip leading numbering: Hadith.191 - | 7-43 | (1) | 2.
-- Rule N4: collapse whitespace
-- ---------------------------------------------------------------------------
update public.narrators n
set normalized_name = nullif(
  trim(
    both from regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(public.unaccent(n.name)),
          '\s*[-–,]\s*(may\s+(god|allah)\s+be\s+pleased\s+with\s+him(\s+and\s+his\s+father)?|peace\s+be\s+upon\s+him|\(a\.?s\.?\)|\(ra\)|\(as\))\s*$',
          '',
          'gi'
        ),
        '^(hadith\.\s*\d+\s*[-–:]?\s*|\(?\d+([.\-]\d+)*\)?[.\-]?\s*)',
        '',
        'i'
      ),
      '\s+',
      ' ',
      'g'
    )
  ),
  ''
);

create index if not exists narrators_normalized_name_idx
  on public.narrators (normalized_name);

create index if not exists narrators_name_quality_idx
  on public.narrators (name_quality);

-- ---------------------------------------------------------------------------
-- Rule A: null arabic_name where it only repeats a non-Arabic name
--   A1: arabic_name is not null
--   A2: arabic_name contains no Arabic-script letter (\u0600-\u06FF)
--   A3: lower(trim(arabic_name)) = lower(trim(name))
-- ---------------------------------------------------------------------------
update public.narrators
set arabic_name = null
where arabic_name is not null
  and arabic_name !~ '[\u0600-\u06FF]'
  and lower(trim(arabic_name)) = lower(trim(name));

-- ---------------------------------------------------------------------------
-- Rule Q: classify name_quality
-- Fragment (any of F1–F6) else needs_review (R1) else clean.
--
-- F1 fragment_word: name ~* \y(that|quoted|said|heard|narrated|reported|told|telling|on the authority of|someone who)\y
-- F2 fragment_digit: name ~ '\d'
-- F3 fragment_length: char_length(name) > 60
-- F4 fragment_honorific: trailing honorific (same pattern as N2)
-- F5 fragment_leading_numbering: leading Hadith.N or numeric ref
-- F6 fragment_relational_stub: ^(his|her|their) (father|forefathers|son|mother) | ^(to me|someone)
--
-- R1 needs_review: arabic_name is null AND name has no Arabic script
--    (covers former latin-copy rows after Rule A nulling, and originally empty arabic)
-- ---------------------------------------------------------------------------
update public.narrators
set name_quality = case
  -- F1: transmission/function words (POSIX word edges)
  when name ~* '(^|[^[:alpha:]])(that|quoted|said|heard|narrated|reported|told|telling)([^[:alpha:]]|$)'
    or name ~* 'on the authority of'
    or name ~* 'someone who'
    then 'fragment'
  -- F2
  when name ~ '\d'
    then 'fragment'
  -- F3
  when char_length(name) > 60
    then 'fragment'
  -- F4
  when name ~* '(may\s+(god|allah)\s+be\s+pleased\s+with\s+him( and his father)?|peace be upon him|\(a\.?s\.?\)|\(ra\)|\(as\))\s*$'
    then 'fragment'
  -- F5
  when name ~* '^(hadith\.\s*\d+\s*[-–:]?\s*|\(?\d+([.\-]\d+)*\)?[.\-]?\s*)'
    then 'fragment'
  -- F6
  when name ~* '^(his|her|their)[[:space:]]+(father|forefathers|son|mother)([^[:alpha:]]|$)'
    or name ~* '^(to me|someone)([^[:alpha:]]|$)'
    then 'fragment'
  -- R1
  when (arabic_name is null or trim(arabic_name) = '')
    and name !~ '[\u0600-\u06FF]'
    then 'needs_review'
  else 'clean'
end;

-- ---------------------------------------------------------------------------
-- Rule I: identity_status → unverified for fragments
--   I1: name_quality = 'fragment'
--   I2: do not change clean / needs_review identity_status here
-- ---------------------------------------------------------------------------
update public.narrators
set identity_status = 'unverified'
where name_quality = 'fragment'
  and identity_status is distinct from 'unverified';

commit;
