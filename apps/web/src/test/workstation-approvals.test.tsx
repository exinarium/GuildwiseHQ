import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkstationApprovals } from '../pages/WorkstationApprovals.tsx';

/*
 * Workstation page > Approvals (R22): the held list with "Approve with passkey" only for the two routine kinds, the relay
 * of the assertion, the runner's answer, and adding / removing a passkey with the reminder that only
 * `guildwise-runner passkey trust` on the machine makes it count.
 */
const webauthn = vi.hoisted(() => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => webauthn);

const WS = '0192f3a0-0000-7000-8000-000000000010';
const PK = '0192f3a0-0000-7000-8000-000000000020';
const CRED = 'Y3JlZGVudGlhbC1pZC1vbmUtdHdvLXRocmVl';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const future = () => new Date(Date.now() + 240_000).toISOString();

const held = (over: Record<string, unknown> = {}) => ({
  online: true,
  reportedAt: '2026-11-21T10:00:00.000Z',
  items: [
    {
      id: 'recipe-1',
      kind: 'recipe.write',
      summary: 'write recipe for Shop (staging)',
      commandHash: 'a'.repeat(64),
      createdAt: '2026-11-21T09:59:00.000Z',
      expiresAt: '2026-11-22T09:59:00.000Z',
      passkey: { challenge: 'Y2hhbGxlbmdl', nonce: 'bm9uY2U', expiresAt: future(), credentialIds: [CRED] },
      passkeyApprovable: true,
    },
    {
      id: 'grant-1',
      kind: 'devops.request',
      summary: 'DevOps engineer asks for sudo',
      commandHash: 'b'.repeat(64),
      createdAt: '2026-11-21T09:58:00.000Z',
      expiresAt: '2026-11-22T09:58:00.000Z',
      passkeyApprovable: false,
    },
  ],
  relays: [],
  ...over,
});

let approvals: ReturnType<typeof held>;
let passkeys: Array<Record<string, unknown>>;
const calls: Array<[string, string, unknown]> = [];

