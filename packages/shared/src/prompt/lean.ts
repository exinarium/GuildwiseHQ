/**
 * Lean instructions (Lean Team v3, runner 0.1.24): the rendered CLAUDE.md is the same for every shift of a role until
 * its last lines, so the prompt cache can be shared between agents and shifts; sections a kind of shift never uses are
 * left out. Pure string work on the rendered markdown, so every renderer benefits without being touched.
 */

const IDENTITY_HEADING = '# Who you are';

/**
 * Moves the opening "# Who you are" section (the agent's name and seniority, the project it works for) to the END of the
 * file. The text before it is then identical for every agent of a role and project, and that is what the cache keys on.
 */
export function identityLast(markdown: string): string {
  if (!markdown.startsWith(IDENTITY_HEADING)) return markdown;
  const rest = markdown.slice(IDENTITY_HEADING.length);
  const next = rest.search(/\n\n# /);
  if (next < 0) return markdown;
  const identity = `${IDENTITY_HEADING}${rest.slice(0, next)}`.trimEnd();
  const body = rest.slice(next).replace(/^\n+/, '').trimEnd();
  return `${body}\n\n${identity}\n`;
}

/**
 * Removes the `## <title>` sections (a heading that starts with one of `titles`) from markdown, each up to the next
 * heading of its own level or a higher one (its `###` subsections go with it).
 */
export function dropSections(markdown: string, titles: readonly string[]): string {
  if (titles.length === 0) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  let dropping = false;
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    const h = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = (h[1] as string).length;
      if (dropping && level <= 2) dropping = false;
      if (!dropping && level === 2 && titles.some((t) => (h[2] as string).trim().startsWith(t))) {
        dropping = true;
        continue;
      }
    }
    if (!dropping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The BA's role text holds the intake chat and the organisation design chat: no background shift runs them. */
const BA_CHAT = ['Intake (chat', 'Designing the organization'];
const BA_FINALIZE = ['Finalize (background)'];
const BA_OUTBOUND = ['Outbound updates'];
const BA_ANSWERING = ['Answering questions'];
const BA_PHASES = ['Phases (background)'];
const BA_REPORTING = ['Reporting to the manager'];
const BA_NEW_REPOS = ['New repositories'];

export type ShiftKindName = 'card' | 'question' | 'devops' | 'ba_task' | 'ceo';

/** The `##` sections of a role's instructions the shift does not use. Only the BA's long role text is trimmed. */
export function roleSectionsToDrop(
  roleKey: string,
  kind: ShiftKindName,
  opts: { batchIntake?: boolean } = {},
): string[] {
  if (roleKey !== 'ba') return [];
  if (kind === 'question')
    return [...BA_CHAT, ...BA_FINALIZE, ...BA_OUTBOUND, ...BA_PHASES, ...BA_REPORTING, ...BA_NEW_REPOS];
  if (kind === 'ba_task') {
    // a batch intake shift reads its ticket and drafts cards like the intake chat: it keeps that section
    if (opts.batchIntake) return ['Designing the organization'];
    return [...BA_CHAT, ...BA_FINALIZE, ...BA_OUTBOUND, ...BA_ANSWERING, ...BA_NEW_REPOS];
  }
  if (kind === 'card') return [...BA_CHAT, ...BA_ANSWERING, ...BA_PHASES, ...BA_REPORTING];
  return BA_CHAT;
}
