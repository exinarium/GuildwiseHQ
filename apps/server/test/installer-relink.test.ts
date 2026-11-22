import { afterEach, describe, expect, it } from 'vitest';
import { runSh, type ShSetup, shHome } from './helpers/installer-sh.ts';

/**
 * UAT 1.10.0 finding 5, installer side: a re-run with a link from the same account re-links the same workstation; a link
 * that cannot (another account, an unlinked workstation) says what a NEW workstation means and asks first, and --yes
 * never answers that question.
 */
let setup: ShSetup;
afterEach(() => setup?.cleanup());

// a runner whose re-link is refused unless --new-workstation is given
const REFUSING = [
  'is_paired() { return 0; }',
  'paired_server() { echo https://hq.example; }',
  'runner() { echo "runner $*" >> "$STUB_LOG"; case "$*" in *--new-workstation*) echo "Paired as workstation n."; return 0 ;; *) echo "relink_refused (other_account): This link belongs to a different account than the workstation \\"Desk\\"."; return 4 ;; esac; }',
  'SERVER_URL=https://hq.example; PAIRING_CODE=ABCD-EFGH; DEFAULT_NAME=Desk',
].join('\n');

describe('re-running the installer on a paired computer', () => {
  it('a link from the same account re-links the same workstation', () => {
    setup = shHome();
    const r = runSh(
      setup,
      [
        'is_paired() { return 0; }',
        'paired_server() { echo https://hq.example; }',
        'runner() { echo "runner $*" >> "$STUB_LOG"; echo "Re-linked the same workstation w: its agents, DevOps engineer and switches stay."; }',
        'SERVER_URL=https://hq.example; PAIRING_CODE=ABCD-EFGH; DEFAULT_NAME=Desk',
        'pair_runner',
      ].join('\n'),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Re-linked the same workstation "Desk"');
    expect(r.log).not.toContain('--new-workstation');
  });

  it('--yes does not answer the new-workstation question: it stops and changes nothing', () => {
    setup = shHome();
    const r = runSh(setup, `parse_flags "$@"; ${REFUSING}\nask_typed_yes() { return 1; }\npair_runner`, {
      args: ['--yes'],
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('different account');
    expect(`${r.stdout}${r.stderr}`).toContain('its DevOps engineer is retired');
    expect(`${r.stdout}${r.stderr}`).toContain('nothing was changed');
    expect(r.log.match(/runner pair/g)).toHaveLength(1);
    expect(r.log).not.toContain('--new-workstation');
  });

  it('a yes typed at the keyboard, or --new-workstation, pairs as a new workstation', () => {
    setup = shHome();
    const typed = runSh(setup, `parse_flags "$@"; ${REFUSING}\nask_typed_yes() { return 0; }\npair_runner`, {
      args: ['--yes'],
    });
    expect(typed.status, typed.stderr).toBe(0);
    expect(typed.stdout).toContain('Paired as a new workstation "Desk"');
    setup.cleanup();
    setup = shHome();
    const flag = runSh(setup, `parse_flags "$@"; ${REFUSING}\nask_typed_yes() { return 1; }\npair_runner`, {
      args: ['--yes', '--new-workstation'],
    });
    expect(flag.status, flag.stderr).toBe(0);
    expect(flag.log.split('\n').filter((l) => l.startsWith('runner pair'))).toHaveLength(1);
    expect(flag.log).toContain('--new-workstation');
  });
});
