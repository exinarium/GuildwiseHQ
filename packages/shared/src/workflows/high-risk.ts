/**
 * High-risk paths (Lean Team v3, design 5.4 and 13): a change that touches authentication, permissions or secrets, data
 * and migrations, or tenancy and billing needs a second Opus review and, for a normal client project, the project owner's
 * approval. The list is one shared module so the card flow (code-v6) and the platform team's deploy policy (S4) agree on
 * what "high risk" means. Sandbox, policy and deploy code is deliberately not on the list (owner decision, design 13).
 *
 * The server computes the flag from the paths of the card diff at every handoff; an agent cannot lower it.
 */

export type HighRiskCategory = 'auth' | 'data' | 'tenancy';

export interface HighRiskRule {
  id: HighRiskCategory;
  label: string;
  globs: readonly string[];
}

export const HIGH_RISK_RULES: readonly HighRiskRule[] = [
  {
    id: 'auth',
    label: 'authentication, permissions or secrets',
    globs: [
      '**/auth/**',
      '**/authn/**',
      '**/authz/**',
      '**/authentication/**',
      '**/authorization/**',
      '**/permissions/**',
      '**/permission*',
      '**/rbac/**',
      '**/acl/**',
      '**/oauth/**',
      '**/sso/**',
      '**/session*',
      '**/*password*',
      '**/*two-factor*',
      '**/*2fa*',
      '**/*totp*',
      '**/jwt*',
      '**/secrets/**',
      '**/*secret*',
      '**/credentials*',
      '**/crypto/**',
      '**/crypto.*',
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
    ],
  },
  {
    id: 'data',
    label: 'data and migrations',
    globs: [
      '**/migrations/**',
      '**/migration/**',
      '**/*migration*',
      '**/migrate.*',
      '**/*.sql',
      '**/prisma/**',
      '**/alembic/**',
      '**/db/schema*',
      '**/schema.prisma',
      '**/data-migrations/**',
      // Guildwise's own data layer (the platform team's fixes)
      'apps/server/src/db/**',
      'apps/server/src/eventstore/**',
      'apps/server/src/projections/rebuild.ts',
    ],
  },
  {
    id: 'tenancy',
    label: 'tenancy and billing',
    globs: [
      '**/tenant/**',
      '**/tenants/**',
      '**/tenancy/**',
      '**/*tenant*',
      '**/billing/**',
      '**/payment/**',
      '**/payments/**',
      '**/*billing*',
      '**/*invoice*',
      '**/*subscription*',
      '**/stripe*',
      '**/paystack*',
      '**/payfast*',
      // Guildwise's own organisations, members and sharing (the platform team's fixes)
      'apps/server/src/orgs/**',
      'apps/server/src/commands/orgs.ts',
      'apps/server/src/commands/platform.ts',
      'apps/server/src/commands/sharing.ts',
      'apps/server/src/commands/members.ts',
      'packages/shared/src/orgs/**',
    ],
  },
];

/** Every high-risk glob, all categories (the platform team's deploy policy imports this). */
export const HIGH_RISK_GLOBS: readonly string[] = HIGH_RISK_RULES.flatMap((r) => r.globs);

/**
 * Paths that are never high risk by themselves: tests, documentation and the sandbox, policy and deploy code (owner decision
 * of design 13: those fixes go live after review and UAT). A change that also touches a listed high-risk path is still flagged
 * by that path.
 */
export const HIGH_RISK_EXEMPT_GLOBS: readonly string[] = [
  'docs/**',
  '**/*.md',
  'e2e/**',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  'deploy/**',
  'apps/runner/src/devops/**',
  'apps/runner/src/sandbox/**',
  'apps/runner/src/adapters/claude-policy.ts',
  'apps/runner/src/adapters/sandbox*',
];

/** A glob (`**`, `*`, `?`) as a case-insensitive regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        // `**/` = zero or more directories; a trailing `**` = anything
        if (glob.charAt(i + 2) === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

const COMPILED: ReadonlyArray<{ id: HighRiskCategory; res: RegExp[] }> = HIGH_RISK_RULES.map((r) => ({
  id: r.id,
  res: r.globs.map(globToRegExp),
}));

const EXEMPT: readonly RegExp[] = HIGH_RISK_EXEMPT_GLOBS.map(globToRegExp);

const normalise = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\/+/, '');

/** The categories a path falls in (empty: not high risk). */
export function highRiskCategoriesOf(path: string): HighRiskCategory[] {
  const p = normalise(path);
  if (EXEMPT.some((re) => re.test(p))) return [];
  return COMPILED.filter((c) => c.res.some((re) => re.test(p))).map((c) => c.id);
}

/** Is this path a high-risk path (auth, permissions, secrets, data, migrations, tenancy, billing)? */
export function isHighRiskPath(path: string): boolean {
  return highRiskCategoriesOf(path).length > 0;
}

/** Does any of the paths fall on the high-risk list? */
export function isHighRiskPaths(paths: readonly string[]): boolean {
  return paths.some(isHighRiskPath);
}

/** The high-risk paths among `paths` (in order). */
export function highRiskPaths(paths: readonly string[]): string[] {
  return paths.filter(isHighRiskPath);
}

/** The distinct categories the paths fall in, with a label for the desk text. */
export function highRiskSummary(paths: readonly string[]): {
  categories: HighRiskCategory[];
  labels: string[];
} {
  const seen = new Set<HighRiskCategory>();
  for (const p of paths) for (const c of highRiskCategoriesOf(p)) seen.add(c);
  const categories = HIGH_RISK_RULES.filter((r) => seen.has(r.id)).map((r) => r.id);
  return { categories, labels: HIGH_RISK_RULES.filter((r) => seen.has(r.id)).map((r) => r.label) };
}
