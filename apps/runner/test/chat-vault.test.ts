import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, renderChatInstructions, renderReadableFolders, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChatSettings } from '../src/adapters/claude-policy.ts';
import type { ChatStartInput } from '../src/adapters/types.ts';
import { readVaultContext } from '../src/vaults/context.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
if (!builder) throw new Error('role');

const VAULT_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789d1';

/** A vault clone (a `.git` folder, a project doc, standing orders and a secret) under a runner's vaults dir. */
function cloneVault(vaultsDir: string, folder = 'projects/toy'): string {
  const root = join(vaultsDir, VAULT_ID);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, ...folder.split('/')), { recursive: true });
  writeFileSync(join(root, 'standing-orders.md'), 'Always cite sources.\n');
  writeFileSync(join(root, ...folder.split('/'), 'PROJECT.md'), '# Toy\nA toy project.\n');
  writeFileSync(join(root, ...folder.split('/'), 'notes.md'), 'n\n');
  writeFileSync(join(root, '.env'), 'TOKEN=1\n');
  return root;
}

describe('readVaultContext for a chat', () => {
  it('reads the project folder, and only the root standing orders without a folder', async () => {
    const vaults = tmp('aom-vaults-');
    const root = cloneVault(vaults);
    const proj = await readVaultContext(vaults, { vaultId: VAULT_ID, kind: 'org', folder: 'projects/toy' });
    expect(proj?.addDir).toBe(root);
    expect(proj?.projectDoc).toContain('A toy project');
    expect(proj?.standingOrders.map((o) => o.title)).toEqual(['Vault standing orders']);
    const org = await readVaultContext(vaults, { vaultId: VAULT_ID, kind: 'org' });
    expect(org?.projectDoc).toBeUndefined();
    expect(org?.standingOrders).toHaveLength(1);
  });

  it('no clone here: no context', async () => {
    expect(await readVaultContext(tmp('aom-vaults-'), { vaultId: VAULT_ID, kind: 'org' })).toBeNull();
  });
});

describe('policy: the vault as a read-only folder of a chat', () => {
  it('is readable, not writable, and its secret files stay blocked', () => {
    const vault = cloneVault(tmp('aom-vaults-'));
    const s = buildChatSettings(true, [], policyCtx({ readDirs: [vault] }), POLICY_PATHS);
    expect(s.permissions.additionalDirectories).toContain(vault);
    expect(s.permissions.deny).toContain(`Edit(//${vault.slice(1)}/**)`);
    expect(s.permissions.deny).toContain(`Read(//${vault.slice(1)}/**/.env)`);
    const fs = s.sandbox?.filesystem;
    expect(fs?.denyWrite).toContain(vault);
    expect(fs?.allowWrite).not.toContain(vault);
    expect(fs?.allowRead).toContain(join(vault, 'standing-orders.md'));
    expect(fs?.allowRead.some((p) => p.endsWith('.env'))).toBe(false);
  });
});

describe('instructions', () => {
  const base = { name: 'Ada', seniority: 'junior' as const, roleKey: 'builder' };

  it('lists the vault as read-only and sends writes through aom commands', () => {
    const text = renderReadableFolders([{ name: 'organization', path: '/data/vaults/v1', kind: 'vault' }]);
    expect(text).toContain('/data/vaults/v1 (the knowledge vault "organization"');
    expect(text).toContain('read-only');
    expect(text).toContain('aom publish');
    expect(text).toContain('aom investigation record');
    expect(text).toContain('never directly');
    expect(renderReadableFolders([{ name: 'lib', path: '/src/lib', kind: 'reference' }])).not.toContain(
      'knowledge vault',
    );
  });

  it('a chat carries PROJECT.md and the standing orders, kept short', () => {
    const text = renderChatInstructions(
      base,
      {},
      {
        vault: {
          projectDoc: `# Toy\n${'x'.repeat(5000)}`,
          standingOrders: [{ title: 'Vault standing orders', body: 'Always cite sources.' }],
        },
      },
    );
    expect(text).toContain('# Knowledge vault');
    expect(text).toContain('## PROJECT.md');
    expect(text).toContain('Always cite sources.');
    expect(text).toContain('[...cut]');
    expect(text.length).toBeLessThan(9000);
  });

  it('a vault that is not cloned here is said plainly; an empty vault adds nothing', () => {
    expect(renderChatInstructions(base, {}, { vault: { missing: true } })).toContain(
      'not cloned on this workstation',
    );
    expect(renderChatInstructions(base, {}, { vault: {} })).not.toContain('Knowledge vault');
    expect(renderChatInstructions(base, {})).not.toContain('Knowledge vault');
  });
});

