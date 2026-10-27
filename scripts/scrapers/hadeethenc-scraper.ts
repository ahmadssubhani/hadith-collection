import { runSite, parseCli } from "./hadith-scraper";
import { SITES } from "./sites";

const { opts } = parseCli(process.argv.slice(2));
runSite(SITES.hadeethenc, opts);
