import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSh, type ShSetup, shHome } from './helpers/installer-sh.ts';

/**
 * Named runner instances (`--instance <name>`): two runners on one machine, one paired with UAT and one with production.
 * The installer gives each its own dedicated user `guildwise-runner-<name>`, service and sudoers files, and passes
 * `--instance <name>` to every guildwise-admin call. Without the flag nothing changes. Nothing here runs as root:
 * `as_root` is replaced by a logger and `user_home` by a fixed answer.
 */
let setup: ShSetup;
afterEach(() => setup?.cleanup());

const STUB_ROOT =
  'as_root() { echo "as_root $*" >> "$STUB_LOG"; }; record_service_mode() { :; }; install_admin_tools() { :; }';
const STATE =
  'echo "user=$DEDICATED_USER service=$DEDICATED_SERVICE mode=$OPT_RUNNER_USER hint=$ADMIN_HINT dir=$ADMIN_DIR node=$BUNDLED_NODE_BIN"';

describe('--instance: flags', () => {
  it('names the instance user and service and forces the dedicated user', () => {
    setup = shHome();
    const r = runSh(setup, `parse_flags "$@"; ${STATE}`, { args: ['--instance', 'uat'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(
      'user=guildwise-runner-uat service=guildwise-runner-uat mode=dedicated hint=/usr/local/lib/guildwise/uat/guildwise-admin --instance uat dir=/usr/local/lib/guildwise/uat node=/usr/local/lib/guildwise/uat/node/bin',
    );
    const env = runSh(setup, `parse_flags "$@"; ${STATE}`, { env: { GUILDWISE_INSTANCE: 'prod' } });
    expect(env.stdout).toContain('user=guildwise-runner-prod ');
    const eq = runSh(setup, `parse_flags "$@"; ${STATE}`, { args: ['--instance=prod'] });
    expect(eq.stdout).toContain('service=guildwise-runner-prod ');
  });

  it('without --instance: the single guildwise-runner, as before', () => {
    setup = shHome();
    const r = runSh(setup, `parse_flags "$@"; ${STATE}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(
      'user=guildwise-runner service=guildwise-runner mode= hint=/usr/local/lib/guildwise/guildwise-admin dir=/usr/local/lib/guildwise node=/usr/local/lib/guildwise/node/bin',
    );
  });

  it.each(['UAT', 'u_at', '-x', 'x-', 'a/b', 'abcdefghijklmnop'])('refuses the name %j', (name) => {
    setup = shHome();
    const r = runSh(setup, 'parse_flags "$@"', { args: [`--instance=${name}`] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--instance is a short name of lowercase letters');
  });

  it.each(['node', 'guildwise-admin', 'deploy-compose', 'docker'])('refuses the reserved name %j', (name) => {
    setup = shHome();
    const r = runSh(setup, 'parse_flags "$@"', { args: ['--instance', name] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is a reserved name');
  });

  it('refuses --instance with --runner-user current', () => {
    setup = shHome();
    const r = runSh(setup, 'parse_flags "$@"', { args: ['--instance', 'uat', '--runner-user', 'current'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot go with --runner-user current');
  });
});

describe('--instance: Linux', () => {
  it('creates guildwise-runner-uat and places the runner in its own home', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; choose_runner_user >/dev/null; ${STUB_ROOT}; user_home() { echo "/home/$1"; }; setup_runner_user >/dev/null; echo "as=\${RUNNER_AS} root=\${RUNNER_ROOT} data=\${DATA_DIR}"`,
      { args: ['--instance', 'uat'], params: { requireSignedRunners: false } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'as_root /usr/local/lib/guildwise/uat/guildwise-admin --instance uat user create\n',
    );
    expect(r.stdout.trim().split('\n').pop()).toBe(
      'as=guildwise-runner-uat root=/home/guildwise-runner-uat/.local/share/guildwise/runner data=/home/guildwise-runner-uat/.aom-runner',
    );
  });

  it('installs and restarts the guildwise-runner-uat system service through guildwise-admin --instance uat', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUB_ROOT}; RUNNER_ROOT=/home/guildwise-runner-uat/r; RUNNER_NAME=guildwise-runner-uat; install_dedicated_service; stop_dedicated_service`,
      { args: ['--instance', 'uat'] },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'as_root /usr/local/lib/guildwise/uat/guildwise-admin --instance uat service install --runner-root /home/guildwise-runner-uat/r --start\n',
    );
    expect(r.log).toContain('as_root systemctl restart guildwise-runner-uat.service\n');
    expect(r.log).toContain('as_root systemctl stop guildwise-runner-uat.service\n');
    expect(r.log).not.toMatch(/guildwise-runner\.service/);
    expect(r.stdout).toContain('system service "guildwise-runner-uat"');
  });

  it('without --instance the service calls are exactly as before', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUB_ROOT}; RUNNER_ROOT=/home/guildwise-runner/r; RUNNER_NAME=guildwise-runner; install_dedicated_service`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'as_root /usr/local/lib/guildwise/guildwise-admin service install --runner-root /home/guildwise-runner/r --start\n',
    );
    expect(r.log).toContain('as_root systemctl restart guildwise-runner.service\n');
  });

  it("the legacy clean-up and the rootless Docker go to the instance's own tools", () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUB_ROOT}; RUNNER_MODE=dedicated; RUNNER_NAME=guildwise-runner-prod; RUNNER_HOME=/home/guildwise-runner-prod
policy_value() { case "$1" in docker) echo rootless ;; *) return 1 ;; esac; }
install_docker_binaries() { echo "install_docker_binaries $ADMIN_DIR/docker" >> "$STUB_LOG"; }
setup_runner_docker() { :; }
apply_root_choices`,
      { args: ['--instance', 'prod', '--docker', 'rootless'] },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'as_root /usr/local/lib/guildwise/prod/guildwise-admin --instance prod cleanup-legacy --user guildwise-runner-prod\n',
    );
    expect(r.log).toContain('install_docker_binaries /usr/local/lib/guildwise/prod/docker\n');
    expect(r.log).toContain(
      'as_root /usr/local/lib/guildwise/prod/guildwise-admin --instance prod docker rootless --user guildwise-runner-prod\n',
    );
    expect(r.log).not.toMatch(/\/usr\/local\/lib\/guildwise\/guildwise-admin/);
    expect(r.log).not.toMatch(/sudoers|approve-app|sudo on/);
  });

  it('UAT and prod may share one rootless daemon, each with the same typed acceptance (owner 2026-11-21)', () => {
    for (const inst of ['uat', 'prod']) {
      setup = shHome();
      const r = runSh(
        setup,
        `parse_flags "$@"; ${STUB_ROOT}; RUNNER_MODE=dedicated; RUNNER_NAME=guildwise-runner-${inst}; RUNNER_HOME=/home/guildwise-runner-${inst}
policy_value() { case "$1" in docker) echo shared ;; dockerHost) echo /run/docker-svc/docker.sock ;; esac; }
install_docker_binaries() { echo "install_docker_binaries $ADMIN_DIR/docker" >> "$STUB_LOG"; }
apply_root_choices`,
        {
          args: [
            '--instance',
            inst,
            '--docker',
            'shared',
            '--docker-socket',
            '/run/docker-svc/docker.sock',
            '--accept-shared-daemon',
          ],
        },
      );
      expect(r.status, r.stderr).toBe(0);
      // the root-owned docker CLI guildwise-admin asks the daemon with comes from the signed release first
      expect(r.log).toContain(`install_docker_binaries /usr/local/lib/guildwise/${inst}/docker`);
      expect(r.log).toContain(
        `as_root /usr/local/lib/guildwise/${inst}/guildwise-admin --instance ${inst} docker shared --docker-socket /run/docker-svc/docker.sock --accept-shared-daemon --user guildwise-runner-${inst}\n`,
      );
    }
  });
});

describe('--instance: macOS', () => {
  it('uses the LaunchDaemon com.guildwisehq.runner.<name>', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUB_ROOT}; RUNNER_ROOT=/var/guildwise-runner-uat/r; RUNNER_NAME=guildwise-runner-uat; install_dedicated_service; stop_dedicated_service`,
      { os: 'macos', args: ['--instance', 'uat'] },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'as_root /usr/local/lib/guildwise/uat/guildwise-admin --instance uat service install --runner-root /var/guildwise-runner-uat/r --start\n',
    );
    expect(r.log).toContain('as_root launchctl kickstart -k system/com.guildwisehq.runner.uat\n');
    expect(r.log).toContain('as_root launchctl bootout system/com.guildwisehq.runner.uat\n');
    expect(r.stdout).toContain('LaunchDaemon com.guildwisehq.runner.uat');
  });

  it('without --instance the label is com.guildwisehq.runner, as before', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUB_ROOT}; RUNNER_ROOT=/var/guildwise-runner/r; RUNNER_NAME=guildwise-runner; install_dedicated_service`,
      { os: 'macos' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain('as_root launchctl kickstart -k system/com.guildwisehq.runner\n');
  });
});

describe('--instance: its own root-owned tools folder', () => {
  const ADMIN_SRC = "#!/usr/local/lib/guildwise/node/bin/node\n'use strict';\n// guildwise-admin body\n";

  /** A staged release with the two tools and a Node runtime the stub curl serves; as_root only logs. */
  function tools(args: string[]) {
    setup = shHome();
    const stage = join(setup.home, 'stage');
    mkdirSync(join(stage, 'pkg/aom-runner/admin'), { recursive: true });
    writeFileSync(join(stage, 'pkg/aom-runner/admin/guildwise-admin.cjs'), ADMIN_SRC);
    const node = Buffer.from('fake node runtime');
    writeFileSync(join(setup.www, 'node.tar.xz'), node);
    const sha = createHash('sha256').update(node).digest('hex');
    const r = runSh(
      setup,
      `parse_flags "$@"; as_root() { echo "as_root $*" >> "$STUB_LOG"; }
