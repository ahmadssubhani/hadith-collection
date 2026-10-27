/**
 * Shared helpers for collectors: dry-run by default, provenance, unmatched CSV.
 */
import { loadLocalEnv } from "../load-env";
loadLocalEnv();
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const APPLY = process.argv.includes("--apply");

export function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function unmatchedPath(name: string): string {
  const dir = path.join(process.cwd(), "data", "unmatched");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

export function csvEscape(value: string | number | boolean | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function writeUnmatchedCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const file = unmatchedPath(filename);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${rows.length} unmatched rows → ${file}`);
}

export async function ensureImportBatch(
  sb: SupabaseClient,
  provider: string,
  sourceUrl: string | null,
  notes: string,
  license = "unknown",
  permissionStatus = "unknown"
): Promise<number | null> {
  if (!APPLY) {
    console.log(`[dry-run] would create import_batches provider=${provider}`);
    return null;
  }
  const checksum = createHash("sha256").update(`${provider}|${sourceUrl ?? ""}|${notes}`).digest("hex").slice(0, 32);
  const { data, error } = await sb
    .from("import_batches")
    .insert({
      provider,
      source_url: sourceUrl,
      license,
      permission_status: permissionStatus,
      retrieved_at: new Date().toISOString(),
      checksum,
      notes,
    })
    .select("id")
    .single();
  if (error) throw new Error(`import_batches: ${error.message}`);
  return data.id as number;
}

export async function insertRawRecord(
  sb: SupabaseClient,
  batchId: number | null,
  externalId: string,
  payload: unknown
): Promise<void> {
  if (!APPLY || batchId == null) return;
  const { error } = await sb.from("raw_import_records").upsert(
    {
      batch_id: batchId,
      external_id: externalId,
      raw_payload: payload as object,
      processing_status: "pending",
    },
    { onConflict: "batch_id,external_id" }
  );
  if (error) throw new Error(`raw_import_records: ${error.message}`);
}

export async function fetchAll<T extends Record<string, unknown>>(
  sb: SupabaseClient,
  table: string,
  select: string,
  filter?: (q: ReturnType<SupabaseClient["from"]>) => unknown
): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    let q = sb.from(table).select(select).range(from, from + page - 1);
    if (filter) q = filter(q as never) as typeof q;
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < page) break;
  }
  return out;
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `item-${Date.now()}`;
}

export function logMode(collector: string) {
  console.log(`\n=== ${collector} ===`);
  console.log(APPLY ? "MODE: APPLY" : "MODE: dry-run (pass --apply to write)");
}

export function appendGapNote(line: string) {
  const dir = path.join(process.cwd(), "data", "unmatched");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "_collector-notes.log");
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
}
