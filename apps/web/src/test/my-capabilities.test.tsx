import { type AuthoredCapability, capabilitiesOfTree, packTree, sealLarge, unzipTree } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackProvenance } from '../components/agents/PackProvenance.tsx';
import { PackEditor } from '../components/capabilities/CapabilityEditor.tsx';
import { HirePackDialog } from '../components/capabilities/HirePackDialog.tsx';
import { MyCapabilitiesTab } from '../components/capabilities/MyCapabilitiesTab.tsx';
import { PackAssignments } from '../components/capabilities/PackAssignments.tsx';
import { RegistryTab } from '../components/capabilities/RegistryTab.tsx';
import { RoleOffers } from '../components/capabilities/RoleOffers.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { diffLines } from '../lib/diff-lines.ts';

const WS = '0192f3a0-0000-7000-8000-0000000000a1';
const PACK = '0192f3a0-0000-7000-8000-0000000000c2';
const AT = '2026-10-24T10:00:00.000Z';
const H = '0'.repeat(64);

type Handler = (init: RequestInit, url: string) => unknown | Promise<unknown>;
function stub(handlers: Record<string, Handler>) {
  // biome-ignore lint/suspicious/noExplicitAny: a request body
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = Object.keys(handlers)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const body = key ? await (handlers[key] as Handler)(init, url) : {};
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status: body === undefined ? 204 : method === 'POST' ? 201 : 200,
      });
    }),
  );
  return calls;
}
const owner = {
  'GET /api/auth/me': () => ({
    user: { id: 'u', email: 'o@example.com', displayName: 'Owner' },
    activeOrg: { id: 'o', name: 'Org', role: 'owner' },
    orgs: [{ id: 'o', role: 'owner' }],
  }),
};
const wrap = (ui: ReactNode, path = '/x') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/persona-chats/:id" element={<p>persona chat page</p>} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
afterEach(() => vi.unstubAllGlobals());

const myPack = (over: Record<string, unknown> = {}) => ({
  id: PACK,
  name: 'mine',
  description: 'My things',
  visibility: 'private',
  state: 'private',
  workstationId: WS,
  workstationName: 'Desk',
  workstationOnline: true,
  supported: true,
  revision: 1,
  pinnedSha: 'a'.repeat(64),
  status: 'ready',
  error: null,
  items: [{ kind: 'persona', key: 'mine:critic', name: 'Critic', description: 'Doubts' }],
  hasScripts: false,
  saving: false,
  update: null,
  mayApprove: true,
  holders: [],
  createdAt: AT,
  grantedAgentIds: [],
  ...over,
});
const myPacks = (packs: unknown[] = [myPack()]) => ({
  packs,
  workstations: [{ id: WS, name: 'Desk', online: true, supported: true }],
});

const persona: AuthoredCapability = {
  kind: 'persona',
  key: 'critic',
  name: 'Critic',
  description: 'Finds the weak spot.',
  stance: 'Doubt first.',
  voice: 'Terse',
  icon: 'x',
  tools: ['read'],
  prompt: 'You find the weak spot.',
};

