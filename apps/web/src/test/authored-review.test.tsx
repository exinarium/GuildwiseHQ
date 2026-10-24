/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  type AuthoredCapability,
  authoredTreeContentHash,
  type PackDto,
  packTree,
  sealLarge,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackEditor } from '../components/capabilities/CapabilityEditor.tsx';
import { TrustReview } from '../components/capabilities/TrustReview.tsx';
import { UpdateReview } from '../components/capabilities/UpdateReview.tsx';
import { ToastProvider } from '../components/ui.tsx';

/** Q57 and R3c: the reviewer reads the text of an authored organization pack; the author sees a diff against the approved version. */
const PACK = '0192f3a0-0000-7000-8000-0000000000c2';
const AT = '2026-10-24T10:00:00.000Z';
const critic = (prompt: string): AuthoredCapability => ({
  kind: 'persona',
  key: 'critic',
  name: 'Critic',
  description: 'Finds the weak spot.',
  stance: 'Doubt first.',
  voice: 'Terse',
  icon: 'x',
  tools: ['read'],
  prompt,
});
const v1 = packTree([critic('You find the weak spot in a plan.')], { name: 'crew', description: '' });
const v2 = packTree([critic('You find the weak spot, then the second one.')], {
  name: 'crew',
  description: '',
});
const sha1 = authoredTreeContentHash('crew', v1);
const sha2 = authoredTreeContentHash('crew', v2);

const pack = (over: Partial<PackDto> = {}): PackDto =>
  ({
    id: PACK,
    name: 'crew',
    url: 'authored:x',
    ref: 'v1',
    adapter: 'generic',
    scope: 'org',
    projectId: null,
    preset: null,
    status: 'ready',
    error: null,
    pinnedSha: sha1,
    contentHash: sha1,
    trusted: false,
    trustedSha: null,
    scriptsEnabled: false,
    hasScripts: false,
    license: null,
    integrityFailed: false,
    itemCount: 1,
    workstationIds: [],
    update: null,
    lastCheckedAt: null,
    addedAt: AT,
    attribution: null,
    source: 'authored',
    visibility: 'org',
    ownerUserId: 'm',
    ownerName: 'Mia',
    description: '',
    credentialKind: null,
    credentialFingerprint: null,
    revision: 1,
    holders: [],
    ...over,
  }) as PackDto;

type Handler = (init: RequestInit, url: string) => unknown | Promise<unknown>;
function stub(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = Object.keys(handlers)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const body = key ? await (handlers[key] as Handler)(init, url) : {};
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status: body === undefined ? 204 : method === 'POST' ? 202 : 200,
      });
    }),
  );
  return calls;
}
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
afterEach(() => vi.unstubAllGlobals());

const detail = (p: PackDto, snapSha: string) => ({
  pack: {
    ...p,
    updateSnapshot: null,
    snapshot: {
      ref: 'v1',
      sha: snapSha,
      contentHash: snapSha,
      adapter: 'generic',
      items: [],
      issues: [],
      notes: [],
      license: null,
      hasScripts: false,
    },
  },
});

/** The review-read answers like the author's workstation: sealed to the key this page made. */
function readHandlers(content: unknown | (() => unknown)) {
  let replyKey = '';
  return {
    'POST /api/packs/': (init: RequestInit) => {
      replyKey = JSON.parse(String(init.body)).replyKey;
      return { requestId: '0192f3a0-0000-7000-8000-0000000000e9' };
    },
    'GET /api/packs/reads/': async () => ({
      status: 'ready',
      ciphertext: await sealLarge(
        replyKey,
        JSON.stringify(typeof content === 'function' ? (content as () => unknown)() : content),
      ),
    }),
  };
}

