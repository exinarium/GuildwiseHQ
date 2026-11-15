import type { RulePackPreview } from '@aom/shared';

export type PreviewRule = RulePackPreview['rules'][number];

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How a rule of a pack meets the organization's own rules, as one line. Null when there is nothing to say. */
export function statusLine(r: PreviewRule): string | null {
  const first = r.existing[0]?.title ?? '';
  switch (r.status) {
    case 'installed':
      return 'Already installed';
    case 'edited':
      return 'You edited this rule';
    case 'covered':
      return `Covered by your rule "${first}" (not added)`;
    case 'may_conflict':
      return `May contradict "${r.existing.map((x) => x.title).join('", "')}"`;
    default:
      return null;
  }
}
