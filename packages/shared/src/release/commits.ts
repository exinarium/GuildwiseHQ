export interface ConventionalTitle {
  type: string;
  scope?: string;
  bang: boolean;
  subject: string;
}

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;

/** "feat(api)!: drop v1 routes" -> {type:'feat', scope:'api', bang:true, subject}; null when not a conventional title. */
export function parseConventionalTitle(title: string): ConventionalTitle | null {
  const m = CONVENTIONAL.exec(title.trim());
  if (!m) return null;
  return {
    type: (m[1] as string).toLowerCase(),
    ...(m[2] !== undefined ? { scope: m[2] } : {}),
    bang: m[3] === '!',
    subject: m[4] as string,
  };
}

/** A "BREAKING CHANGE:" or "BREAKING-CHANGE:" footer line in a commit body. */
export function hasBreakingFooter(body: string): boolean {
  return /^BREAKING[ -]CHANGE:/m.test(body);
}
