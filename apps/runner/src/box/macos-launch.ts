import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EgressProxy, type EgressRoute, startEgressProxy } from '../sandbox/egress-proxy.ts';
import { proxyEnv } from '../sandbox/harness-sandbox.ts';
import { type MacProfileInput, macDevopsProfile } from './macos-profile.ts';

/**
 * quiet-approvals phase B, S5: the DevOps boxes on macOS. The inner and the outer box are alternative Seatbelt profiles
 * (`(deny default)`, see macos-profile.ts) applied with `sandbox-exec`; the box's only way out is the egress proxy, which
 * listens on a runner-side loopback port (Seatbelt cannot bind a socket into the box) and forwards to the proxy's Unix
 * socket. The model goes through the proxy's route as on Linux.
 *
 * Not run on a Mac here (no Mac on the DevBox): the command and the profile are unit-tested; Mac QA is required.
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Why the macOS box cannot start, or null. `exists` is a test hook. */
export function macBoxMissing(exists: (p: string) => boolean = existsSync): string | null {
  return exists(SANDBOX_EXEC) ? null : 'sandbox-exec is missing (macOS only)';
}

/** `sandbox-exec -f <profile> <bin> <args>`, with the proxy variables. */
export function macBoxCommand(
  profileFile: string,
  cmd: { bin: string; args: string[]; env: Record<string, string> },
  port: number,
): { bin: string; args: string[]; env: Record<string, string> } {
  return {
    bin: SANDBOX_EXEC,
    args: ['-f', profileFile, cmd.bin, ...cmd.args],
    env: { ...cmd.env, ...proxyEnv(port) },
  };
}

/** A runner-side loopback port that forwards to a Unix socket (the egress proxy). */
export async function startTcpBridge(socketPath: string): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((c) => {
    const u = connect(socketPath);
    c.pipe(u).pipe(c);
    u.on('error', () => c.destroy());
    c.on('error', () => u.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface MacLaunch {
  command: { bin: string; args: string[]; env: Record<string, string> };
  port: number;
  cleanup(): Promise<void>;
}

/** Starts the proxy and the bridge, writes the profile and wraps the command. */
export async function launchMacBox(o: {
  profile: Omit<MacProfileInput, 'proxyPort'>;
  routes: EgressRoute[];
  allowedHosts: string[];
  cmd: { bin: string; args: string[]; env: Record<string, string> };
}): Promise<MacLaunch> {
  const dir = mkdtempSync(join(tmpdir(), 'aom-mac-'));
  chmodSync(dir, 0o700);
  const proxy: EgressProxy = await startEgressProxy({
    socketPath: join(dir, 'p.sock'),
    allowedHosts: o.allowedHosts,
    routes: o.routes,
  });
  const bridge = await startTcpBridge(join(dir, 'p.sock'));
  const file = join(dir, `devops-${o.profile.level}.sb`);
  writeFileSync(file, macDevopsProfile({ ...o.profile, proxyPort: bridge.port }), { mode: 0o600 });
  return {
    command: macBoxCommand(file, o.cmd, bridge.port),
    port: bridge.port,
    cleanup: async () => {
      await bridge.close().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
