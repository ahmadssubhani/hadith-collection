-- Migration 016: fix normalized_name when trailing honorific is followed by a dash
-- Example input name:
--   "7-43 Hamzih ... al-Alavi - may God be pleased with him -"
-- After 015 leading-number strip + lower/unaccent, honorific strip failed because
-- the pattern required end-of-string immediately after "him", but a trailing " -" remained.
--
-- Rule N2b (additive to 015 N2): strip honorific even when followed by optional dashes/spaces.
-- Then re-apply leading-number strip + whitespace collapse (same as 015 N3/N4).
-- Does NOT change name, arabic_name, name_quality, identity_status, or chain_narrators.

begin;

comment on column public.narrators.normalized_name is
  'Deterministic: unaccent(lower(name)); strip honorifics (incl. trailing dash after honorific); strip leading Hadith./numeric refs';

update public.narrators n
set normalized_name = nullif(
  trim(
    both from regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(public.unaccent(n.name)),
          -- N2b: honorific, then optional trailing dashes/spaces to end
          '\s*[-–,]*\s*(may\s+(god|allah)\s+be\s+pleased\s+with\s+him(\s+and\s+his\s+father)?|peace\s+be\s+upon\s+him|\(a\.?s\.?\)|\(ra\)|\(as\))\s*[-–,]*\s*$',
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

commit;
