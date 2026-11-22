import { afterEach, describe, expect, it } from 'vitest';
import { runSh, type ShSetup, shHome } from './helpers/installer-sh.ts';

/**
 * easy-runner-setup: the installer passes the one screen's flags to `guildwise-runner setup` (which shows the screen and
 * validates names against the server's offers), signs the dedicated user in during the same run, and after connecting
 * opens the plain approvals URL and pairs this browser with the code typed on the terminal. Nothing runs as root and no
 * secret appears on any command line: `runner`, `as_runner` and the browser opener only log.
 */
let setup: ShSetup;
afterEach(() => setup?.cleanup());

const STUB_SETUP = [
  'setup_supported() { return 0; }',
  'detect_docker() { DOCKER_FOUND=none; DOCKER_SOCKET=""; }',
  'apply_root_choices() { :; }',
  'stop_dedicated_service() { :; }',
  'as_runner() { echo "as_runner $*" >> "$STUB_LOG"; }',
  'runner() { echo "runner $*" >> "$STUB_LOG"; }',
  'interactive() { return 1; }',
  'RUNNER_MODE=dedicated; RUNNER_AS=guildwise-runner; RUNNER_NAME=guildwise-runner; RUNNER_HOME=/home/guildwise-runner',
].join('\n');

describe('installer flags for the one screen', () => {
  it('parses, validates and passes every new flag to guildwise-runner setup', () => {
    setup = shHome();
    const r = runSh(setup, `parse_flags "$@"; ${STUB_SETUP}\nset_local_permissions >/dev/null`, {
      args: [
        '--devops-orgs',
        'Acme Law,Smith & Co',
        '--devops-requests',
        'auto',
        '--allow-scripts',
        'https://github.com/acme/website',
        '--no-ytdlp',
        '--wsl-distro-name',
        'Guildwise',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    const line = r.log.split('\n').find((l) => l.startsWith('runner setup')) ?? '';
    expect(line).toContain('--devops-orgs Acme Law,Smith & Co');
    expect(line).toContain('--devops-requests auto');
    expect(line).toContain('--allow-scripts https://github.com/acme/website');
    expect(line).toContain('--no-ytdlp');
    expect(line).toContain('--wsl-distro-name Guildwise');
    expect(line).toContain('--yes');
  });

  it('reads the GUILDWISE_* variables (Windows forwards them) and --with-ytdlp', () => {
    setup = shHome();
    const r = runSh(setup, `parse_flags "$@"; ${STUB_SETUP}\nset_local_permissions >/dev/null`, {
      args: ['--with-ytdlp'],
      env: { GUILDWISE_DEVOPS_REQUESTS: 'ask', GUILDWISE_WSL_DISTRO_NAME: 'Ubuntu-24.04' },
    });
    expect(r.status, r.stderr).toBe(0);
    const line = r.log.split('\n').find((l) => l.startsWith('runner setup')) ?? '';
    expect(line).toContain('--with-ytdlp');
    expect(line).toContain('--devops-requests ask');
    expect(line).toContain('--wsl-distro-name Ubuntu-24.04');
  });

  it.each([
    [['--devops-requests', 'maybe'], '--devops-requests is ask or auto'],
    [['--devops-orgs', 'owned'], '--devops-orgs is none or organization names'],
    [['--wsl-distro-name', 'bad;name'], '--wsl-distro-name takes'],
    [['--allow-scripts', 'a b'], '--allow-scripts is repository URLs'],
  ])('refuses %j', (args, msg) => {
    setup = shHome();
    const r = runSh(setup, 'parse_flags "$@"', { args });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(msg);
  });

  it('organisation names are accepted (setup checks them against the offers)', () => {
    setup = shHome();
    const r = runSh(setup, 'parse_flags "$@"; echo "orgs=$OPT_DEVOPS_ORGS"', {
      args: ['--devops-orgs=Acme Law'],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('orgs=Acme Law');
  });
});

describe('approvals on this computer after connecting [B2]', () => {
  const STUB_PAGE = [
    'as_runner() { if [ "$1" = cat ]; then echo 47613; else echo "as_runner $*" >> "$STUB_LOG"; fi; }',
    'runner() { echo "runner $*" >> "$STUB_LOG"; }',
    'xdg-open() { echo "xdg-open $*" >> "$STUB_LOG"; }',
    'RUNNER_HOME=/home/guildwise-runner',
    'pair_browser() { echo "runner approvals pair $1" >> "$STUB_LOG"; }',
  ].join('\n');

  it('interactive: opens the plain URL (no # and no secret) and pairs with the typed code', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `${STUB_PAGE}\nOPT_YES=0; interactive() { return 0; }\nask_text() { echo k7m2-q9; }\nopen_approvals_page; echo "url=$APPROVALS_URL"`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain('xdg-open http://127.0.0.1:47613/');
    expect(r.log).not.toMatch(/xdg-open \S*#/);
    expect(r.log).toContain('runner approvals pair K7M2-Q9');
    expect(r.stdout).toContain('url=http://127.0.0.1:47613/');
  });

  it('a code that is not one is refused before anything runs; Enter skips', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `${STUB_PAGE}\nOPT_YES=0; interactive() { return 0; }\nn=0; ask_text() { n=$((n+1)); [ $n = 1 ] && echo '; rm -rf ~' || echo ''; }\nopen_approvals_page`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).not.toContain('approvals pair');
    expect(r.stdout).toContain('That is not a pairing code');
  });

  it('--yes opens nothing and prints the pairing steps', () => {
    setup = shHome();
    const r = runSh(setup, `${STUB_PAGE}\nOPT_YES=1\nopen_approvals_page`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).not.toContain('xdg-open');
    expect(r.log).not.toContain('approvals pair');
    expect(r.stdout).toContain('open http://127.0.0.1:47613/ in a browser on this computer');
  });
});