beforeEach(() => {
  calls.length = 0;
  approvals = held();
  passkeys = [];
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push([method, url, init.body ? JSON.parse(String(init.body)) : undefined]);
      if (url === '/api/workstations')
        return json({
          workstations: [
            {
              id: WS,
              userId: WS,
              name: 'Desk',
              platform: 'linux',
              hostname: 'desk.lan',
              runnerVersion: '1.10.0',
              status: 'active',
              connected: true,
              lastSeenAt: '2026-11-21T10:00:00.000Z',
              runtimes: [],
              repos: [],
              pairedAt: '2026-11-01T10:00:00.000Z',
            },
          ],
        });
      if (url === `/api/workstations/${WS}/passkeys` && method === 'GET')
        return json({ passkeys, rpId: window.location.hostname, origin: window.location.origin });
      if (url === `/api/workstations/${WS}/approvals`) return json(approvals);
      if (url === `/api/workstations/${WS}/approvals/recipe-1/passkey`) {
        approvals = held({
          relays: [
            {
              commandId: 'c1',
              itemId: 'recipe-1',
              status: 'refused',
              error: 'nonce already used',
              at: '2026-11-21T10:00:05.000Z',
            },
          ],
        });
        return json({ relayed: true, commandId: 'c1' }, 202);
      }
      if (url === `/api/workstations/${WS}/passkeys/options`)
        return json({
          options: { challenge: 'cmVnLWNoYWxsZW5nZQ', rp: { id: 'x' } },
          registrationToken: 'tok.sig',
        });
      if (url === `/api/workstations/${WS}/passkeys` && method === 'POST') {
        const dto = {
          id: PK,
          name: 'work laptop',
          credentialId: CRED,
          alg: -7,
          createdAt: '2026-11-21T10:01:00.000Z',
        };
        passkeys = [dto];
        return json(dto, 201);
      }
      if (url === `/api/workstations/${WS}/passkeys/${PK}` && method === 'DELETE') {
        passkeys = [];
        return json({ ok: true });
      }
      return json({ error: { code: 'not_found', message: `unexpected ${method} ${url}` } }, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/workstations/${WS}/approvals`]}>
        <Routes>
          <Route path="/workstations/:id/approvals" element={<WorkstationApprovals />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Approvals page (R22)', () => {
  it('offers a passkey only for the routine kinds; everything else says to approve on the workstation', async () => {
    renderPage();
    const recipe = await screen.findByTestId('held-recipe-1');
    expect(within(recipe).getByText('Recipe change')).toBeTruthy();
    expect(within(recipe).getByRole('button', { name: /Approve with passkey/ })).toBeTruthy();
    const grant = screen.getByTestId('held-grant-1');
    expect(within(grant).queryByRole('button', { name: /Approve with passkey/ })).toBeNull();
    expect(within(grant).getByTestId('local-only-grant-1').textContent).toContain(
      'guildwise-runner approve grant-1',
    );
    expect(screen.getByTestId('approvals-rule').textContent).toContain('guildwise-runner passkey trust');
  });

  it('asks the passkey for the runner’s challenge, relays the assertion and shows the runner’s answer', async () => {
    webauthn.startAuthentication.mockResolvedValue({
      id: CRED,
      rawId: CRED,
      type: 'public-key',
      response: { authenticatorData: 'YXV0aA', clientDataJSON: 'Y2Q', signature: 'c2ln', userHandle: 'dWg' },
      clientExtensionResults: {},
    });
    renderPage();
    await userEvent.click(await screen.findByTestId('approve-recipe-1'));
    await waitFor(() => expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1));
    expect(webauthn.startAuthentication.mock.calls[0]?.[0]).toEqual({
      optionsJSON: {
        challenge: 'Y2hhbGxlbmdl',
        rpId: window.location.hostname,
        allowCredentials: [{ id: CRED, type: 'public-key' }],
        userVerification: 'required',
        timeout: 120_000,
      },
    });
    await waitFor(() =>
      expect(calls.find(([m, u]) => m === 'POST' && u.endsWith('/approvals/recipe-1/passkey'))?.[2]).toEqual({
        credentialId: CRED,
        authenticatorData: 'YXV0aA',
        clientDataJSON: 'Y2Q',
        signature: 'c2ln',
        userHandle: 'dWg',
      }),
    );
    expect((await screen.findByTestId('relay-recipe-1')).textContent).toContain(
      'The workstation refused the passkey: nonce already used',
    );
  });

  it('a cancelled passkey prompt relays nothing', async () => {
    webauthn.startAuthentication.mockRejectedValue(
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
    );
    renderPage();
    await userEvent.click(await screen.findByTestId('approve-recipe-1'));
    expect(await screen.findByText('The passkey prompt was cancelled or timed out.')).toBeTruthy();
    expect(calls.some(([m, u]) => m === 'POST' && u.includes('/approvals/'))).toBe(false);
  });

  it('adds a passkey and says it counts only after passkey trust on the workstation; removes one', async () => {
    const registration = {
      id: CRED,
      rawId: CRED,
      type: 'public-key',
      response: { clientDataJSON: 'Y2Q', attestationObject: 'YW8' },
    };
    webauthn.startRegistration.mockResolvedValue(registration);
    renderPage();
    await userEvent.type(await screen.findByLabelText('Passkey name'), 'work laptop');
    await userEvent.click(screen.getByTestId('add-passkey'));
    const added = await screen.findByTestId('passkey-added');
    expect(added.textContent).toContain('guildwise-runner passkey trust');
    expect(added.textContent).toContain(CRED.slice(0, 12));
    expect(webauthn.startRegistration.mock.calls[0]?.[0]).toEqual({
      optionsJSON: { challenge: 'cmVnLWNoYWxsZW5nZQ', rp: { id: 'x' } },
    });
    expect(calls.find(([m, u]) => m === 'POST' && u === `/api/workstations/${WS}/passkeys`)?.[2]).toEqual({
      name: 'work laptop',
      registrationToken: 'tok.sig',
      response: registration,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Remove passkey work laptop' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls.some(([m, u]) => m === 'DELETE' && u === `/api/workstations/${WS}/passkeys/${PK}`)).toBe(
        true,
      ),
    );
  });

  it('shows an offline workstation, and disables passkeys where the browser has none', async () => {
    approvals = held({ online: false, items: [] });
    vi.stubGlobal('PublicKeyCredential', undefined);
    renderPage();
    expect(await screen.findByText(/This workstation is offline/)).toBeTruthy();
    const add = await screen.findByTestId('add-passkey');
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This browser cannot use passkeys.')).toBeTruthy();
  });
});