describe('the capability editor', () => {
  it('validates live with the shared parsers, blocks saving on errors and saves the pack in the standard layout', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <PackEditor
        name="mine"
        description=""
        initialTree={{}}
        saving={false}
        canApprove={false}
        orgVisible={false}
        onSave={onSave}
        onClose={() => undefined}
      />,
    );
    // nothing yet: cannot save
    expect(screen.getByTestId('save-pack')).toBeDisabled();
    await user.click(screen.getByTestId('add-persona'));
    await user.type(screen.getByLabelText('Key of the new persona'), 'critic');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    // a new persona is empty: the parser's errors are shown and saving is blocked
    expect(screen.getByTestId('editor-blocked')).toBeInTheDocument();
    expect(screen.getAllByTestId('editor-issues')[0]).toHaveTextContent(/Error/);
    expect(screen.getByTestId('save-pack')).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Critic');
    await user.type(screen.getByLabelText('Icon'), 'x');
    await user.type(screen.getByLabelText('Description'), 'Finds the weak spot.');
    await user.type(screen.getByLabelText('Stance'), 'Doubt first.');
    await user.type(screen.getByLabelText('Voice'), 'Terse');
    await user.type(screen.getByLabelText('Prompt'), 'You find the weak spot.');
    await waitFor(() => expect(screen.queryByTestId('editor-blocked')).not.toBeInTheDocument());
    // the tools profile maps to the persona's tools
    await user.selectOptions(screen.getByTestId('tools-profile'), 'shell');
    await user.click(screen.getByTestId('save-pack'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [tree, approve] = onSave.mock.calls[0] as [Record<string, string>, boolean];
    expect(approve).toBe(false);
    // what is saved is the standard pack layout: a git pack indexes it, and the editor reads it back
    expect(Object.keys(tree).sort()).toEqual(['README.md', 'personas/critic.md']);
    const back = capabilitiesOfTree(tree).caps[0];
    expect(back).toMatchObject({ kind: 'persona', key: 'critic', tools: ['read', 'edit', 'shell'] });
  });

  it('edits a skill with a script file (a warning, not an error) and a playbook with ordered steps', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const tree = packTree([
      {
        kind: 'skill',
        key: 'tidy',
        description: 'Tidy up.',
        body: 'Do it.',
        files: { 'scripts/run.sh': 'echo' },
      },
      {
        kind: 'playbook',
        key: 'flow',
        description: 'A flow.',
        workflow: 'Go.',
        steps: [{ slug: 'one', text: 'First' }],
        files: {},
      },
    ]);
    render(
      <PackEditor
        name="mine"
        description=""
        initialTree={tree}
        saving={false}
        canApprove={false}
        orgVisible={false}
        onSave={onSave}
        onClose={() => undefined}
      />,
    );
    await user.click(screen.getByTestId('editor-cap-skill-tidy'));
    expect(screen.getByTestId('extra-files')).toHaveTextContent('scripts/run.sh');
    expect(screen.getAllByTestId('editor-issues')[0]).toHaveTextContent(/stays disabled until/);
    expect(screen.getByTestId('save-pack')).toBeEnabled();
    await user.click(screen.getByTestId('editor-cap-playbook-flow'));
    await user.click(screen.getByRole('button', { name: 'Add a step' }));
    expect(within(screen.getByTestId('steps')).getAllByText(/Step 0[12]/)).toHaveLength(2);
    await user.click(screen.getByTestId('save-pack'));
    const saved = onSave.mock.calls[0]?.[0] as Record<string, string>;
    expect(Object.keys(saved)).toContain('playbooks/flow/steps/step-02-step-2.md');
  });

  it('offers the approval checkbox only to an Owner or Admin of an organization pack', () => {
    const { rerender } = render(
      <PackEditor
        name="mine"
        description=""
        initialTree={packTree([persona])}
        saving={false}
        canApprove
        orgVisible
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByLabelText(/Approve this version myself/)).toBeInTheDocument();
    rerender(
      <PackEditor
        name="mine"
        description=""
        initialTree={packTree([persona])}
        saving={false}
        canApprove={false}
        orgVisible
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByLabelText(/Approve this version myself/)).not.toBeInTheDocument();
  });

  it('exports a zip that unzips to the pack layout', async () => {
    const user = userEvent.setup();
    let blob: Blob | undefined;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => {
        blob = b;
        return 'blob:x';
      },
      revokeObjectURL: () => undefined,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(
      <PackEditor
        name="mine"
        description=""
        initialTree={packTree([persona])}
        saving={false}
        canApprove={false}
        orgVisible={false}
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    await user.click(screen.getByTestId('export-zip'));
    expect(click).toHaveBeenCalled();
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
      r.readAsArrayBuffer(blob as Blob);
    });
    expect(Object.keys(unzipTree(bytes, 'mine')).sort()).toEqual(['README.md', 'personas/critic.md']);
    click.mockRestore();
  });
});