describe('chat: the vault of the conversation', () => {
  const agent = {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'builder',
    seniority: 'junior',
    runtime: 'mock',
    model: 'mock',
    skills: [],
    permissions: builder.permissions,
    isDevops: false,
  };

  async function run(
    clone: boolean,
    context: Record<string, unknown>,
    devops = false,
    extra: Record<string, unknown> = {},
  ) {
    h = await startHarness();
    if (clone) cloneVault(join(h.dataDir, 'vaults'));
    const adapter = h.runner.chat.deps.adapters.get('mock') as unknown as {
      startChat(i: ChatStartInput): Promise<unknown>;
      writeInstructions(s: unknown, md: string): Promise<void>;
    };
    const seen: { input?: ChatStartInput; instructions?: string } = {};
    const orig = adapter.startChat.bind(adapter);
    adapter.startChat = async (input) => {
      seen.input = input;
      return orig(input);
    };
    const origWrite = adapter.writeInstructions.bind(adapter);
    adapter.writeInstructions = async (s, md) => {
      seen.instructions = md;
      return origWrite(s, md);
    };
    const msg = {
      chatId: uuidv7(),
      threadId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
      agent: { ...agent, isDevops: devops },
      message: 'what do we know',
      context,
      ...extra,
    };
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    return { input: seen.input as ChatStartInput, instructions: seen.instructions ?? '' };
  }

  it('a chat with a cloned vault reads it read-only and gets its project doc and standing orders', async () => {
    const { input, instructions } = await run(true, {
      projectKey: 'TOY',
      vault: { vaultId: VAULT_ID, kind: 'org', folder: 'projects/toy' },
    });
    expect(input.readDirs).toHaveLength(1);
    expect(input.readDirs?.[0]).toMatch(new RegExp(`vaults[/\\\\]${VAULT_ID}$`));
    expect(instructions).toContain('the knowledge vault');
    expect(instructions).toContain('A toy project');
    expect(instructions).toContain('Always cite sources.');
  });

  it('a chat with no project opens the organization vault as a whole', async () => {
    const { input, instructions } = await run(true, { vault: { vaultId: VAULT_ID, kind: 'org' } });
    expect(input.readDirs).toHaveLength(1);
    expect(instructions).toContain('Always cite sources.');
    expect(instructions).not.toContain('A toy project');
  });

  it('no clone on this workstation: the chat still runs and the instructions say so', async () => {
    const { input, instructions } = await run(false, {
      vault: { vaultId: VAULT_ID, kind: 'org', folder: 'projects/toy' },
    });
    expect(input.readDirs).toEqual([]);
    expect(instructions).toContain('not cloned on this workstation');
  });

  it('no vault in the context: nothing is opened', async () => {
    const { input, instructions } = await run(true, {});
    expect(input.readDirs).toEqual([]);
    expect(instructions).not.toContain('Knowledge vault');
  });

  it('the DevOps engineer, who reads anywhere, is given no vault folder', async () => {
    const { input } = await run(true, { vault: { vaultId: VAULT_ID, kind: 'org' } }, true);
    expect(input.readDirs).toEqual([]);
  });

  it("a chat gets its role's persona and the owner's extension instructions (chat.start.role)", async () => {
    const role = {
      name: 'Builder',
      persona: '## How you work\nTests first.',
      extensions: 'Prefer small commits.',
    };
    const { instructions } = await run(false, {}, false, { role });
    expect(instructions).toContain('# Your role: Builder\n## How you work\nTests first.');
    expect(instructions).toContain('Prefer small commits.');
    await h?.stop();
    const plain = await run(false, {});
    expect(plain.instructions).not.toContain('# Your role');
  });
});
