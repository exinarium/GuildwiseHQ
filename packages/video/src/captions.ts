import { stamp } from './ffmpeg.ts';

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

const srtStamp = (s: number) => stamp(s).replace('.', ',');

/** SubRip captions. */
export function srt(cues: CaptionCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtStamp(c.start)} --> ${srtStamp(c.end)}\n${c.text}\n`).join('\n');
}

/**
 * Splits a spoken passage into short chunks (at most `maxWords`, breaking early after punctuation) and spreads its
 * time over them by length: the big burned-in captions of a Short.
 */
export function chunkCaption(cue: CaptionCue, maxWords = 4): CaptionCue[] {
  const words = cue.text.split(/\s+/).filter(Boolean);
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords || /[.,;:!?]$/.test(w)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  // a lone trailing word reads badly: fold it into the chunk before
  if (groups.length > 1 && (groups[groups.length - 1]?.length ?? 0) === 1) {
    const tail = groups.pop() as string[];
    groups[groups.length - 1]?.push(...tail);
  }
  const weights = groups.map((g) => g.join(' ').length + 2);
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = cue.start;
  return groups.map((g, i) => {
    const d = ((cue.end - cue.start) * (weights[i] as number)) / sum;
    const c = { start: t, end: i === groups.length - 1 ? cue.end : t + d, text: g.join(' ') };
    t += d;
    return c;
  });
}

const assTime = (s: number) => {
  const cs = Math.round(s * 100);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
};

/** An ASS file for burning large captions into a vertical video. */
export function ass(cues: CaptionCue[], width: number, height: number): string {
  const size = Math.round(width * 0.085);
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Liberation Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00201010,&H80000000,1,0,0,0,100,100,0,0,1,${Math.round(size / 9)},2,2,60,60,${Math.round(height * 0.2)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = cues.map(
    (c) =>
      `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text.toUpperCase().replace(/[{}\\]/g, '')}`,
  );
  return `${[...head, ...lines].join('\n')}\n`;
}