describe('My capabilities', () => {
  it('lists my packs with their state and creates a private one on my workstation', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...owner,
      'GET /api/my-capabilities': () => myPacks(),
      'GET /api/pack-assignments': () => ({ items: [] }),
      'POST /api/my-capabilities': () => ({
        pack: myPack({
          id: '0192f3a0-0000-7000-8000-0000000000c3',
          name: 'fresh',
          state: 'draft',
          pinnedSha: null,
        }),
      }),
    });
    wrap(<MyCapabilitiesTab />);
    const card = await screen.findByTestId('my-pack-mine');
    expect(within(card).getByTestId('pack-state')).toHaveTextContent('private to my workstation');
    expect(card).toHaveTextContent('Stored on Desk');
    await user.click(screen.getByTestId('new-pack'));
    await user.type(screen.getByLabelText('Name'), 'fresh');
    expect(screen.getByLabelText('Who can use it')).toHaveValue('private');
    await user.click(screen.getByRole('button', { name: 'Create pack' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/my-capabilities')).toBe(true),
    );
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/my-capabilities')?.body).toEqual({
      name: 'fresh',
      description: '',
      visibility: 'private',
      workstationId: WS,
    });
  });

  it('shares a private pack with the organization only after a confirmation, and says it needs a review', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...owner,
      'GET /api/my-capabilities': () => myPacks(),
      'GET /api/pack-assignments': () => ({ items: [] }),
      'PUT /api/my-capabilities/': () => undefined,
    });
    wrap(<MyCapabilitiesTab />);
    await user.click(await screen.findByTestId('toggle-visibility'));
    expect(
      await screen.findByText(/Nobody can use it until they approve this exact version/),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Share it' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.url).toBe(`/api/my-capabilities/${PACK}/visibility`),
    );
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ visibility: 'org' });
  });

  it('marks an organization pack that waits for review, and the save the organization has not approved yet', async () => {
    stub({
      ...owner,
      'GET /api/my-capabilities': () =>
        myPacks([
          myPack({
            visibility: 'org',
            state: 'in_review',
            update: { sha: 'b'.repeat(64), ref: 'v2', diff: {}, foundAt: AT },
          }),
        ]),
      'GET /api/pack-assignments': () => ({ items: [] }),
    });
    wrap(<MyCapabilitiesTab />);
    const card = await screen.findByTestId('my-pack-mine');
    expect(within(card).getByTestId('pack-state')).toHaveTextContent('waiting for an Owner or Admin');
    expect(card).toHaveTextContent(/waits for an Owner or Admin to review it/);
  });

  it('opens a saved pack in the editor: the files come back sealed to a key only this page has', async () => {
    const user = userEvent.setup();
    let replyKey = '';
    stub({
      ...owner,
      'GET /api/my-capabilities': () => myPacks(),
      'GET /api/pack-assignments': () => ({ items: [] }),
      'GET /api/agents': () => ({ agents: [] }),
      'POST /api/my-capabilities/': (init) => {
        replyKey = JSON.parse(String(init.body)).replyKey;
        return { requestId: '0192f3a0-0000-7000-8000-0000000000e9' };
      },
      'GET /api/my-capabilities/reads/': async () => ({
        status: 'ready',
        ciphertext: await sealLarge(replyKey, JSON.stringify({ tree: packTree([persona]) })),
      }),
    });
    wrap(<MyCapabilitiesTab />);
    await user.click(await screen.findByTestId('edit-pack'));
    expect(await screen.findByTestId('pack-editor')).toBeInTheDocument();
    expect(screen.getByTestId('editor-cap-persona-critic')).toBeInTheDocument();
    // the private pack offers the grant of agents of its workstation
    expect(screen.getByTestId('grant-agents')).toHaveTextContent('No agent runs on this workstation');
  });

  it('shows a refusal of the workstation, and offline editing as a message instead of a spinner', async () => {
    const user = userEvent.setup();
    stub({
      ...owner,
      'GET /api/my-capabilities': () =>
        myPacks([myPack({ error: 'the pack has no skill, persona or playbook yet' })]),
      'GET /api/pack-assignments': () => ({ items: [] }),
      'POST /api/my-capabilities/': () => ({ requestId: '0192f3a0-0000-7000-8000-0000000000e1' }),
      'GET /api/my-capabilities/reads/': () => ({
        status: 'failed',
        error: 'the workstation did not answer',
      }),
    });
    wrap(<MyCapabilitiesTab />);
    expect(await screen.findByTestId('pack-error')).toHaveTextContent('no skill, persona or playbook');
    await user.click(screen.getByTestId('edit-pack'));
    expect(await screen.findByRole('alert')).toHaveTextContent('the workstation did not answer');
  });
});

describe('member opt-in', () => {
  it('asks the member before a pack lands on their workstation, and sends their answer', async () => {
    const user = userEvent.setup();
    const calls = stub({
      'GET /api/pack-assignments': () => ({
        items: [
          {
            packId: PACK,
            packName: 'acme',
            url: 'ssh://git@git.example.org/acme/skills.git',
            ref: 'main',
            private: true,
            workstationId: WS,
            workstationName: 'Desk',
            requestedByName: 'Olga',
            deskItemId: null,
            requestedAt: AT,
          },
        ],
      }),
      'POST /api/pack-assignments/': () => undefined,
    });
    wrap(<PackAssignments />);
    const card = await screen.findByTestId('assignment-acme');
    expect(card).toHaveTextContent('Allow the pack "acme" on Desk?');
    expect(card).toHaveTextContent('Nothing is downloaded until you accept');
    expect(card).toHaveTextContent('deploy key or token was sealed for this workstation');
    await user.click(within(card).getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.url).toBe(`/api/pack-assignments/${PACK}/decide`),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ workstationId: WS, accept: false });
  });
});

