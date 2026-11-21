import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 1.10.0 hardening, R18-U (DIAGNOSIS finding 5): the app user (`node`) owned `release/` in the image, so a file write in the
// app could drop a higher `aom-runner-<v>.tgz` that every runner then installed. The runtime image now copies it root-owned
// and read-only (directories and files 0555); nothing in the runtime stage hands it back to `node`.

const root = resolve(import.meta.dirname, '../../..');
const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));

describe('the core image keeps release/ read-only', () => {
  it('copies the runner release root-owned with mode 0555', () => {
    const copies = runtime.split('\n').filter((l) => /^COPY\b.*\s\/app\/release\s*$/.test(l));
    // from the runner-release stage (signed release, R21/R30), still root-owned and 0555
    expect(copies).toEqual([
      'COPY --from=runner-release --chown=root:root --chmod=0555 /out/release /app/release',
    ]);
  });
  it('never gives it back to the app user', () => {
    const runs = runtime.split('\n').filter((l) => !l.startsWith('COPY'));
    expect(runs.filter((l) => /\b(chown|chmod)\b.*\/app(\/release)?\b/.test(l))).toEqual([]);
    expect(runtime).toMatch(/AOM_RUNNER_RELEASE_DIR=\/app\/release/);
  });
});
