/**
 * After migration 013: dump unmatched attribution fragments to CSV.
 *   npx tsx scripts/collectors/log-attribution-gaps.ts
 */
import { adminClient, logMode, writeUnmatchedCsv } from "./_shared";

async function main() {
  logMode("log-attribution-gaps");
  const sb = adminClient();
  const { data, error } = await sb.rpc("resolve_variation_attributions", { p_limit: null });
  if (error) {
    // Fallback: read existing attributions + attribution_string books and re-check client-side is heavy;
    // prefer RPC. If RPC blocked for some roles, surface error.
    throw new Error(error.message);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const frags: string[] = row.unmatched_fragments ?? [];
    for (const f of frags) {
      const key = (f ?? "").trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([fragment, n]) => [fragment, n, "unmatched_after_013"]);

  writeUnmatchedCsv("attribution-fragments.csv", ["fragment", "variation_hits", "reason"], rows);
  console.log(`Unique unmatched fragments: ${rows.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
