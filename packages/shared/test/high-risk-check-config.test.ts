import { describe, expect, it } from 'vitest';
import { ownerApprovalDecision } from '../src/cards/lean-v6.ts';
import { classifyDeployRisk } from '../src/platform/index.ts';
import {
  highRiskByCategory,
  highRiskCategoriesOf,
  highRiskNotice,
  highRiskPaths,
  highRiskSummary,
  isHighRiskPath,
  isHighRiskPaths,
} from '../src/workflows/index.ts';

const FILES = [
  'package.json',
  'turbo.json',
  'nx.json',
  'eslint.config.mjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintignore',
  'biome.json',
  'biome.jsonc',
  '.prettierrc',
  '.prettierrc.yaml',
  'prettier.config.js',
  '.prettierignore',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.build.json',
  'jsconfig.json',
  'vitest.config.ts',
  'vitest.workspace.ts',
  'jest.config.cjs',
  'playwright.config.ts',
  '.husky/pre-commit',
  '.lintstagedrc',
  '.lintstagedrc.json',
  'lint-staged.config.js',
  'lefthook.yml',
  'lefthook.yaml',
  'Directory.Build.props',
  'Directory.Build.targets',
  '.editorconfig',
  '.globalconfig',
  'x.ruleset',
  'pyproject.toml',
  'setup.cfg',
  'ruff.toml',
  '.ruff.toml',
  'mypy.ini',
  '.flake8',
];

describe('check-config high-risk category', () => {
  const cases = FILES.flatMap((f) => [f, `apps/web/${f}`, `packages/x/y/${f}`]);
  it.each(cases)('%s is check-config', (p) => {
    expect(highRiskCategoriesOf(p)).toContain('check-config');
    expect(isHighRiskPath(p)).toBe(true);
  });

  it.each(['e2e/playwright.config.ts', 'e2e/package.json', 'test/tsconfig.json', 'docs/package.json'])(
    'exempt folder %s still matches',
    (p) => expect(highRiskCategoriesOf(p)).toEqual(['check-config']),
  );

  it.each([
    'src/package-json-utils.ts',
    'docs/tsconfig-guide.md',
    'src/eslint-rules.md',
    'package-lock.json',
    'pnpm-lock.yaml',
    'apps/web/src/App.tsx',
  ])('%s is not check-config', (p) => {
    expect(highRiskCategoriesOf(p)).not.toContain('check-config');
  });

  it('keeps other categories and lists several', () => {
    const paths = ['apps/web/package.json', 'apps/server/src/auth/login.ts', 'src/a.ts'];
    expect(highRiskCategoriesOf('.env')).toEqual(['auth']);
    expect(highRiskPaths(paths)).toEqual(['apps/web/package.json', 'apps/server/src/auth/login.ts']);
    expect(highRiskSummary(paths).categories).toEqual(['auth', 'check-config']);
    const notice = highRiskNotice(paths);
    expect(notice).toMatch(/check configuration/);
    expect(notice).toContain('apps/web/package.json');
    expect(highRiskByCategory(paths).map((g) => g.category)).toEqual(['auth', 'check-config']);
    expect(highRiskNotice(['a/package.json', 'b/package.json', 'c/package.json'], 2)).toMatch(/and 1 more/);
  });

  it('feeds the owner approval and the deploy risk', () => {
    expect(
      ownerApprovalDecision({ highRisk: isHighRiskPaths(['apps/web/tsconfig.json']) } as never).reason,
    ).toBe('high_risk');
    expect(classifyDeployRisk(['package.json']).categories).toEqual(['check_configuration']);
  });
});
