import { createHash } from 'node:crypto';
import { type FormDefinition, newFormDefinition, newFormField, publicFormView } from '@aom/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_TEXT } from '../public-form/messages.ts';
import { PublicFormPage } from '../public-form/PublicFormPage.tsx';

const PID = 'AbCdEfGhIjKlMnOpQrStUv';
const SID = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json({ error: { code, message: 'x', ...extra } }, status);

const definition = (): FormDefinition => {
  const d = newFormDefinition('Rental application');
  const name = newFormField('short_text', 'full_name', 'Full name');
  name.required = true;
  const id = newFormField('file', 'id_copy', 'ID copy');
  if (id.type === 'file') id.allowedTypes = ['.pdf'];
  d.fields = [name, id];
  return publicFormView(d);
};
const dto = (over: Record<string, unknown> = {}) => ({
  form: definition(),
  version: 1,
  logo: null,
  session: 's1.AAAAAAAAAAAAAAAA.abc.1.sig',
  powBits: 0,
  minFillMs: 0,
  link: null,
  ...over,
});

type Call = { method: string; url: string; headers: Record<string, string>; body: any };
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
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      };
      calls.push(c);
      return handler(c);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const pdf = () => new File(['%PDF-1.7 content'], 'id.pdf', { type: 'application/pdf' });
const setup = () => userEvent.setup({ applyAccept: false });
const fill = async (u: ReturnType<typeof setup>) => {
  await u.type(await screen.findByLabelText(/Full name/), 'Ann Example');
  await u.upload(screen.getByLabelText(/ID copy/), pdf());
};
const path = (c: Call) => c.url.replace(`/api/public/forms/${PID}`, '');

/** A server that takes the three steps, with hooks for the failures. */
function server(opts: { putFails?: number; completeFails?: number } = {}) {
  let putFails = opts.putFails ?? 0;
  let completeFails = opts.completeFails ?? 0;
  let stored = false;
  handler = (c) => {
    const p = path(c);
    if (p === '' && c.method === 'GET') return json(dto());
    if (p === '/submissions' && c.method === 'POST')
      return json(
        { submissionId: SID, uploadToken: 'u1.tok', parts: [{ field: 'id_copy', index: 0, needed: true }] },
        201,
      );
    if (p === `/submissions/${SID}` && c.method === 'GET')
      return json({
        status: 'receiving',
        parts: [{ field: 'id_copy', index: 0, state: stored ? 'stored' : 'pending' }],
      });
    if (p === `/submissions/${SID}/parts/0`) {
      if (putFails-- > 0) return err(502, 'storage_failed', { retryable: true });
      stored = true;
      return json({ state: 'stored' });
    }
    if (p === `/submissions/${SID}/complete`) {
      if (completeFails-- > 0) return err(502, 'storage_failed', { retryable: true });
      return json({ status: 'complete', confirmation: 'Thank you. We have received your answers.' });
    }
    return err(404, 'form_not_available');
  };
}

