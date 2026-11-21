import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseSheet } from '../components/environments/ReleaseSheet.tsx';
import { ToastProvider } from '../components/ui.tsx';

vi.mock('../lib/orgRole.ts', () => ({
  useCanManageOrg: () => true,
  useActiveOrgRole: () => 'owner',
}));

/**
 * Release-flow signing on the release sheet (R30): per place, "Runner: not required", "waiting for signature" with the two
 * ways to sign, or "signed by <key id>"; Release now stays off for a place that takes only a signed runner until it is signed.
 */
const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SHA = '9f8e7d6c5b4a'.padEnd(40, '0');
const ART = 'a'.repeat(64);
const KEY = '515674AC008F1CF3';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
const calls: Array<{ url: string; method: string; body: unknown }> = [];
beforeEach(() => {
  calls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const envStatus = {
  environments: [
    {
      env: 'uat',
      label: 'Test site',
      role: 'live',
      hosting: 'ssh',
      runtime: 'docker',
      placeId: U(5),
      placeName: 'uat',
      appUrl: null,
      releasedBy: 'owner',
      updates: 'when you release',
      rules: [],
      current: null,
      health: { state: 'healthy', at: new Date().toISOString(), detail: null },
      lastRun: null,
      waitingRelease: null,
      blockedBy: [],
      savedState: 'saved',
      triedState: 'tried',
      approvalState: 'approved',
      openQuestions: 0,
      state: 'healthy',
      stateText: 'Ready.',
    },
  ],
  openQuestions: 0,
  deliveryMode: 'recipe',
  generatedAt: new Date().toISOString(),
};
const preview = {
  env: 'uat',
  repo: 'core',
  branch: 'development',
  sha: SHA,
  shortSha: SHA.slice(0, 7),
  subject: 'chore(release): 1.10.0',
  author: 'Sam',
  committedAt: new Date().toISOString(),
  source: 'release',
  sourceDetail: '1.10.0',
};
const target = (over: Record<string, unknown>) => ({
  targetId: U(5),
  targetName: 'uat',
  signing: {
    required: true,
    keyId: KEY,
    publicKey: `RW${'A'.repeat(54)}`,
    artefact: 'release/manifest.json',
  },
  state: 'waiting_signature',
  artefact: 'release/uat/manifest.json',
  artefactSha256: ART,
  preparedAt: new Date().toISOString(),
  signature: null,
  error: null,
  ...over,
});
const signingBody = (t: Record<string, unknown>) => ({
  env: 'uat',
  commit: SHA,
  release: { releaseId: U(7), version: '1.10.0', tag: 'v1.10.0' },
  targets: [t],
});

function route(signing: unknown) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith('/environments/status')) return json(envStatus);
    if (u.includes('/delivery/deploy/preview')) return json(preview);
    if (u.includes('/release-signing?')) return json(signing);
    if (method === 'POST') return json({ state: 'signing' }, 202);
    return json({});
  });
}
const open = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>
          <ReleaseSheet projectId={U(1)} env="uat" label="Test site" onClose={() => undefined} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('ReleaseSheet: runner signature per place (R30)', () => {
  it('waiting for a signature: both ways to sign, and Release now stays off with the reason', async () => {
    route(signingBody(target({})));
    open();
    expect(await screen.findByTestId('release-signing-uat-state')).toHaveTextContent(
      `Runner: waiting for signature by key ${KEY}`,
    );
    expect(screen.getByTestId('release-signing-uat-download')).toHaveTextContent(
      `Download manifest.json (sha256 ${ART.slice(0, 12)}`,
    );
    expect(screen.getByTestId('release-signing-uat-download')).toHaveAttribute(
      'href',
      `/api/projects/${U(1)}/release-signing/manifest?releaseId=${U(7)}&targetId=${U(5)}`,
    );
    expect(screen.getByTestId('release-now')).toBeDisabled();
    expect(screen.getByTestId('release-disabled-reason')).toHaveTextContent(
      'Waiting for a signed runner for uat.',
    );
    // the status is asked for the commit the sheet shows
    expect(calls.some((c) => c.url.includes(`/release-signing?env=uat&commit=${SHA}`))).toBe(true);
  });

  it('signs on the workstation, or uploads the offline .minisig with the sha256 it was downloaded at', async () => {
    route(signingBody(target({})));
    open();
    await userEvent.click(await screen.findByTestId('release-signing-uat-sign'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/release-signing/sign'))?.body).toEqual({
        releaseId: U(7),
        targetId: U(5),
      }),
    );
    const minisig =
      'untrusted comment: signature\nRUSwAAAA\ntrusted comment: guildwise-runner 1.10.0\nZZZZ\n';
    await userEvent.upload(
      screen.getByTestId('release-signing-uat-upload'),
      new File([minisig], 'manifest.json.minisig', { type: 'text/plain' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/release-signing/signature'))?.body).toEqual({
        releaseId: U(7),
        targetId: U(5),
        minisig,
        artefactSha256: ART,
      }),
    );
  });

  it('nothing packaged yet: the place offers to package its runner for the commit shown', async () => {
    route(signingBody(target({ state: 'not_prepared', artefactSha256: null, preparedAt: null })));
    open();
    expect(await screen.findByTestId('release-signing-uat-state')).toHaveTextContent(
      'Package the runner for this place first',
    );
    expect(screen.queryByTestId('release-signing-uat-download')).toBeNull();
    await userEvent.click(screen.getByTestId('release-signing-uat-prepare'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/release-signing/prepare'))?.body).toEqual({
        targetId: U(5),
        commit: SHA,
      }),
    );
    expect(screen.getByTestId('release-now')).toBeDisabled();
  });

  it('signed: says by which key, and Release now turns on', async () => {
    route(
      signingBody(
        target({
          state: 'signed',
          signature: { keyId: KEY, source: 'upload', at: new Date().toISOString() },
        }),
      ),
    );
    open();
    expect(await screen.findByTestId('release-signing-uat-state')).toHaveTextContent(
      `Runner: signed by ${KEY}`,
    );
    await waitFor(() => expect(screen.getByTestId('release-now')).toBeEnabled());
  });

  it('signed and kept for rollback: packaging again is offered only on purpose, after a confirm, and says it needs a new signature', async () => {
    route(
      signingBody(
        target({
          state: 'signed',
          signature: { keyId: KEY, source: 'upload', at: new Date().toISOString() },
        }),
      ),
    );
    open();
    const button = await screen.findByTestId('release-signing-uat-repackage');
    expect(button).toHaveTextContent('Package again (needs a new signature)');
    expect(screen.getByTestId('release-signing-uat')).toHaveTextContent('kept for a rollback');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(button);
    expect(calls.some((c) => c.url.endsWith('/release-signing/prepare'))).toBe(false);
    await userEvent.click(button);
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/release-signing/prepare'))?.body).toEqual({
        targetId: U(5),
        commit: SHA,
        repackage: true,
      }),
    );
    expect(confirm.mock.calls[0]?.[0]).toContain('waits for a new one');
    confirm.mockRestore();
  });

  it('a place that takes no signed runner shows no signing step and does not hold the release', async () => {
    route(
      signingBody(target({ signing: null, state: 'not_required', artefact: null, artefactSha256: null })),
    );
    open();
    await waitFor(() => expect(screen.getByTestId('release-now')).toBeEnabled());
    expect(screen.queryByTestId('release-signing')).toBeNull();
  });
});
