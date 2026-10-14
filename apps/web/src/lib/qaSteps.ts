/**
 * The agent's manual QA steps (markdown) as a checklist: headings are scenarios ("Happy path", "Edge cases", ...), a line
 * `- [ ] text` is a step the person ticks off, any other bullet or sentence is a note. Pure and tolerant: whatever the
 * agent wrote still renders, as text only (nothing is interpreted as HTML).
 */
export interface QaStepItem {
  /** Position among all steps of the list (ticked state is kept by it). */
  index: number;
  kind: 'step' | 'note';
  text: string;
  /** The agent already ticked it (`- [x]`). */
  done: boolean;
}

export interface QaScenario {
  title: string | null;
  items: QaStepItem[];
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const STEP = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const CLEAN = /\*\*|__|`/g;

/** Plain text of a line: emphasis and code marks removed (the renderer shows text only). */
const plain = (s: string): string => s.replace(CLEAN, '').trim();

export function parseQaSteps(markdown: string): QaScenario[] {
  const out: QaScenario[] = [];
  let current: QaScenario | null = null;
  let index = 0;
  const ensure = (): QaScenario => {
    if (!current) {
      current = { title: null, items: [] };
      out.push(current);
    }
    return current;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = HEADING.exec(line);
    if (h) {
      current = { title: plain(h[1] ?? ''), items: [] };
      out.push(current);
      continue;
    }
    const step = STEP.exec(line);
    if (step) {
      ensure().items.push({
        index: index++,
        kind: 'step',
        text: plain(step[2] ?? ''),
        done: step[1] !== ' ',
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    ensure().items.push({
      index: index++,
      kind: 'note',
      text: plain(bullet ? (bullet[1] ?? '') : line),
      done: false,
    });
  }
  return out.filter((s) => s.items.length > 0 || s.title);
}

/** Number of steps (tickable lines) in the list. */
export const countSteps = (scenarios: QaScenario[]): number =>
  scenarios.reduce((n, s) => n + s.items.filter((i) => i.kind === 'step').length, 0);
