import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runnerNode } from '../src/shims.ts';

/**
 * UAT 1.10.0 bug 7: the `aom` shim exec'd `/usr/bin/node` (the launcher's `exec node` found the system Node first), not the
 * instance's root-owned, pinned `/usr/local/lib/guildwise/<instance>/node`.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('runnerNode: the install’s own Node first', () => {
  it('an instance user gets its instance’s Node, the single runner the top-level one, else the running Node', () => {
    const have = new Set([
      '/usr/local/lib/guildwise/uat/node/bin/node',
      '/usr/local/lib/guildwise/node/bin/node',
    ]);
    const exists = (p: string) => have.has(p);
    expect(runnerNode('guildwise-runner-uat', exists, '/usr/bin/node')).toBe(
      '/usr/local/lib/guildwise/uat/node/bin/node',
    );
    expect(runnerNode('guildwise-runner', exists, '/usr/bin/node')).toBe(
      '/usr/local/lib/guildwise/node/bin/node',
    );
    expect(runnerNode('guildwise-runner-prod', exists, '/usr/bin/node')).toBe('/usr/bin/node');
    expect(runnerNode('guildwise-runner-uat', () => false, '/usr/bin/node')).toBe('/usr/bin/node');
    // a name that is not an instance never builds a path from it
    expect(runnerNode('guildwise-runner-../../tmp', (p) => p.includes('tmp'), '/usr/bin/node')).toBe(
      '/usr/bin/node',
    );
  });
});

describe('the release launcher (scripts/package-runner.sh) runs the pinned Node before any Node on PATH', () => {
  it('falls back to `node` on PATH only when no pinned Node is there', () => {
    const sh = readFileSync(join(import.meta.dirname, '../../../scripts/package-runner.sh'), 'utf8');
    const launcher = /cat > "\$PKG\/aom-runner" <<'LAUNCH'\n([\s\S]*?)\nLAUNCH\n/.exec(sh)?.[1];
    expect(launcher).toBeTruthy();
    const d = mkdtempSync(join(tmpdir(), 'aom-launch-'));
    dirs.push(d);
    mkdirSync(join(d, 'pkg', 'dist'), { recursive: true });
    mkdirSync(join(d, 'bin'));
    writeFileSync(join(d, 'pkg', 'aom-runner'), (launcher as string).replace('@FLOOR@', '1.10.0'));
    chmodSync(join(d, 'pkg', 'aom-runner'), 0o755);
    writeFileSync(join(d, 'pkg', 'dist', 'aom-runner.mjs'), 'console.log("NODE=" + process.execPath);\n');
    writeFileSync(join(d, 'bin', 'node'), `#!/bin/sh\necho NODE=PATH-NODE\n`);
    chmodSync(join(d, 'bin', 'node'), 0o755);
    const r = spawnSync(join(d, 'pkg', 'aom-runner'), ['--version'], {
      encoding: 'utf8',
      env: { PATH: `${join(d, 'bin')}:/usr/bin:/bin` },
    });
    // this machine's user is not a runner user: the top-level pinned Node if installed, else PATH's
    const pinned = '/usr/local/lib/guildwise/node/bin/node';
    expect(r.stdout.trim(), r.stderr).toBe(existsSync(pinned) ? `NODE=${pinned}` : 'NODE=PATH-NODE');
    expect(launcher).toContain('guildwise-runner-*) PINNED="/usr/local/lib/guildwise/');
    expect(launcher).toContain('exec "$NODE" "$HERE/dist/aom-runner.mjs" "$@"');
    expect(launcher).not.toMatch(/^exec node /m);
  });
});
