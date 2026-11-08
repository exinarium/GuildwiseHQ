// Argument handling and date formatting for build-guide.mjs. Plain ESM without dependencies, so it can be tested
// and used to validate the arguments before Playwright is loaded.

/** Renders as "7 October 2026", the date the guide has always shown. */
export const DEFAULT_GUIDE_DATE = '2026-10-07';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export class GuideArgError extends Error {}

/** "2026-11-08" -> "8 November 2026". Throws GuideArgError naming the value when it is not a real calendar date. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) throw new GuideArgError(`--date "${iso}" is not a date in the form YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d)
    throw new GuideArgError(`--date "${iso}" is not a real calendar date`);
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new GuideArgError(`${flag} needs a value`);
  return v;
}

/** argv (process.argv.slice(2)) -> { out, date, dateText, edition, given }. Throws GuideArgError on a bad value. */
export function parseGuideArgs(argv, here = '.') {
  const out = flagValue(argv, '--out');
  const rawDate = flagValue(argv, '--date');
  const rawEdition = flagValue(argv, '--edition');
  const date = rawDate ?? DEFAULT_GUIDE_DATE;
  const dateText = longDate(date);
  let edition = null;
  if (rawEdition !== undefined) {
    edition = rawEdition.trim();
    if (!/^[^\u0000-\u001f\u007f]{1,40}$/.test(edition))
      throw new GuideArgError(`--edition "${rawEdition}" must be 1 to 40 characters without control characters`);
  }
  return { out, date, dateText, edition, given: rawDate !== undefined || edition !== null };
}

/** The Chromium footer template for a date text. */
export function footerTemplate(dateText) {
  const safe = String(dateText).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="width:100%;font-family:'Geist','Liberation Sans',Arial,sans-serif;font-size:7.5pt;color:#6b7280;padding:0 15mm;display:flex;justify-content:space-between;">
  <span>Guildwise HQ &middot; User Guide &middot; ${safe}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}
