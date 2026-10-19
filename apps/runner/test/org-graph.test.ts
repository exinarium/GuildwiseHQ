import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphOrgPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { indexRepository } from '../src/graph/indexer.ts';
import { readOrgGraph } from '../src/graph/org.ts';
import { GraphService } from '../src/graph/service.ts';
import { makeGraphRepo } from './graph-fixtures.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const P_SHOP = '019e3f6a-7b1c-7a2d-8c3e-000000000001';
const P_BILL = '019e3f6a-7b1c-7a2d-8c3e-000000000002';
const P_SITE = '019e3f6a-7b1c-7a2d-8c3e-000000000003';
const P_OLD = '019e3f6a-7b1c-7a2d-8c3e-000000000004';
const ORG_VAULT = 'orgvault1';

const shopFiles = {
  'apps/web/package.json': JSON.stringify({
    name: '@acme/shop-web',
    dependencies: { '@acme/billing-client': '1.0.0', react: '18.0.0' },
  }),
  'apps/web/src/main.ts': 'export function checkout() { return 1; }\n',
  'services/invoicing/package.json': JSON.stringify({ name: '@acme/shop-invoicing' }),
  'services/invoicing/src/index.ts': 'export class SecretLedgerSymbol {}\n',
};
const billFiles = {
  'packages/billing-client/package.json': JSON.stringify({
    name: '@acme/billing-client',
    main: 'src/index.ts',
  }),
  'packages/billing-client/src/index.ts': 'export function charge() { return 1; }\n',
  'services/invoicing/package.json': JSON.stringify({ name: '@acme/bill-invoicing' }),
  'services/invoicing/src/index.ts': 'export function raiseInvoice() { return 1; }\n',
};
const siteFiles = {
  'site/package.json': JSON.stringify({ name: 'docs-site' }),
  'site/src/index.ts': 'export const x = 1;\n',
  'docs/README.md': '# Docs\n',
};

async function world() {
  const out = tmp('aom-org-graph-');
  const vaultDirs: Record<string, string> = {};
  const vaultDir = (id: string) => (vaultDirs[id] ??= join(out, 'vaults', id));
  const svc = new GraphService({
    paths: { graphCache: join(out, 'cache') } as never,
    vaults: {
      vault: (id: string) => ({ vaultId: id, storage: 'local' }),
      dir: vaultDir,
      exclusive: async <T>(id: string, fn: (d: string) => Promise<T>) => fn(vaultDir(id)),
      syncNow: async () => undefined,
    } as never,
    findRepo: async () => undefined,
    version: 't',
  });
  const graph = async (projectId: string, files: Record<string, string>, repoKey: string) => {
    const fx = makeGraphRepo(files);
    await indexRepository({
      repoPath: fx.repo,
      repoKey,
      repoName: repoKey,
      graphDir: svc.graphDir(vaultDir(`pv-${projectId.slice(-1)}`), `projects/p${projectId.slice(-1)}`),
      cacheDir: svc.cacheDir,
      indexerVersion: 't',
    });
    return { vaultId: `pv-${projectId.slice(-1)}`, folder: `projects/p${projectId.slice(-1)}` };
  };
  const shop = await graph(P_SHOP, shopFiles, 'aaaaaaaaaaaa');
  const bill = await graph(P_BILL, billFiles, 'bbbbbbbbbbbb');
  const site = await graph(P_SITE, siteFiles, 'cccccccccccc');
  const old = await graph(P_OLD, billFiles, 'dddddddddddd');
  const payload = (over: Partial<GraphOrgPayload> = {}): GraphOrgPayload => ({
    orgId: '019e3f6a-7b1c-7a2d-8c3e-0000000000f1',
    vault: { vaultId: ORG_VAULT, storage: 'local' },
    projects: [
      { projectId: P_SHOP, key: 'SHOP', name: 'Web shop', retired: false, graph: shop },
      { projectId: P_BILL, key: 'BILL', name: 'Billing', retired: false, graph: bill },
      { projectId: P_SITE, key: 'SITE', name: 'Docs site', retired: false, graph: site },
      { projectId: P_OLD, key: 'OLD', name: 'Old billing', retired: true, graph: old },
      { projectId: '019e3f6a-7b1c-7a2d-8c3e-000000000005', key: 'NEW', name: 'No graph yet', retired: false },
    ],
    assertions: [],
    ...over,
  });
  return { svc, out, orgDir: vaultDir(ORG_VAULT), payload };
}

function tree(dir: string, rel = ''): Record<string, string> {
  const o: Record<string, string> = {};
  if (!existsSync(dir)) return o;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    if (statSync(p).isDirectory()) Object.assign(o, tree(p, r));
    else o[r] = readFileSync(p, 'utf8');
  }
  return o;
}

