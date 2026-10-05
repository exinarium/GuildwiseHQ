// Converts the transcript formats the runner meets (WebVTT, SRT, Podcasting 2.0 JSON, HTML) to plain text.
// Pure and deterministic.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Lines of the last `WINDOW` emitted lines a new line is compared with (rolling auto-captions repeat the previous line). */
const WINDOW = 6;

/**
 * WebVTT or SRT to plain text. Cue timing, ids, notes, styling and inline tags (`<00:00:01.500><c> word</c>`) are
 * dropped. YouTube's rolling auto-captions show every line in two or three consecutive cues; a line is only emitted
 * when it is not one of the last few lines already emitted, so the text reads once. Output is paragraphs of
 * a few lines each.
 */
export function captionsToText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inCue = false;
  let skipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === '') {
      inCue = false;
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    if (!inCue) {
      if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(line) || /^Kind:|^Language:/.test(line)) {
        skipBlock = !/^WEBVTT/.test(line) && !/^(Kind|Language):/.test(line);
        continue;
      }
      if (line.includes('-->')) {
        inCue = true;
        continue;
      }
      // a cue id (SRT counter or VTT identifier) sits on the line before the timing line
      if ((lines[i + 1] ?? '').includes('-->')) continue;
      continue;
    }
    const text = decodeEntities(line.replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (out.slice(-WINDOW).includes(text)) continue;
    out.push(text);
  }
  return paragraphs(out);
}

function paragraphs(lines: string[]): string {
  const paras: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const l of lines) {
    cur.push(l);
    len += l.length + 1;
    if (len > 500 && /[.?!]["')\]]?$/.test(l)) {
      paras.push(cur.join(' '));
      cur = [];
      len = 0;
    }
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras.join('\n\n');
}

/** Podcasting 2.0 JSON transcripts (`{ segments: [{ speaker, startTime, body }] }`) and similar `text` lists. */
export function jsonTranscriptToText(raw: string): string {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return '';
  }
  const list = Array.isArray(v)
    ? v
    : ((v as Record<string, unknown> | null)?.segments ??
      (v as Record<string, unknown> | null)?.transcript ??
      (v as Record<string, unknown> | null)?.results ??
      (v as Record<string, unknown> | null)?.captions);
  if (!Array.isArray(list)) return '';
  const out: string[] = [];
  let speaker = '';
  for (const seg of list) {
    if (!seg || typeof seg !== 'object') continue;
    const s = seg as Record<string, unknown>;
    const body = [s.body, s.text, s.content, s.utterance, s.transcript].find((x) => typeof x === 'string') as
      | string
      | undefined;
    if (!body?.trim()) continue;
    const who = typeof s.speaker === 'string' ? s.speaker : '';
    if (who && who !== speaker) {
      out.push(`${out.length ? '\n' : ''}${who}: ${body.trim()}`);
      speaker = who;
    } else out.push(body.trim());
  }
  return out.join(' ').replace(/ \n/g, '\n').trim();
}

/** An HTML page (a linked transcript) to text: scripts, styles and navigation dropped, block tags become line breaks. */
export function htmlToText(html: string): string {
  const main = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? html;
  const text = main
    .replace(/<(script|style|nav|header|footer|aside|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Picks the converter from the content type, the URL and the first bytes. */
export function transcriptToText(raw: string, hint: { contentType?: string; url?: string }): string {
  const ct = (hint.contentType ?? '').toLowerCase();
  const url = (hint.url ?? '').toLowerCase().split('?')[0] ?? '';
  const head = raw.trimStart().slice(0, 200);
  if (/^WEBVTT/.test(head) || ct.includes('text/vtt') || url.endsWith('.vtt')) return captionsToText(raw);
  if (ct.includes('srt') || url.endsWith('.srt') || /^\d+\s*\n\d\d:\d\d:\d\d[,.]\d+\s*-->/.test(head))
    return captionsToText(raw);
  if (ct.includes('json') || url.endsWith('.json') || /^[[{]/.test(head)) {
    const t = jsonTranscriptToText(raw);
    if (t) return t;
  }
  if (ct.includes('html') || /^<(!doctype|html)/i.test(head) || url.endsWith('.html')) return htmlToText(raw);
  return raw.replace(/\r\n?/g, '\n').trim();
}
