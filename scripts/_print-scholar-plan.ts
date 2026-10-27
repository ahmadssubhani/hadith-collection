import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync("data/preapply-checks.json", "utf8"));
console.log("| id | name | action |");
console.log("|----|------|--------|");
const all = [...r.scholars.set_sunni_rows, ...r.scholars.leave_null_rows].sort(
  (a: { id: number }, b: { id: number }) => a.id - b.id
);
for (const s of all) {
  const flag = s.action === "leave_null" ? "**LEAVE NULL**" : "Sunni";
  console.log(`| ${s.id} | ${s.name} | ${flag} |`);
}
console.log("\nset_sunni:", r.scholars.set_sunni, "leave_null:", r.scholars.leave_null);
console.log("bukhari abort:", r.bukhari_repoint.abort_recommended, "collisions:", r.bukhari_repoint.collisions.length);