describe('the public form page', () => {
  it('loads the form, sends start, the file and complete, then shows the confirmation (no cookies sent)', async () => {
    server();
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    expect(await screen.findByTestId('form-confirmation')).toHaveTextContent('Thank you');
    const start = calls.find((c) => path(c) === '/submissions');
    expect(start?.body).toMatchObject({
      session: expect.stringMatching(/^s1\./),
      website: '',
      answers: { full_name: 'Ann Example' },
      files: [
        { field: 'id_copy', name: 'id.pdf', size: 16, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
    // the file is not among the text answers, and no credentials travel
    expect(start?.body.answers.id_copy).toBeUndefined();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.headers).toMatchObject({
      'x-upload-token': 'u1.tok',
      'content-type': 'application/octet-stream',
    });
    expect(put?.headers['x-file-name']).toBe('id.pdf');
    expect(
      vi.mocked(fetch).mock.calls.every(([, init]) => (init as RequestInit).credentials === 'omit'),
    ).toBe(true);
    // the saved answers are removed once the submission is complete
    expect(sessionStorage.getItem(`gwf:${PID}`)).toBeNull();
  });

  it.each([
    ['link_expired', 410, /personal link has expired/],
    ['link_revoked', 410, /no longer valid/],
    ['link_used', 410, /already used/],
    ['link_invalid', 404, /not valid/],
    ['form_not_available', 404, /This form is not available/],
  ])('shows a clear sentence for %s and no form', async (code, status, text) => {
    handler = () => err(status as number, code as string);
    render(<PublicFormPage publicId={PID} linkToken="v1.x" />);
    expect(await screen.findByTestId('public-closed')).toHaveTextContent(text as RegExp);
    expect(screen.queryByTestId('form-renderer')).toBeNull();
  });

  it('sends the personal link in a header, never in the address', async () => {
    server();
    render(<PublicFormPage publicId={PID} linkToken="v1.linkid.exp.sig" />);
    await screen.findByTestId('form-renderer');
    const first = calls[0] as Call;
    expect(first.headers['x-form-link']).toBe('v1.linkid.exp.sig');
    expect(first.url).not.toContain('v1.linkid');
  });

  it('a storage failure shows the retry message, keeps the answers, and Try again sends only what is missing', async () => {
    server({ completeFails: 1 });
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    const notice = await screen.findByTestId('public-notice');
    expect(notice).toHaveTextContent(/couldn't save your form.*still here/i);
    expect(screen.getByLabelText(/Full name/)).toHaveValue('Ann Example');
    const putsBefore = calls.filter((c) => c.method === 'PUT').length;
    expect(putsBefore).toBe(1);
    await u.click(screen.getByTestId('public-retry'));
    expect(await screen.findByTestId('form-confirmation')).toBeInTheDocument();
    // the file was stored the first time: it is not sent again, and no second submission was started
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(putsBefore);
    expect(calls.filter((c) => path(c) === '/submissions' && c.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => path(c).endsWith('/complete'))).toHaveLength(2);
  });

  it('a failing file upload is retried with the same file and no retyping', async () => {
    server({ putFails: 1 });
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    await screen.findByTestId('public-notice');
    await u.click(screen.getByTestId('public-retry'));
    expect(await screen.findByTestId('form-confirmation')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('shows the field problems the server found, with the field marked', async () => {
    server();
    const base = handler;
    handler = (c) =>
      path(c) === '/submissions' && c.method === 'POST'
        ? err(400, 'invalid_answers', { fields: [{ field: 'full_name', code: 'too_short' }] })
        : base(c);
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    expect(await screen.findByTestId('public-notice')).toHaveTextContent(/need attention/i);
    await waitFor(() => expect(screen.getByTestId('error-full_name')).toBeInTheDocument());
  });

  it('starts over with a fresh session when the submission ran out, keeping the answers and the file', async () => {
    server();
    const base = handler;
    let expired = true;
    handler = (c) => {
      if (path(c) === `/submissions/${SID}` && expired) {
        expired = false;
        return err(410, 'submission_expired');
      }
      return base(c);
    };
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    expect(await screen.findByTestId('form-confirmation')).toBeInTheDocument();
    expect(calls.filter((c) => path(c) === '/submissions' && c.method === 'POST')).toHaveLength(2);
  });

  it('shows the offline flow answer as the final state', async () => {
    server();
    const base = handler;
    handler = (c) =>
      path(c) === '/submissions' && c.method === 'POST'
        ? json({ status: 'link_later', message: 'We will email you a secure upload link.' }, 202)
        : base(c);
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    expect(await screen.findByTestId('public-closed')).toHaveTextContent(
      'We will email you a secure upload link.',
    );
  });

  it('keeps the typed answers in sessionStorage (never localStorage) and restores them after a reload', async () => {
    server();
    const first = render(<PublicFormPage publicId={PID} />);
    await setup().type(await screen.findByLabelText(/Full name/), 'Ann');
    expect(JSON.parse(sessionStorage.getItem(`gwf:${PID}`) as string)).toMatchObject({ full_name: 'Ann' });
    expect(localStorage.length).toBe(0);
    first.unmount();
    render(<PublicFormPage publicId={PID} />);
    expect(await screen.findByLabelText(/Full name/)).toHaveValue('Ann');
  });

  it('without crypto.subtle (plain http), a form with a file sends a valid proof of work and the right file hash', async () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: <T extends ArrayBufferView>(a: T) => real.getRandomValues(a as never) as T,
      randomUUID: () => real.randomUUID(),
      subtle: undefined,
    });
    server();
    const base = handler;
    handler = (c) => (path(c) === '' && c.method === 'GET' ? json(dto({ powBits: 8 })) : base(c));
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    expect(await screen.findByTestId('form-confirmation')).toHaveTextContent('Thank you');
    const start = calls.find((c) => path(c) === '/submissions');
    const h = createHash('sha256').update(`${start?.body.session}:${start?.body.nonce}`).digest();
    expect(start?.body.nonce).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(h[0]).toBe(0);
    expect(start?.body.files[0].sha256).toBe(createHash('sha256').update('%PDF-1.7 content').digest('hex'));
  });

  it('a 403 bad_origin says to use the link the firm gave, not the generic error, and keeps the answers', async () => {
    server();
    const base = handler;
    handler = (c) => (path(c) === '/submissions' && c.method === 'POST' ? err(403, 'bad_origin') : base(c));
    render(<PublicFormPage publicId={PID} />);
    const u = setup();
    await fill(u);
    await u.click(screen.getByTestId('form-submit'));
    const notice = await screen.findByTestId('public-notice');
    expect(notice).toHaveTextContent(PUBLIC_TEXT.badOrigin);
    expect(notice).not.toHaveTextContent(/Something went wrong/);
    expect(screen.getByLabelText(/Full name/)).toHaveValue('Ann Example');
  });

  it('the rendered page has no style attribute (the policy has no inline styles)', async () => {
    server();
    const { container } = render(<PublicFormPage publicId={PID} />);
    await screen.findByTestId('form-renderer');
    expect(container.querySelector('[style]')).toBeNull();
  });
});
