import { describe, expect, it } from 'vitest';
import { e2eOnlyFailure, e2eTestPathMatcher, isE2eTestContent } from '../src/index.ts';

const GLOBS = ['e2e/**', 'tests/e2e/**', 'playwright/**'];

describe('isE2eTestContent (BLOCKERS.md section 2)', () => {
  it.each([
    'e2e/README.md',
    'e2e/docs/guide.mdx',
    'e2e/notes.txt',
    'e2e/package.json',
    'e2e/package-lock.json',
    'e2e/pnpm-lock.yaml',
    'e2e/yarn.lock',
    'e2e/video/screens.json',
    'e2e/tsconfig.json',
    './e2e/README.md',
  ])('%s is not test content', (p) => {
    expect(isE2eTestContent(p)).toBe(false);
  });

  it.each([
    'e2e/login.spec.ts',
    'e2e/helpers/auth.ts',
    'e2e/fixtures/x.json',
    'e2e/__fixtures__/user.json',
    'e2e/snapshots/home.json',
    'e2e/login.spec.ts-snapshots/home-chromium.png',
    'e2e/data/seed.json',
    'e2e/playwright.config.ts',
    'e2e/scripts/seed.sh',
    'e2e/login.spec.ts-snapshots/greeting-chromium-linux.txt',
    'e2e/fixtures/expected.txt',
    'e2e/__snapshots__/notes.md',
    'e2e/test-data/users.json',
    'e2e/golden/page.json',
    'e2e/cypress.json',
    'e2e/.mocharc.json',
    'e2e/jest.config.json',
  ])('%s is test content', (p) => {
    expect(isE2eTestContent(p)).toBe(true);
  });
});

describe('e2eTestPathMatcher', () => {
  it('matches test content inside the globs only', () => {
    const m = e2eTestPathMatcher(GLOBS);
    expect(m('e2e/login.spec.ts')).toBe(true);
    expect(m('tests/e2e/fixtures/a.json')).toBe(true);
    expect(m('e2e/README.md')).toBe(false);
    expect(m('e2e/package.json')).toBe(false);
    expect(m('e2e/video/screens.json')).toBe(false);
    expect(m('src/login.spec.ts')).toBe(false);
  });

  it('matches nothing without globs', () => {
    expect(e2eTestPathMatcher([])('e2e/login.spec.ts')).toBe(false);
  });

  it('uses the glob compiler it is given', () => {
    const m = e2eTestPathMatcher(GLOBS, () => (p) => p.startsWith('custom/'));
    expect(m('custom/a.spec.ts')).toBe(true);
    expect(m('custom/README.md')).toBe(false);
    expect(m('e2e/a.spec.ts')).toBe(false);
  });
});

describe('e2eOnlyFailure uses the shared classifier', () => {
  it('a failure that names an E2E README is not E2E-only', () => {
    const v = e2eOnlyFailure('broken: see e2e/README.md', GLOBS);
    expect(v.e2eOnly).toBe(false);
  });

  it('a failure that names a spec is E2E-only', () => {
    const v = e2eOnlyFailure('fails in e2e/login.spec.ts', GLOBS);
    expect(v.e2eOnly).toBe(true);
  });
});
