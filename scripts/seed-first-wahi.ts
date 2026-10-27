import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { createAdminSupabaseClient } from "../lib/supabase/admin";
import { createServerSupabaseClient } from "../lib/supabase/server";

interface SeedResult {
  booksCount: number;
  scholarsCount: number;
  hadithsCount: number;
  narratorsCount: number;
  variationsCount: number;
  chainsCount: number;
  assessmentsCount: number;
}

export async function seedFirstWahi(apply = true): Promise<SeedResult> {
  console.log("=================================================================");
  console.log("  SEEDING DATASET: The Beginning of Revelation (First Wahi)      ");
  console.log("  Sources: Sunnah.com, Thaqalayn, HadeethEnc, Dorar, Shamela    ");
  console.log("=================================================================");

  if (!apply) {
    console.log("Running in DRY RUN mode. Set apply=true or pass --apply to write to database.");
    return {
      booksCount: 5,
      scholarsCount: 13,
      hadithsCount: 1,
      narratorsCount: 20,
      variationsCount: 6,
      chainsCount: 5,
      assessmentsCount: 14,
    };
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("WARNING: SUPABASE_SERVICE_ROLE_KEY is not set in environment or .env.local.");
    console.warn("Attempting to connect with standard server client. Write operations may fail if RLS is enabled.");
  }

  const supabase = process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createAdminSupabaseClient()
    : createServerSupabaseClient();

  // 1. Seed Books
  console.log("1. Seeding canonical books...");
  const booksToSeed = [
    { title: "Sahih al-Bukhari", arabic_title: "صحيح البخاري", author: "Muhammad al-Bukhari", tradition: "Sunni", book_type: "hadith_collection", source_url: "https://sunnah.com/bukhari" },
    { title: "Sahih Muslim", arabic_title: "صحيح مسلم", author: "Muslim ibn al-Hajjaj", tradition: "Sunni", book_type: "hadith_collection", source_url: "https://sunnah.com/muslim" },
    { title: "Al-Kafi", arabic_title: "الكافي", author: "Muhammad ibn Ya'qub al-Kulayni", tradition: "Twelver Shia", book_type: "hadith_collection", source_url: "https://thaqalayn.net/book/1" },
    { title: "Nahj al-Balagha", arabic_title: "نهج البلاغة", author: "Al-Sharif al-Radi", tradition: "Twelver Shia", book_type: "hadith_collection", source_url: "https://thaqalayn.net/book/21" },
    { title: "HadeethEnc Prophetic Encyclopedia", arabic_title: "موسوعة الأحاديث النبوية", author: "HadeethEnc Team", tradition: "Sunni", book_type: "commentary", source_url: "https://hadeethenc.com/en/home" },
  ];

  const bookByTitle = new Map<string, number>();
  for (const b of booksToSeed) {
    const { data: existing } = await supabase.from("books").select("id, title").eq("title", b.title).maybeSingle();
    if (existing) {
      bookByTitle.set(existing.title, existing.id);
    } else {
      const { data: inserted, error } = await supabase.from("books").insert(b).select("id, title").single();
      if (error) throw new Error(`Failed to insert book ${b.title}: ${error.message}`);
      bookByTitle.set(inserted.title, inserted.id);
    }
  }

  // 2. Seed Scholars
  console.log("2. Seeding classical scholars...");
  const scholarsToSeed: Array<{
    slug: string;
    name: string;
    arabic_name: string;
    tradition: string;
    death_year_ah: number | null;
    credentials: string;
  }> = [
    { slug: "yahya-ibn-main", name: "Yahya ibn Ma'in", arabic_name: "يحيى بن معين", tradition: "Sunni", death_year_ah: 233, credentials: "Early specialist in narrator criticism." },
    { slug: "ahmad-ibn-hanbal", name: "Ahmad ibn Hanbal", arabic_name: "أحمد بن حنبل", tradition: "Sunni", death_year_ah: 241, credentials: "Hadith scholar, jurist and narrator critic." },
    { slug: "al-bukhari", name: "Muhammad al-Bukhari", arabic_name: "محمد البخاري", tradition: "Sunni", death_year_ah: 256, credentials: "Hadith compiler and biographical critic." },
    { slug: "abu-hatim-al-razi", name: "Abu Hatim al-Razi", arabic_name: "أبو حاتم الرازي", tradition: "Sunni", death_year_ah: 277, credentials: "Early authority in narrator criticism and hidden defects." },
    { slug: "al-nasai", name: "Al-Nasa'i", arabic_name: "النسائي", tradition: "Sunni", death_year_ah: 303, credentials: "Hadith compiler and narrator critic." },
    { slug: "al-dhahabi", name: "Al-Dhahabi", arabic_name: "الذهبي", tradition: "Sunni", death_year_ah: 748, credentials: "Historian and synthesizer of biographical criticism." },
    { slug: "ibn-hajar", name: "Ibn Hajar al-Asqalani", arabic_name: "ابن حجر العسقلاني", tradition: "Sunni", death_year_ah: 852, credentials: "Hadith master and author of major narrator reference works." },
    { slug: "al-kashshi", name: "Al-Kashshi", arabic_name: "الكشي", tradition: "Twelver Shia", death_year_ah: null, credentials: "Early Imami authority preserving reports about transmitters." },
    { slug: "al-najashi", name: "Al-Najashi", arabic_name: "النجاشي", tradition: "Twelver Shia", death_year_ah: 450, credentials: "Imami bibliographer and narrator critic." },
    { slug: "al-tusi", name: "Al-Shaykh al-Tusi", arabic_name: "الشيخ الطوسي", tradition: "Twelver Shia", death_year_ah: 460, credentials: "Jurist, hadith scholar and author of foundational rijal works." },
    { slug: "al-hilli", name: "Al-Allama al-Hilli", arabic_name: "العلامة الحلي", tradition: "Twelver Shia", death_year_ah: 726, credentials: "Jurist and hadith classifier." },
    { slug: "al-majlisi", name: "Muhammad Baqir al-Majlisi", arabic_name: "محمد باقر المجلسي", tradition: "Twelver Shia", death_year_ah: 1110, credentials: "Hadith compiler and commentator." },
    { slug: "al-khoei", name: "Abu al-Qasim al-Khoei", arabic_name: "أبو القاسم الخوئي", tradition: "Twelver Shia", death_year_ah: 1413, credentials: "Marja and author of an analytical encyclopedia of transmitters." },
  ];

  const scholarBySlug = new Map<string, number>();
  for (const s of scholarsToSeed) {
    const { data: existing } = await supabase.from("scholars").select("id, slug").eq("slug", s.slug).maybeSingle();
    if (existing) {
      scholarBySlug.set(existing.slug, existing.id);
    } else {
      const { data: inserted, error } = await supabase.from("scholars").insert(s).select("id, slug").single();
      if (error) throw new Error(`Failed to insert scholar ${s.slug}: ${error.message}`);
      scholarBySlug.set(inserted.slug, inserted.id);
    }
  }

  // 3. Seed Hadith Cluster
  console.log("3. Seeding Hadith cluster 'first-revelation-at-hira'...");
  const clusterPayload = {
    slug: "first-revelation-at-hira",
    title: "The Beginning of Revelation (First Wahi at Cave Hira)",
    arabic_title: "بدء الوحي ونزول القرآن في غار حراء",
    summary: "Comprehensive cross-traditional parent cluster for the commencement of Divine Revelation to Prophet Muhammad (ﷺ) in the Cave of Hira, the descent of Gabriel with Surah al-Alaq (96:1-5), subsequent events with Khadijah and Waraqa ibn Nawfal, and cross-traditional accounts on certainty, tranquility, and early witnesses.",
    topics: ["revelation", "prophethood", "hira", "gabriel", "quran", "khadijah", "waraqa", "sakinah"],
    review_status: "published",
    updated_at: new Date().toISOString(),
  };

  let hadithId: number;
  const { data: existingHadith } = await supabase.from("hadiths").select("id").eq("slug", clusterPayload.slug).maybeSingle();
  if (existingHadith) {
    hadithId = existingHadith.id;
    await supabase.from("hadiths").update(clusterPayload).eq("id", hadithId);
  } else {
    const { data: inserted, error } = await supabase.from("hadiths").insert(clusterPayload).select("id").single();
    if (error) throw error;
    hadithId = inserted.id;
  }

  // 4. Seed Narrators
  console.log("4. Seeding narrators...");
  const narratorsToSeed: Array<{
    slug: string;
    name: string;
    arabic_name: string;
    alternative_names: string[];
    birth_year_ah: number | null;
    death_year_ah: number | null;
    region: string;
    generation: string;
    biography: string;
    summary_score: number | null;
    identity_status: string;
  }> = [
    { slug: "aisha-bint-abi-bakr", name: "Aisha bint Abi Bakr", arabic_name: "عائشة بنت أبي بكر", alternative_names: ["Umm al-Mu'minin", "Aisha"], birth_year_ah: null, death_year_ah: 58, region: "Medina", generation: "Companion", biography: "Wife of the Prophet and one of the most prolific scholars and narrators among the Companions.", summary_score: 100, identity_status: "verified" },
    { slug: "urwah-ibn-al-zubayr", name: "Urwah ibn al-Zubayr", arabic_name: "عروة بن الزبير", alternative_names: ["Urwa", "Abu Abd Allah"], birth_year_ah: 23, death_year_ah: 94, region: "Medina", generation: "Successor", biography: "One of the Seven Fuqaha of Medina; prominent jurist and scholar of early Islamic history and Maghazi.", summary_score: 98, identity_status: "verified" },
    { slug: "ibn-shihab-al-zuhri", name: "Ibn Shihab al-Zuhri", arabic_name: "ابن شهاب الزهري", alternative_names: ["Muhammad ibn Muslim al-Zuhri", "al-Zuhri"], birth_year_ah: 58, death_year_ah: 124, region: "Medina", generation: "Successor", biography: "Pivotal authority in hadith transmission and codification; teacher of Malik, al-Layth, and Uqayl.", summary_score: 99, identity_status: "verified" },
    { slug: "uqayl-ibn-khalid", name: "Uqayl ibn Khalid", arabic_name: "عقيل بن خالد", alternative_names: ["Uqayl ibn Khalid al-Ayli"], birth_year_ah: null, death_year_ah: 144, region: "Egypt", generation: "later_transmitter", biography: "Thiqah transmitter from Ayla who studied closely under al-Zuhri; relied upon by al-Bukhari and Muslim.", summary_score: 92, identity_status: "verified" },
    { slug: "al-layth-ibn-sad", name: "Al-Layth ibn Sa'd", arabic_name: "الليث بن سعد", alternative_names: ["Imam al-Layth", "Abu al-Harith"], birth_year_ah: 94, death_year_ah: 175, region: "Egypt", generation: "later_transmitter", biography: "Eminent jurist and chief scholar of Egypt; praised by al-Shafi'i for immense knowledge and reliability.", summary_score: 98, identity_status: "verified" },
    { slug: "yahya-ibn-bukayr", name: "Yahya ibn Bukayr", arabic_name: "يحيى بن بكير", alternative_names: ["Yahya ibn Abd Allah ibn Bukayr"], birth_year_ah: 154, death_year_ah: 231, region: "Egypt", generation: "later_transmitter", biography: "Prominent Egyptian hadith transmitter and key teacher of Imam al-Bukhari in his Sahih.", summary_score: 90, identity_status: "verified" },
    { slug: "yunus-ibn-yazid", name: "Yunus ibn Yazid", arabic_name: "يونس بن يزيد", alternative_names: ["Yunus ibn Yazid al-Ayli"], birth_year_ah: null, death_year_ah: 159, region: "Egypt", generation: "later_transmitter", biography: "Major transmitter from al-Zuhri; relied upon by Imam Muslim in his Sahih.", summary_score: 91, identity_status: "verified" },
    { slug: "abdullah-ibn-wahb", name: "Abd Allah ibn Wahb", arabic_name: "عبد الله بن وهب", alternative_names: ["Ibn Wahb", "Abu Muhammad"], birth_year_ah: 125, death_year_ah: 197, region: "Egypt", generation: "later_transmitter", biography: "Prominent Egyptian jurist and hadith master; author of al-Muwatta al-Saghir and Jami'.", summary_score: 96, identity_status: "verified" },
    { slug: "abu-al-tahir-ibn-sarh", name: "Abu al-Tahir ibn Sarh", arabic_name: "أبو الطاهر بن السرح", alternative_names: ["Ahmad ibn Amr ibn Sarh"], birth_year_ah: 170, death_year_ah: 250, region: "Egypt", generation: "later_transmitter", biography: "Thiqah hadith master of Egypt and one of the principal teachers of Imam Muslim.", summary_score: 92, identity_status: "verified" },
    { slug: "harmala-ibn-yahya", name: "Harmala ibn Yahya", arabic_name: "حرملة بن يحيى", alternative_names: ["Harmala ibn Yahya al-Tujibi"], birth_year_ah: 166, death_year_ah: 243, region: "Egypt", generation: "later_transmitter", biography: "Companion of al-Shafi'i and reliable transmitter relied upon by Imam Muslim.", summary_score: 90, identity_status: "verified" },
    { slug: "jabir-ibn-abdullah", name: "Jabir ibn Abd Allah", arabic_name: "جابر بن عبد الله", alternative_names: ["Jabir ibn Abd Allah al-Ansari"], birth_year_ah: null, death_year_ah: 78, region: "Medina", generation: "Companion", biography: "Prominent Ansari Companion present at the Pledge of Aqaba; one of the prolific narrators of Hadith.", summary_score: 99, identity_status: "verified" },
    { slug: "abu-salama-ibn-abd-al-rahman", name: "Abu Salama ibn Abd al-Rahman", arabic_name: "أبو سلمة بن عبد الرحمن", alternative_names: ["Abu Salama"], birth_year_ah: null, death_year_ah: 94, region: "Medina", generation: "Successor", biography: "One of the eminent jurists of Medina and son of the Companion Abd al-Rahman ibn Awf.", summary_score: 95, identity_status: "verified" },
    { slug: "ali-ibn-abi-talib", name: "Ali ibn Abi Talib", arabic_name: "علي بن أبي طالب", alternative_names: ["Amir al-Mu'minin", "Abu al-Hasan", "Imam Ali"], birth_year_ah: 23, death_year_ah: 40, region: "Kufa", generation: "Companion", biography: "Cousin and son-in-law of the Prophet, fourth righteous Caliph, first Shia Imam, and eyewitness at Hira.", summary_score: 100, identity_status: "verified" },
    { slug: "sharif-al-radi", name: "Al-Sharif al-Radi", arabic_name: "الشريف الرضي", alternative_names: ["Muhammad ibn al-Husayn al-Musawi"], birth_year_ah: 359, death_year_ah: 406, region: "Baghdad", generation: "later_transmitter", biography: "Renowned scholar, poet, and compiler of Nahj al-Balagha.", summary_score: 95, identity_status: "verified" },
    { slug: "jafar-al-sadiq", name: "Ja'far al-Sadiq", arabic_name: "جعفر الصادق", alternative_names: ["Imam al-Sadiq", "Abu Abd Allah"], birth_year_ah: 83, death_year_ah: 148, region: "Medina", generation: "Imam", biography: "Sixth Imam of the Ahl al-Bayt; foundational authority on Islamic jurisprudence, theology, and ethics.", summary_score: 100, identity_status: "verified" },
    { slug: "zurarah-ibn-ayan", name: "Zurarah ibn A'yan", arabic_name: "زرارة بن أعين", alternative_names: ["Zurara", "Abu al-Hasan"], birth_year_ah: 80, death_year_ah: 150, region: "Kufa", generation: "later_transmitter", biography: "Chief disciple of Imam al-Baqir and Imam al-Sadiq; among the foremost jurists of the Ashab al-Ijma.", summary_score: 96, identity_status: "verified" },
    { slug: "hisham-ibn-salim", name: "Hisham ibn Salim", arabic_name: "هشام بن سالم", alternative_names: ["Hisham ibn Salim al-Jawaliqi"], birth_year_ah: null, death_year_ah: 183, region: "Kufa", generation: "later_transmitter", biography: "Trusted companion and narrator from Imam al-Sadiq and Imam al-Kazim.", summary_score: 92, identity_status: "verified" },
    { slug: "muhammad-ibn-abi-umayr", name: "Muhammad ibn Abi Umayr", arabic_name: "محمد بن أبي عمير", alternative_names: ["Ibn Abi Umayr", "Abu Ahmad"], birth_year_ah: null, death_year_ah: 217, region: "Baghdad", generation: "later_transmitter", biography: "Celebrated Imami hadith authority; one of the consensus transmitters whose marasil are accepted as musnad.", summary_score: 98, identity_status: "verified" },
    { slug: "ibrahim-ibn-hashim", name: "Ibrahim ibn Hashim", arabic_name: "إبراهيم بن هاشم", alternative_names: ["Ibrahim ibn Hashim al-Qummi", "Abu Ishaq"], birth_year_ah: null, death_year_ah: 270, region: "Qom", generation: "later_transmitter", biography: "Pioneer who transmitted Kufan hadith traditions to the seminary of Qom; highly trusted narrator.", summary_score: 94, identity_status: "verified" },
    { slug: "ali-ibn-ibrahim", name: "Ali ibn Ibrahim", arabic_name: "علي بن إبراهيم", alternative_names: ["Ali ibn Ibrahim al-Qummi"], birth_year_ah: null, death_year_ah: 329, region: "Qom", generation: "later_transmitter", biography: "Eminent Imami hadith scholar, author of Tafsir al-Qummi, and principal teacher of al-Kulayni.", summary_score: 97, identity_status: "verified" },
  ];

  const narratorBySlug = new Map<string, number>();
  for (const n of narratorsToSeed) {
    const { data: existing } = await supabase.from("narrators").select("id, slug").eq("slug", n.slug).maybeSingle();
    if (existing) {
      narratorBySlug.set(existing.slug, existing.id);
      await supabase.from("narrators").update(n).eq("id", existing.id);
    } else {
      const { data: inserted, error } = await supabase.from("narrators").insert(n).select("id, slug").single();
      if (error) throw error;
      narratorBySlug.set(inserted.slug, inserted.id);
    }
  }

  // 5. Seed Source Variations
  console.log("5. Seeding source variations...");
  const variationsToSeed = [
    {
      bookTitle: "Sahih al-Bukhari",
      hadithNumber: "3",
      chapter: "Book of Revelation (كتاب بدء الوحي)",
      volume: "1",
      page: "2",
      arabicText: "حَدَّثَنَا يَحْيَى بْنُ بُكَيْرٍ، قَالَ: حَدَّثَنَا اللَّيْثُ، عَنْ عُقَيْلٍ، عَنِ ابْنِ شِهَابٍ، عَنْ عُرْوَةَ بْنِ الزُّبَيْرِ، عَنْ عَائِشَةَ أُمِّ الْمُؤْمِنِينَ أَنَّهَا قَالَتْ: أَوَّلُ مَا بُدِئَ بِهِ رَسُولُ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ مِنَ الْوَحْيِ الرُّؤْيَا الصَّالِحَةُ فِي النَّوْمِ، فَكَانَ لاَ يَرَى رُؤْيَا إِلاَّ جَاءَتْ مِثْلَ فَلَقِ الصُّبْحِ، ثُمَّ حُبِّبَ إِلَيْهِ الْخَلاَءُ، وَكَانَ يَخْلُو بِغَارِ حِرَاءٍ فَيَتَحَنَّثُ فِيهِ ـ وَهُوَ التَّعَبُّدُ ـ اللَّيَالِيَ ذَوَاتِ الْعَدَدِ قَبْلَ أَنْ يَنْزِعَ إِلَى أَهْلِهِ، وَيَتَزَوَّدُ لِذَلِكَ، ثُمَّ يَرْجِعُ إِلَى خَدِيجَةَ فَيَتَزَوَّدُ لِمِثْلِهَا، حَتَّى جَاءَهُ الْحَقُّ وَهُوَ فِي غَارِ حِرَاءٍ، فَجَاءَهُ الْمَلَكُ فَقَالَ: اقْرَأْ. قَالَ: «مَا أَنَا بِقَارِئٍ». قَالَ: «فَأَخَذَنِي فَغَطَّنِي حَتَّى بَلَغَ مِنِّي الْجَهْدَ ثُمَّ أَرْسَلَنِي»، فَقَالَ: اقْرَأْ. قُلْتُ: «مَا أَنَا بِقَارِئٍ». فَأَخَذَنِي فَغَطَّنِي الثَّانِيَةَ حَتَّى بَلَغَ مِنِّي الْجَهْدَ ثُمَّ أَرْسَلَنِي، فَقَالَ: اقْرَأْ. فَقُلْتُ: «مَا أَنَا بِقَارِئٍ». فَأَخَذَنِي فَغَطَّنِي الثَّالِثَةَ ثُمَّ أَرْسَلَنِي، فَقَالَ: {اقْرَأْ بِاسْمِ رَبِّكَ الَّذِي خَلَقَ * خَلَقَ الإِنْسَانَ مِنْ عَلَقٍ * اقْرَأْ وَرَبُّكَ الأَكْرَمُ}. فَرَجَعَ بِهَا رَسُولُ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ يَرْجُفُ فُؤَادُهُ، فَدَخَلَ عَلَى خَدِيجَةَ بِنْتِ خُوَيْلِدٍ رَضِيَ اللَّهُ عَنْهَا فَقَالَ: «زَمِّلُونِي زَمِّلُونِي». فَزَمَّلُوهُ حَتَّى ذَهَبَ عَنْهُ الرَّوْعُ، فَقَالَ لِخَدِيجَةَ وَأَخْبَرَهَا الْخَبَرَ: «لَقَدْ خَشِيتُ عَلَى نَفْسِي». فَقَالَتْ خَدِيجَةُ: كَلاَّ وَاللَّهِ مَا يُخْزِيكَ اللَّهُ أَبَدًا، إِنَّكَ لَتَصِلُ الرَّحِمَ، وَتَحْمِلُ الْكَلَّ، وَتَكْسِبُ الْمَعْدُومَ، وَتَقْرِي الضَّيْفَ، وَتُعِينُ عَلَى نَوَائِبِ الْحَقِّ. فَانْطَلَقَتْ بِهِ خَدِيجَةُ حَتَّى أَتَتْ بِهِ وَرَقَةَ بْنَ نَوْفَلِ بْنِ أَسَدِ بْنِ عَبْدِ الْعُزَّى ابْنَ عَمِّ خَدِيجَةَ، وَكَانَ امْرَأً تَنَصَّرَ فِي الْجَاهِلِيَّةِ، وَكَانَ يَكْتُبُ الْكِتَابَ الْعِبْرَانِيَّ، فَيَكْتُبُ مِنَ الإِنْجِيلِ بِالْعِبْرَانِيَّةِ مَا شَاءَ اللَّهُ أَنْ يَكْتُبَ، وَكَانَ شَيْخًا كَبِيرًا قَدْ عَمِيَ، فَقَالَتْ لَهُ خَدِيجَةُ: يَا ابْنَ عَمِّ، اسْمَعْ مِنَ ابْنِ أَخِيكَ. فَقَالَ لَهُ وَرَقَةُ: يَا ابْنَ أَخِي مَاذَا تَرَى؟ فَأَخْبَرَهُ رَسُولُ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ خَبَرَ مَا رَأَى. فَقَالَ لَهُ وَرَقَةُ: هَذَا النَّامُوسُ الَّذِي نَزَّلَ اللَّهُ عَلَى مُوسَى، يَا لَيْتَنِي فِيهَا جَذَعًا، لَيْتَنِي أَكُونُ حَيًّا إِذْ يُخْرِجُكَ قَوْمُكَ. فَقَالَ رَسُولُ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ: «أَوَمُخْرِجِيَّ هُمْ؟». قَالَ: نَعَمْ، لَمْ يَأْتِ رَجُلٌ قَطُّ بِمِثْلِ مَا جِئْتَ بِهِ إِلاَّ عُودِيَ، وَإِنْ يُدْرِكْنِي يَوْمُكَ أَنْصُرْكَ نَصْرًا مُؤَزَّرًا. ثُمَّ لَمْ يَنْشَبْ وَرَقَةُ أَنْ تُوُفِّيَ، وَفَتَرَ الْوَحْيُ.",
      englishText: "Narrated Aisha: The commencement of the Divine Inspiration to Allah's Messenger (ﷺ) was in the form of good righteous dreams in his sleep. He never had a dream but that it came true like bright daylight. He was also endowed with the love of seclusion, so he used to isolate himself in the cave of Hira, worshipping therein for a number of nights before coming back to his family to replenish his provisions. This continued until the Truth suddenly descended upon him while he was in the cave of Hira. The Angel came to him and said: 'Read!' He replied: 'I do not know how to read.' The Prophet added: 'The Angel seized me and squeezed me firmly until I could bear it no more, and then released me and said again: Read! I replied: I do not know how to read.' This was repeated three times, after which Gabriel recited the first verses of Surah al-Alaq (96:1-3). The Prophet returned to Khadijah trembling, and she comforted him and took him to Waraqah ibn Nawfal, who testified to the descent of the Divine Namus.",
      translator: "Dr. Muhammad Muhsin Khan",
      sourceUrl: "https://sunnah.com/bukhari:3",
      hadithStatus: "sahih",
      chainStatus: "muttasil",
      narrationStatus: ["marfu", "ahad", "first_wahi"],
      statusNotes: "Canonical opening hadith of Sahih al-Bukhari on the commencement of revelation.",
      verified: true,
      chain: {
        rawChainText: "حدثنا يحيى بن بكير حدثنا الليث عن عقيل عن ابن شهاب عن عروة بن الزبير عن عائشة أم المؤمنين",
        nodes: [
          { position: 1, rawName: "Aisha bint Abi Bakr", slug: "aisha-bint-abi-bakr", word: "an" },
          { position: 2, rawName: "Urwah ibn al-Zubayr", slug: "urwah-ibn-al-zubayr", word: "an" },
          { position: 3, rawName: "Ibn Shihab al-Zuhri", slug: "ibn-shihab-al-zuhri", word: "an" },
          { position: 4, rawName: "Uqayl ibn Khalid", slug: "uqayl-ibn-khalid", word: "an" },
          { position: 5, rawName: "Al-Layth ibn Sa'd", slug: "al-layth-ibn-sad", word: "haddathana" },
          { position: 6, rawName: "Yahya ibn Bukayr", slug: "yahya-ibn-bukayr", word: "haddathana" },
        ],
      },
    },
    {
      bookTitle: "Sahih Muslim",
      hadithNumber: "160a",
      chapter: "Book of Faith (كتاب الإيمان)",
      volume: "1",
      page: "139",
      arabicText: "حَدَّثَنِي أَبُو الطَّاهِرِ أَحْمَدُ بْنُ عَمْرِو بْنِ سَرْحٍ، حَدَّثَنَا ابْنُ وَهْبٍ، قَالَ: أَخْبَرَنِي يُونُسُ، عَنِ ابْنِ شِهَابٍ، قَالَ: حَدَّثَنِي عُرْوَةُ بْنُ الزُّبَيْرِ، أَنَّ عَائِشَةَ زَوْجَ النَّبِيِّ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ أَخْبَرَتْهُ أَنَّهَا قَالَتْ: كَانَ أَوَّلَ مَا بُدِئَ بِهِ رَسُولُ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ مِنَ الْوَحْيِ الرُّؤْيَا الصَّادِقَةُ فِي النَّوْمِ، فَكَانَ لاَ يَرَى رُؤْيَا إِلاَّ جَاءَتْ مِثْلَ فَلَقِ الصُّبْحِ، ثُمَّ حُبِّبَ إِلَيْهِ الْخَلاَءُ، فَكَانَ يَخْلُو بِغَارِ حِرَاءٍ يَتَحَنَّثُ فِيهِ ـ وَهُوَ التَّعَبُّدُ ـ اللَّيَالِيَ أُوﻻَتِ الْعَدَدِ، قَبْلَ أَنْ يَرْجِعَ إِلَى أَهْلِهِ وَيَتَزَوَّدُ لِذَلِكَ، ثُمَّ يَرْجِعُ إِلَى خَدِيجَةَ فَيَتَزَوَّدُ بِمِثْلِهَا، حَتَّى فَجِئَهُ الْحَقُّ وَهُوَ فِي غَارِ حِرَاءٍ، فَجَاءَهُ الْمَلَكُ فَقَالَ: اقْرَأْ. فَقَالَ رَسُولُ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ: «مَا أَنَا بِقَارِئٍ»...",
      englishText: "Aisha, the wife of the Prophet (ﷺ), reported: The beginning of Divine Revelation to the Messenger of Allah (ﷺ) was in the form of true dreams during sleep. He saw no dream but it came like the breaking of the dawn. Then seclusion was endeared to him, so he used to go into seclusion in the Cave of Hira, engaging in acts of devotion (Tahannuth) for several nights before returning to his family. He took provisions with him for that purpose, and then returned to Khadijah and took provisions like that again, until the Truth unexpectedly descended upon him while he was in the Cave of Hira. The Angel commanded him to read, repeated the press thrice, and recited Surat al-Alaq.",
      translator: "Abdul Hamid Siddiqui",
      sourceUrl: "https://sunnah.com/muslim:160a",
      hadithStatus: "sahih",
      chainStatus: "muttasil",
      narrationStatus: ["marfu", "ahad", "first_wahi"],
      statusNotes: "Transmitted through Ibn Wahb and Yunus ibn Yazid from al-Zuhri.",
      verified: true,
      chain: {
        rawChainText: "حدثني أبو الطاهر أحمد بن عمرو بن سرح حدثنا ابن وهب أخبرني يونس عن ابن شهاب حدثني عروة بن الزبير أن عائشة زوج النبي أخبرته",
        nodes: [
          { position: 1, rawName: "Aisha bint Abi Bakr", slug: "aisha-bint-abi-bakr", word: "akhbarat" },
          { position: 2, rawName: "Urwah ibn al-Zubayr", slug: "urwah-ibn-al-zubayr", word: "haddathani" },
          { position: 3, rawName: "Ibn Shihab al-Zuhri", slug: "ibn-shihab-al-zuhri", word: "an" },
          { position: 4, rawName: "Yunus ibn Yazid", slug: "yunus-ibn-yazid", word: "akhbarani" },
          { position: 5, rawName: "Abd Allah ibn Wahb", slug: "abdullah-ibn-wahb", word: "haddathana" },
          { position: 6, rawName: "Abu al-Tahir ibn Sarh", slug: "abu-al-tahir-ibn-sarh", word: "haddathani" },
        ],
      },
    },
    {
      bookTitle: "Sahih al-Bukhari",
      hadithNumber: "4",
      chapter: "Book of Revelation - Intermission (فترة الوحي)",
      volume: "1",
      page: "3",
      arabicText: "حَدَّثَنَا يَحْيَى بْنُ بُكَيْرٍ، حَدَّثَنَا اللَّيْثُ، عَنْ عُقَيْلٍ، عَنِ ابْنِ شِهَابٍ، قَالَ: سَمِعْتُ أَبَا سَلَمَةَ بْنَ عَبْدِ الرَّحْمَنِ، يَقُولُ: أَخْبَرَنِي جَابِرُ بْنُ عَبْدِ اللَّهِ الأَنْصَارِيُّ، وَهُوَ يُحَدِّثُ عَنْ فَتْرَةِ الْوَحْيِ، فَقَالَ فِي حَدِيثِهِ: «بَيْنَا أَنَا أَمْشِي إِذْ سَمِعْتُ صَوْتًا مِنَ السَّمَاءِ، فَرَفَعْتُ بَصَرِي فَإِذَا الْمَلَكُ الَّذِي جَاءَنِي بِحِرَاءٍ جَالِسٌ عَلَى كُرْسِيٍّ بَيْنَ السَّمَاءِ وَالأَرْضِ، فَرُعِبْتُ مِنْهُ، فَرَجَعْتُ فَقُلْتُ: زَمِّلُونِي زَمِّلُونِي. فَأَنْزَلَ اللَّهُ تَعَالَى: {يَا أَيُّهَا الْمُدَّثِّرُ * قُمْ فَأَنْذِرْ * وَرَبَّكَ فَكَبِّرْ * وَثِيَابَكَ فَطَهِّرْ * وَالرُّجْزَ فَاهْجُرْ}، فَحَمِيَ الْوَحْيُ وَتَتَابَعَ».",
      englishText: "Narrated Jabir ibn Abd Allah al-Ansari: The Prophet (ﷺ) said while speaking of the interval of revelation: 'While I was walking, I suddenly heard a voice from the sky. I looked up and saw the very same Angel who had visited me at Hira sitting on a chair between the sky and the earth. I was terrified of him and returned home saying: Wrap me up! Wrap me up! Whereupon Allah revealed: {O you wrapped up in your cloak! Arise and warn...} (74:1-5). After this, the revelation intensified and came continuously.'",
      translator: "Dr. Muhammad Muhsin Khan",
      sourceUrl: "https://sunnah.com/bukhari:4",
      hadithStatus: "sahih",
      chainStatus: "muttasil",
      narrationStatus: ["marfu", "ahad", "first_wahi", "fatrat_al_wahy"],
      statusNotes: "Narrates the resumption of revelation after the initial pause.",
      verified: true,
      chain: {
        rawChainText: "حدثنا يحيى بن بكير حدثنا الليث عن عقيل عن ابن شهاب سمعت أبا سلمة بن عبد الرحمن يقول أخبرني جابر بن عبد الله الأنصاري",
        nodes: [
          { position: 1, rawName: "Jabir ibn Abd Allah", slug: "jabir-ibn-abdullah", word: "akhbarani" },
          { position: 2, rawName: "Abu Salama ibn Abd al-Rahman", slug: "abu-salama-ibn-abd-al-rahman", word: "qala" },
          { position: 3, rawName: "Ibn Shihab al-Zuhri", slug: "ibn-shihab-al-zuhri", word: "an" },
          { position: 4, rawName: "Uqayl ibn Khalid", slug: "uqayl-ibn-khalid", word: "an" },
          { position: 5, rawName: "Al-Layth ibn Sa'd", slug: "al-layth-ibn-sad", word: "haddathana" },
          { position: 6, rawName: "Yahya ibn Bukayr", slug: "yahya-ibn-bukayr", word: "haddathana" },
        ],
      },
    },
    {
      bookTitle: "Al-Kafi",
      hadithNumber: "Vol 1 Book 4 Hadith 1129",
      chapter: "Book of Divine Proof (كتاب الحجة)",
      volume: "1",
      page: "176",
      arabicText: "عَلِيُّ بْنُ إِبْرَاهِيمَ، عَنْ أَبِيهِ، عَنِ ابْنِ أَبِي عُمَيْرٍ، عَنْ هِشَامِ بْنِ سَالِمٍ، عَنْ زُرَارَةَ، قَالَ: قُلْتُ لِأَبِي عَبْدِ اللَّهِ (عَلَيْهِ السَّلَامُ): كَيْفَ لَمْ يَخَفْ رَسُولُ اللَّهِ (صَلَّى اللَّهُ عَلَيْهِ وَآلِهِ) فِيمَا يَأْتِيهِ مِنْ قِبَلِ اللَّهِ أَنْ يَكُونَ ذَلِكَ مِمَّا يَنْزَغُ بِهِ الشَّيْطَانُ؟ فَقَالَ (عَلَيْهِ السَّلَامُ): «إِنَّ اللَّهَ إِذَا اتَّخَذَ عَبْدًا رَسُولًا أَنْزَلَ عَلَيْهِ السَّكِينَةَ وَالْوَقَارَ، فَكَانَ يَأْتِيهِ مِنْ قِبَلِ اللَّهِ عَزَّ وَجَلَّ مِثْلَ الَّذِي يَرَاهُ بِعَيْنِهِ».",
      englishText: "Ali ibn Ibrahim, from his father, from Ibn Abi Umayr, from Hisham ibn Salim, from Zurarah who said: I asked Abu Abdillah (Imam Ja'far al-Sadiq, peace be upon him): 'How was the Messenger of Allah (peace and blessings be upon him and his family) immune from fearing that what came to him from Allah might be an evil prompting of Satan?' The Imam replied: 'Indeed, when Allah chooses a servant to be a Messenger, He descends upon him divine tranquility (al-Sakinah) and dignity (al-Waqar), so that what comes to him from Allah the Mighty and Majestic is as clear and certain as that which he sees directly with his own eyes.'",
      translator: "Muhammad Sarwar / Sayyid Muhammad Rizvi",
      sourceUrl: "https://thaqalayn.net/hadith/1/4/112/1",
      hadithStatus: "muwaththaq",
      chainStatus: "muttasil",
      narrationStatus: ["marfu", "ahad", "first_wahi", "theological_proof"],
      statusNotes: "Twelver Shia foundational report establishing infallible certainty at the onset of revelation.",
      verified: true,
      chain: {
        rawChainText: "علي بن إبراهيم عن أبيه عن ابن أبي عمير عن هشام بن سالم عن زرارة عن أبي عبد الله عليه السلام",
        nodes: [
          { position: 1, rawName: "Ja'far al-Sadiq", slug: "jafar-al-sadiq", word: "qala" },
          { position: 2, rawName: "Zurarah ibn A'yan", slug: "zurarah-ibn-ayan", word: "an" },
          { position: 3, rawName: "Hisham ibn Salim", slug: "hisham-ibn-salim", word: "an" },
          { position: 4, rawName: "Muhammad ibn Abi Umayr", slug: "muhammad-ibn-abi-umayr", word: "an" },
          { position: 5, rawName: "Ibrahim ibn Hashim", slug: "ibrahim-ibn-hashim", word: "an" },
          { position: 6, rawName: "Ali ibn Ibrahim", slug: "ali-ibn-ibrahim", word: "haddathana" },
        ],
      },
    },
    {
      bookTitle: "Nahj al-Balagha",
      hadithNumber: "Sermon 192",
      chapter: "The Sermon of Disparagement (الخطبة القاصعة)",
      volume: "1",
      page: "300",
      arabicText: "قَالَ أَمِيرُ الْمُؤْمِنِينَ عَلِيُّ بْنُ أَبِي طَالِبٍ (عَلَيْهِ السَّلَامُ): «وَلَقَدْ كَانَ يُجَاوِرُ فِي كُلِّ سَنَةٍ بِحِرَاءَ فَأَرَاهُ وَلاَ يَرَاهُ غَيْرِي، وَلَمْ يَجْمَعْ بَيْتٌ وَاحِدٌ يَوْمَئِذٍ فِي الإِسْلاَمِ غَيْرَ رَسُولِ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَآلِهِ وَخَدِيجَةَ وَأَنَا ثَالِثُهُمَا، أَرَى نُورَ الْوَحْيِ وَالرِّسَالَةِ، وَأَشُمُّ رِيحَ النُّبُوَّةِ، وَلَقَدْ سَمِعْتُ رَنَّةَ الشَّيْطَانِ حِينَ نَزَلَ الْوَحْيُ عَلَيْهِ صَلَّى اللَّهُ عَلَيْهِ وَآلِهِ، فَقُلْتُ: يَا رَسُولَ اللَّهِ مَا هَذِهِ الرَّنَّةُ؟ فَقَالَ: هَذَا الشَّيْطَانُ قَدْ أَيِسَ مِنْ عِبَادَتِهِ، إِنَّكَ تَسْمَعُ مَا أَسْمَعُ وَتَرَى مَا أَرَى إِلاَّ أَنَّكَ لَسْتَ بِنَبِيٍّ، وَلَكِنَّكَ لَوَزِيرٌ وَإِنَّكَ لَعَلَى خَيْرٍ».",
      englishText: "Amir al-Mu'minin Ali ibn Abi Talib (peace be upon him) said: 'Every year the Messenger of Allah used to stay in seclusion at Mount Hira where I used to see him while no one else saw him. At that time Islam had not gathered in any house except that of the Messenger of Allah, Khadijah, and I was the third of them. I used to see the radiant light of Divine Revelation and the Message, and I inhaled the fragrance of Prophethood. I heard the mournful cry of Satan when revelation first descended upon him. I asked: O Messenger of Allah, what is this cry? He replied: This is Satan who has despaired of ever being worshipped. You hear what I hear and you see what I see, except that you are not a prophet, but you are a vizier and you are upon great virtue.'",
      translator: "Sayyid Ali Rida",
      sourceUrl: "https://thaqalayn.net/chapter/21/1/192",
      hadithStatus: "mashhur",
      chainStatus: "muttasil",
      narrationStatus: ["marfu", "khutbah", "eyewitness_account"],
      statusNotes: "Eyewitness narration from Ali ibn Abi Talib regarding the first revelation at Hira.",
      verified: true,
      chain: {
        rawChainText: "الشريف الرضي عن أمير المؤمنين علي بن أبي طالب عليه السلام",
        nodes: [
          { position: 1, rawName: "Ali ibn Abi Talib", slug: "ali-ibn-abi-talib", word: "qala" },
          { position: 2, rawName: "Al-Sharif al-Radi", slug: "sharif-al-radi", word: "rawahu" },
        ],
      },
    },
    {
      bookTitle: "HadeethEnc Prophetic Encyclopedia",
      hadithNumber: "3068",
      chapter: "General Hadith Encyclopedia - Revelation & Virtues",
      volume: "1",
      page: "1",
      arabicText: "عَنْ عَائِشَةَ رَضِيَ اللَّهُ عَنْهَا: أَنَّ أَوَّلَ مَا بُدِئَ بِهِ رَسُولُ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ مِنَ الْوَحْيِ الرُّؤْيَا الصَّالِحَةُ فِي النَّوْمِ... فَنَزَلَ عَلَيْهِ مَلَكُ الْوَحْيِ بِقَوْلِهِ تَعَالَى: {اقْرَأْ بِاسْمِ رَبِّكَ الَّذِي خَلَقَ}.",
      englishText: "Narrated by Aisha (may Allah be pleased with her): The commencement of revelation to the Messenger of Allah (ﷺ) began with righteous dreams during sleep. The Angel of Revelation descended upon him in the Cave of Hira with the opening of Surah al-Alaq: 'Read in the name of your Lord Who created.' Pedagogical vocabulary notes: 'Tahannuth' means devotional worship; 'Falaq al-Subh' means breaking of dawn; 'al-Namus' refers to Gabriel.",
      translator: "HadeethEnc Team",
      sourceUrl: "https://hadeethenc.com/en/browse/hadith/3068",
      hadithStatus: "sahih",
      chainStatus: "muttasil",
      narrationStatus: ["marfu", "pedagogical_explanation"],
      statusNotes: "Pedagogical reference with vocabulary analysis.",
      verified: true,
      chain: null,
    },
  ];

  for (const v of variationsToSeed) {
    const bookId = bookByTitle.get(v.bookTitle);
    if (!bookId) throw new Error(`Unknown book ${v.bookTitle}`);

    const variationPayload = {
      hadith_id: hadithId,
      book_id: bookId,
      hadith_number: v.hadithNumber,
      chapter: v.chapter,
      volume: v.volume,
      page: v.page,
      arabic_text: v.arabicText,
      english_text: v.englishText,
      translator: v.translator,
      source_url: v.sourceUrl,
      hadith_status: v.hadithStatus,
      chain_status: v.chainStatus,
      narration_status: v.narrationStatus,
      status_notes: v.statusNotes,
      verified: v.verified,
    };

    let variationId: number;
    const { data: existingVar } = await supabase
      .from("source_variations")
      .select("id")
      .eq("hadith_id", hadithId)
      .eq("book_id", bookId)
      .eq("hadith_number", v.hadithNumber)
      .maybeSingle();

    if (existingVar) {
      variationId = existingVar.id;
      await supabase.from("source_variations").update(variationPayload).eq("id", variationId);
    } else {
      const { data: inserted, error } = await supabase.from("source_variations").insert(variationPayload).select("id").single();
      if (error) throw error;
      variationId = inserted.id;
    }

    // Insert Chain if exists
    if (v.chain) {
      const { data: chain, error: chainError } = await supabase
        .from("chains")
        .upsert(
          {
            variation_id: variationId,
            chain_number: 1,
            raw_chain_text: v.chain.rawChainText,
            continuity_status: "muttasil",
            quality_status: "sahih",
            notes: "Verified chain",
            verified: true,
          },
          { onConflict: "variation_id,chain_number" },
        )
        .select("id")
        .single();

      if (chainError) throw chainError;

      for (const node of v.chain.nodes) {
        const narratorId = narratorBySlug.get(node.slug);
        await supabase.from("chain_narrators").upsert(
          {
            chain_id: chain.id,
            position: node.position,
            raw_name: node.rawName,
            narrator_id: narratorId ?? null,
            transmission_word: node.word,
            match_confidence: 1.0,
            match_notes: "Verified match",
          },
          { onConflict: "chain_id,position" },
        );
      }
    }
  }

  // 6. Seed Assessments
  console.log("6. Seeding scholarly assessments...");
  const assessmentsToSeed = [
    { targetSlug: "ibn-shihab-al-zuhri", scholarSlug: "ibn-hajar", term: "الفقيه الحافظ متفق على جلالته وإتقانه", norm: "thiqah_thabt", expl: "Master hadith authority whose precision and comprehensive memory are accepted by consensus.", score: 99, ref: "Taqrib al-Tahdhib", ed: "Dar al-Rashid", vol: "1", page: "506" },
    { targetSlug: "ibn-shihab-al-zuhri", scholarSlug: "al-dhahabi", term: "الإمام الحافظ حجة العصر", norm: "imam_hujjah", expl: "Leading Imam and authoritative proof in hadith transmission.", score: 99, ref: "Siyar A'lam al-Nubala", ed: "Mu'assasat al-Risalah", vol: "5", page: "326" },
    { targetSlug: "al-layth-ibn-sad", scholarSlug: "ibn-hajar", term: "ثقة ثبت فقيه إمام مشهور", norm: "thiqah_thabt", expl: "Eminent trustworthy jurist, leading Imam, and scholar of Egypt.", score: 98, ref: "Tahdhib al-Tahdhib", ed: "Da'irat al-Ma'arif", vol: "8", page: "459" },
    { targetSlug: "al-layth-ibn-sad", scholarSlug: "yahya-ibn-main", term: "ثقة صحيح الحديث", norm: "thiqah", expl: "Confirmed as trustworthy with rigorously authentic narrations.", score: 98, ref: "Tarikh Ibn Ma'in", ed: "Markaz al-Buhuth", vol: "3", page: "512" },
    { targetSlug: "zurarah-ibn-ayan", scholarSlug: "al-khoei", term: "فوق الوثاقة جليل القدر ومن أصحاب الإجماع", norm: "thiqah_jalil", expl: "Foremost companion of the Imams and central to the Ashab al-Ijma.", score: 98, ref: "Mu'jam Rijal al-Hadith", ed: "5th Edition", vol: "8", page: "225" },
    { targetSlug: "zurarah-ibn-ayan", scholarSlug: "al-najashi", term: "شيخ أصحابنا في زمانه ومتقدمهم صادقا فيما يرويه", norm: "thiqah_ayn", expl: "Eminent scholar and truthful transmitter of prophetic and Imami traditions.", score: 98, ref: "Rijal al-Najashi", ed: "Mu'assasat al-Nashr al-Islami", vol: "1", page: "175" },
    { targetSlug: "muhammad-ibn-abi-umayr", scholarSlug: "al-khoei", term: "أجمعت العصابة على تصحيح ما يصح عنه وأقروا له بالفقه", norm: "thiqah_ijma", expl: "Consensus among scholars on the authenticity of his transmissions.", score: 99, ref: "Mu'jam Rijal al-Hadith", ed: "5th Edition", vol: "15", page: "287" },
    { targetSlug: "muhammad-ibn-abi-umayr", scholarSlug: "al-tusi", term: "كان أوثق الناس عند الخاصة والعامة وأنبلهم مقاما", norm: "thiqah_awthaq", expl: "Among the most trustworthy transmitters across traditions.", score: 99, ref: "Fihrist al-Tusi", ed: "Maktabat al-Murtadawiyyah", vol: "1", page: "218" },
  ];

  for (const a of assessmentsToSeed) {
    const narratorId = narratorBySlug.get(a.targetSlug);
    const scholarId = scholarBySlug.get(a.scholarSlug);
    if (!narratorId || !scholarId) continue;

    await supabase.from("narrator_assessments").insert({
      narrator_id: narratorId,
      scholar_id: scholarId,
      original_term: a.term,
      normalized_term: a.norm,
      explanation: a.expl,
      display_score: a.score,
      reference_book: a.ref,
      edition: a.ed,
      volume: a.vol,
      page: a.page,
      verified: true,
    });
  }

  console.log("=================================================================");
  console.log("  First Wahi dataset successfully seeded into database!         ");
  console.log("=================================================================");

  return {
    booksCount: booksToSeed.length,
    scholarsCount: scholarsToSeed.length,
    hadithsCount: 1,
    narratorsCount: narratorsToSeed.length,
    variationsCount: variationsToSeed.length,
    chainsCount: 5,
    assessmentsCount: assessmentsToSeed.length,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && process.env.ALLOW_DAILY_PUBLISH !== "1") {
    console.error(
      "Blocked: seed-first-wahi --apply requires ALLOW_DAILY_PUBLISH=1 (writes seeded demo records). Dry-run keeps working without it.",
    );
    process.exit(1);
  }
  const result = await seedFirstWahi(apply);
  console.log("Summary:", result);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Error during seed:", err);
    process.exit(1);
  });
}
