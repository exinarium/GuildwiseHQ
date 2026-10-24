import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { launchInHarnessSandbox } from '../src/adapters/harness-session.ts';
import {
  proxyEnv,
  REAL_SHELL_IN_BOX,
  realShellPath,
  shellShimScript,
} from '../src/sandbox/harness-sandbox.ts';

/**
 * Owner decision Q68: Codex may take roles without a shell once the shell in its box runs only `aom ...` and a test proves it. The
 * shim that is the box's `bash` does the enforcing (whatever Codex's own rules say), so these tests run real commands through it.
 */
const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-aomonly-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the aom-only shim, run with the host bash', () => {
  const bin = join(root, 'unit', 'bin');
  mkdirSync(bin, { recursive: true });
  const marker = join(root, 'unit', 'MARKER');
  // the stub `aom` prints its arguments, one per line; the fake bwrap just runs what follows `--`
  writeFileSync(join(bin, 'aom'), '#!/bin/sh\nprintf "AOM-ARG[%s]\\n" "$@"\n', { mode: 0o755 });
  const fakeBwrap = join(root, 'unit', 'fake-bwrap');
  writeFileSync(fakeBwrap, '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', {
    mode: 0o755,
  });
  const trusted = join(root, 'unit', 'trusted');
  mkdirSync(trusted, { recursive: true });
  writeFileSync(join(trusted, 'helper.sh'), '#!/bin/sh\necho TRUSTED-HELPER-RAN\n', { mode: 0o755 });
  writeFileSync(join(root, 'unit', 'evil.sh'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const shim = join(root, 'unit', 'bash');
  writeFileSync(
    shim,
    shellShimScript(realShellPath(), [], [], fakeBwrap, realShellPath(), { trustedScripts: [trusted] }),
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  const run = (...args: string[]) => {
    rmSync(marker, { force: true });
    const r = spawnSync(shim, args, {
      encoding: 'utf8',
      cwd: join(root, 'unit'),
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, ran: existsSync(marker) };
  };

  it('runs aom and its arguments, plain or quoted without expansion', () => {
    expect(run('-c', 'aom').out).toBe('AOM-ARG[]\n');
    expect(run('-c', 'aom').code).toBe(0);
    expect(run('-lc', 'aom card show --id=7').out).toBe('AOM-ARG[card]\nAOM-ARG[show]\nAOM-ARG[--id=7]\n');
    expect(run('-c', 'aom comment --note "two words, and more" \'it is $HOME\'').out).toBe(
      'AOM-ARG[comment]\nAOM-ARG[--note]\nAOM-ARG[two words, and more]\nAOM-ARG[it is $HOME]\n',
    );
    expect(run('-l', '-c', 'aom a/b.c:d=e@f%g+h,i-j').code).toBe(0);
  });

  it.each([
    'aom; touch MARKER',
    'aom && touch MARKER',
    'aom || touch MARKER',
    'aom | touch MARKER',
    'aom & touch MARKER',
    `aom $(touch ${join(root, 'unit', 'MARKER')})`,
    `aom \`touch ${join(root, 'unit', 'MARKER')}\``,
    `aom "$(touch ${join(root, 'unit', 'MARKER')})"`,
    `aom "\`touch ${join(root, 'unit', 'MARKER')}\`"`,
    'aom "${HOME}"',
    'aom "a\\"b"',
    'aom "a!b"',
    'aom > MARKER',
    'aom < /etc/passwd',
    'aom (touch MARKER)',
    'aom {a,b}',
    'aom *',
    'aom ?',
    'aom [a]',
    'aom ~',
    'aom a#b',
    'aom a\\ b',
    `aom\ntouch ${join(root, 'unit', 'MARKER')}`,
    `aom x\ntouch ${join(root, 'unit', 'MARKER')}`,
    "aom 'unterminated",
    'aom "unterminated',
    "aom note 'line one\nline two'",
    ' aom',
    'aom-env x',
    '/usr/bin/aom',
    './aom',
    'env aom',
    'cd . && aom',
    'FOO=1 aom',
    `touch ${join(root, 'unit', 'MARKER')}`,
    'ls',
    'bash',
    'sh -c ls',
    '',
  ])('refuses %j', (cmd) => {
    const r = run('-c', cmd);
    expect(r.code, r.out).toBe(126);
    expect(r.out).toContain('only the aom command');
    expect(r.ran).toBe(false);
  });

  it('refuses every other way to start a shell: no command, options, extra arguments, a script it does not trust', () => {
    for (const args of [
      [],
      ['-i'],
      ['-x', '-c', 'aom'],
      ['-c'],
      ['-c', 'aom', 'extra'],
      ['-s'],
      ['--rcfile', '/etc/passwd', '-c', 'aom'],
      [join(root, 'unit', 'evil.sh')],
      [join(trusted, '..', 'evil.sh')],
      ['--', 'evil.sh'],
    ]) {
      const r = run(...args);
      expect(r.code, `${args.join(' ')}: ${r.out}`).toBe(126);
      expect(r.ran).toBe(false);
    }
  });

  it('lets the runner’s own scripts start (a #!/usr/bin/env bash helper) from a trusted folder only', () => {
    const r = run(join(trusted, 'helper.sh'));
    expect(r.out).toContain('TRUSTED-HELPER-RAN');
  });

  it('needs bash to be the shim’s interpreter', () => {
    expect(() => shellShimScript('/bin/sh', [], [], 'bwrap', '/bin/sh', { trustedScripts: [] })).toThrow(
      /bash/,
    );
  });
});

const have = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
const bwrapOk =
  process.platform === 'linux' &&
  have('bwrap') &&
  spawnSync('socat', ['-V']).status === 0 &&
  spawnSync('bwrap', [
    '--unshare-user',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--',
    '/usr/bin/true',
  ]).status === 0;

describe.skipIf(!bwrapOk)(
  'in the real harness box (bubblewrap): a Codex session of a role without a shell',
  () => {
    async function box(aomOnly: boolean) {
      const dir = join(root, aomOnly ? 'box-aom' : 'box-full');
      const cwd = join(dir, 'wt');
      const agent = join(dir, 'agent');
      const dirs = { home: join(agent, 'home'), scratch: join(agent, 'scratch'), tmp: join(agent, 'tmp') };
      for (const d of [cwd, ...Object.values(dirs)]) mkdirSync(d, { recursive: true });
      // the runner's bin folder, read-only in the box, with an `aom` that records what it was asked and a bash helper like aom-env
      const bin = join(dir, 'runner', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'aom'), '#!/bin/sh\nprintf "AOM[%s]\\n" "$@"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'helper'), '#!/usr/bin/env bash\necho HELPER-VIA-ENV-BASH\n', { mode: 0o755 });
      const nodeRoot = realpathSync(join(process.execPath, '..', '..'));
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      const launched = await launchInHarnessSandbox({
        cliHosts: [],
        sandbox: {
          cwd,
          readOnlyCwd: false,
          ...dirs,
          writable: [],
          readonly: [nodeRoot, bin],
          readDirs: [],
          gitDirs: [],
          mayCommit: false,
        },
        replaceShell: true,
        ...(aomOnly ? { aomOnlyShell: true } : {}),
        cmd: {
          bin: '/bin/bash',
          args: [],
          env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dirs.home, ...proxyEnv(3128) },
        },
      });
      // what Codex does: start `/bin/bash -lc "<command>"` by its absolute path, in the box
      const exec = async (command: string, via = '/bin/bash') => {
        // the box's own arguments (up to `--`), then a plain `sh` that starts the shell the way Codex does
        const upToDashes = launched.command.args.slice(0, launched.command.args.indexOf('--') + 1);
        const r = await execa(
          launched.command.bin,
          [
            ...upToDashes,
            aomOnly ? REAL_SHELL_IN_BOX : '/bin/sh',
            '-c',
            `exec ${via} -lc "$1"`,
            'sh',
            command,
          ],
          { cwd, env: launched.command.env, extendEnv: false, reject: false, all: true, timeout: 30_000 },
        );
        if (process.env.DBG) console.log(JSON.stringify({ command, via, all: r.all, code: r.exitCode }));
        return String(r.all ?? '');
      };
      return { exec, cwd, outside, launched };
    }

    it('runs `aom ...` and nothing else, however Codex starts its shell; a role with a shell still has a full one', async () => {
      const b = await box(true);
      try {
        expect(await b.exec('aom card show --id 7')).toContain('AOM[card]\nAOM[show]\nAOM[--id]\nAOM[7]');
        // by the absolute path, by /usr/bin/bash and through env: all the shim
        expect(await b.exec('aom ok', '/usr/bin/bash')).toContain('AOM[ok]');
        for (const via of ['/bin/bash', '/usr/bin/bash', '/usr/bin/env bash']) {
          const out = await b.exec(`touch ${b.cwd}/pwned; echo SHELL-RAN`, via);
          expect(out, via).toContain('only the aom command');
          expect(out, via).not.toContain('SHELL-RAN');
        }
        for (const cmd of [
          `aom; touch ${b.cwd}/pwned`,
          `aom && touch ${b.cwd}/pwned`,
          `aom $(touch ${b.cwd}/pwned)`,
          `aom > ${b.cwd}/pwned`,
          `cat /etc/hostname`,
          `ls ${b.outside}`,
        ])
          expect(await b.exec(cmd), cmd).toContain('only the aom command');
        expect(existsSync(join(b.cwd, 'pwned'))).toBe(false);
        // a runner helper that starts with `#!/usr/bin/env bash` still starts (the shim lets the runner's own bin folder through)
        expect(await b.exec('aom ok')).not.toContain('only the aom command');
      } finally {
        await b.launched.cleanup();
      }
    });

    it('the same box without the flag keeps a full shell (the flag is what restricts it)', async () => {
      const b = await box(false);
      try {
        const out = await b.exec(`touch ${b.cwd}/free; echo SHELL-RAN`);
        expect(out).toContain('SHELL-RAN');
        expect(existsSync(join(b.cwd, 'free'))).toBe(true);
      } finally {
        await b.launched.cleanup();
      }
    });
  },
);
