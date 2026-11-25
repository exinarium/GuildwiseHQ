import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { assertNotAgentSession, checkSeal, readPolicyKey, seal } from '../policy/integrity.ts';
import { writeFileAtomic } from '../policy/store.ts';
import { LABEL } from './docker-proxy.ts';
import { type BridgePort, bridgeContainer } from './port-bridge.ts';
import { type RecipeApproval, recipeBinding, recipeEgress } from './recipe-approval.ts';

/**
 * quiet-approvals phase B, S6 and D9: test services from a recipe. The runner itself (never a box) creates, on the
 * runner's Docker daemon:
 * - an `internal: true` network (no internet) labelled for this runner, or a normal one only when the recipe may have
 *   egress (`recipeEgress`: the local ceiling allows it AND a Desk click approved this recipe's sha256 plus image digests);
 * - each service from its digest-pinned image on that network, with no published port;
 * - the port bridge (pinned by digest) on that network and the default one, forwarding only the listed ports from
 *   127.0.0.1.
 * Agents then reach the services through the existing test-service openings (`sandbox/test-services.ts`).
 *
 * The Desk click is the passkey-approvable held kind `test.recipe_egress` (runner-verified, no protocol change).
 */

export const RECIPE_EGRESS_KIND = 'test.recipe_egress';

export interface TestService {
  name: string;
  image: string;
  port: number;
  hostPort: number;
  env?: Record<string, string>;
  /** The container's command (absent: the image's own). */
  cmd?: string[];
}
export interface TestRecipe {
  services: TestService[];
  /** The recipe asks for internet for its containers. */
  egress?: boolean;
}

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const DIGEST_IMAGE = /^[a-z0-9./_-]+@(sha256:[0-9a-f]{64})$/;

/** Parses and checks a recipe (JSON): names, digest-pinned images, ports. Throws with the first problem. */
export function parseRecipe(text: string): TestRecipe {
  const j = JSON.parse(text) as { services?: unknown; egress?: unknown };
  if (!Array.isArray(j.services) || j.services.length === 0 || j.services.length > 10)
    throw new Error('a recipe lists 1 to 10 services');
  const services = (j.services as Array<Record<string, unknown>>).map((s) => {
    if (typeof s.name !== 'string' || !NAME.test(s.name)) throw new Error(`service name ${String(s.name)}`);
    if (typeof s.image !== 'string' || !DIGEST_IMAGE.test(s.image))
      throw new Error(`service ${s.name}: the image is pinned by its digest (name@sha256:...)`);
    const port = Number(s.port);
    const hostPort = Number(s.hostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`service ${s.name}: port`);
    if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535)
      throw new Error(`service ${s.name}: hostPort`);
    const env = s.env && typeof s.env === 'object' ? (s.env as Record<string, string>) : undefined;
    const cmd = Array.isArray(s.cmd) ? (s.cmd as unknown[]) : undefined;
    if (cmd && (cmd.length > 40 || cmd.some((c) => typeof c !== 'string' || c.length > 4000)))
      throw new Error(`service ${s.name}: cmd is a list of strings`);
    return {
      name: s.name,
      image: s.image,
      port,
      hostPort,
      ...(env ? { env } : {}),
      ...(cmd ? { cmd: cmd as string[] } : {}),
    };
  });
  return { services, ...(j.egress === true ? { egress: true } : {}) };
}

export const recipeDigests = (r: TestRecipe): string[] =>
  r.services.map((s) => DIGEST_IMAGE.exec(s.image)?.[1] as string);

// ---------------------------------------------------------------- approved recipes (sealed, local)

export class RecipeApprovals {
  constructor(readonly policyDir: string) {}

  private file(): string {
    return join(this.policyDir, 'recipe-approvals.json');
  }

  get(projectId: string): RecipeApproval | undefined {
    try {
      const { check, body } = checkSeal(this.policyDir, JSON.parse(readFileSync(this.file(), 'utf8')));
      if (check !== 'ok') return undefined;
      return (body as { approvals?: Record<string, RecipeApproval> })?.approvals?.[projectId];
    } catch {
      return undefined;
    }
  }

