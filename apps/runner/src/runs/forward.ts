import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join, posix } from 'node:path';
import { RESERVED_RUN_PORTS } from '@aom/shared';

/**
 * Per-port forwarders for a tester in a local environment (docs/design/run-and-integration-tests.md D6). The tester's
 * shell runs in a network namespace of its own, so `localhost:<port>` there is an empty loopback. The runner listens on
 * one Unix socket per environment port inside the agent's private tmp dir and connects each connection to
 * `127.0.0.1:<that port>` on the workstation, and nothing else: the sandbox can reach exactly the environment's ports.
 * `aom-env` (bin/aom-env) starts a `socat` per socket inside the command's namespace, so the same port number works there.
 */

export interface ForwardTarget {
  port: number;
  /** The environment's name for it (`web`, `api`): shown to the tester. */
  name?: string;
}

export interface EnvForwards {
  /** `<port>=<socket>` pairs, as `AOM_ENV_FORWARDS` carries them. */
  spec: string;
  sockets: Array<{ port: number; socket: string }>;
  /** Stops listening and removes the sockets. Idempotent. */
  close(): void;
}

/** The directory of the sockets inside the agent's tmp dir. */
export const forwardDir = (agentTmp: string): string => join(agentTmp, 'env');

/**
 * Starts a forwarder per port. `allowed` returns the ports the environment currently owns, asked again on every
 * connection: a port that is no longer part of the environment (it stopped) is refused.
 */
export async function startForwards(
  agentTmp: string,
  ports: readonly number[],
  allowed: () => ReadonlySet<number>,
): Promise<EnvForwards> {
  const dir = forwardDir(agentTmp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const servers: net.Server[] = [];
  const sockets: Array<{ port: number; socket: string }> = [];
  const close = () => {
    for (const s of servers.splice(0)) s.close();
    for (const { socket } of sockets) rmSync(socket, { force: true });
  };
  try {
    for (const port of new Set(ports)) {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || RESERVED_RUN_PORTS.includes(port)) continue;
      const socket = join(dir, `${port}.sock`);
      rmSync(socket, { force: true });
      const server = net.createServer((client) => {
        if (!allowed().has(port)) {
          client.destroy();
          return;
        }
        const upstream = net.connect({ host: '127.0.0.1', port });
        const drop = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on('error', drop);
        upstream.on('error', drop);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      });
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(socket, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      try {
        chmodSync(socket, 0o600);
      } catch {
        /* the directory is already private */
      }
      servers.push(server);
      sockets.push({ port, socket });
    }
  } catch (err) {
    close();
    throw err;
  }
  return { spec: sockets.map((s) => `${s.port}=${s.socket}`).join(','), sockets, close };
}

/** One declared test service a handoff check reaches through its own Unix socket (GWP-248). */
export interface ServiceForward {
  name: string;
  host: string;
  port: number;
  /** The socket on the workstation. */
  socket: string;
}

export interface ServiceForwards {
  /** `host:port=<socket inside the sandbox>` pairs, comma separated, for `CHECK_BRIDGE_SCRIPT`. */
  spec: string;
  forwards: ServiceForward[];
  /** The `host:port` pairs whose upstream connect failed during the run (once each, in order). */
  failures(): string[];
  /** Stops listening and removes the sockets. Idempotent. */
  close(): void;
}

/** The directory of a check's service sockets inside its private tmp dir. */
export const serviceForwardDir = (checkTmp: string): string => join(checkTmp, 'svc');

const serviceDomain = (host: string, port: number): string =>
  `${host.includes(':') ? `[${host}]` : host}:${port}`;

/**
 * Handoff checks (GWP-248, docs/RUNNER.md "Handoff checks"): one Unix socket per declared, allowed local test service
 * under `<checkTmp>/svc/<port>.sock`, connected to that service's loopback host:port only. The check runs in a network
 * namespace of its own; `CHECK_BRIDGE_SCRIPT` listens on the same port inside it and connects to the socket, so the
 * project's default URL works unchanged. A failed upstream connect is recorded (`failures()`): the check result names it
 * as an environment problem. `innerTmp` is where `checkTmp` is seen inside the sandbox (it is bound over `/tmp`).
 */
export async function startServiceForwards(
  checkTmp: string,
  services: ReadonlyArray<{ name: string; host: string; port: number }>,
  innerTmp = '/tmp',
): Promise<ServiceForwards> {
  const dir = serviceForwardDir(checkTmp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const servers: net.Server[] = [];
  const forwards: ServiceForward[] = [];
  const failed: string[] = [];
  const close = () => {
    for (const s of servers.splice(0)) s.close();
    for (const { socket } of forwards) rmSync(socket, { force: true });
  };
  const seen = new Set<number>();
  try {
    for (const s of services) {
      if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || RESERVED_RUN_PORTS.includes(s.port))
        continue;
      if (seen.has(s.port)) continue; // one listener per port inside the namespace
      seen.add(s.port);
      const host = s.host === 'localhost' ? '127.0.0.1' : s.host;
      if (host !== '127.0.0.1' && host !== '::1') continue; // the decision already refused anything else
      const domain = serviceDomain(s.host, s.port);
      const socket = join(dir, `${s.port}.sock`);
      rmSync(socket, { force: true });
      const server = net.createServer((client) => {
        const upstream = net.connect({ host, port: s.port });
        const drop = () => {
          client.destroy();
          upstream.destroy();
        };
        let connected = false;
        upstream.once('connect', () => {
          connected = true;
        });
        client.on('error', drop);
        upstream.on('error', () => {
          if (!connected && !failed.includes(domain)) failed.push(domain);
          drop();
        });
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      });
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(socket, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      try {
        chmodSync(socket, 0o600);
      } catch {
        /* the directory is already private */
      }
      servers.push(server);
      forwards.push({ name: s.name, host: s.host, port: s.port, socket });
    }
  } catch (err) {
    close();
    throw err;
  }
  const inner = posix.join(innerTmp, 'svc');
  return {
    spec: forwards
      .map((f) => `${serviceDomain(f.host, f.port)}=${posix.join(inner, `${f.port}.sock`)}`)
      .join(','),
    forwards,
    failures: () => [...failed],
    close,
  };
}
