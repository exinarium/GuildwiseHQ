/**
 * The voice-over of every generated video: the style the script writer is told to follow, the pronunciation map and
 * `speakable()`, which derives what the voice reads from what viewers read. The help videos use the same voice
 * (Kokoro `af_heart`, see video/overview-script.md and e2e/video/narration/types.ts).
 */
export const NARRATION_STYLE = [
  'Warm, clear, second person ("you").',
  'Short sentences, written for speech. One idea per cue.',
  'No URLs, no bullet symbols, no emoji. Numbers in words where you can.',
  'Say "Guildwise HQ" for the product. Never read code aloud: describe what it does.',
  'Show demo data only: never real customer or personal data.',
].join(' ');

export interface Pronunciation {
  /** The written form, matched as a whole word and case sensitive. */
  written: string;
  /** What the voice should be given instead. */
  say: string;
}

/** Longest first: `speakable()` applies them in this order. */
export const PRONUNCIATIONS: readonly Pronunciation[] = [
  { written: 'Guildwise HQ', say: 'Guildwise H Q' },
  { written: 'GuildwiseHQ', say: 'Guildwise H Q' },
  { written: 'Guildwise-HQ', say: 'Guildwise H Q' },
  { written: 'PostgreSQL', say: 'post-gres' },
  { written: 'Postgres', say: 'post-gres' },
  { written: 'aom-runner', say: 'the runner' },
  { written: 'OAuth', say: 'O auth' },
  { written: 'HQ', say: 'H Q' },
  { written: 'SSH', say: 'S S H' },
  { written: 'CLI', say: 'C L I' },
  { written: 'CI', say: 'C I' },
  { written: 'PRs', say: 'P Rs' },
  { written: 'PR', say: 'P R' },
  { written: 'VPS', say: 'V P S' },
  { written: 'VTT', say: 'V T T' },
];

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0 to 999,999,999 in words ("one hundred and five" is spoken without "and": "one hundred five"). */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) return String(n);
  if (n < 20) return ONES[n] as string;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  for (const [size, name] of [
    [1_000_000, 'million'],
    [1000, 'thousand'],
  ] as const) {
    if (n >= size)
      return `${numberToWords(Math.floor(n / size))} ${name}${n % size ? ` ${numberToWords(n % size)}` : ''}`;
  }
  return String(n);
}

const digitsToWords = (digits: string): string => [...digits].map((d) => ONES[Number(d)] as string).join(' ');

/** A year the way it is said: 1999 "nineteen ninety-nine", 2026 "twenty twenty-six", 2005 "two thousand five". */
function yearToWords(n: number): string {
  if (n >= 2000 && n < 2010) return numberToWords(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  return `${numberToWords(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${numberToWords(lo)}` : numberToWords(lo)}`;
}

/** A dotted version: trailing zero parts are dropped ("1.0" is "version one", "1.2.0" "version one point two"). */
function versionToWords(parts: string[]): string {
  const p = [...parts];
  while (p.length > 1 && Number(p[p.length - 1]) === 0) p.pop();
  return p.map((x) => numberToWords(Number(x))).join(' point ');
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi;
// bare domain names with a common top level domain
const DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|co|ai)(?:\/[^\s)>\]]*)?\b/gi;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PRONUNCIATION_RES = [...PRONUNCIATIONS]
  .sort((a, b) => b.written.length - a.written.length)
  .map((p) => ({ re: new RegExp(`(?<![\\w-])${escapeRe(p.written)}(?![\\w-])`, 'g'), say: p.say }));

/**
 * What the voice reads for a cue's on-screen text. Deterministic: no URLs, markdown or code marks, the pronunciation
 * map, versions and numbers in words ("Guildwise HQ 1.2.0 is out" becomes "Guildwise H Q version one point two is
 * out"). A cue's own `speech` field wins over this.
 */
export function speakable(text: string): string {
  let s = text;
  // markdown: links keep their text, emphasis and code marks go
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/[`*_]{1,3}(?=\S)([^`*_\n]+?)(?<=\S)[`*_]{1,3}/g, '$1').replace(/`/g, '');
  s = s.replace(URL_RE, ' ').replace(DOMAIN_RE, ' ');
  for (const { re, say } of PRONUNCIATION_RES) s = s.replace(re, say);
  s = s
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\s*(?:->|=>|→)\s*/g, ' to ')
    .replace(/&/g, ' and ')
    .replace(/\s*[—–]\s*/g, ', ');
  // versions: v1.2.0, 1.2.3, "version 1.0"
  s = s.replace(
    /(\bversion\s+)?(?<![\w.])(v?)(\d+(?:\.\d+){1,3})(?![\w]|\.\d)/gi,
    (m, ver: string | undefined, v: string, nums: string) => {
      const parts = nums.split('.');
      // "2.5" alone is a decimal; two parts are a version when called one or when they end in zero ("1.0")
      if (!ver && !v && parts.length < 3 && Number(parts[1]) !== 0) return m;
      return `${ver ?? 'version '}${versionToWords(parts)}`;
    },
  );
  // percent, thousands separators, decimals, years, plain numbers
  s = s.replace(/(?<![\w.])(\d+)%/g, (_m, n: string) => `${numberToWords(Number(n))} percent`);
  s = s.replace(/(?<![\w.,])(\d{1,3}(?:,\d{3})+)(?![\w])/g, (m) =>
    numberToWords(Number(m.replace(/,/g, ''))),
  );
  s = s.replace(
    /(?<![\w.])(\d+)\.(\d+)(?![\w])/g,
    (_m, a: string, b: string) => `${numberToWords(Number(a))} point ${digitsToWords(b)}`,
  );
  s = s.replace(/(?<![\w.])(\d+)(?![\w])/g, (_m, n: string) => {
    const v = Number(n);
    if (n.length === 4 && v >= 1900 && v <= 2099) return yearToWords(v);
    return numberToWords(v);
  });
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,]+/, '')
    .trim();
}