describe('hire from pack', () => {
  const personaDto = (over: Record<string, unknown> = {}) => ({
    key: 'analyst',
    name: 'Mary, Analyst',
    description: 'Digs into the problem.',
    icon: 'M',
    declaredTools: ['read', 'shell'],
    permissions: {
      allowedTools: ['read'],
      deniedShellPatterns: [],
      writableGlobs: [],
      mayCommit: false,
      browser: false,
      riskTiers: ['small', 'large'],
      readOrgRepos: false,
      repoIds: null,
    },
    withheld: ['the shell tool'],
    provenanceLabel: 'BMAD · analyst · v6.12.4',
    roleKey: 'bmad-analyst',
    role: null,
    hiredAgentIds: [],
    ...over,
  });
  const base = (personas: unknown[]) => ({
    ...owner,
    'GET /api/workstations': () => ({
      workstations: [
        {
          id: WS,
          userId: 'u',
          name: 'Desk',
          status: 'active',
          connected: true,
          runtimes: [{ id: 'mock', version: '1', available: true, capabilities: [] }],
          repos: [],
          pairedAt: AT,
          platform: null,
          hostname: null,
          runnerVersion: null,
          lastSeenAt: null,
        },
      ],
    }),
    [`GET /api/packs/${PACK}/personas`]: () => ({
      packId: PACK,
      packName: 'bmad',
      trusted: true,
      readableNow: true,
      personas,
    }),
  });

  it('lists the personas with the permissions this user could grant, a review list, and hires with the provenance', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...base([personaDto()]),
      [`POST /api/packs/${PACK}/hire`]: () => ({ requestId: '0192f3a0-0000-7000-8000-0000000000e2' }),
      'GET /api/pack-hires/': () => ({
        requestId: 'x',
        status: 'done',
        error: null,
        agents: [{ agentId: 'a1', name: 'Mary', roleKey: 'bmad-analyst' }],
      }),
    });
    const onClose = vi.fn();
    wrap(<HirePackDialog packId={PACK} packName="bmad" onClose={onClose} />);
    const row = await screen.findByTestId('persona-analyst');
    expect(row).toHaveTextContent('BMAD · analyst · v6.12.4');
    await user.click(within(row).getByLabelText('Hire Mary, Analyst'));
    expect(screen.getByTestId('permissions-analyst')).toHaveTextContent('Tools it would get: read');
    expect(screen.getByTestId('permissions-analyst')).toHaveTextContent(
      'Withheld, because you may not grant it: the shell tool',
    );
    expect(screen.getByTestId('hire-review')).toHaveTextContent('bmad-analyst');
    const name = screen.getByLabelText('Agent name for Mary, Analyst');
    await user.clear(name);
    await user.type(name, 'Mary');
    await user.click(screen.getByTestId('confirm-hire'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const hire = calls.find((c) => c.method === 'POST' && c.url.endsWith('/hire'));
    expect(hire?.body).toEqual({ items: [{ key: 'analyst', name: 'Mary' }], workstationId: WS, capacity: 1 });
  });

  it('adds every agent of the pack at once and lists them for review before confirming', async () => {
    const user = userEvent.setup();
    stub(
      base([
        personaDto(),
        personaDto({
          key: 'architect',
          name: 'Winston',
          roleKey: 'bmad-architect',
          provenanceLabel: 'BMAD · architect · v6.12.4',
        }),
      ]),
    );
    wrap(<HirePackDialog packId={PACK} packName="bmad" onClose={() => undefined} />);
    await user.click(await screen.findByTestId('add-all'));
    expect(screen.getByTestId('confirm-hire')).toHaveTextContent('Hire 2 agents');
    expect(screen.getByTestId('hire-review')).toHaveTextContent('bmad-architect');
    expect(screen.getByTestId('hire-review')).toHaveTextContent('bmad-analyst');
  });

  it('says so when no workstation holding the pack is online, or the pack is not approved', async () => {
    stub({
      ...base([personaDto()]),
      [`GET /api/packs/${PACK}/personas`]: () => ({
        packId: PACK,
        packName: 'bmad',
        trusted: true,
        readableNow: false,
        personas: [personaDto()],
      }),
    });
    wrap(<HirePackDialog packId={PACK} packName="bmad" onClose={() => undefined} />);
    expect(await screen.findByTestId('hire-offline')).toBeInTheDocument();
  });

  it('shows the provenance tag on an agent, with a warning when the pack lost its approval', () => {
    render(
      <PackProvenance
        agent={{
          provenance: {
            packId: PACK,
            packName: 'bmad',
            capability: 'analyst',
            ref: 'v6.12.4',
            sha: 'a'.repeat(40),
            hash: H,
            visibility: 'org',
            label: 'BMAD · analyst · v6.12.4',
            warning: 'revoked',
          },
        }}
      />,
    );
    expect(screen.getByTestId('pack-provenance')).toHaveTextContent('BMAD · analyst · v6.12.4');
    expect(screen.getByTestId('pack-provenance-warning')).toHaveTextContent('pack no longer approved');
  });
});

