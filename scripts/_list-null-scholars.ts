import { loadLocalEnv } from "./load-env";
loadLocalEnv();
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/rest\/v1\/?$/i, "");
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const page = 1000;
  const all: { id: number; slug: string; name: string; arabic_name: string | null }[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb
      .from("scholars")
      .select("id,slug,name,arabic_name")
      .is("tradition", null)
      .order("id")
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < page) break;
  }
  console.log(JSON.stringify(all, null, 2));
  console.log("total", all.length);
}
main();
