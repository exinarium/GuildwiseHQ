import { afterEach, describe, expect, it } from 'vitest';
import { runSh, type ShSetup, shHome } from './helpers/installer-sh.ts';

/**
 * O6 (release-readiness audit): `install.sh --help` and `-h` print the options and exit 0, before anything is checked,
 * asked or installed; an unknown option still fails with the same list.
 */
let setup: ShSetup;
afterEach(() => setup?.cleanup());

describe('installer --help', () => {
  it.each([
    ['--help', 'linux'],
    ['-h', 'linux'],
    ['--help', 'macos'],
    ['-h', 'macos'],
  ] as const)('%s on %s prints the options and exits 0', (flag, os) => {
    setup = shHome();
    const r = runSh(setup, 'main "$@"', { args: [flag], os });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Usage: install.sh [options]');
    expect(r.stdout).toContain('  --instance <name>\n');
    expect(r.stdout).toContain('  --yes\n');
    expect(r.stdout).toContain('  --devops-orgs none|<name-or-id,...>\n');
    expect(`${r.stdout}${r.stderr}`).not.toContain('Unknown option');
    // nothing ran: no step, no stub program called
    expect(r.log).toBe('');
  });

  it('parse_flags alone: --help exits 0 even after other options', () => {
    setup = shHome();
    const r = runSh(setup, 'parse_flags "$@"; echo after', { args: ['--yes', '--help'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('--instance <name>');
    expect(r.stdout).not.toContain('after');
  });

  it('an unknown option still fails and names the same options', () => {
    setup = shHome();
    const r = runSh(setup, 'parse_flags "$@"', { args: ['--nope'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown option: --nope');
    expect(r.stderr).toContain('Options: --help, -h, --yes, --runner-user dedicated|current,');
    expect(r.stderr).toContain('--new-workstation, --choose-folders.');
  });
});