describe('the reviewer reads an authored organization pack (Q57)', () => {
  it('shows the files of the pack before approval, and approval waits for them', async () => {
    const user = userEvent.setup();
    const calls = stub({
      [`GET /api/packs/${PACK}`]: () => detail(pack(), sha1),
      ...readHandlers({ tree: v1, sha: sha1 }),
      [`POST /api/packs/${PACK}/trust`]: () => ({ pack: pack() }),
    });
    wrap(<TrustReview pack={pack()} onClose={() => undefined} />);
    expect(await screen.findByTestId('authored-files')).toBeInTheDocument();
    // the request asks the server to relay a read of the author's workstation, with the approved revision as well
    const start = calls.find((c) => c.url === `/api/packs/${PACK}/review-read`);
    expect(start?.body.replyKey).toBeTruthy();
    expect(start?.body.withPinned).toBe(true);
    // every file is there with its text
    await user.click(await screen.findByText('personas/critic.md'));
    expect(await screen.findByText(/You find the weak spot in a plan/)).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve this exact commit and content' });
    await waitFor(() => expect(approve).toBeEnabled());
    await user.click(approve);
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/trust'))?.body).toEqual({ sha: sha1, contentHash: sha1 }),
    );
  });

  it('refuses to approve unread content: files that do not hash to the submitted content, or a workstation that does not answer', async () => {
    const user = userEvent.setup();
    stub({
      [`GET /api/packs/${PACK}`]: () => detail(pack(), sha1),
      // the workstation holds other files than the ones submitted for review
      ...readHandlers({ tree: v2, sha: sha2 }),
    });
    const first = wrap(<TrustReview pack={pack()} onClose={() => undefined} />);
    expect(await screen.findByTestId('authored-read-mismatch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve this exact commit and content' })).toBeDisabled();
    first.unmount();

    stub({
      [`GET /api/packs/${PACK}`]: () => detail(pack(), sha1),
      'POST /api/packs/': () => ({ requestId: '0192f3a0-0000-7000-8000-0000000000e8' }),
      'GET /api/packs/reads/': () => ({ status: 'failed', error: 'the workstation did not answer' }),
    });
    wrap(<TrustReview pack={pack()} onClose={() => undefined} />);
    const err = await screen.findByTestId('authored-read-error');
    expect(err).toHaveTextContent('the workstation did not answer');
    expect(screen.getByRole('button', { name: 'Approve this exact commit and content' })).toBeDisabled();
    await user.click(within(err).getByRole('button', { name: 'Try again' }));
  });

  it('Q67: with the author workstation offline the review says it waits and that the desk will say when it is back, and shows the files once read', async () => {
    let waiting = true;
    stub({
      [`GET /api/packs/${PACK}`]: () => detail(pack(), sha1),
      [`GET /api/packs/${PACK}/review-wait`]: () => ({
        waiting,
        workstationName: "Mia's laptop",
        since: AT,
      }),
      'POST /api/packs/': () => ({
        requestId: '0192f3a0-0000-7000-8000-0000000000e7',
        wait: { waiting: true },
      }),
      // the read stays pending while the workstation is away
      'GET /api/packs/reads/': () => ({ status: 'pending' }),
    });
    wrap(<TrustReview pack={pack()} onClose={() => undefined} />);
    const note = await screen.findByTestId('authored-read-waiting');
    expect(note).toHaveTextContent("Waiting for Mia's laptop");
    expect(note).toHaveTextContent('the server keeps no copy');
    expect(note).toHaveTextContent('note on your desk');
    expect(screen.queryByTestId('authored-files')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve this exact commit and content' })).toBeDisabled();
    waiting = false;
  });

  it('does not ask for a read of a git pack', async () => {
    const calls = stub({ [`GET /api/packs/${PACK}`]: () => detail(pack({ source: 'git' }), sha1) });
    wrap(<TrustReview pack={pack({ source: 'git' })} onClose={() => undefined} />);
    await screen.findByTestId('trust-review');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.some((c) => c.url.includes('/review-read'))).toBe(false);
    expect(screen.queryByTestId('authored-files')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve this exact commit and content' })).toBeEnabled();
  });

  it('shows an update as a file list and a text diff against the approved revision', async () => {
    const user = userEvent.setup();
    stub({
      ...readHandlers({ tree: v2, sha: sha2, pinned: { tree: v1, sha: sha1 } }),
    });
    const p = pack({
      trusted: true,
      trustedSha: sha1,
      update: {
        sha: sha2 as never,
        ref: 'v2',
        foundAt: AT,
        diff: {
          hasChanges: true,
          counts: { filesAdded: 0, filesChanged: 1, filesRemoved: 0 },
          scriptsAdded: [],
          scriptsChanged: [],
          addedCapabilities: [],
          removedCapabilities: [],
          changedCapabilities: [],
        } as never,
      },
    });
    wrap(<UpdateReview pack={p} onClose={() => undefined} />);
    const files = await screen.findByTestId('authored-files');
    expect(within(files).getByTestId('version-diff-summary')).toHaveTextContent('1 changed');
    await user.click(within(files).getByText('personas/critic.md'));
    const diff = await within(files).findByTestId('text-diff');
    expect(diff.querySelector('[data-kind="del"]')?.textContent).toContain('weak spot in a plan');
    expect(diff.querySelector('[data-kind="add"]')?.textContent).toContain('second one');
    await waitFor(() => expect(screen.getByRole('button', { name: /Accept update/ })).toBeEnabled());
  });
});

describe('the author sees what changed since the approved version (R3c)', () => {
  it('shows a file list and a text diff in the editor against the approved revision, updated as they edit', async () => {
    const user = userEvent.setup();
    wrap(
      <PackEditor
        name="crew"
        description=""
        initialTree={v2}
        approvedTree={v1}
        saving={false}
        canApprove={false}
        orgVisible
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    const box = await screen.findByTestId('approved-diff');
    await user.click(within(box).getByText('Changes since the approved version'));
    expect(within(box).getByTestId('version-diff-summary')).toHaveTextContent('1 changed');
    await user.click(within(box).getByText('personas/critic.md'));
    expect(within(box).getByTestId('text-diff').querySelector('[data-kind="add"]')?.textContent).toContain(
      'second one',
    );
  });

  it('shows no diff for a pack without an earlier approved revision', async () => {
    wrap(
      <PackEditor
        name="crew"
        description=""
        initialTree={v1}
        saving={false}
        canApprove={false}
        orgVisible
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    await screen.findByTestId('pack-editor');
    expect(screen.queryByTestId('approved-diff')).toBeNull();
  });
});
