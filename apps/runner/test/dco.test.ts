import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectSignOff } from '../src/git/dco.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

function dirWith(files: Record<string, string>): string {
  const d = tmp('aom-dco-');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), text);
  }
  return d;
}

describe('detectSignOff', () => {
  it('asks for a sign-off when .github/dco.yml exists', async () => {
    expect(await detectSignOff(dirWith({ '.github/dco.yml': 'require: {}' }))).toEqual({
      required: true,
      reason: '.github/dco.yml',
    });
  });
  it('asks for a sign-off when a workflow checks Signed-off-by', async () => {
    const d = dirWith({
      '.github/workflows/dco.yml': 'run: grep "^Signed-off-by:"',
      '.github/workflows/ci.yml': 'x',
    });
    expect(await detectSignOff(d)).toEqual({ required: true, reason: '.github/workflows/dco.yml' });
  });
  it('asks for a sign-off when .gitlab-ci.yml checks Signed-off-by', async () => {
    expect((await detectSignOff(dirWith({ '.gitlab-ci.yml': 'script: grep Signed-off-by' }))).required).toBe(
      true,
    );
  });
  it.each(['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'])(
    'asks for a sign-off when %s names the DCO',
    async (f) => {
      expect(await detectSignOff(dirWith({ [f]: 'We use the Developer Certificate of Origin.' }))).toEqual({
        required: true,
        reason: f,
      });
    },
  );
  it('does not ask when nothing mentions it', async () => {
    const d = dirWith({
      'CONTRIBUTING.md': 'Be nice.',
      '.github/workflows/ci.yml': 'run: pnpm test',
      'README.md': 'x',
    });
    expect(await detectSignOff(d)).toEqual({ required: false });
    expect(await detectSignOff(tmp('aom-dco-empty-'))).toEqual({ required: false });
  });
});
