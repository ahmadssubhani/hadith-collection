# Bukhari hadith-number stub repoint (migration 009)

**Status:** SQL drafted — **not applied**.  
**Canonical book:** id **27** `Sahih al-Bukhari` (English).  
**Arabic twin:** id **67** `صحيح البخاري` → `canonical_book_id = 27` (007).  
**Rule:** stubs are **not deleted**; `book_kind = 'hadith_number_stub'`, `canonical_book_id = 27`.

Each stub currently has **1** `source_variations` row. After apply: that row’s `book_id` → 27, `attribution_text` ← former book title, `hadith_number` filled from title when empty.

| stub book_id | former title | extracted number(s) | variations moved |
|--------------|--------------|---------------------|------------------|
| 74 | Sahih al-Bukhari 7387, | 7387 | 1 |
| 75 | Sahih al-Bukhari 7412, | 7412 | 1 |
| 76 | Sahih al-Bukhari 7427, | 7427 | 1 |
| 77 | Sahih al-Bukhari 7437, | 7437 | 1 |
| 78 | Sahih al-Bukhari 7495, | 7495 | 1 |
| 79 | Sahih al-Bukhari 7278, | 7278 | 1 |
| 80 | Sahih al-Bukhari 7284, | 7284 | 1 |
| 81 | Sahih al-Bukhari 7317, | 7317 | 1 |
| 82 | Sahih al-Bukhari 7327, | 7327 | 1 |
| 83 | Sahih al-Bukhari 7340, | 7340 | 1 |
| 84 | Sahih al-Bukhari 7350, | 7350 | 1 |
| 85 | Sahih al-Bukhari 7258, | 7258 | 1 |
| 86 | Sahih al-Bukhari 7176, | 7176 | 1 |
| 87 | Sahih al-Bukhari 7183, | 7183 | 1 |
| 88 | Sahih al-Bukhari 7193, | 7193 | 1 |
| 89 | Sahih al-Bukhari 7199, | 7199 | 1 |
| 90 | Sahih al-Bukhari 7222, | 7222 | 1 |
| 91 | Sahih al-Bukhari 7055, | 7055 | 1 |
| 92 | Sahih al-Bukhari 7062, | 7062 | 1 |
| 93 | Sahih al-Bukhari 7102, 7103, | 7102, 7103 | 1 |
| 94 | Sahih al-Bukhari 7105, 7106, | 7105, 7106 | 1 |
| 95 | Sahih al-Bukhari 7001, | 7001 | 1 |
| 96 | Sahih al-Bukhari 7015, | 7015 | 1 |
| 97 | Sahih al-Bukhari 7028, | 7028 | 1 |
| 98 | Sahih al-Bukhari 7030, | 7030 | 1 |
| 99 | Sahih al-Bukhari 7036, | 7036 | 1 |
| 100 | Sahih al-Bukhari 6957, | 6957 | 1 |
| 101 | Sahih al-Bukhari 6924, | 6924 | 1 |

**Total:** 28 stubs → 28 variation `book_id` updates.

Attribution-string books (~44) keep their rows; variations pointing at them get `attribution_text` + `attribution_book_id` set (book_id unchanged in that step so FKs stay valid for review).

**Applied at:** _(pending)_