  /** After the Desk click (a verified passkey) or a local yes: exactly this recipe and these digests. */
  approve(projectId: string, text: string, digests: readonly string[]): void {
    assertNotAgentSession();
    const key = readPolicyKey(this.policyDir);
    if (!key) throw new Error('no policy key on this computer');
    let approvals: Record<string, RecipeApproval> = {};
    try {
      const { check, body } = checkSeal(this.policyDir, JSON.parse(readFileSync(this.file(), 'utf8')));
      if (check === 'ok')
        approvals = { ...((body as { approvals?: Record<string, RecipeApproval> }).approvals ?? {}) };
    } catch {
      // first approval
    }
    approvals[projectId] = recipeBinding(text, digests);
    writeFileAtomic(this.file(), `${JSON.stringify(seal(key, { approvals }))}\n`, 0o600);
  }
}

// ---------------------------------------------------------------- the plan and the run

export interface TestServicesPlan {
  network: { Name: string; Internal: boolean; Labels: Record<string, string> };
  services: Array<{ name: string; body: Record<string, unknown> }>;
  bridge: { name: string; body: Record<string, unknown> };
  /** The loopback ports agents use (`127.0.0.1:<hostPort>`). */
  testServices: string[];
  egress: boolean;
}

export function planTestServices(o: {
  instance: string;
  projectKey: string;
  recipe: TestRecipe;
  recipeText: string;
  bridgeImage: string;
  ceilingEgress: boolean;
  approved?: RecipeApproval;
}): TestServicesPlan {
  const egress =
    o.recipe.egress === true &&
    recipeEgress(o.ceilingEgress, o.approved, o.recipeText, recipeDigests(o.recipe)).egress;
  const prefix = `gw-${o.instance.slice(0, 8)}-${o.projectKey.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(
    0,
    40,
  );
  const net = `${prefix}-net`;
  const labels = { [LABEL]: o.instance, 'guildwise.project': o.projectKey };
  const ports: BridgePort[] = o.recipe.services.map((s) => ({
    hostPort: s.hostPort,
    service: `${prefix}-${s.name}`,
    servicePort: s.port,
  }));
  return {
    network: { Name: net, Internal: !egress, Labels: labels },
    services: o.recipe.services.map((s) => ({
      name: `${prefix}-${s.name}`,
      body: {
        Image: s.image,
        ...(s.cmd ? { Cmd: s.cmd } : {}),
        Env: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`),
        Labels: labels,
        HostConfig: { NetworkMode: net, CapDrop: ['ALL'], ReadonlyRootfs: false },
      },
    })),
    bridge: {
      name: `${prefix}-bridge`,
      body: bridgeContainer({
        instance: o.instance,
        name: `${prefix}-bridge`,
        image: o.bridgeImage,
        internalNetwork: net,
        ports,
      }),
    },
    testServices: o.recipe.services.map((s) => `127.0.0.1:${s.hostPort}`),
    egress,
  };
}

/** A minimal Docker Engine API client on the runner's own daemon socket (the runner side, never a box). */
export function dockerApi(socket: string) {
  return (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: unknown }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          socketPath: socket,
          path: `/v1.43${path}`,
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
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      req.end(data);
    });
}

/** Brings the plan up (idempotent: an existing one is replaced). Returns the test-service openings. */
export async function runTestServices(socket: string, plan: TestServicesPlan): Promise<string[]> {
  const api = dockerApi(socket);
  const must = async (what: string, p: Promise<{ status: number; json: unknown }>) => {
    const r = await p;
    if (r.status >= 300 && r.status !== 304)
      throw new Error(`${what}: ${String((r.json as { message?: string } | null)?.message ?? r.status)}`);
    return r;
  };
  await downTestServices(socket, plan);
  await must('network', api('POST', '/networks/create', plan.network));
  for (const s of [...plan.services, plan.bridge]) {
    await must(
      `container ${s.name}`,
      api('POST', `/containers/create?name=${encodeURIComponent(s.name)}`, s.body),
    );
  }
  // the bridge also joins the default network (the only way its published ports reach 127.0.0.1)
  await must('bridge network', api('POST', '/networks/bridge/connect', { Container: plan.bridge.name }));
  for (const s of [...plan.services, plan.bridge])
    await must(`start ${s.name}`, api('POST', `/containers/${encodeURIComponent(s.name)}/start`));
  return plan.testServices;
}

export async function downTestServices(socket: string, plan: TestServicesPlan): Promise<void> {
  const api = dockerApi(socket);
  for (const s of [plan.bridge, ...plan.services])
    await api('DELETE', `/containers/${encodeURIComponent(s.name)}?force=true`).catch(() => undefined);
  await api('DELETE', `/networks/${encodeURIComponent(plan.network.Name)}`).catch(() => undefined);
}
