import type { SupabaseClient } from "@supabase/supabase-js";
import type { HadithCandidate } from "./topics-registry";

export interface PersistClusterOptions {
  clusterSlug: string;
  clusterTitle: string;
  clusterArabicTitle?: string;
  clusterSummary?: string;
  clusterKeywords?: string[];
}

function logSupabaseError(context: string, err: unknown) {
  if (err && typeof err === "object") {
    const pgErr = err as { message?: string; details?: string; hint?: string; code?: string };
    console.error(`[Supabase Error] ${context}:`, {
      message: pgErr.message,
      details: pgErr.details,
      hint: pgErr.hint,
      code: pgErr.code,
    });
  } else {
    console.error(`[Supabase Error] ${context}:`, err);
  }
}

/**
 * Shared database persistence helper that upserts a single HadithCandidate and its
 * linked records (hadiths, books, source_variations, chains, chain_narrators, hadith_assessments)
 * into Supabase. Used by both daily batch ingestion and full bulk ingestion scripts.
 */
export async function persistCandidate(
  candidate: HadithCandidate,
  clusterOptions: PersistClusterOptions,
  supabase: SupabaseClient
): Promise<{ variationId: number; hadithId: number } | null> {
  try {
    // 1. Ensure parent cluster in hadiths table
    const clusterSlug = clusterOptions.clusterSlug;
    let clusterHadithId: number;

    const { data: existingCluster } = await supabase
      .from("hadiths")
      .select("id")
      .eq("slug", clusterSlug)
      .maybeSingle();

    if (existingCluster) {
      clusterHadithId = existingCluster.id;
      const { error: updateErr } = await supabase
        .from("hadiths")
        .update({ review_status: "published" })
        .eq("id", clusterHadithId);

      if (updateErr) {
        logSupabaseError(`updating hadith cluster '${clusterSlug}'`, updateErr);
      }
    } else {
      const { data: insertedCluster, error: clusterErr } = await supabase
        .from("hadiths")
        .insert({
          slug: clusterSlug,
          title: clusterOptions.clusterTitle,
          arabic_title: clusterOptions.clusterArabicTitle ?? null,
          summary: clusterOptions.clusterSummary ?? null,
          topics: clusterOptions.clusterKeywords ?? [],
          review_status: "published",
        })
        .select("id")
        .single();

      if (clusterErr) {
        logSupabaseError(`inserting hadith cluster '${clusterSlug}'`, clusterErr);
        throw clusterErr;
      }
      clusterHadithId = insertedCluster.id;
    }

    // 2. Ensure book in books table
    let bookId: number;
    const { data: existingBook } = await supabase
      .from("books")
      .select("id")
      .eq("title", candidate.bookTitle)
      .maybeSingle();

    if (existingBook) {
      bookId = existingBook.id;
    } else {
      const { data: newBook, error: bErr } = await supabase
        .from("books")
        .insert({
          title: candidate.bookTitle,
          arabic_title: candidate.bookTitle,
          author: "Canonical Compiler",
          tradition: candidate.bookTitle.includes("Kafi") || candidate.bookTitle.includes("Nahj") ? "Twelver Shia" : "Sunni",
          book_type: candidate.bookTitle.includes("Encyclopedia") ? "commentary" : "hadith_collection",
        })
        .select("id")
        .single();

      if (bErr) {
        logSupabaseError(`inserting book '${candidate.bookTitle}'`, bErr);
        throw bErr;
      }
      bookId = newBook.id;
    }

    // 3. Upsert source variation
    const { data: variation, error: vErr } = await supabase
      .from("source_variations")
      .upsert(
        {
          hadith_id: clusterHadithId,
          book_id: bookId,
          hadith_number: candidate.hadithNumber,
          chapter: candidate.chapter,
          volume: candidate.volume ?? "1",
          page: candidate.page ?? "1",
          arabic_text: candidate.arabicText,
          english_text: candidate.englishText,
          translator: candidate.translator ?? "Authentic translation",
          source_url: candidate.sourceUrl ?? null,
          hadith_status: candidate.hadithStatus,
          chain_status: candidate.chainStatus,
          narration_status: candidate.narrationStatus,
          status_notes: candidate.statusNotes ?? null,
          verified: true,
        },
        { onConflict: "hadith_id,book_id,hadith_number" }
      )
      .select("id")
      .single();

    if (vErr) {
      logSupabaseError(`upserting variation for candidate '${candidate.identifier}'`, vErr);
      return null;
    }

    // 4. Upsert chains & chain_narrators
    if (candidate.nodes && candidate.nodes.length > 0) {
      const { data: chain, error: cErr } = await supabase
        .from("chains")
        .upsert(
          {
            variation_id: variation.id,
            chain_number: 1,
            raw_chain_text: candidate.rawChainText ?? "Sanad",
            continuity_status: candidate.chainStatus,
            quality_status: candidate.hadithStatus,
            verified: true,
          },
          { onConflict: "variation_id,chain_number" }
        )
        .select("id")
        .single();

      if (cErr) {
        logSupabaseError(`upserting chain for variation ${variation.id}`, cErr);
      } else if (chain) {
        for (const node of candidate.nodes) {
          let narratorId: number | null = null;
          if (node.slug) {
            const { data: nRec } = await supabase
              .from("narrators")
              .select("id")
              .eq("slug", node.slug)
              .maybeSingle();
            if (nRec) narratorId = nRec.id;
          }

          const { error: cnErr } = await supabase.from("chain_narrators").upsert(
            {
              chain_id: chain.id,
              position: node.position,
              narrator_id: narratorId,
              raw_name: node.rawName,
              transmission_word: node.word ?? "an",
              match_confidence: narratorId ? 1 : 0.8,
            },
            { onConflict: "chain_id,position" }
          );

          if (cnErr) {
            logSupabaseError(`upserting chain_narrator position ${node.position} for chain ${chain.id}`, cnErr);
          }
        }
      }
    }

    // 5. Upsert assessments
    if (candidate.assessments && candidate.assessments.length > 0) {
      for (const ass of candidate.assessments) {
        const { data: sch } = await supabase
          .from("scholars")
          .select("id")
          .eq("slug", ass.scholarSlug)
          .maybeSingle();

        if (sch) {
          const { error: aErr } = await supabase.from("hadith_assessments").upsert(
            {
              variation_id: variation.id,
              scholar_id: sch.id,
              original_grade: ass.originalGrade,
              normalized_grade: ass.normalizedGrade,
              explanation: ass.explanation,
              reference_book: ass.referenceBook,
              volume: ass.volume ?? null,
              page: ass.page ?? null,
              verified: true,
            },
            { onConflict: "variation_id,scholar_id" }
          );

          if (aErr) {
            logSupabaseError(`upserting assessment by scholar ${ass.scholarSlug} for variation ${variation.id}`, aErr);
          }
        }
      }
    }

    return {
      variationId: variation.id,
      hadithId: clusterHadithId,
    };
  } catch (err) {
    logSupabaseError(`persisting candidate '${candidate.identifier}'`, err);
    return null;
  }
}
