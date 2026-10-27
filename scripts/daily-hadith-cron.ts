import { loadLocalEnv } from "./load-env";
loadLocalEnv();

import { publishDailyHadithBatch, setActiveTopic, getDailyStatus } from "../lib/cron/daily-ingest";

async function main() {
  const args = process.argv.slice(2);

  const apply = args.includes("--apply");
  const showStatus = args.includes("--status");
  const topicIndex = args.indexOf("--topic");
  const setTopicIndex = args.indexOf("--set-topic");
  const batchSizeIndex = args.indexOf("--batch-size");

  const topicSlug = topicIndex !== -1 ? args[topicIndex + 1] : undefined;
  const setTopicSlug = setTopicIndex !== -1 ? args[setTopicIndex + 1] : undefined;
  const batchSize = batchSizeIndex !== -1 ? Number(args[batchSizeIndex + 1]) || 5 : 5;

  console.log("\n=================================================================");
  console.log("  ON-DEMAND DAILY HADITH BATCH PUBLISHER & PREVIEWER             ");
  console.log("=================================================================\n");

  if (setTopicSlug) {
    console.log(`Setting active daily topic to: ${setTopicSlug}...`);
    const res = await setActiveTopic(setTopicSlug);
    console.log(res.message);
    return;
  }

  if (showStatus) {
    console.log("Fetching currently-live batch status...\n");
    const status = await getDailyStatus(topicSlug);
    console.log(`Active Topic: ${status.activeTopic.title} (${status.activeTopic.slug})`);
    console.log(`Current Live Day: Day ${status.activeTopic.dayNumber}`);
    console.log(`Published At: ${status.activeTopic.publishedAt || "None (no batch currently live)"}`);
    console.log(`Live Items Count: ${status.liveBatchCount}`);
    return;
  }

  if (!apply) {
    console.log("Mode: DRY-RUN PREVIEW (No changes made to database)");
    console.log("Showing currently-live status + preview of next batch:\n");

    const status = await getDailyStatus(topicSlug);
    console.log(`Currently Live Batch: Day ${status.activeTopic.dayNumber} (${status.activeTopic.publishedAt || "No batch live yet"}) - ${status.liveBatchCount} items live`);
    console.log(`Upcoming Next Batch (Day ${status.activeTopic.dayNumber + 1}):`);
    status.upcomingShortlist.forEach((h, idx) => {
      console.log(`  [#${idx + 1}] ${h.bookTitle} — Hadith ${h.hadithNumber}`);
      console.log(`      Chapter: ${h.chapter}`);
      console.log(`      Identifier: ${h.identifier} | Grade: ${h.hadithStatus}`);
      console.log(`      EN: ${h.englishPreview.slice(0, 100)}...`);
    });
    console.log("\nTo unpublish the current batch and publish the next batch live, run:");
    console.log("  ALLOW_DAILY_PUBLISH=1 npm run cron:publish-daily\n");
    return;
  }

  if (process.env.ALLOW_DAILY_PUBLISH !== "1") {
    console.error(
      "Blocked: daily publish requires ALLOW_DAILY_PUBLISH=1. Dry-run keeps working without it.",
    );
    process.exit(1);
  }

  console.log("Mode: APPLY (Unpublishing current batch and publishing new batch to database)");
  console.log(`Batch size: ${batchSize} hadiths\n`);

  const result = await publishDailyHadithBatch({
    topicSlug,
    apply: true,
    batchSize,
  });

  if (!result.success) {
    console.error(`Error: ${result.message}`);
    if (result.error) console.error(result.error);
    process.exit(1);
  }

  console.log(`\n-----------------------------------------------------------------`);
  console.log(`  ON-DEMAND PUBLISH COMPLETE`);
  console.log(`  DAY: Day ${result.dayNumber} | DATE: ${result.runDate}`);
  console.log(`  PUBLISHED TODAY: ${result.count} hadiths`);
  console.log(`  REMAINING IN POOL: ${result.remainingInTopicPool} hadiths`);
  console.log(`-----------------------------------------------------------------\n`);

  console.log(`Newly Published Live Hadiths (Day ${result.dayNumber}):\n`);
  result.shortlistedHadiths.forEach((h, idx) => {
    console.log(`[#${idx + 1}] ${h.bookTitle} — Hadith ${h.hadithNumber}`);
    console.log(`    Chapter: ${h.chapter}`);
    console.log(`    Identifier: ${h.identifier} | Grade: ${h.hadithStatus}`);
    console.log(`    Arabic: ${h.arabicPreview}`);
    console.log(`    English: ${h.englishPreview}`);
    if (h.sourceUrl) console.log(`    Source: ${h.sourceUrl}`);
    console.log("");
  });

  console.log(result.message);
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});