STAGE_SIGNED=1; STAGE_DIR=${stage}; STAGE_PKG=${stage}/pkg; STAGE_MANIFEST=${stage}/manifest.json
node_platform() { echo linux-x64; }
manifest_get() { echo "https://hq.example.com/node.tar.xz ${sha}"; }
install_admin_tools`,
      { args },
    );
    return { r, stage };
  }

  it('installs into /usr/local/lib/guildwise/<name>/ only, its tools running under its own Node', () => {
    const { r, stage } = tools(['--instance', 'uat']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      `as_root install -o 0 -g 0 -m 0755 ${stage}/guildwise-admin.instance /usr/local/lib/guildwise/uat/guildwise-admin\n`,
    );
    expect(r.log).not.toContain('deploy-compose');
    expect(r.log).toContain(
      'as_root mv /usr/local/lib/guildwise/uat/node.new /usr/local/lib/guildwise/uat/node\n',
    );
    // the parent stays root-owned 0755; nothing of the top-level runner's (or another instance's) tools is touched
    expect(r.log).toContain('as_root chmod 755 /usr/local/lib/guildwise\n');
    for (const line of r.log.split('\n').filter((l) => l.startsWith('as_root ')))
      expect(line, line).not.toMatch(/\/usr\/local\/lib\/guildwise\/(guildwise-admin|deploy-compose|node)\b/);
    // only the interpreter line differs from the verified file
    expect(readFileSync(join(stage, 'guildwise-admin.instance'), 'utf8')).toBe(
      ADMIN_SRC.replace('/usr/local/lib/guildwise/node/', '/usr/local/lib/guildwise/uat/node/'),
    );
  });

  it("two instances never write into each other's folder", () => {
    const uat = tools(['--instance', 'uat']).r.log;
    const prod = tools(['--instance', 'prod']).r.log;
    expect(uat).not.toContain('/usr/local/lib/guildwise/prod');
    expect(prod).not.toContain('/usr/local/lib/guildwise/uat');
    expect(prod).toContain('/usr/local/lib/guildwise/prod/guildwise-admin\n');
  });

  it('without --instance: the verified files go to the top-level folder unchanged, as before', () => {
    const { r, stage } = tools([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      `as_root install -o 0 -g 0 -m 0755 ${stage}/pkg/aom-runner/admin/guildwise-admin.cjs /usr/local/lib/guildwise/guildwise-admin\n`,
    );
    expect(r.log).not.toContain('chmod 755 /usr/local/lib\n');
    expect(r.log).not.toContain('.instance');
  });
});
