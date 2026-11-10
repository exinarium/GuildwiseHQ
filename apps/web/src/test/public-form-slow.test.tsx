import { type FormDefinition, newFormDefinition, newFormField, publicFormView } from '@aom/shared';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_TEXT } from '../public-form/messages.ts';
import { PublicFormPage, SLOW_MS } from '../public-form/PublicFormPage.tsx';
import { PowUnsupportedError, solvePow } from '../public-form/pow.ts';

// A real proof of work must not run under fake timers: the solver is replaced, the rest of the module is kept.
vi.mock('../public-form/pow.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-form/pow.ts')>()),
  solvePow: vi.fn(),
}));

const PID = 'AbCdEfGhIjKlMnOpQrStUv';
const SID = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const definition = (): FormDefinition => {
  const d = newFormDefinition('Rental application');
  const name = newFormField('short_text', 'full_name', 'Full name');
  name.required = true;
  d.fields = [name];
  return publicFormView(d);
};

let starts: unknown[];
beforeEach(() => {
  starts = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const p = url.replace(`/api/public/forms/${PID}`, '');
      const method = init.method ?? 'GET';
      if (p === '' && method === 'GET')
        return json({
          form: definition(),
          version: 1,
          logo: null,
          session: 's1.AAAAAAAAAAAAAAAA.abc.1.sig',
          powBits: 16,
          minFillMs: 0,
          link: null,
        });
      if (p === '/submissions' && method === 'POST') {
        starts.push(JSON.parse(init.body as string));
        return json({ submissionId: SID, uploadToken: 'u1.tok', parts: [] }, 201);
      }
      if (p === `/submissions/${SID}` && method === 'GET') return json({ status: 'receiving', parts: [] });
      if (p === `/submissions/${SID}/complete`)
        return json({ status: 'complete', confirmation: 'Thank you. We have received your answers.' });
      return json({ error: { code: 'form_not_available', message: 'x' } }, 404);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(solvePow).mockReset();
});

describe('the public form page while the check is slow or cannot run', () => {
  it(`after ${SLOW_MS} ms of checking it says this can take longer, and typing still works`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let solve: (nonce: string) => void = () => {};
    vi.mocked(solvePow).mockImplementation(
      () =>
        new Promise<string>((r) => {
          solve = r;
        }),
    );
    render(<PublicFormPage publicId={PID} />);
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const name = await screen.findByLabelText(/Full name/);
    await u.type(name, 'Ann');
    await u.click(screen.getByTestId('form-submit'));
    // still within the threshold: no slow line yet
    await act(() => vi.advanceTimersByTimeAsync(SLOW_MS - 1000));
    expect(screen.getByTestId('public-status')).not.toHaveTextContent(PUBLIC_TEXT.slowCheck);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByTestId('public-status')).toHaveTextContent(PUBLIC_TEXT.slowCheck);
    expect(starts).toHaveLength(0);
    // the page stays usable while it waits
    await u.type(name, ' Example');
    expect(name).toHaveValue('Ann Example');
    await act(async () => solve('abc'));
    expect(await screen.findByTestId('form-confirmation')).toHaveTextContent('Thank you');
    expect(starts[0]).toMatchObject({ nonce: 'abc' });
  });

  it('a quick check never shows the slow line', async () => {
    vi.mocked(solvePow).mockResolvedValue('abc');
    render(<PublicFormPage publicId={PID} />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText(/Full name/), 'Ann');
    await u.click(screen.getByTestId('form-submit'));
    expect(await screen.findByTestId('form-confirmation')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(PUBLIC_TEXT.slowCheck);
  });

  it('when the check cannot run in this browser it asks for a secure link, shows no generic error and keeps the answers', async () => {
    const failing = Promise.reject(new PowUnsupportedError());
    failing.catch(() => {});
    vi.mocked(solvePow).mockReturnValue(failing);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    render(<PublicFormPage publicId={PID} />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText(/Full name/), 'Ann Example');
    await u.click(screen.getByTestId('form-submit'));
    const notice = await screen.findByTestId('public-notice');
    expect(notice).toHaveTextContent(PUBLIC_TEXT.needsSecureLink);
    expect(screen.queryByTestId('public-retry')).toBeNull();
    expect(document.body).not.toHaveTextContent(/Something went wrong/);
    expect(screen.queryByTestId('public-closed')).toBeNull();
    expect(screen.getByLabelText(/Full name/)).toHaveValue('Ann Example');
    expect(starts).toHaveLength(0);
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
