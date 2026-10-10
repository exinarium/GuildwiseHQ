import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBash } from '../src/installer/render.ts';

const base = {
  serverUrl: 'https://hq.example.com',
  pairingCode: 'ABCD-EFGH',
  sessionToken: 'tok_0123456789abcdefghij',
  workstationName: 'Desk',
  release: null,
  generatedAt: new Date('2026-10-10T08:00:00Z'),
  expiresAt: new Date('2026-10-10T08:30:00Z'),
};

/** Runs only `add_repo_folders` of the rendered installer: everything before `main()` is function definitions. */
function runFolders(expertMode: boolean, env: Record<string, string> = {}, args = '') {
  const home = mkdtempSync(join(tmpdir(), 'aom-inst-'));
  try {
    const script = renderBash('linux', { ...base, expertMode });
    const body = script.slice(0, script.lastIndexOf('main "$@"'));
    const file = join(home, 'run.sh');
    writeFileSync(
      file,
      `${body}
# stubs: nothing is installed, asked or reported
runner() { echo "runner $*" >> "${home}/calls"; }
report() { :; }
ask_text() { echo "ASKED" >> "${home}/calls"; printf '%s' "\${HOME}/chosen"; }
ask_yn() { return 0; }
case " ${args} " in *" --choose-folders "*) CHOOSE_FOLDERS=1 ;; esac
add_repo_folders >/dev/null 2>&1
`,
    );
    const r = spawnSync('bash', [file], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
    const calls = spawnSync('cat', [join(home, 'calls')], { encoding: 'utf8' }).stdout;
    return { home, calls, status: r.status, stderr: r.stderr };
  } finally {
    // the caller only needs the text; the folder is removed after it is read
  }
}

describe('installer: code folder', () => {
  it('records the mode in the script header', () => {
    expect(renderBash('linux', { ...base, expertMode: false })).toContain('\nEXPERT_MODE=0\n');
    expect(renderBash('macos', { ...base, expertMode: true })).toContain('\nEXPERT_MODE=1\n');
    expect(renderBash('linux', base)).toContain('\nEXPERT_MODE=0\n');
  });

  it('simple mode does not ask and uses ~/src', () => {
    const r = runFolders(false);
    expect(r.calls).not.toContain('ASKED');
    expect(r.calls).toContain(`runner repos add ${r.home}/src`);
    rmSync(r.home, { recursive: true, force: true });
  });

  it('expert mode asks where the code lives', () => {
    const r = runFolders(true);
    expect(r.calls).toContain('ASKED');
    expect(r.calls).toContain(`runner repos add ${r.home}/chosen`);
    rmSync(r.home, { recursive: true, force: true });
  });

  it('the --choose-folders flag and GUILDWISE_CHOOSE_FOLDERS bring the question back in simple mode', () => {
    const a = runFolders(false, {}, '--choose-folders');
    expect(a.calls).toContain('ASKED');
    rmSync(a.home, { recursive: true, force: true });
    const b = runFolders(false, { GUILDWISE_CHOOSE_FOLDERS: '1' });
    expect(b.calls).toContain('ASKED');
    rmSync(b.home, { recursive: true, force: true });
  });

  it('GUILDWISE_REPO_DIRS still wins in every mode', () => {
    const r = runFolders(false, { GUILDWISE_REPO_DIRS: '/tmp/aom-fixed-dir' });
    expect(r.calls).not.toContain('ASKED');
    expect(r.calls).toContain('runner repos add /tmp/aom-fixed-dir');
    rmSync(r.home, { recursive: true, force: true });
  });
});
