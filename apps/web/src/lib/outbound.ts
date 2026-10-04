import type { OutboundKind } from '@aom/shared';

export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const tokens = (s: string): string[] => s.match(/\s+|[^\s]+/g) ?? [];

/**
 * Word-level diff between the draft as written and the text approved (longest common subsequence over words and the
 * whitespace between them). Used to show the manager what their edit changed, and the history what was posted.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i] as string);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push('removed', a[i++] as string);
    else push('added', b[j++] as string);
  }
  while (i < n) push('removed', a[i++] as string);
  while (j < m) push('added', b[j++] as string);
  return out;
}

export const KIND_LABEL: Record<OutboundKind, string> = {
  comment: 'Comment',
  resolution: 'Resolution',
  decision: 'Design decision',
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved, waiting to be posted',
  rejected: 'Rejected, never posted',
  posted: 'Posted',
  failed: 'Posting failed',
  blocked: 'Blocked: internal details',
};

export const systemLabel = (s: string): string => (s === 'jira' ? 'Jira' : 'GitHub');
