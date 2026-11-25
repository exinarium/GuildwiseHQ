import { chmodSync, realpathSync, rmSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { underRoot } from './folder-check.ts';

/**
 * quiet-approvals phase B, R4-B2: the Docker gatekeeper. The real socket is never in a box; the runner serves this filtering
 * socket instead.
 * (a) Every JSON body is parsed into a per-endpoint field allowlist (unknown or case-variant keys are refused) and the
 *     proxy forwards its OWN re-serialised JSON, never the original bytes.
 * (b) Containers, volumes and networks carry `guildwise.runner=<instance>` to be listed, inspected, used or deleted; the
 *     proxy adds it on create. `NetworkMode` must be a proxy-made network. Privileged, capabilities, devices, host modes,
 *     `container:` namespaces, links, volume drivers, other mount types and ports bound off 127.0.0.1 are refused.
 * (c) A bind source must be exactly one of the allowed roots (a card worktree or the request's scratch root, whose parents
 *     no box can write), by its real location; no sub paths (a container uses `-w`).
 * (d) Every request on a connection is parsed (node's HTTP parser); raw bytes are spliced only after an allowed attach or
 *     exec upgrade that the daemon answered with `101` (anything else is relayed and both sockets close, so nothing is
 *     smuggled on a kept-alive connection); ambiguous framing and API versions below 1.40 are refused.
 * (e) BuildKit (`/session`, `/grpc`, `/build`) is not available through the gatekeeper: `docker build` does not work in
 *     the outer box (an upgrade other than attach and exec start is refused).
 *
 * Rework 1 (REVIEW B1): networks are allowed by the gate's own record of what it created successfully (2xx, by name and
 * returned id; predefined and existing names refused); a container without a network mode goes on the gate's own
 * internal network, never the default bridge; network connect/disconnect checks the target container; a volume mount
 * uses only the gate's own labelled volumes; exec create has a body allowlist (no Privileged, no User); image pulls only
 * by name and tag (no `fromSrc` URL fetches); card worktree binds are always read-only.
 */

export const LABEL = 'guildwise.runner';
export const API_FLOOR = [1, 40] as const;

export interface DockerProxyPolicy {
  instance: string;
  /** Exactly these folders may be bind sources (real paths): the request's own folder, writable. */
  bindRoots: string[];
  /** Exactly these folders may be bind sources read-only (the card worktrees: always forced read-only). */
  roBindRoots?: string[];
  /** The local ceiling's `containerEgress`: may a proxy-made network reach the internet? */
  containerEgress: boolean;
}

export type Verdict =
  | {
      ok: true;
      body?: unknown;
      /** Named volumes the body uses: each must be one of the gate's own labelled volumes. */
      volumes?: string[];
      /** Containers the body names (network connect): each must be one of the gate's own. */
      containers?: string[];
      /** The container goes on the gate's own internal default network (made on first use). */
      defaultNetwork?: boolean;
    }
  | { ok: false; status: number; reason: string };

/** Docker's own networks, never a name the gate makes or a container joins. */
export const PREDEFINED_NETWORKS: readonly string[] = ['bridge', 'host', 'none', 'default'];

const EXEC_KEYS = [
  'AttachStdin',
  'AttachStdout',
  'AttachStderr',
  'Tty',
  'Cmd',
  'Env',
  'WorkingDir',
  'DetachKeys',
  'ConsoleSize',
] as const;

const refuse = (reason: string, status = 403): Verdict => ({ ok: false, status, reason });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Keeps exactly the allowed keys (exact case); any other key refuses the request. */
function only(o: unknown, allowed: readonly string[], where: string): Obj | string {
  if (o === undefined || o === null) return {};
  if (!isObj(o)) return `${where} is not an object`;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `${where}.${k} is not allowed`;
  return o;
}

const CREATE_KEYS = [
  'Image',
  'Cmd',
  'Entrypoint',
  'Env',
  'WorkingDir',
  'Labels',
  'ExposedPorts',
  'Tty',
  'OpenStdin',
  'StdinOnce',
  'AttachStdin',
  'AttachStdout',
  'AttachStderr',
  'StopSignal',
  'StopTimeout',
  'Healthcheck',
  'HostConfig',
  'NetworkingConfig',
  'Hostname',
  'User',
] as const;
const HOST_KEYS = [
  'Binds',
  'Mounts',
  'PortBindings',
  'NetworkMode',
  'RestartPolicy',
  'Memory',
  'NanoCpus',
  'AutoRemove',
  'Tmpfs',
  'Init',
  'ShmSize',
] as const;
const MOUNT_KEYS = [
  'Type',
  'Source',
  'Target',
  'ReadOnly',
  'VolumeOptions',
  'TmpfsOptions',
  'BindOptions',
] as const;

export class DockerGate {
  /** Networks this proxy made successfully (by name and by the id the daemon returned): the only ones allowed. */
  readonly networks = new Set<string>();

  constructor(readonly p: DockerProxyPolicy) {}

  /** The gate's own internal network for a container that names none. */
  get defaultNetworkName(): string {
    return `gw-${this.p.instance.slice(0, 12)}-internal`;
  }

  /** After the daemon answered a network create with 2xx: its name and id are allowed from now on. */
  noteNetwork(name: string, id?: string): void {
    if (PREDEFINED_NETWORKS.includes(name)) return;
    this.networks.add(name);
    if (id) this.networks.add(id);
  }

  /** 'rw', 'ro' (a card worktree: forced read-only) or null (not a bind source). */
  private bindKind(src: string): 'rw' | 'ro' | null {
    let real: string;
    try {
      real = realpathSync(src);
    } catch {
      return null;
    }
    // the daemon resolves the path itself: no link anywhere in it (as given) and in the root, and exactly a root
    if (real !== src.replace(/\/+$/, '')) return null;
    const exact = (roots: readonly string[]) =>
      roots.some((r) => {
        try {
          const rr = realpathSync(r);
          return rr === r && real === rr && underRoot(real, rr);
        } catch {
          return false;
        }
      });
    if (exact(this.p.roBindRoots ?? [])) return 'ro';
    if (exact(this.p.bindRoots)) return 'rw';
    return null;
  }

  /** POST /containers/create */
  createContainer(body: unknown): Verdict {
    const b = only(body, CREATE_KEYS, 'body');
    if (typeof b === 'string') return refuse(b);
    if (typeof b.Image !== 'string' || !b.Image) return refuse('an image is needed');
    const host = only(b.HostConfig, HOST_KEYS, 'HostConfig');
    if (typeof host === 'string') return refuse(host);
    const mode = host.NetworkMode;
    const defaultNetwork = mode === undefined || mode === '' || mode === 'default';
    if (
      !defaultNetwork &&
      mode !== 'none' &&
      !(typeof mode === 'string' && !PREDEFINED_NETWORKS.includes(mode) && this.networks.has(mode))
    )
      return refuse(`NetworkMode ${String(mode)}: only a network made through this gatekeeper (or none)`);
    const binds: string[] = [];
    for (const bind of Array.isArray(host.Binds) ? host.Binds : host.Binds === undefined ? [] : [null]) {
      if (typeof bind !== 'string') return refuse('HostConfig.Binds must be strings');
      const [src, dst, opts] = bind.split(':');
      if (!src?.startsWith('/')) return refuse('named volumes go through Mounts');
      const kind = this.bindKind(src);
      if (!kind)
        return refuse(`bind ${src}: only a card worktree or the request's scratch folder, as a whole`);
      if (!dst) return refuse(`bind ${src}: a target is needed`);
      // a card worktree is read-only in a container, whatever was asked
      const o = (opts ?? '').split(',').filter((x) => x && x !== 'rw' && x !== 'ro');
      binds.push(
        `${src}:${dst}:${[kind === 'ro' || (opts ?? '').split(',').includes('ro') ? 'ro' : 'rw', ...o].join(',')}`,
      );
    }
    const volumes: string[] = [];
    const mounts: Obj[] = [];
    for (const m of Array.isArray(host.Mounts) ? host.Mounts : host.Mounts === undefined ? [] : [null]) {
      const mm = only(m, MOUNT_KEYS, 'Mounts[]');
      if (typeof mm === 'string') return refuse(mm);
      if (!['bind', 'volume', 'tmpfs'].includes(String(mm.Type)))
        return refuse(`mount type ${String(mm.Type)}`);
      if (isObj(mm.VolumeOptions) && mm.VolumeOptions.DriverConfig !== undefined)
        return refuse('Mounts[].VolumeOptions.DriverConfig');
      if (mm.Type === 'bind') {
        const kind = typeof mm.Source === 'string' ? this.bindKind(mm.Source) : null;
        if (!kind)
          return refuse(
            `bind ${String(mm.Source)}: only a card worktree or the request's scratch folder, as a whole`,
          );
        mounts.push(kind === 'ro' ? { ...mm, ReadOnly: true } : mm);
        continue;
      }
      // a named volume must be one of the gate's own (checked against the daemon); none = an anonymous volume
      if (mm.Type === 'volume' && mm.Source !== undefined) {
        if (typeof mm.Source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(mm.Source))
          return refuse('a volume name');
        volumes.push(mm.Source);
      }
      mounts.push(mm);
    }
    if (isObj(host.PortBindings))
      for (const list of Object.values(host.PortBindings))
        for (const pb of Array.isArray(list) ? list : [])
          if (!isObj(pb) || pb.HostIp !== '127.0.0.1') return refuse('ports are bound on 127.0.0.1 only');
    const net = only(b.NetworkingConfig, ['EndpointsConfig'], 'NetworkingConfig');
    if (typeof net === 'string') return refuse(net);
    if (isObj(net.EndpointsConfig))
      for (const name of Object.keys(net.EndpointsConfig))
        if (PREDEFINED_NETWORKS.includes(name) || !this.networks.has(name))
          return refuse(`network ${name} was not made through this gatekeeper`);
    const labels = isObj(b.Labels) ? { ...b.Labels } : {};
    labels[LABEL] = this.p.instance;
    const hostOut: Obj = {
      ...host,
      NetworkMode: defaultNetwork ? this.defaultNetworkName : mode,
      ...(host.Binds !== undefined ? { Binds: binds } : {}),
      ...(host.Mounts !== undefined ? { Mounts: mounts } : {}),
    };
    // canonical: the proxy's own JSON of exactly the checked fields
    return {
      ok: true,
      body: JSON.parse(JSON.stringify({ ...b, HostConfig: hostOut, Labels: labels })),
      ...(volumes.length ? { volumes } : {}),
      ...(defaultNetwork ? { defaultNetwork: true } : {}),
    };
  }

  /** POST /containers/{id}/exec: the body allowlist (no Privileged, no User). */
  execCreate(body: unknown): Verdict {
    const b = only(body, EXEC_KEYS, 'body');
    if (typeof b === 'string') return refuse(b);
    if (!Array.isArray(b.Cmd) || b.Cmd.length === 0 || b.Cmd.some((c) => typeof c !== 'string'))
      return refuse('Cmd is a list of strings');
    return { ok: true, body: JSON.parse(JSON.stringify(b)) };
  }

  /** POST /networks/{id}/connect|disconnect: the target container must be one of the gate's own. */
  networkConnect(body: unknown): Verdict {
    const b = only(body, ['Container', 'EndpointConfig', 'Force'], 'body');
    if (typeof b === 'string') return refuse(b);
    if (typeof b.Container !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(b.Container))
      return refuse('a container');
    const ep = only(b.EndpointConfig, ['Aliases'], 'EndpointConfig');
    if (typeof ep === 'string') return refuse(ep);
    return { ok: true, body: JSON.parse(JSON.stringify(b)), containers: [b.Container] };
  }

  /** POST /networks/create: labelled, internal (no internet) unless the local ceiling allows container egress. */
  createNetwork(body: unknown): Verdict {
    const b = only(body, ['Name', 'Labels', 'Internal', 'Attachable', 'CheckDuplicate'], 'body');
    if (typeof b === 'string') return refuse(b);
    if (typeof b.Name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(b.Name))
      return refuse('a network name');
    if (PREDEFINED_NETWORKS.includes(b.Name.toLowerCase()))
      return refuse(`${b.Name} is one of Docker's own networks`);
    const labels = isObj(b.Labels) ? { ...b.Labels } : {};
    labels[LABEL] = this.p.instance;
    return {
      ok: true,
      body: { Name: b.Name, Labels: labels, Internal: this.p.containerEgress ? b.Internal === true : true },
    };
  }

  /** POST /volumes/create: labelled, the local driver, no options. */
  createVolume(body: unknown): Verdict {
    const b = only(body, ['Name', 'Labels'], 'body');
    if (typeof b === 'string') return refuse(b);
    const labels = isObj(b.Labels) ? { ...b.Labels } : {};
    labels[LABEL] = this.p.instance;
    return { ok: true, body: { ...(typeof b.Name === 'string' ? { Name: b.Name } : {}), Labels: labels } };
  }

  /** The route, and what to check before it goes upstream. */
  classify(
    method: string,
    path: string,
  ):
    | { kind: 'refuse'; reason: string }
    | { kind: 'pass' }
    | {
        kind: 'body';
        check: (b: unknown) => Verdict;
        made?: 'network';
        /** The object the path names, checked before the body (exec create on a container, network connect). */
        scope?: { object: 'containers' | 'networks'; id: string };
      }
    | {
        kind: 'scoped';
        object: 'containers' | 'networks' | 'volumes' | 'exec';
        id: string;
        upgrade?: boolean;
      }
    | { kind: 'list'; object: 'containers' | 'networks' | 'volumes' } {
    const m = /^\/v(\d+)\.(\d+)(\/.*)$/.exec(path.split('?')[0] ?? '');
    const p = m ? (m[3] as string) : (path.split('?')[0] ?? '');
    if (m && (Number(m[1]) < API_FLOOR[0] || (Number(m[1]) === API_FLOOR[0] && Number(m[2]) < API_FLOOR[1])))
      return { kind: 'refuse', reason: `API version below v${API_FLOOR.join('.')}` };
    if (method === 'GET' && (p === '/_ping' || p === '/version')) return { kind: 'pass' };
    if (method === 'HEAD' && p === '/_ping') return { kind: 'pass' };
    if (method === 'GET' && (p === '/images/json' || /^\/images\/[^/]+\/json$/.test(p)))
      return { kind: 'pass' };
    if (method === 'POST' && p === '/images/create') {
      // a pull by name and tag only: never `fromSrc` (the daemon would fetch any URL past the egress proxy)
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      for (const k of q.keys())
        if (!['fromImage', 'tag', 'platform'].includes(k))
          return { kind: 'refuse', reason: `image create with ${k} is not available` };
      if (!q.get('fromImage')) return { kind: 'refuse', reason: 'an image pull names fromImage' };
      return { kind: 'pass' };
    }
    if (method === 'POST' && p === '/containers/create')
      return { kind: 'body', check: (b) => this.createContainer(b) };
    if (method === 'POST' && p === '/networks/create')
      return { kind: 'body', check: (b) => this.createNetwork(b), made: 'network' };
    if (method === 'POST' && p === '/volumes/create')
      return { kind: 'body', check: (b) => this.createVolume(b) };
    if (method === 'GET' && p === '/containers/json') return { kind: 'list', object: 'containers' };
    if (method === 'GET' && p === '/networks') return { kind: 'list', object: 'networks' };
    if (method === 'GET' && p === '/volumes') return { kind: 'list', object: 'volumes' };
    let c = /^\/containers\/([A-Za-z0-9_.-]+)\/exec$/.exec(p);
    if (c && method === 'POST')
      return {
        kind: 'body',
        check: (b) => this.execCreate(b),
        scope: { object: 'containers', id: c[1] as string },
      };
    c = /^\/networks\/([A-Za-z0-9_.-]+)\/(connect|disconnect)$/.exec(p);
    if (c && method === 'POST')
      return {
        kind: 'body',
        check: (b) => this.networkConnect(b),
        scope: { object: 'networks', id: c[1] as string },
      };
    c = /^\/containers\/([A-Za-z0-9_.-]+)\/(start|stop|kill|wait|logs|json|restart|attach|top|stats)$/.exec(
      p,
    );
    if (c) return { kind: 'scoped', object: 'containers', id: c[1] as string, upgrade: c[2] === 'attach' };
    c = /^\/containers\/([A-Za-z0-9_.-]+)$/.exec(p);
    if (c && method === 'DELETE') return { kind: 'scoped', object: 'containers', id: c[1] as string };
    c = /^\/exec\/([A-Za-z0-9]+)\/(start|json|resize)$/.exec(p);
    if (c) return { kind: 'scoped', object: 'exec', id: c[1] as string, upgrade: c[2] === 'start' };
    c = /^\/networks\/([A-Za-z0-9_.-]+)$/.exec(p);
    if (c) return { kind: 'scoped', object: 'networks', id: c[1] as string };
    c = /^\/volumes\/([A-Za-z0-9_.-]+)$/.exec(p);
    if (c) return { kind: 'scoped', object: 'volumes', id: c[1] as string };
    return { kind: 'refuse', reason: `${method} ${p} is not available through the gatekeeper` };
  }
}

/** The label filter the proxy forces on every list. */
export function scopedQuery(path: string, instance: string): string {
  const [base, q = ''] = path.split('?');
  const params = new URLSearchParams(q);
  params.set('filters', JSON.stringify({ label: [`${LABEL}=${instance}`] }));
  return `${base}?${params.toString()}`;
}

export interface DockerProxy {
  close(): Promise<void>;
  gate: DockerGate;
}

/** The largest upgrade request body the gate takes (exec start's JSON is a few dozen bytes). */
const UPGRADE_BODY_MAX = 4096;

/**
 * Rework 2 (REVIEW B1): exactly `len` body bytes from `head` and then the paused socket; whatever follows them comes back
 * as `rest`, to be held until the daemon switched protocols. Undefined when the socket ends or stalls first.
 */
async function readBody(
  sock: Socket,
  head: Buffer,
  len: number,
): Promise<{ body: Buffer; rest: Buffer } | undefined> {
  let buf = head;
  if (buf.length < len) {
    buf =
      (await new Promise<Buffer | undefined>((resolve) => {
        let acc = buf;
        const done = (v: Buffer | undefined) => {
          clearTimeout(timer);
          sock.off('data', onData);
          sock.off('end', onEnd);
          sock.pause();
          resolve(v);
        };
        const onData = (c: Buffer) => {
          acc = Buffer.concat([acc, c]);
          if (acc.length >= len) done(acc);
        };
        const onEnd = () => done(undefined);
        const timer = setTimeout(() => done(undefined), 5_000);
        sock.on('data', onData);
        sock.on('end', onEnd);
        sock.resume();
      })) ?? Buffer.alloc(0);
    if (buf.length < len) return undefined;
  }
  return { body: buf.subarray(0, len), rest: Buffer.from(buf.subarray(len)) };
}

/** Rework 2 (REVIEW B1): an upgrade body re-serialised from Detach, Tty and ConsoleSize; undefined when it is not that. */
export function upgradeBody(raw: Buffer): string | undefined {
  if (raw.length === 0) return '';
  let v: unknown;
  try {
    v = JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r)) {
    if (k === 'Detach' || k === 'Tty') {
      if (typeof r[k] !== 'boolean') return undefined;
      out[k] = r[k];
    } else if (k === 'ConsoleSize') {
      const c = r[k];
      if (c === null) continue;
      if (!Array.isArray(c) || c.length !== 2 || !c.every((n) => Number.isInteger(n) && n >= 0 && n < 65536))
        return undefined;
      out[k] = c;
    } else return undefined;
  }
  return JSON.stringify(out);
}

