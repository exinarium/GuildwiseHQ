import {
  CheckCircle2,
  CircleDashed,
  CircleDot,
  ClipboardCheck,
  Eye,
  FileText,
  Flag,
  FlaskConical,
  Hourglass,
  type LucideIcon,
  OctagonX,
  Pencil,
  RotateCcw,
} from 'lucide-react';

export interface StageStyle {
  /** A CSS colour (a `var(--stage-*)` token): dots, rails and chips, never text. */
  color: string;
  icon: LucideIcon;
}

const KNOWN: Record<string, StageStyle> = {
  Spec: { color: 'var(--stage-spec)', icon: Pencil },
  'To do': { color: 'var(--stage-todo)', icon: CircleDashed },
  Rework: { color: 'var(--stage-rework)', icon: RotateCcw },
  'In progress': { color: 'var(--stage-progress)', icon: CircleDot },
  Blocked: { color: 'var(--stage-blocked)', icon: OctagonX },
  Review: { color: 'var(--stage-review)', icon: Eye },
  Test: { color: 'var(--stage-test)', icon: FlaskConical },
  'Test (waiting on bug)': { color: 'var(--stage-waiting)', icon: Hourglass },
  Docs: { color: 'var(--stage-docs)', icon: FileText },
  Finalize: { color: 'var(--stage-finalize)', icon: Flag },
  QA: { color: 'var(--stage-review)', icon: ClipboardCheck },
  Done: { color: 'var(--stage-done)', icon: CheckCircle2 },
};

const CYCLE = [
  'var(--stage-spec)',
  'var(--stage-progress)',
  'var(--stage-test)',
  'var(--stage-docs)',
  'var(--stage-finalize)',
  'var(--stage-review)',
  'var(--stage-rework)',
  'var(--stage-todo)',
];

/** Colour and glyph of a board column. Custom workflows bring their own names: a stable hash picks the hue. */
export function stageStyle(name: string): StageStyle {
  const known = KNOWN[name];
  if (known) return known;
  let sum = 0;
  for (const ch of name) sum += ch.charCodeAt(0);
  return { color: CYCLE[sum % CYCLE.length] as string, icon: CircleDot };
}