describe('the organization graph (design section 8)', () => {
  it('derives depends_on (EXTRACTED) from a declared package and touches (INFERRED) from a shared area, as drafts, in the organization vault', async () => {
    const w = await world();
    const r = await w.svc.buildOrg(w.payload());
    expect(r).toMatchObject({ ok: true, projects: 5, withGraph: 4 });
    const g = readOrgGraph(w.orgDir);
    expect(g).not.toBeNull();
    const dep = g?.derived.find((d) => d.kind === 'depends_on');
    expect(dep).toMatchObject({ from: P_SHOP, to: P_BILL, conf: 'EXTRACTED', status: 'draft' });
    expect(dep?.evidence[0]).toBe('apps/web declares @acme/billing-client, which is packages/billing-client');
    const touch = g?.derived.find((d) => d.kind === 'touches');
    expect(touch).toMatchObject({ from: P_SHOP, to: P_BILL, conf: 'INFERRED', status: 'draft' });
    expect(touch?.evidence).toEqual(['both have an area named invoicing']);
    expect((r as { drafts: number }).drafts).toBe(2);
    // everything is under org/graph/ and the drafts are written for the CEO to show in chat
    expect(Object.keys(tree(w.orgDir)).sort()).toEqual([
      'org/graph/drafts.md',
      'org/graph/links.jsonl',
      'org/graph/manifest.json',
      'org/graph/projects.jsonl',
    ]);
    const drafts = readFileSync(join(w.orgDir, 'org/graph/drafts.md'), 'utf8');
    expect(drafts).toContain(
      'SHOP Web shop depends on BILL Billing [E]: apps/web declares @acme/billing-client',
    );
    expect(drafts).toContain('shares an area with');
  });

  it('a retired project is a node but never in a derived link, and a repeated build is byte for byte the same', async () => {
    const w = await world();
    await w.svc.buildOrg(w.payload());
    const first = tree(w.orgDir);
    const g = readOrgGraph(w.orgDir);
    expect(g?.projects.find((p) => p.id === P_OLD)?.retired).toBe(true);
    expect(g?.derived.some((d) => d.from === P_OLD || d.to === P_OLD)).toBe(false);
    await w.svc.buildOrg(w.payload());
    expect(tree(w.orgDir)).toEqual(first);
  });

  it('holds module and package names of projects but never a symbol, a file or a line of code', async () => {
    const w = await world();
    await w.svc.buildOrg(w.payload());
    const text = Object.values(tree(w.orgDir)).join('\n');
    expect(text).not.toContain('SecretLedgerSymbol');
    expect(text).not.toContain('checkout');
    expect(text).not.toContain('raiseInvoice');
    expect(text).not.toContain('main.ts');
    expect(text).toContain('apps/web');
  });

  it('a link the Owner asserted turns the draft between those projects into an accepted one, and is listed', async () => {
    const w = await world();
    await w.svc.buildOrg(
      w.payload({
        assertions: [
          {
            linkId: '019e3f6a-7b1c-7a2d-8c3e-0000000000a1',
            from: { projectId: P_SHOP },
            to: { projectId: P_BILL },
            kind: 'depends_on',
          },
          {
            linkId: '019e3f6a-7b1c-7a2d-8c3e-0000000000a2',
            from: { projectId: P_SITE },
            to: { name: 'status-page.example' },
            kind: 'uses',
            note: 'public status page',
          },
        ],
      }),
    );
    const g = readOrgGraph(w.orgDir);
    expect(g?.derived.every((d) => d.status === 'accepted')).toBe(true);
    expect(g?.assertions).toHaveLength(2);
    expect(g?.assertions[1]).toMatchObject({
      from: { project: P_SITE },
      to: { name: 'status-page.example' },
      note: 'public status page',
    });
    expect(readFileSync(join(w.orgDir, 'org/graph/drafts.md'), 'utf8')).toContain('No drafts.');
  });

  it('a project whose graph is not on this workstation is listed without links; an unknown vault is a fixed failure', async () => {
    const w = await world();
    const p = w.payload();
    p.projects[2] = {
      ...(p.projects[2] as (typeof p.projects)[number]),
      graph: { vaultId: 'elsewhere', folder: 'projects/x' },
    };
    const r = await w.svc.buildOrg(p);
    expect(r).toMatchObject({ ok: true });
    const failing = new GraphService({
      paths: { graphCache: join(w.out, 'c2') } as never,
      vaults: { vault: () => undefined } as never,
      findRepo: async () => undefined,
      version: 't',
    });
    expect(await failing.buildOrg(w.payload())).toEqual({ ok: false, reason: 'no_vault' });
  });
});
