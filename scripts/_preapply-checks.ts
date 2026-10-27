/**
 * Pre-apply checks: scholar tradition review + Bukhari (book_id, hadith_number) collisions.
 */
import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/** Names that are clearly classical Sunni muhaddithūn / rijāl / madhhab imams. */
const CLEARLY_SUNNI = new Set([
  "أبو حاتم بن حبان البستي",
  "البخاري",
  "الدارقطني",
  "أبو أحمد بن عدي الجرجاني",
  "أبو الفرج ابن الجوزي",
  "مسلمة بن القاسم الأندلسي",
  "زكريا بن يحيى الساجي",
  "عبد الباقي بن قانع البغدادي",
  "أبو يعلى الخليلي",
  "مصنفوا تحرير تقريب التهذيب",
  "أحمد بن حنبل",
  "أبو زرعة الرازي",
  "أبو داود السجستاني",
  "علي بن المديني",
  "على بن المديني",
  "أحمد بن عبد الله العجلي",
  "محمد بن سعد كاتب الواقدي",
  "أبو عبد الله الحاكم",
  "أبو الفتح الأزدي",
  "أبو بكر البيهقي",
  "يعقوب بن شيبة السدوسي",
  "عمرو بن علي الفلاس",
  "أبو سعيد بن يونس المصري",
  "عبد الرحمن بن يوسف بن خراش",
  "محمد بن إدريس الشافعي",
  "أحمد بن صالح المصري",
  "يحيى بن بكير",
  "عبد الله بن وهب المصري",
  "أبو جعفر العقيلي",
  "عبد الغني بن سعيد الأزدي",
  "إسحاق بن راهويه",
  "يحيى بن سعيد القطان",
  "سفيان بن عيينة",
  "السيوطي",
  "مالك بن أنس",
  "أيوب بن أبي تميمة السختياني",
  "قتادة بن دعامة السدوسي",
  "مكحول الشامي",
  "عمرو بن دينار الأثرم",
  "الليث بن سعد المصري",
  "معمر بن راشد",
  "أحمد بن الفرات الرازي",
  "ابن منجويه الأصبهاني",
  "شعيب الأرناؤوط",
  "سبط ابن الجوزي",
  "ابن شهاب الزهري",
  "محمد بن عبد الله بن عمار الموصلي",
  "ابن أبي حاتم الرازي",
  "المزي",
  "سفيان الثوري",
  "أبو القاسم اللالكائي",
  "عبد الله بن عباس",
  "ربيعة بن أبي عبد الرحمن الرأي",
  "ميمون بن مهران الجزري",
  "ابن عبد البر الأندلسي",
  "عبد الرحمن بن مهدي",
  "أبو بكر البزار",
  "محمد بن عبد الله المخرمي",
  "البرهان الحلبي",
  "ابن الكيال الشافعي",
  "بشر بن المفضل",
  "الخطيب البغدادي",
  "يعقوب بن سفيان الفسوي",
  "شعبة بن الحجاج بن الورد",
  "الأوزاعي",
  "أبو إسحاق الفزاري",
  "معتمر بن سليمان الرقي",
  "إسماعيل بن عياش العنسي",
  "الفضيل بن عياض",
  "شعيب بن حرب البغدادي",
  "سلام بن أبي مطيع الخزاعي",
  "أبو القاسم بن عساكر",
  "إبراهيم بن يعقوب الجوزجاني",
  "أبو مسهر الغساني",
  "أبو جعفر الطحاوي",
  "ابن الأثير",
  "وكيع بن الجراح",
  "محمد بن عبد الله بن نمير",
  "وهيب بن خالد",
  "ابن دحية الكلبي",
  "أبو عيسى الترمذي",
  "ابن حزم الأندلسي",
  "عبد الملك بن عبد العزيز بن جريج",
  "أبو علي الغساني",
  "هشام بن عبد الملك الطيالسي",
  "النضر بن عبد الجبار",
  "عفان بن مسلم الصفار",
  "حماد بن زيد الجهضمي",
  "جرير بن عبد الحميد الضبي",
  "أبو محمد عبد المؤمن الدمياطي",
  "هشام بن عروة القرشي",
  "عبد الله بن المبارك",
  "أبو القاسم بن بشكوال",
  "يحيى بن سعيد الأنصاري",
]);

/** Ambiguous / too short / could be multiple people — leave tradition null. */
const FLAG_AMBIGUOUS = new Set([
  "زياد بن سعد",
  "أسود بن سالم العابد",
  "العباس بن مصعب المروزي",
  "محمد بن عمر",
  "محمد بن حمدويه",
  "محمد بن علي الصوري",
  "إسحاق بن إبراهيم الفارسي",
]);

async function fetchAll<T extends Record<string, unknown>>(
  table: string,
  select: string
): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from(table).select(select).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < page) break;
  }
  return out;
}

