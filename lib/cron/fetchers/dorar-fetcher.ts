import { RawFetchedCandidate, SourceFetcher, TopicDefinition } from "./types";

/**
 * DorarFetcher implements Hadith search via dorar.net as reverse-engineered
 * from the public proxy implementation in AhmedElTabarani/dorar-hadith-api.
 *
 * Endpoint Pattern: https://dorar.net/dorar_api.json?skey=<arabic_search_term>
 * Alternate Pattern : https://dorar.net/site/hadith/search?skey=<arabic_search_term>
 */
export class DorarFetcher implements SourceFetcher {
  name = "Dorar.net Fetcher";
  sourceType = "dorar" as const;

  async fetchCandidates(
    topic?: TopicDefinition,
    options?: { maxResults?: number; expandSearch?: boolean }
  ): Promise<RawFetchedCandidate[]> {
    const searchTerms = topic?.searchQueries?.arabic ?? [];
    if (searchTerms.length === 0) {
      searchTerms.push("بدء الوحي");
    }

    console.log(
      `[DorarFetcher] Fetching candidates for topic: ${topic?.slug ?? "general"} with ${searchTerms.length} queries`
    );

    const candidates: RawFetchedCandidate[] = [];
    const maxResults = options?.maxResults ?? 20;

    for (const term of searchTerms) {
      const apiUrl = `https://dorar.net/dorar_api.json?skey=${encodeURIComponent(term)}`;

      try {
        const response = await fetch(apiUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
            Referer: "https://dorar.net/",
          },
          signal: AbortSignal.timeout(8000),
        });

        if (response.status === 403) {
          throw new Error(
            `[DorarFetcher] Direct request to dorar.net pattern (${apiUrl}) blocked by Cloudflare bot protection (HTTP 403 Forbidden).`
          );
        }

        if (!response.ok) {
          throw new Error(
            `[DorarFetcher] HTTP error ${response.status} ${response.statusText} fetching ${apiUrl}`
          );
        }

        const bodyText = await response.text();
        let jsonData: { ahadith?: { result?: string } };

        try {
          jsonData = JSON.parse(bodyText);
        } catch {
          throw new Error(
            `[DorarFetcher] Failed to parse JSON response from ${apiUrl}: Response was not valid JSON.`
          );
        }

        if (!jsonData.ahadith?.result) {
          throw new Error(
            `[DorarFetcher] Invalid response structure from ${apiUrl}: Missing ahadith.result field.`
          );
        }

        const htmlResult = jsonData.ahadith.result;
        const parsedCandidates = this.parseDorarHtmlResult(htmlResult, term);

        for (const candidate of parsedCandidates) {
          candidates.push(candidate);
          if (candidates.length >= maxResults) {
            return candidates;
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Throw clear error explaining what was tried as required by specification
        throw new Error(
          `[DorarFetcher] Request pattern '${apiUrl}' failed: ${errorMessage}`
        );
      }
    }

    return candidates;
  }

  /**
   * Helper parser for Dorar HTML result payloads.
   */
  private parseDorarHtmlResult(
    html: string,
    queryTerm: string
  ): RawFetchedCandidate[] {
    const results: RawFetchedCandidate[] = [];
    // Clean basic HTML entity encoding
    const decoded = html
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Extract blocks matching dorar result cards (.hadith-info / .hadith)
    const cardRegex = /<div[^>]*class=["']hadith-info["'][^>]*>([\s+S]*?)<\/div>/gi;
    let match: RegExpExecArray | null;
    let index = 1;

    while ((match = cardRegex.exec(decoded)) !== null) {
      const block = match[1];

      // Extract Hadith text
      const textMatch = block.match(/<div[^>]*class=["']hadith["'][^>]*>([\s\S]*?)<\/div>/i);
      const rawText = textMatch ? textMatch[1].replace(/<[^>]+>/g, "").trim() : "";

      // Extract metadata fields
      const bookMatch = block.match(/المصدر:\s*<\/strong>\s*([^<]+)/i);
      const numberMatch = block.match(/الصفحة أو الرقم:\s*<\/strong>\s*([^<]+)/i);
      const gradeMatch = block.match(/درجة الحديث:\s*<\/strong>\s*([^<]+)/i) ||
                         block.match(/خلاصة حكم المحدث:\s*<\/strong>\s*([^<]+)/i);

      const bookTitle = bookMatch ? bookMatch[1].trim() : "Dorar al-Saniyyah";
      const hadithNumber = numberMatch ? numberMatch[1].trim() : String(index);
      const hadithStatus = gradeMatch ? gradeMatch[1].trim().toLowerCase() : "sahih";

      if (rawText) {
        results.push({
          source: "dorar",
          sourceIdentifier: `dorar:${index}_${encodeURIComponent(queryTerm)}`,
          bookTitle,
          hadithNumber,
          chapter: "General Collection",
          volume: "1",
          page: hadithNumber,
          arabicText: rawText,
          englishText: "", // Dorar has no English text; preserved as empty string
          translator: undefined,
          sourceUrl: `https://dorar.net/site/hadith/search?skey=${encodeURIComponent(queryTerm)}`,
          tradition: "Sunni",
          hadithStatus,
          chainStatus: "muttasil",
          narrationStatus: ["marfu"],
          rawPayload: { queryTerm, rawBlock: block },
        });
        index++;
      }
    }

    return results;
  }
}
