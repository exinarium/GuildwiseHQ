import { type FormDefinition, newFormDefinition, newFormField, publicFormView } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectBlockedError, DirectExpiredError } from '../public-form/direct-upload.ts';
import { PublicFormPage } from '../public-form/PublicFormPage.tsx';

const mocks = vi.hoisted(() => ({ directUpload: vi.fn() }));
vi.mock('../public-form/direct-upload.ts', async (orig) => ({
  ...(await orig<typeof import('../public-form/direct-upload.ts')>()),
  directUpload: mocks.directUpload,
}));

const PID = 'AbCdEfGhIjKlMnOpQrStUv';
const SID = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const ORIGIN = 'https://up.example.com';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const definition = (): FormDefinition => {
  const d = newFormDefinition('Rental application');
  const name = newFormField('short_text', 'full_name', 'Full name');
  name.required = true;
  const id = newFormField('file', 'id_copy', 'ID copy');
  if (id.type === 'file') id.allowedTypes = ['.pdf'];
  d.fields = [name, id];
  return publicFormView(d);
};

type Call = { method: string; url: string; body: any };
let calls: Call[];

const grantBody = (url: string) => ({
  grant: {
    method: 'PUT',
    url,
    headers: {},
    chunkBytes: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
});

/** A server for a direct part. `afterComplete` is what the status answers once the browser reported completion. */
function server(opts: { grantUrl?: string; afterComplete?: Record<string, unknown> } = {}) {
  let completed = false;
  const afterComplete = opts.afterComplete ?? { state: 'stored' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = {
        method: init.method ?? 'GET',
        url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      };
      calls.push(c);
      const p = url.replace(`/api/public/forms/${PID}`, '');
      if (p === '' && c.method === 'GET')
        return json({
          form: definition(),
          version: 1,
          logo: null,
          session: 's1.AAAAAAAAAAAAAAAA.abc.1.sig',
          powBits: 0,
          minFillMs: 0,
          link: null,
          uploadOrigins: [ORIGIN],
        });
      if (p === '/submissions' && c.method === 'POST')
        return json(
          {
            submissionId: SID,
            uploadToken: 'u1.tok',
            parts: [{ field: 'id_copy', index: 0, needed: true, mode: 'direct' }],
          },
          201,
        );
      if (p === `/submissions/${SID}` && c.method === 'GET')
        return json({
          status: 'receiving',
          parts: [
            {
              field: 'id_copy',
              index: 0,
              ...(completed ? afterComplete : { state: 'pending' }),
            },
          ],
        });
      if (p === `/submissions/${SID}/parts/0/grant` && c.method === 'POST')
        return json(grantBody(opts.grantUrl ?? `${ORIGIN}/session/abc`));
      if (p === `/submissions/${SID}/parts/0/grant/complete`) {
        completed = true;
        return json({ state: 'verifying' });
      }
      if (p === `/submissions/${SID}/parts/0/grant/cancel`) return json({ state: 'cancelled' });
      if (p === `/submissions/${SID}/complete`)
        return json({ status: 'complete', confirmation: 'Thank you. We have received your answers.' });
      return json({ error: { code: 'form_not_available', message: 'x' } }, 404);
    }),
  );
}

const setup = () => userEvent.setup({ applyAccept: false });
const submit = async () => {
  render(<PublicFormPage publicId={PID} />);
  const u = setup();
  await u.type(await screen.findByLabelText(/Full name/), 'Ann Example');
  await u.upload(
    screen.getByLabelText(/ID copy/),
    new File(['%PDF-1.7 content'], 'id.pdf', { type: 'application/pdf' }),
  );
  await u.click(screen.getByTestId('form-submit'));
};
const paths = () => calls.map((c) => `${c.method} ${c.url.replace(`/api/public/forms/${PID}`, '')}`);
const noRelayPut = () =>
  expect(calls.filter((c) => c.url.endsWith('/parts/0') && c.method === 'PUT')).toEqual([]);

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  mocks.directUpload.mockReset();
  mocks.directUpload.mockImplementation(
    async (_f: File, _g: unknown, h: { onProgress(a: number, b: number): void }) => {
      h.onProgress(16, 16);
      return { etag: 'e1' };
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the public form page, direct upload to the storage provider', () => {
  it('sends the file to the provider, reports completion, waits for the check and never uses the relay', async () => {
    server();
    await submit();
    expect(await screen.findByTestId('form-confirmation')).toHaveTextContent('Thank you');
    expect(mocks.directUpload).toHaveBeenCalledTimes(1);
    expect(mocks.directUpload.mock.calls[0]?.[1]).toMatchObject({ url: `${ORIGIN}/session/abc` });
    const done = calls.find((c) => c.url.endsWith('/grant/complete'));
    expect(done?.body).toMatchObject({
      size: 16,
      etag: 'e1',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    noRelayPut();
  });

  it('refuses a grant for an origin the page was not told about: cancels it as blocked and shows an error', async () => {
    server({ grantUrl: 'https://evil.example.net/x' });
    await submit();
    expect(await screen.findByTestId('public-closed')).toHaveTextContent(/could not be sent/);
    expect(mocks.directUpload).not.toHaveBeenCalled();
    const cancel = calls.find((c) => c.url.endsWith('/grant/cancel'));
    expect(cancel?.body).toEqual({ reason: 'blocked' });
    expect(paths().some((p) => p.endsWith('/complete'))).toBe(false);
    noRelayPut();
  });

  it('cancels as blocked when the browser cannot reach the provider (CSP or CORS)', async () => {
    server();
    mocks.directUpload.mockRejectedValue(new DirectBlockedError());
    await submit();
    expect(await screen.findByTestId('public-closed')).toHaveTextContent(/could not be sent/);
    expect(calls.find((c) => c.url.endsWith('/grant/cancel'))?.body).toEqual({ reason: 'blocked' });
    noRelayPut();
  });

  it('asks for one new grant when the first expired, then finishes', async () => {
    server();
    mocks.directUpload.mockRejectedValueOnce(new DirectExpiredError());
    await submit();
    expect(await screen.findByTestId('form-confirmation')).toBeInTheDocument();
    expect(mocks.directUpload).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.url.endsWith('/grant') && c.method === 'POST')).toHaveLength(2);
    expect(calls.find((c) => c.url.endsWith('/grant/cancel'))?.body).toEqual({ reason: 'retry' });
    noRelayPut();
  });

  it.each([
    ['type_refused', /not an accepted type/],
    ['malware_detected', /failed a security check/],
  ])(
    'shows the error when the stored file fails the check (%s) and does not complete',
    async (error, text) => {
      server({ afterComplete: { state: 'failed', error } });
      await submit();
      expect(await screen.findByTestId('public-notice')).toHaveTextContent(text);
      expect(paths().some((p) => p === `POST /submissions/${SID}/complete`)).toBe(false);
      expect(screen.queryByTestId('form-confirmation')).toBeNull();
      noRelayPut();
    },
  );
});
