import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A throwaway sshd in a Docker container acting as the customer's VPS (fixtures/sshd/Dockerfile): a real `ssh`, a real
 * `authorized_keys`, two users with a password (root / deploy). Bound to 127.0.0.1 on a random port; removed afterwards.
 * Tests that need it skip themselves when Docker is not usable (`AOM_SKIP_SSHD=1` skips too).
 */
export const SSHD_IMAGE = 'aom-test-sshd:1';
export const ROOT_PASSWORD = 'rootpw-for-tests';
export const DEPLOY_PASSWORD = 'deploypw-for-tests';

export function sshdAvailable(): boolean {
  if (process.env.AOM_SKIP_SSHD === '1') return false;
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0;
}

export interface Sshd {
  name: string;
  port: number;
  /** Runs a shell command in the container as root; returns stdout. */
  sh(cmd: string): string;
  /** SHA256 fingerprint of the server's ed25519 host key. */
  hostFingerprint(): string;
  stop(): void;
}

export function startSshd(): Sshd {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sshd');
  execFileSync('docker', ['build', '-q', '-t', SSHD_IMAGE, dir], { stdio: 'pipe' });
  const name = `aom-test-sshd-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', SSHD_IMAGE], {
    stdio: 'pipe',
  });
  const mapped =
    execFileSync('docker', ['port', name, '22'], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const sh = (cmd: string) =>
    execFileSync('docker', ['exec', name, 'sh', '-c', cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // wait until sshd answers
  for (let i = 0; i < 50; i++) {
    const r = spawnSync('ssh-keyscan', ['-T', '1', '-p', String(port), '-t', 'ed25519', '127.0.0.1'], {
      encoding: 'utf8',
    });
    if (r.stdout.includes('ssh-ed25519')) break;
    spawnSync('sleep', ['0.2']);
  }
  return {
    name,
    port,
    sh,
    hostFingerprint: () =>
      /(SHA256:\S+)/.exec(sh('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'))?.[1] as string,
    stop: () => {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    },
  };
}
