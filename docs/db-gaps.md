# Database gaps

Generated: 2026-10-19T07:05:22.501Z  
Project: ggmqufghubpgsquldjdx

## Priority gaps

| Gap | Count |
|-----|------:|
| Narrators with no jarh wa taʿdīl ruling | **1097** / 1128 |
| Chains with no assessment | **822** / 822 |
| Hadiths with no category (M2M) | **4** / 5 |
| Books with no / unclassified tradition | **0** / 101 |

## Structural gaps (collectors C)

| Gap | Count |
|-----|------:|
| Chains with zero nodes | 33 |
| Variations with no chain | 247 |
| Scholars with null tradition | 7 |
| variation_book_attributions rows | 283 |

## How to shrink gaps

```bash
# After placing sourced CSVs under data/collectors/
npm run collect:rijal              # dry-run
npm run collect:rijal:apply
npm run collect:relations
npm run collect:relations:apply
npm run collect:chains
npm run collect:chains:apply
npm run collect:scholars
npm run collect:scholars:apply
npm run collect:books
npm run collect:books:apply
npm run collect:gaps               # refresh this file
```

Unmatched rows land in `data/unmatched/*.csv`. Never invent rulings — leave NULL and log.
