import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  classifyIp,
  endpointListed,
  isForbiddenEndpointHost,
  isLoopbackHost,
  isPrivateEndpointHost,
  orgCredentialEndpointProblem,
} from '@aom/shared';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * The direct-model runtime's check of an OpenAI-compatible endpoint, at connection time (R3c; docs/ARCHITECTURE.md section 38.5).
 * A base URL that names a private-network host was checked when it was entered, but only an IP literal could be judged then: a
 * NAME (`ollama.lan`, or one an attacker controls) can resolve to anything and can change later. So the name is resolved here,
 * every address it gives is judged, and the connection goes to an address that was judged:
 *   - loopback (this machine): fine, as before;
 *   - link-local, metadata, unspecified, multicast: never;
 *   - a private-network address (RFC 1918, carrier-grade NAT, unique-local): only when the owner listed `host:port` (the name as
 *     written in the URL, or the address it resolved to) in the workstation's private endpoints (Q47);
 *   - a public address: fine.
 * An ORGANIZATION's endpoint (an org admin chose the URL) gets no loopback exemption: it must be https to a public address, or an
 * exact private-endpoint entry (`orgCredentialEndpointProblem`), and the address a name resolves to is judged the same way.
 */
export type Resolver = (host: string) => Promise<string[]>;

const defaultResolve: Resolver = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** Why a connection to `host:port` must not be made, or undefined. Pure apart from the resolver. */
export async function resolvedEndpointProblem(
  host: string,
  port: number,
  entries: readonly string[],
  resolve: Resolver = defaultResolve,
  orgSourced = false,
): Promise<string | undefined> {
  const h = host.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host) && !orgSourced) return undefined;
  let addrs: string[];
  if (isIP(h)) addrs = [h];
  else {
    try {
      addrs = await resolve(h);
    } catch {
      return `cannot resolve ${h}`;
    }
    if (addrs.length === 0) return `cannot resolve ${h}`;
  }
  for (const raw of addrs) {
    const ip = raw.toLowerCase();
    if (isForbiddenEndpointHost(ip))
      return `${h} resolves to ${ip}: link-local and metadata addresses cannot be used as an endpoint`;
    if (isLoopbackHost(ip) && !orgSourced) continue;
    if (classifyIp(ip) === undefined) return `${h} resolves to ${ip}, which is not an IP address`;
    if (isPrivateEndpointHost(ip) && !endpointListed(h, port, entries) && !endpointListed(ip, port, entries))
      return `${h}:${port} resolves to ${ip}, which is on a private network. Add ${h}:${port} to this workstation's private endpoints first.`;
  }
  return undefined;
}

type Lookup = (
  hostname: string,
  options: { all?: boolean; family?: number | string },
  cb: (err: Error | null, address: unknown, family?: number) => void,
) => void;

/**
 * A fetch for the endpoint's base URL: the name is judged first (a clear message), and the socket is then opened with a lookup that
 * judges the address again, so a name that changes between the check and the connection (DNS rebinding) cannot get through.
 */
export function guardedFetch(o: {
  entries: () => readonly string[];
  resolve?: Resolver;
  /** Whether a URL belongs to an organization's credential (judged without the loopback exemption). */
  isOrgUrl?: (url: string) => boolean;
  /** Test hook: where the request really goes (default: undici with a guarded lookup). */
  inner?: (url: string, init?: RequestInit) => Promise<Response>;
}): (url: string, init?: RequestInit) => Promise<Response> {
  const resolve = o.resolve ?? defaultResolve;
  const portOf = (u: URL): number => Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  // one agent per host and port: its lookup knows the port, which decides whether a private address is listed
  const agents = new Map<string, Agent>();
  const dispatcher = (host: string, port: number, org: boolean): Agent => {
    const key = `${host}:${port}:${org}`;
    let agent = agents.get(key);
    if (agent) return agent;
    agent = new Agent({
      connect: {
        lookup: ((hostname, options, cb) => {
          resolve(hostname)
            .then(async (addrs) => {
              const ok: string[] = [];
              for (const a of addrs)
                if (!(await resolvedEndpointProblem(host, port, o.entries(), async () => [a], org)))
                  ok.push(a);
              if (ok.length === 0) return cb(new Error(`the endpoint ${hostname} is not allowed`), []);
              const fam = (a: string) => (a.includes(':') ? 6 : 4);
              if (options.all)
                cb(
                  null,
                  ok.map((address) => ({ address, family: fam(address) })),
                );
              else cb(null, ok[0], fam(ok[0] as string));
            })
            .catch((err: Error) => cb(err, []));
        }) as Lookup as never,
      },
    });
    agents.set(key, agent);
    return agent;
  };
  return async (url, init) => {
    const u = new URL(url);
    const org = o.isOrgUrl?.(url) === true;
    const spelled = org ? orgCredentialEndpointProblem(url, o.entries()) : undefined;
    if (spelled) throw new Error(spelled);
    const problem = await resolvedEndpointProblem(u.hostname, portOf(u), o.entries(), resolve, org);
    if (problem) throw new Error(problem);
    if (o.inner) return o.inner(url, init);
    return undiciFetch(url, {
      ...(init as object),
      dispatcher: dispatcher(u.hostname, portOf(u), org),
    } as never) as unknown as Promise<Response>;
  };
}