/** Serves the gatekeeper on `socketPath` in front of the real daemon socket `upstream`. */
export async function startDockerProxy(o: {
  socketPath: string;
  upstream: string;
  policy: DockerProxyPolicy;
  onRefuse?: (reason: string) => void;
}): Promise<DockerProxy> {
  const gate = new DockerGate(o.policy);
  const ask = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: unknown }>((resolve) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          socketPath: o.upstream,
          path,
          method,
          headers: {
            host: 'docker',
            ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let json: unknown = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {}
            resolve({ status: res.statusCode ?? 502, json });
          });
        },
      );
      req.on('error', () => resolve({ status: 502, json: null }));
      req.end(data);
    });
  const labelled = async (object: string, id: string): Promise<boolean> => {
    if (object === 'exec') {
      const e = await ask('GET', `/exec/${id}/json`);
      const cid = isObj(e.json) ? String(e.json.ContainerID ?? '') : '';
      return !!cid && labelled('containers', cid);
    }
    const r = await ask('GET', object === 'containers' ? `/containers/${id}/json` : `/${object}/${id}`);
    if (!isObj(r.json)) return false;
    const labels = (object === 'containers' ? (r.json.Config as Obj | undefined)?.Labels : r.json.Labels) as
      | Obj
      | undefined;
    return isObj(labels) && labels[LABEL] === o.policy.instance;
  };
  const fail = (res: ServerResponse, status: number, reason: string) => {
    o.onRefuse?.(reason);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `refused by the Guildwise gatekeeper: ${reason}` }));
  };
  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body?: Buffer,
    onAnswer?: (status: number, body: Buffer) => void,
  ) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = v;
    if (body) {
      headers['content-length'] = String(body.length);
      delete headers['transfer-encoding'];
    }
    const up = httpRequest({ socketPath: o.upstream, path, method: req.method, headers }, (ur) => {
      if (!onAnswer) {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
        return;
      }
      // the answer is read whole first (a network create: the gate records only what the daemon really made)
      const chunks: Buffer[] = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const all = Buffer.concat(chunks);
        onAnswer(ur.statusCode ?? 502, all);
        const h = { ...ur.headers };
        delete h['transfer-encoding'];
        h['content-length'] = String(all.length);
        res.writeHead(ur.statusCode ?? 502, h);
        res.end(all);
      });
    });
    up.on('error', () => fail(res, 502, 'the daemon did not answer'));
    if (body) up.end(body);
    else req.pipe(up);
  };
  /** The gate's own internal network (made once, on first need, only through the gate's own record). */
  const ensureDefaultNetwork = async (): Promise<boolean> => {
    const name = gate.defaultNetworkName;
    if (gate.networks.has(name)) return true;
    const existing = await ask('GET', `/networks/${name}`);
    if (existing.status === 200 && isObj(existing.json)) {
      const labels = existing.json.Labels as Obj | undefined;
      if (isObj(labels) && labels[LABEL] === o.policy.instance && existing.json.Internal === true) {
        gate.noteNetwork(name, String(existing.json.Id ?? ''));
        return true;
      }
      return false;
    }
    const made = await ask('POST', '/networks/create', {
      Name: name,
      Internal: true,
      Labels: { [LABEL]: o.policy.instance },
    });
    if (made.status >= 200 && made.status < 300) {
      gate.noteNetwork(name, isObj(made.json) ? String(made.json.Id ?? '') : undefined);
      return true;
    }
    return false;
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers['content-length'] !== undefined && req.headers['transfer-encoding'] !== undefined)
        return fail(res, 400, 'ambiguous framing');
      const path = req.url ?? '/';
      const route = gate.classify(req.method ?? 'GET', path);
      if (route.kind === 'refuse') return fail(res, 403, route.reason);
      if (route.kind === 'pass') return forward(req, res, path);
      if (route.kind === 'list') return forward(req, res, scopedQuery(path, o.policy.instance));
      if (route.kind === 'scoped') {
        if (!(await labelled(route.object, route.id)))
          return fail(res, 404, `${route.object} ${route.id} is not Guildwise's`);
        return forward(req, res, path);
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let parsed: unknown;
      try {
        parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        return fail(res, 400, 'the body is not JSON');
      }
      if (route.scope && !(await labelled(route.scope.object, route.scope.id)))
        return fail(res, 404, `${route.scope.object} ${route.scope.id} is not Guildwise's`);
      const v = route.check(parsed);
      if (!v.ok) return fail(res, v.status, v.reason);
      for (const vol of v.volumes ?? [])
        if (!(await labelled('volumes', vol))) return fail(res, 403, `volume ${vol} is not Guildwise's`);
      for (const c of v.containers ?? [])
        if (!(await labelled('containers', c))) return fail(res, 404, `container ${c} is not Guildwise's`);
      if (v.defaultNetwork && !(await ensureDefaultNetwork()))
        return fail(res, 409, 'the gatekeeper could not make its internal network');
      if (route.made === 'network' && isObj(v.body) && typeof v.body.Name === 'string') {
        const name = v.body.Name;
        // a name that exists already (another stack's network) is never taken over
        if ((await ask('GET', `/networks/${name}`)).status !== 404)
          return fail(res, 409, `a network called ${name} exists already`);
        return forward(req, res, path, Buffer.from(JSON.stringify(v.body)), (status, answer) => {
          if (status < 200 || status >= 300) return;
          let id: string | undefined;
          try {
            id = String((JSON.parse(answer.toString('utf8')) as { Id?: unknown }).Id ?? '') || undefined;
          } catch {}
          gate.noteNetwork(name, id);
        });
      }
      return forward(req, res, path, Buffer.from(JSON.stringify(v.body)));
    })();
  });
  // attach and exec start upgrade to a raw stream: only after the label check above allowed them
  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
    void (async () => {
      const route = gate.classify(req.method ?? 'POST', req.url ?? '/');
      if (route.kind !== 'scoped' || !route.upgrade || !(await labelled(route.object, route.id))) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      // nothing from the box goes upstream until the daemon switched protocols (REVIEW B1: no smuggling on a kept-alive
      // connection after an error answer)
      client.pause();
      const refuse = () => client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      // Rework 2 (REVIEW B1): the upgrade request is rebuilt here, never relayed: no Transfer-Encoding, a body of exactly
      // Content-Length bytes (at most 4 KB) re-serialised from an allowlist; every byte after it is held until the 101
      if (req.headers['transfer-encoding'] !== undefined) return refuse();
      const cl = req.headers['content-length'] === undefined ? 0 : Number(req.headers['content-length']);
      if (!Number.isInteger(cl) || cl < 0 || cl > UPGRADE_BODY_MAX) return refuse();
      const got = await readBody(client, head, cl);
      if (!got) return refuse();
      const body = upgradeBody(got.body);
      if (body === undefined) return refuse();
      const held = got.rest;
      const up = connect(o.upstream);
      const close = () => {
        up.destroy();
        client.destroy();
      };
      up.on('error', close);
      client.on('error', close);
      up.write(
        `${req.method} ${req.url} HTTP/1.1\r\nHost: docker\r\nUpgrade: tcp\r\nConnection: Upgrade\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      let answer = Buffer.alloc(0);
      const onData = (c: Buffer) => {
        answer = Buffer.concat([answer, c]);
        const end = answer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (answer.length > 64 * 1024) close();
          return;
        }
        up.off('data', onData);
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(answer.subarray(0, end).toString('latin1'))?.[1];
        client.write(answer);
        if (status !== '101') {
          // relay the daemon's answer and close: the connection never carries another request
          up.once('end', () => client.end());
          up.on('data', (d) => client.write(d));
          setTimeout(close, 2_000).unref?.();
          return;
        }
        // only now does what the box sent after the upgrade request go upstream, as the exec's raw stream
        if (held.length) up.write(held);
        up.pipe(client);
        client.pipe(up);
        client.resume();
      };
      up.on('data', onData);
    })();
  });
  rmSync(o.socketPath, { force: true });
  await new Promise<void>((r) => server.listen(o.socketPath, () => r()));
  chmodSync(o.socketPath, 0o600);
  return {
    gate,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          rmSync(o.socketPath, { force: true });
          r();
        });
        server.closeAllConnections?.();
      }),
  };
}
