# Tradition fixes (migration 009)

**Status:** SQL drafted — **not applied** until you approve.  
**Rule:** No invented bio data; tradition only where classification is clear from known corpus / import provenance.

## Pre-apply orphan re-verification (exact, paginated — not PostgREST 1000-skew)

| Check | Audit (skewed) | Exact re-verify |
|-------|----------------|-----------------|
| Orphan chains (`variation_id` missing) | 67 | **0** |
| Dangling `chain_narrators.narrator_id` | 234 | **0** |
| Chains with zero nodes | 141 | **33** |
| Variations with no chain | 247 | **247** (confirmed) |
| Unresolved nodes (`narrator_id` null) | 0 | **0** |

No migration depends on deleting orphan chains — there are none.

---

## A) Books 7–16 → `Twelver Shia`

| id | title | from | to |
|----|-------|------|-----|
| 7 | Man Lā Yaḥḍuruh al-Faqīh | Sunni | Twelver Shia |
| 8 | Al-Khiṣāl | Sunni | Twelver Shia |
| 9 | Al-Amālī | Sunni | Twelver Shia |
| 10 | Al-Kāfi | Sunni | Twelver Shia |
| 11 | Faḍaʾil al-Shīʿa | Sunni | Twelver Shia |
| 12 | Kitāb al-Ghayba | Sunni | Twelver Shia |
| 13 | Kāmil al-Ziyārāt | Sunni | Twelver Shia |
| 14 | ʿUyūn akhbār al-Riḍā | Sunni | Twelver Shia |
| 15 | Kitāb al-Muʾmin | Sunni | Twelver Shia |
| 16 | Maʿānī al-ʾAkhbār | Sunni | Twelver Shia |

Book 17 (Nahj al-Balāgha) already Twelver Shia — unchanged.

---

## B) Scholars Majlisi / Behbudi

| id | name | from | to |
|----|------|------|-----|
| 2 | Allamah al-Majlisi | Sunni | Twelver Shia |
| 3 | Muhammad Baqir al-Behbudi | Sunni | Twelver Shia |

---

## C) Scholars with `tradition IS NULL` (101 rows, ids 12–112)

Pre-apply review (`data/preapply-checks.json`):

| Action | Count | IDs |
|--------|-------|-----|
| Set `Sunni` | **94** | 12–112 except the leave-null set |
| **Leave NULL** (ambiguous) | **7** | **43, 44, 85, 86, 88, 89, 112** |

Leave-null names:

| id | name | reason |
|----|------|--------|
| 43 | إسحاق بن إبراهيم الفارسي | ambiguous |
| 44 | زياد بن سعد | ambiguous |
| 85 | أسود بن سالم العابد | ambiguous |
| 86 | العباس بن مصعب المروزي | ambiguous |
| 88 | محمد بن عمر | ambiguous |
| 89 | محمد بن حمدويه | ambiguous |
| 112 | محمد بن علي الصوري | ambiguous |

Full 101-row plan: see response / `data/preapply-checks.json`.

After apply, expected remaining null-tradition scholars among 12–112: **7**.

---

## D) Ibn Hajar merge (no delete)

| Action | Detail |
|--------|--------|
| Canonical | scholar **id 7** (`ibn-hajar-al-asqalani`, Arabic + 773–852 AH) |
| Alias row kept | scholar **id 1** → `canonical_scholar_id = 7` |
| FK move | `hadith_assessments` scholar_id 1→7 (7 rows currently on id 1) |
| Aliases inserted | `Ibn Hajar al-Asqalani`, `ibn-hajar`, `ابن حجر العسقلاني` on entity 7 |

---

## Apply checklist

1. Record counts (`scripts/record-migration-counts.ts`)
2. Apply 006 → 010 in order with `DATABASE_URL`
3. Re-query this log’s expected counts
4. Append “Applied at …” timestamp below

**Applied at:** _(pending)_
