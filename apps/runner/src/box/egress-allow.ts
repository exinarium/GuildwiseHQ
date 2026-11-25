import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIpLiteral } from '@aom/shared';
import { writeFileAtomic } from '../policy/store.ts';

/**
 * quiet-approvals Rework 1 (REVIEW S3, decision: build it now): the outer box's way out through the runner's egress proxy
 * is, besides the model proxy and the registries, exactly:
 * - the hosts of the project's own git remotes (https on 443/80; ssh as the exact `host:port`, loopback included, so a
 *   plain-git `ssh://uat-git@127.0.0.1` keeps working through the proxy);
 * - the deploy targets this computer ran an approved deploy to (`deploy-hosts.json`, recorded by the runner);
 * and nothing else. ssh goes through the proxy with a `ProxyCommand` (`socat ... PROXY:`), git over https through
 * `HTTPS_PROXY`.
 */

export interface OuterEgress {
  /** Host names reached on 443/80 (https, http); they must resolve to public addresses. */
  hosts: string[];
  /**
   * Rework 2 (REVIEW B4): exact `host:port` endpoints of a NAME (ssh, a non-default https port). The name must resolve to
   * a public address at every connect (never an exemption, never cached across connects): rebinding to 127.0.0.1 or the
   * LAN is refused.
   */
  endpoints: string[];
  /**
   * Rework 2 (REVIEW B4): exact `ip:port` endpoints written as an IP literal (or `localhost`) in a clone's origin: the only
   * private or loopback addresses the outer box may reach (UAT's `ssh://uat-git@127.0.0.1`).
   */
  privateEndpoints: string[];
}

/** An IP literal or `localhost`: the only hosts a private exemption may name. */
export const literalHost = (host: string): boolean =>
  host.toLowerCase() === 'localhost' || isIpLiteral(host.replace(/^\[|\]$/g, ''));

const HOST = /^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/;

/** One git remote (`https://`, `ssh://`, `git@host:path`) as egress entries; null for anything else (a local path). */
export function remoteEgress(url: string): { host?: string; endpoint?: string } | null {
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(url);
  if (scp?.[1]) return { endpoint: `${scp[1]}:22` };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname;
  if (!HOST.test(host)) return null;
  if (u.protocol === 'ssh:' || u.protocol === 'git+ssh:') return { endpoint: `${host}:${u.port || '22'}` };
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    const def = u.protocol === 'https:' ? '443' : '80';
    return u.port && u.port !== def ? { endpoint: `${host}:${u.port}` } : { host };
  }
  return null;
}

export function outerEgress(remotes: readonly string[], deployHosts: readonly string[]): OuterEgress {
  const hosts = new Set<string>();
  const endpoints = new Set<string>();
  const privateEndpoints = new Set<string>();
  const addEndpoint = (ep: string) => {
    const host = ep.slice(0, ep.lastIndexOf(':'));
    (literalHost(host) ? privateEndpoints : endpoints).add(ep);
  };
  for (const r of remotes) {
    const e = remoteEgress(r);
    if (e?.host) {
      // a literal on 443/80 is an exact endpoint too (a name goes by name, public addresses only)
      if (literalHost(e.host)) addEndpoint(`${e.host}:${/^http:/.test(r) ? '80' : '443'}`);
      else hosts.add(e.host);
    }
    if (e?.endpoint) addEndpoint(e.endpoint);
  }
  for (const h of deployHosts) {
    const m = /^([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(h.trim());
    if (!m?.[1]) continue;
    if (!literalHost(m[1])) hosts.add(m[1]);
    addEndpoint(`${m[1]}:${m[2] ?? '22'}`);
  }
  return {
    hosts: [...hosts].sort(),
    endpoints: [...endpoints].sort(),
    privateEndpoints: [...privateEndpoints].sort(),
  };
}

/** The ssh command git uses in the outer box: every connection through the egress proxy's bridge. */
export const sshThroughProxy = (bridgePort: number): string =>
  `ssh -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=${bridgePort}'`;

// ---------------------------------------------------------------- the deploy targets this computer deployed to

export const DEPLOY_HOSTS_FILE = 'deploy-hosts.json';

export class DeployHosts {
  constructor(readonly root: string) {}

  private file(): string {
    return join(this.root, DEPLOY_HOSTS_FILE);
  }

  list(): string[] {
    try {
      const j = JSON.parse(readFileSync(this.file(), 'utf8')) as { hosts?: unknown };
      return Array.isArray(j.hosts) ? j.hosts.filter((h): h is string => typeof h === 'string') : [];
    } catch {
      return [];
    }
  }

  /** After a deploy the local gate let run (approved or pinned): its target host. */
  record(host: string | null | undefined): void {
    if (!host || !/^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(host)) return;
    const hosts = [...new Set([...this.list(), host])].slice(-100);
    try {
      writeFileAtomic(this.file(), `${JSON.stringify({ hosts })}\n`, 0o600);
    } catch {
      // advisory
    }
  }
}
