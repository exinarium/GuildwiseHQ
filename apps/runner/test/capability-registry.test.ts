import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITY_REGISTRY_FEATURE, SESSION_TURNS_CAPABILITY } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { CapabilityRegistry, readCapabilityTree, skillRpc } from '../src/capabilities/registry.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp, waitUntil } from './helpers.ts';
import { IDENTITY, makeVault } from './vault-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
const servers: IpcServer[] = [];
afterEach(async () => {
  await h?.stop();
  h = undefined;
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const skillMd = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${name} does a thing.\n${extra}---\n# ${name}\nBody.\n`;
const personaMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} persona\nstance: strict\nvoice: dry\nicon: gavel\n---\nYou are ${name}.\n`;

/** An organization vault clone folder with `org/skills`, `org/personas` and `org/playbooks`. */
function orgClone(): string {
  const root = tmp('aom-caps-');
  const w = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  w('org/skills/our-skill/SKILL.md', skillMd('our-skill'));
  w('org/skills/our-skill/references/guide.md', 'A reference.\n');
  w('org/skills/Bad Skill/SKILL.md', skillMd('bad-skill'));
  w('org/personas/legal-eagle.md', personaMd('Legal Eagle'));
  w(
    'org/playbooks/brainstorm/workflow.md',
    '---\nname: brainstorm\ndescription: Our own brainstorm.\n---\nSteps\n',
  );
  w('org/playbooks/brainstorm/steps/step-01-go.md', 'Go.\n');
  w('org/notes/ignored.md', 'not a capability');
  return root;
}

describe('indexing the organization vault', () => {
  it('reads capabilities, reports problems and skips symlinks and big files', () => {
    const root = orgClone();
    const outside = tmp('aom-outside-');
    writeFileSync(join(outside, 'secret.md'), 'secret');
    symlinkSync(outside, join(root, 'org/skills/our-skill/linked'));
    writeFileSync(join(root, 'org/skills/our-skill/huge.md'), 'x'.repeat(600 * 1024));
    const tree = readCapabilityTree(join(root, 'org'));
    expect(Object.keys(tree)).toEqual(
      expect.arrayContaining([
        'skills/our-skill/SKILL.md',
        'skills/our-skill/references/guide.md',
        'personas/legal-eagle.md',
      ]),
    );
    expect(
      Object.keys(tree).some((p) => p.includes('linked') || p.includes('huge') || p.includes('notes')),
    ).toBe(false);

    const reg = new CapabilityRegistry();
    const r = reg.index('v1', root);
    expect(r.items.map((i) => `${i.kind}:${i.key}`).sort()).toEqual([
      'persona:legal-eagle',
      'playbook:brainstorm',
      'skill:our-skill',
    ]);
    expect(r.items.every((i) => i.source === 'org-vault' && /^[0-9a-f]{64}$/.test(i.hash))).toBe(true);
    expect(r.issues.map((i) => i.path)).toEqual(['skills/Bad Skill/SKILL.md']);
    expect(r.changed).toBe(true);
    expect(reg.index('v1', root).changed).toBe(false);
    writeFileSync(join(root, 'org/personas/legal-eagle.md'), personaMd('Legal Eagle 2'));
    expect(reg.index('v1', root).changed).toBe(true);
    // the report carries metadata only
    expect(JSON.stringify(r.items)).not.toContain('Body.');
  });

  it('lets a vault capability replace a built-in of the same kind and key', () => {
    const reg = new CapabilityRegistry();
    reg.index('v1', orgClone());
    const brainstorm = reg.meta().find((m) => m.kind === 'playbook' && m.key === 'brainstorm');
    expect(brainstorm).toMatchObject({ source: 'org-vault', description: 'Our own brainstorm.' });
    expect(reg.meta().find((m) => m.kind === 'playbook' && m.key === 'prd')?.source).toBe('builtin');
    expect(reg.persona('legal-eagle')?.body).toContain('You are Legal Eagle.');
    expect(reg.persona('cost-hawk')?.meta.name).toBe('Cost Hawk');
    expect(reg.persona('nobody')).toBeUndefined();
  });
});

describe('aom skill show', () => {
  it('prints a capability, lists a playbook’s files and reads one of them', () => {
    const reg = new CapabilityRegistry();
    const prd = reg.show('playbook:prd');
    expect(prd.ok && prd.text).toContain('name: prd');
    expect(prd.ok && prd.text).toContain('steps/step-01-gather.md');
    expect(prd.ok && prd.text).toContain('assets/prd-template.md');
    const step = reg.show('prd', 'steps/step-03-requirements.md');
    expect(step.ok && step.text).toContain('Requirements');
    const csv = reg.show('brainstorm', 'assets/techniques.csv');
    expect(csv.ok && csv.text.split('\n')[0]).toBe('category,technique_name,description');
    expect(reg.show('skill:prd').ok).toBe(false);
    const missing = reg.show('nope');
    expect(!missing.ok && missing.error).toContain('aom skill list');
    const bad = reg.show('prd', '../../etc/passwd');
    expect(bad.ok).toBe(false);
    const near = reg.show('brain');
    expect(!near.ok && near.error).toContain('playbook:brainstorm');
  });

  it('answers the rpc methods and builds the instructions index', () => {
    const reg = new CapabilityRegistry();
    expect(skillRpc(undefined, 'skill.show', { ref: 'prd' }).ok).toBe(false);
    expect(skillRpc(reg, 'skill.show', {})).toMatchObject({ ok: false });
    expect(skillRpc(reg, 'skill.show', { ref: 'chair' })).toMatchObject({ ok: true });
    const list = skillRpc(reg, 'skill.list', { kind: 'persona' });
    expect(list.ok && (list.result as { text: string }).text.split('\n')).toHaveLength(9);
    const idx = reg.instructionsIndex(['interview-techniques', 'prd', 'missing']);
    expect(idx).toContain('`skill:interview-techniques`');
    expect(idx).toContain('`playbook:prd`');
    expect(idx).toContain('`missing`: not found');
    expect(reg.instructionsIndex([])).toBe('');
  });

  it('works from the command line over the local IPC', async () => {
    const reg = new CapabilityRegistry();
    const ipc = new IpcServer();
    servers.push(ipc);
    await ipc.start();
    const token = ipc.registerShift({
      report: async () => ({ accepted: true, message: 'ok' }) as never,
      rpc: async (r) => skillRpc(reg, r.method, r.params),
    });
    const out: string[] = [];
    const err: string[] = [];
    const ctx: AomContext = {
      env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      fetch,
      readFile: () => '',
    };
    expect(
      await runAom(['skill', 'show', 'playbook:brainstorm', '--file', 'steps/step-01-setup.md'], ctx),
    ).toBe(0);
    expect(out.join('')).toContain('Step 1: Set up');
    out.length = 0;
    expect(await runAom(['skill', 'list', '--kind', 'playbook'], ctx)).toBe(0);
    expect(out.join('')).toContain('playbook:advanced-elicitation');
    expect(await runAom(['skill', 'show'], ctx)).not.toBe(0);
    expect(await runAom(['skill', 'list', '--kind', 'bogus'], ctx)).not.toBe(0);
    expect(await runAom(['skill', 'show', 'nope'], ctx)).not.toBe(0);
    expect(err.join('')).toContain('no capability');
  });
});

describe('reporting to the server', () => {
  it('indexes the organization vault after a sync and sends capabilities.report once per change', async () => {
    const v = makeVault({
      'README.md': '# vault\n',
      'org/skills/our-skill/SKILL.md': skillMd('our-skill'),
      'org/personas/legal-eagle.md': personaMd('Legal Eagle'),
    });
    h = await startHarness({ features: [CAPABILITY_REGISTRY_FEATURE] });
    expect(h.server.of('hello')[0]?.capabilities).toContain(SESSION_TURNS_CAPABILITY);
    h.server.send('command', {
      commandId: 'c1',
      command: 'vault.configure',
      payload: {
        vaults: [{ vaultId: 'org1', kind: 'org', name: 'Org', remoteUrl: v.origin, syncIntervalSec: 3600 }],
        identity: IDENTITY,
        workstationName: 'Desk',
        resume: [],
      },
    });
    const rep = await h.server.waitFor('capabilities.report', () => true, 30_000);
    expect(rep.vaultId).toBe('org1');
    expect(rep.items.map((i) => `${i.kind}:${i.key}`).sort()).toEqual([
      'persona:legal-eagle',
      'skill:our-skill',
    ]);
    expect(rep.issues).toEqual([]);
    // a second sync with nothing changed sends nothing more
    const count = h.server.of('capabilities.report').length;
    await h.runner.vaults.syncNow('org1');
    await h.runner.vaults.syncNow('org1');
    expect(h.server.of('capabilities.report')).toHaveLength(count);
    // a change in the vault is reported
    const { pushFromOther } = await import('./vault-fixtures.ts');
    pushFromOther(v, 'org/skills/second-skill/SKILL.md', skillMd('second-skill'));
    await h.runner.vaults.syncNow('org1');
    await waitUntil(() => h?.server.of('capabilities.report').length === count + 1, 10_000, 'second report');
    expect(
      h.server
        .of('capabilities.report')
        .at(-1)
        ?.items.map((i) => i.key),
    ).toContain('second-skill');
  });

  it('sends nothing to a server that did not announce the feature', async () => {
    const v = makeVault({ 'org/skills/our-skill/SKILL.md': skillMd('our-skill') });
    h = await startHarness();
    h.server.send('command', {
      commandId: 'c2',
      command: 'vault.configure',
      payload: {
        vaults: [{ vaultId: 'org1', kind: 'org', name: 'Org', remoteUrl: v.origin, syncIntervalSec: 3600 }],
        identity: IDENTITY,
        workstationName: 'Desk',
        resume: [],
      },
    });
    await h.server.waitFor('command.result', (m) => m.commandId === 'c2');
    await h.runner.vaults.syncNow('org1');
    await new Promise((r) => setTimeout(r, 300));
    expect(h.server.of('capabilities.report')).toHaveLength(0);
  });
});