async function main() {
  const { data: scholars, error } = await sb
    .from("scholars")
    .select("id,slug,name,arabic_name,tradition")
    .gte("id", 12)
    .lte("id", 112)
    .order("id");
  if (error) throw error;

  const plan = (scholars ?? []).map((s) => {
    const name = s.name as string;
    let action: "set_sunni" | "leave_null" | "review";
    let reason: string;
    if (FLAG_AMBIGUOUS.has(name)) {
      action = "leave_null";
      reason = "ambiguous / insufficiently identified";
    } else if (CLEARLY_SUNNI.has(name)) {
      action = "set_sunni";
      reason = "clearly classical Sunni muhaddith/rijal/imam";
    } else {
      action = "leave_null";
      reason = "not on clear-Sunni list — leave null pending review";
    }
    return { id: s.id, slug: s.slug, name, arabic_name: s.arabic_name, current_tradition: s.tradition, action, reason };
  });

  const setSunni = plan.filter((p) => p.action === "set_sunni");
  const leaveNull = plan.filter((p) => p.action === "leave_null");

  // Bukhari collision pre-check: for each stub variation, what (27, hadith_number) would become
  const { data: stubs } = await sb
    .from("books")
    .select("id,title")
    .like("title", "Sahih al-Bukhari %");
  const stubBooks = (stubs ?? []).filter((b) => /^Sahih al-Bukhari \d/i.test(b.title));
  const stubIds = stubBooks.map((b) => b.id);

  const stubVars = stubIds.length
    ? await fetchAll<{ id: number; book_id: number; hadith_number: string | null }>(
        "source_variations",
        "id,book_id,hadith_number"
      ).then((rows) => rows.filter((r) => stubIds.includes(r.book_id)))
    : [];

  // Also get variations already on book 27
  const onCanonical = await fetchAll<{ id: number; book_id: number; hadith_number: string | null }>(
    "source_variations",
    "id,book_id,hadith_number"
  ).then((rows) => rows.filter((r) => r.book_id === 27));

  const existingKeys = new Map<string, number[]>();
  for (const v of onCanonical) {
    const num = String(v.hadith_number ?? "").trim();
    if (!num) continue;
    const k = `27|${num}`;
    const list = existingKeys.get(k) ?? [];
    list.push(v.id);
    existingKeys.set(k, list);
  }

  const proposed: {
    stub_book_id: number;
    title: string;
    variation_id: number;
    current_number: string | null;
    proposed_number: string;
    collision: boolean;
    colliding_variation_ids: number[];
  }[] = [];

  let abort = false;
  for (const stub of stubBooks) {
    const m = stub.title.match(/Sahih al-Bukhari\s+(.+?)\s*$/i);
    const extracted = (m?.[1] ?? "").replace(/,\s*$/, "").trim();
    const vars = stubVars.filter((v) => v.book_id === stub.id);
    for (const v of vars) {
      const proposedNum = (v.hadith_number && String(v.hadith_number).trim()) || extracted;
      const k = `27|${proposedNum}`;
      const colliding = existingKeys.get(k) ?? [];
      const collision = colliding.length > 0;
      if (collision) abort = true;
      proposed.push({
        stub_book_id: stub.id,
        title: stub.title,
        variation_id: v.id,
        current_number: v.hadith_number,
        proposed_number: proposedNum,
        collision,
        colliding_variation_ids: colliding,
      });
      // also detect if two stubs would collide with each other on same number
      const list = existingKeys.get(k) ?? [];
      list.push(v.id);
      existingKeys.set(k, list);
    }
  }

  // self-collisions among stubs after double-add
  const stubSelfCollisions = [...existingKeys.entries()].filter(([, ids]) => ids.length > 1);

  const report = {
    scholars: {
      total: plan.length,
      set_sunni: setSunni.length,
      leave_null: leaveNull.length,
      leave_null_rows: leaveNull,
      set_sunni_rows: setSunni,
    },
    bukhari_repoint: {
      canonical_book_id: 27,
      stub_count: stubBooks.length,
      variations_to_move: proposed.length,
      abort_recommended: abort || stubSelfCollisions.some(([, ids]) => ids.length > 1 && proposed.some((p) => p.collision)),
      collisions: proposed.filter((p) => p.collision),
      all_proposed: proposed,
    },
  };

  mkdirSync("data", { recursive: true });
  writeFileSync(path.join("data", "preapply-checks.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        scholars_set_sunni: setSunni.length,
        scholars_leave_null: leaveNull.length,
        leave_null: leaveNull.map((r) => ({ id: r.id, name: r.name, reason: r.reason })),
        bukhari_abort: report.bukhari_repoint.abort_recommended,
        bukhari_collisions: report.bukhari_repoint.collisions,
        bukhari_move_count: proposed.length,
      },
      null,
      2
    )
  );
  console.log("Wrote data/preapply-checks.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
