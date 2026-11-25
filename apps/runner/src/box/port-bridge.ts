import { LABEL } from './docker-proxy.ts';

/**
 * quiet-approvals phase B, S6: the runner-owned port bridge. Docker publishes no ports for a container that is only on an
 * `internal: true` network, so a pinned-digest bridge container sits on that internal network and a default one and
 * forwards `127.0.0.1:<port>` to the service: only the recipe's listed ports, inbound only, no proxy or other listener, and
 * `net.ipv4.ip_forward` left at its default 0.
 *
 * Day-1 spike (DevBox, the shared rootless daemon, node:22.23-bookworm-slim as the bridge): the host reaches the service
 * through the bridge; from the service, the internet directly (ENETUNREACH), by name (no DNS), and every bridge port (it
 * loops back to the service only) fail; the bridge has ip_forward 0 and the service has no route through it. The runner's
 * own rootless daemon and Docker Desktop were not available here: they are for QA.
 */

export interface BridgePort {
  hostPort: number;
  service: string;
  servicePort: number;
}

const DIGEST_IMAGE = /^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/;

/** The create body of the bridge (sent to the real daemon by the runner itself, never by a box). */
export function bridgeContainer(o: {
  instance: string;
  name: string;
  image: string;
  internalNetwork: string;
  ports: BridgePort[];
}): Record<string, unknown> {
  if (!DIGEST_IMAGE.test(o.image)) throw new Error('the bridge image is pinned by its digest');
  if (o.ports.length === 0) throw new Error('a bridge forwards at least one listed port');
  for (const p of o.ports) {
    if (!Number.isInteger(p.hostPort) || p.hostPort < 1024 || p.hostPort > 65535)
      throw new Error(`port ${p.hostPort}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(p.service)) throw new Error(`service ${p.service}`);
  }
  // one forwarder per listed port: inbound only, to that service and port, nothing else listens
  const script = `const n=require("net");for(const [l,h,p] of ${JSON.stringify(
    o.ports.map((p, i) => [9000 + i, p.service, p.servicePort]),
  )})n.createServer(c=>{const u=n.connect(p,h);c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(l)`;
  const exposed: Record<string, object> = {};
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  o.ports.forEach((p, i) => {
    exposed[`${9000 + i}/tcp`] = {};
    bindings[`${9000 + i}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: String(p.hostPort) }];
  });
  return {
    Image: o.image,
    Cmd: ['node', '-e', script],
    Labels: { [LABEL]: o.instance, 'guildwise.role': 'port-bridge' },
    ExposedPorts: exposed,
    HostConfig: {
      NetworkMode: o.internalNetwork,
      PortBindings: bindings,
      CapDrop: ['ALL'],
      ReadonlyRootfs: true,
      Sysctls: { 'net.ipv4.ip_forward': '0' },
    },
  };
}
