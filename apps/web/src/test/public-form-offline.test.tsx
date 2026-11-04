import { type FormDefinition, newFormDefinition, newFormField, publicFormView } from '@aom/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describePublicError } from '../public-form/messages.ts';
import { PublicFormPage } from '../public-form/PublicFormPage.tsx';

/** GWP-68: the firm's runner is offline. The page asks for an email address only and never sends answers or files. */
const PID = 'AbCdEfGhIjKlMnOpQrStUv';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string, message = 'x', extra: Record<string, unknown> = {}) =>
  json({ error: { code, message, ...extra } }, status);

const definition = (): FormDefinition => {
  const d = newFormDefinition('Rental application');
  const name = newFormField('short_text', 'full_name', 'Full name');
  name.required = true;
  const mail = newFormField('email', 'email_addr', 'Email');
  d.fields = [name, mail];
  return publicFormView(d);
};
const dto = (over: Record<string, unknown> = {}) => ({
  form: definition(),
  version: 1,
  logo: null,
  session: 's1.AAAAAAAAAAAAAAAA.abc.1.sig',
  powBits: 0,
  minFillMs: 0,
  availability: 'open',
  link: null,
  ...over,
});

type Call = { method: string; url: string; body: any };
let calls: Call[];
let handler: (c: Call) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = {
        method: init.method ?? 'GET',
        url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      };
      calls.push(c);
      return handler(c);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const setup = () => userEvent.setup({ applyAccept: false });

describe('availability offline at load', () => {
  it('shows the offline panel with no form fields, asks only for an email, and never sends answers', async () => {
    handler = (c) => {
      if (c.method === 'GET') return json(dto({ availability: 'offline' }));
      return json({ status: 'pending' }, 202);
    };
    const u = setup();
    render(<PublicFormPage publicId={PID} />);
    expect(await screen.findByTestId('public-offline')).toBeTruthy();
    expect(screen.queryByLabelText(/Full name/)).toBeNull();
    expect(screen.getByText(/we'll send you a secure link/i)).toBeTruthy();

    const email = screen.getByTestId('offline-email') as HTMLInputElement;
    // touch: the right keyboard, no zoom, a 44 px target
    expect(email.type).toBe('email');
    expect(email.getAttribute('inputmode')).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(email.className).toContain('text-base');
    expect(screen.getByTestId('offline-send').className).toContain('min-h-11');

    await u.type(email, 'ann@client.example');
    await u.click(screen.getByTestId('offline-send'));
    expect(await screen.findByTestId('public-offline-sent')).toBeTruthy();
    expect(
      screen.getByText(/We'll email you a secure link when Rental application is back online/),
    ).toBeTruthy();

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(`/api/public/forms/${PID}/offline-requests`);
    expect(Object.keys(post?.body).sort()).toEqual(['email', 'nonce', 'session', 'website']);
    expect(calls.some((c) => c.url.endsWith('/submissions'))).toBe(false);
  });

  it('shows the secure-link sentence, and creates no case, when the secure link is opened while offline again', async () => {
    handler = () =>
      json(
        dto({
          availability: 'offline',
          link: { state: 'valid', expiresAt: '2030-01-05T00:00:00.000Z', purpose: 'offline' },
        }),
      );
    render(<PublicFormPage publicId={PID} linkToken="v1.x" />);
    const closed = await screen.findByTestId('public-closed');
    expect(closed.textContent).toMatch(/can't receive your form right now/);
    expect(closed.textContent).toMatch(/secure link stays valid until/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

describe('a 503 runner_offline while sending', () => {
  it('drops the answers, switches to the offline panel and prefills the email from the form', async () => {
    let loads = 0;
    handler = (c) => {
      if (c.method === 'GET') return json(dto({ availability: ++loads > 1 ? 'offline' : 'open' }));
      if (c.url.endsWith('/submissions')) return err(503, 'runner_offline', 'x', { retryable: true });
      return json({ status: 'pending' }, 202);
    };
    const u = setup();
    render(<PublicFormPage publicId={PID} />);
    await u.type(await screen.findByLabelText(/Full name/), 'Ann Example');
    await u.type(screen.getByLabelText(/Email/), 'ann@client.example');
    await u.click(screen.getByRole('button', { name: /submit|send/i }));
    expect(await screen.findByTestId('public-offline')).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByTestId('offline-email') as HTMLInputElement).value).toBe('ann@client.example'),
    );
    expect(screen.queryByLabelText(/Full name/)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});

describe('secure link sentences', () => {
  it('uses the server sentence for an expired, used or revoked secure link, and the personal-link ones otherwise', () => {
    expect(
      describePublicError({
        code: 'link_expired',
        status: 410,
        retryable: false,
        message: 'This secure link has expired. Ask the firm for a new one.',
      }).text,
    ).toBe('This secure link has expired. Ask the firm for a new one.');
    expect(
      describePublicError({
        code: 'link_used',
        status: 410,
        retryable: false,
        message: 'This secure link was already used to send this form.',
      }).text,
    ).toMatch(/secure link was already used/);
    expect(
      describePublicError({
        code: 'link_revoked',
        status: 410,
        retryable: false,
        message: 'This secure link is no longer valid. Ask the firm for a new one.',
      }).closed,
    ).toBe(true);
    expect(
      describePublicError({ code: 'link_used', status: 410, retryable: false, message: 'x' }).text,
    ).toMatch(/personal link/);
    expect(describePublicError({ code: 'runner_online', status: 409, retryable: false }).text).toMatch(
      /reload/i,
    );
  });
});
