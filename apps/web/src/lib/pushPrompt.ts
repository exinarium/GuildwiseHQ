import { BRAND } from '../brand.ts';

const ASK_KEY = `${BRAND.storagePrefix}-push-prompt`;
const HINT_KEY = `${BRAND.storagePrefix}-push-ios-hint`;
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** Shown at most once per page session, however often the shell re-mounts. */
let shownThisSession = false;
export const promptShownThisSession = (): boolean => shownThisSession;
export const markPromptShown = (): void => {
  shownThisSession = true;
};
/** Tests only. */
export const resetPromptSession = (): void => {
  shownThisSession = false;
};

type Stored = { until: number } | { never: true };

function read(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: Stored): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: the prompt only stays hidden for this page session */
  }
}
const active = (s: Stored | null, now: number): boolean => !!s && ('never' in s || s.until > now);

/** "Not now" (7 days) or "Don't ask again" (for good), per device. */
export const askDismissed = (now = Date.now()): boolean => active(read(ASK_KEY), now);
export const snoozeAsk = (now = Date.now()): void => write(ASK_KEY, { until: now + SNOOZE_MS });
export const neverAsk = (): void => write(ASK_KEY, { never: true });

/** The Add-to-Home-Screen hint is one-time. */
export const hintDismissed = (): boolean => read(HINT_KEY) !== null;
export const dismissHint = (): void => write(HINT_KEY, { never: true });
