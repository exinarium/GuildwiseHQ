import { type ChatSegment, ChatSegmentSchema, type ServerToBrowser } from '@aom/shared';

export type { ChatSegment };
export type ToolStatus = Extract<ChatSegment, { type: 'tool' }>['status'];

/** Server -> browser `chat.activity` (forwarded, never stored): `seq` is the segment index, `replace` updates it. */
export type ChatActivityMessage = Extract<ServerToBrowser, { type: 'chat.activity' }>;

const STATUSES: readonly ToolStatus[] = ['running', 'ok', 'error', 'refused'];

/**
 * One segment from unknown JSON (stored data may be older or from another runner version): the shared schema first,
 * then a tolerant reading (unknown tool status counts as `ok`). Null when it is not a segment, so the caller can skip
 * just that segment and keep the message.
 */
export function parseSegment(raw: unknown): ChatSegment | null {
  const strict = ChatSegmentSchema.safeParse(raw);
  if (strict.success) return strict.data;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type === 'text') return typeof r.text === 'string' ? { type: 'text', text: r.text } : null;
  if (r.type === 'thinking') return { type: 'thinking' };
  if (r.type === 'tool') {
    if (typeof r.name !== 'string' || !r.name) return null;
    const status = STATUSES.includes(r.status as ToolStatus) ? (r.status as ToolStatus) : 'ok';
    return {
      type: 'tool',
      name: r.name,
      status,
      ...(typeof r.id === 'string' ? { id: r.id } : {}),
      ...(typeof r.summary === 'string' && r.summary ? { summary: r.summary } : {}),
    };
  }
  return null;
}

/** `data.segments` of a stored message, or null when there are none (old messages, old runner). */
export function parseSegments(data: unknown): ChatSegment[] | null {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).segments : undefined;
  if (!Array.isArray(raw)) return null;
  const out = raw.map(parseSegment).filter((s): s is ChatSegment => s !== null);
  return out.length > 0 ? out : null;
}

/**
 * The turn being streamed: ordered segments built from `chat.activity` (structure) and `chat.delta` (text appended to the
 * last text segment). Pure, so the panel and the tests share it.
 */
export function applyDelta(segments: ChatSegment[], text: string): ChatSegment[] {
  const last = segments[segments.length - 1];
  if (last?.type === 'text') return [...segments.slice(0, -1), { type: 'text', text: last.text + text }];
  return [...segments, { type: 'text', text }];
}

export function applyActivity(segments: ChatSegment[], a: ChatActivityMessage): ChatSegment[] {
  const seg = a.segment;
  if (a.replace) {
    // Same tool id (preferred), else the segment at `seq`.
    let i =
      seg.type === 'tool' && seg.id ? segments.findIndex((s) => s.type === 'tool' && s.id === seg.id) : -1;
    if (i < 0 && a.seq < segments.length && segments[a.seq]?.type === seg.type) i = a.seq;
    if (i >= 0) {
      const next = segments.slice();
      const old = next[i];
      next[i] =
        seg.type === 'tool' && old?.type === 'tool'
          ? { ...old, ...seg, summary: seg.summary ?? old.summary }
          : seg;
      return next;
    }
  }
  if (seg.type === 'thinking' && segments[segments.length - 1]?.type === 'thinking') return segments;
  // A new text segment announces a new paragraph; an empty one is a placeholder the next delta fills.
  return [...segments, seg];
}

/** Text of a turn when segments exist: text segments joined like the server's `body`. */
export function segmentsText(segments: ChatSegment[]): string {
  return segments
    .filter((s): s is Extract<ChatSegment, { type: 'text' }> => s.type === 'text')
    .map((s) => s.text)
    .join('\n\n');
}

export type ToolKind = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'web' | 'mcp' | 'task' | 'other';

/** The icon family of a tool name ("Read", "Bash", "mcp__aom__card_create"...). */
export function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Write':
      return 'write';
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'bash';
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'ToolSearch':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
    case 'TodoWrite':
      return 'task';
    default:
      return 'other';
  }
}

/** "mcp__aom__card_create" -> "aom: card create"; other names unchanged. */
export function toolLabel(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const [, server, ...rest] = name.split('__');
  const tool = rest.join('__').replace(/_/g, ' ');
  return server ? `${server}: ${tool}` : tool;
}

/** What the live status line says for the newest activity. */
export function liveStatus(segments: ChatSegment[]): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (!s) continue;
    if (s.type === 'tool' && s.status === 'running') {
      const verb: Record<ToolKind, string> = {
        read: 'Reading',
        edit: 'Editing',
        write: 'Writing',
        bash: 'Running',
        search: 'Searching',
        web: 'Fetching',
        mcp: 'Using',
        task: 'Delegating',
        other: 'Using',
      };
      const what = s.summary ?? toolLabel(s.name);
      return `${verb[toolKind(s.name)]} ${what}…`;
    }
    if (s.type === 'thinking') return 'Thinking…';
    if (s.type === 'text') return 'Writing…';
    break;
  }
  return 'Thinking…';
}

/** Groups consecutive tool segments; thinking blocks are not shown (only the live status line says "Thinking"). */
export type TurnItem =
  | { kind: 'text'; text: string; key: string }
  | { kind: 'tools'; tools: Extract<ChatSegment, { type: 'tool' }>[]; key: string };

/** Runs of this many tool rows or more collapse behind "Used N tools". */
export const COLLAPSE_AT = 3;

export function groupSegments(segments: ChatSegment[]): TurnItem[] {
  const out: TurnItem[] = [];
  segments.forEach((s, i) => {
    if (s.type === 'text') {
      if (s.text.trim()) {
        out.push({ kind: 'text', text: s.text, key: `t${i}` });
      }
    } else if (s.type === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'tools') last.tools.push(s);
      else out.push({ kind: 'tools', tools: [s], key: `u${i}` });
    }
  });
  return out;
}
