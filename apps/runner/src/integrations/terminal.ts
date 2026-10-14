/**
 * Reads what an interactive CLI printed into a pseudo-terminal. The Claude Code screens (Ink) position every word with a
 * cursor-move escape and wrap long lines; `claude mcp login` clears and redraws its prompt line. This turns such output
 * into plain lines, and finds the sign-in URL (the OSC 8 hyperlink carries the whole URL even when the visible text is cut).
 * Recorded transcripts of the real CLIs (apps/runner/test/fixtures/integrations) pin the behaviour.
 */

/* biome-ignore-all lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters */

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const COL = /\x1b\[(\d*)G/g;
const CSI = /\x1b\[[0-9;?<>=! ]*[@-~]/g;
const ESC2 = /\x1b[()][A-Za-z0-9]|\x1b[=>78cM]/g;

/** Every hyperlink target (OSC 8) in the raw output, in order of appearance, without duplicates. */
export function hyperlinks(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(OSC8)) {
    const url = m[1];
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Plain text of a terminal transcript: escapes removed, cursor-to-column treated as a space, column 1 as a new line. */
export function cleanTerminal(raw: string): string {
  return raw
    .replace(OSC, '')
    .replace(COL, (_m, n: string) => (n === '' || n === '1' ? '\n' : ' '))
    .replace(CSI, '')
    .replace(ESC2, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\x07/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const URL_CHARS = /^[A-Za-z0-9%&=._~:/?#@!$'()*+,;[\]-]+$/;

/**
 * The first https URL: from an OSC 8 hyperlink when the CLI printed one, else from the text, joining lines a narrow
 * terminal wrapped in the middle of the URL. `accept` filters (host allow-list).
 */
export function findUrl(raw: string, accept: (url: URL) => boolean = () => true): string | undefined {
  const candidates = [...hyperlinks(raw)];
  const lines = cleanTerminal(raw).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const start = (lines[i] as string).search(/https:\/\//);
    if (start < 0) continue;
    let url = (lines[i] as string).slice(start).split(' ')[0] as string;
    let j = i + 1;
    // a wrapped URL continues on the next line with no space in it
    while (j < lines.length && URL_CHARS.test(lines[j] as string) && url.length < 4000)
      url += lines[j++] as string;
    candidates.push(url);
  }
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.protocol === 'https:' && accept(u)) return u.toString();
    } catch {
      // not a URL
    }
  }
  return undefined;
}

/** Host names that are never a sign-in page for a user: local and private addresses. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal'))
    return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.startsWith('[')) return false;
  return h.includes('.');
}
