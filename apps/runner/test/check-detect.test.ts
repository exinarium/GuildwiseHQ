import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectChecks, workflowRuns } from '../src/checks/detect.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

function repo(files: Record<string, string>): string {
  const d = tmp('aom-detect-');
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
}

const GW = {
  'package.json': JSON.stringify({
    packageManager: 'pnpm@12.8.1',
    scripts: {
      typecheck: 'pnpm -r --if-present typecheck',
      lint: 'biome check .',
      format: 'biome check --write .',
    },
  }),
  'biome.json': '{}',
  '.github/workflows/ci.yml': `name: ci
jobs:
  a:
    steps:
      - run: scripts/check-no-cloud-imports.sh
      - run: pnpm install --frozen-lockfile
      - name: Typecheck
        run: pnpm -r --if-present typecheck
      - run: pnpm lint
      - run: |
          echo "$HOME"
          pnpm --filter @aom/shared test
`,
};

describe('detectChecks', () => {
  it('a GuildwiseHQ-shaped repository gives the two hardened checks, with the formatter as fix', () => {
    const r = detectChecks(repo(GW));
    expect(r.map((c) => [c.name, c.cmd.join(' '), c.fix?.join(' ')])).toEqual([
      ['typecheck', 'pnpm -r --no-bail --if-present typecheck', undefined],
      ['lint', 'pnpm lint --max-diagnostics=none', 'pnpm format'],
    ]);
    expect(r.every((c) => c.kind === 'check' && c.timeoutMin === 5 && c.cwd === '.')).toBe(true);
  });

  it('reads run blocks and skips shell operators, --write and installs', () => {
    expect(
      workflowRuns(`steps:
  - run: |
      pnpm lint
      pnpm format --write
  - run: "npm run typecheck"
`),
    ).toEqual(['pnpm lint', 'pnpm format --write', 'npm run typecheck']);
    const r = detectChecks(
      repo({
        '.github/workflows/ci.yml': `steps:
  - run: pnpm lint && pnpm test
  - run: pnpm format --write
  - run: npm run lint --fix
  - run: pnpm install --frozen-lockfile
  - run: dotnet format
  - run: dotnet format --verify-no-changes
`,
      }),
    );
    expect(r.map((c) => c.cmd.join(' '))).toEqual(['dotnet format --verify-no-changes']);
  });

  it('package.json scripts when CI has none; npm uses npm run; a script with --write is skipped', () => {
    const r = detectChecks(
      repo({
        'package.json': JSON.stringify({
          scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'format:check': 'prettier --write .' },
        }),
      }),
    );
    expect(r.map((c) => c.cmd.join(' '))).toEqual(['npm run lint', 'npm run typecheck']);
  });

  it('falls back to tool configs only when nothing else was found', () => {
    const r = detectChecks(repo({ 'biome.json': '{}', '.prettierrc': '{}' }));
    expect(r.map((c) => c.cmd.join(' '))).toEqual([
      'npx biome check . --max-diagnostics=none',
      'npx prettier --check .',
    ]);
    expect(r[0]?.fix).toEqual(['npx', 'biome', 'format', '--write', '.']);
    expect(detectChecks(repo({ 'ruff.toml': '' })).map((c) => c.cmd.join(' '))).toEqual([
      'ruff check .',
      'ruff format --check .',
    ]);
    expect(detectChecks(repo({}))).toEqual([]);
  });

  it('uses the project folder as cwd', () => {
    const d = repo({
      'web/package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
      'web/pnpm-lock.yaml': '',
    });
    const r = detectChecks(d, 'web');
    expect(r[0]).toMatchObject({ cwd: 'web', cmd: ['pnpm', 'lint'] });
  });

  it('proposes at most five', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `  - run: eslint dir${i}`).join('\n');
    expect(detectChecks(repo({ '.github/workflows/ci.yml': `steps:\n${lines}\n` }))).toHaveLength(5);
  });
});