describe('role update offers', () => {
  it('shows the offer, reads the new version, shows the diff of the instructions and accepts only on request', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...owner,
      'GET /api/role-offers': () => ({
        items: [
          {
            roleKey: 'bmad-analyst',
            roleName: 'Mary, Analyst',
            fromVersion: 1,
            packId: PACK,
            packName: 'bmad',
            capability: 'analyst',
            provenance: {
              packId: PACK,
              packName: 'bmad',
              capability: 'analyst',
              ref: 'v6.13.0',
              sha: 'b'.repeat(40),
              hash: H,
              visibility: 'org',
            },
            newLabel: 'BMAD · analyst · v6.13.0',
            offeredAt: AT,
            agentCount: 2,
          },
        ],
      }),
      'POST /api/role-offers/bmad-analyst/review': () => ({
        requestId: '0192f3a0-0000-7000-8000-0000000000e3',
      }),
      'GET /api/role-offers/bmad-analyst/review/': () => ({
        requestId: '0192f3a0-0000-7000-8000-0000000000e3',
        status: 'ready',
        error: null,
        current: 'Line one\nOld line\nLine three',
        proposed: 'Line one\nNew line\nLine three',
      }),
      'POST /api/role-offers/bmad-analyst/accept': () => ({ version: 2, movedAgents: 2 }),
    });
    wrap(<RoleOffers />);
    const offer = await screen.findByTestId('role-offer-bmad-analyst');
    expect(offer).toHaveTextContent('keep it until you accept');
    await user.click(within(offer).getByRole('button', { name: 'Review the change' }));
    await user.click(await screen.findByTestId('load-diff'));
    const diff = await screen.findByTestId('role-diff');
    const kinds = Array.from(diff.querySelectorAll('[data-kind]')).map(
      (n) => `${n.getAttribute('data-kind')}:${n.textContent?.trim()}`,
    );
    expect(kinds).toEqual(['same:Line one', 'del:- Old line', 'add:+ New line', 'same:Line three']);
    expect(calls.some((c) => c.url.endsWith('/accept'))).toBe(false);
    await user.click(screen.getByTestId('accept-offer'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/accept'))?.body).toEqual({
        requestId: '0192f3a0-0000-7000-8000-0000000000e3',
      }),
    );
  });

  it('diffs lines', () => {
    expect(diffLines('a\nb', 'a\nc').map((l) => l.kind)).toEqual(['same', 'del', 'add']);
  });
});

describe('chat with a persona', () => {
  it('starts a chat from a registry row and opens it', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...owner,
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/capabilities': () => ({
        items: [
          {
            kind: 'persona',
            key: 'devils-advocate',
            name: "Devil's Advocate",
            description: 'Attacks the plan.',
            hash: H,
            source: 'builtin',
            overrides: false,
            usable: true,
          },
          {
            kind: 'persona',
            key: 'mine:critic',
            name: 'Critic',
            description: 'Mine.',
            hash: H,
            source: 'pack',
            pack: 'mine',
            overrides: false,
            usable: true,
            visibility: 'private',
          },
          {
            kind: 'persona',
            key: 'crew:locked',
            name: 'Locked',
            description: 'Not approved.',
            hash: H,
            source: 'pack',
            pack: 'crew',
            overrides: false,
            usable: false,
            unusableReason: 'untrusted',
          },
        ],
        issues: [],
        indexedAt: null,
      }),
      'POST /api/persona-chats': () => ({ session: { threadId: '0192f3a0-0000-7000-8000-0000000000d1' } }),
    });
    wrap(<RegistryTab />);
    expect(await screen.findByTestId('private-badge')).toHaveTextContent('private to you');
    // no chat with a persona that cannot be used
    expect(screen.queryByTestId('chat-with-crew:locked')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('chat-with-mine:critic'));
    expect(await screen.findByLabelText('Model')).toHaveValue('');
    await user.click(screen.getByTestId('start-persona-chat'));
    await waitFor(() => expect(screen.getByText('persona chat page')).toBeInTheDocument());
    expect(calls.find((c) => c.url === '/api/persona-chats')?.body).toEqual({ personaKey: 'mine:critic' });
  });
});
