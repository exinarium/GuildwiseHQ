import type { FormAnswerValue, FormFieldErrorCode, PublicFormDto } from '@aom/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormRenderer } from '../components/forms/FormRenderer.tsx';
import { PublicApiError, publicApi } from './api.ts';
import { describePublicError } from './messages.ts';
import { solvePow } from './pow.ts';
import { sha256File } from './sha256.ts';

type Answers = Record<string, FormAnswerValue>;
type Phase =
  | { kind: 'loading' }
  | { kind: 'closed'; text: string }
  | { kind: 'form'; dto: PublicFormDto }
  | { kind: 'later'; text: string };

interface Submission {
  id: string;
  token: string;
  /** Part index (position in the manifest) by field id. */
  parts: Array<{ field: string; index: number }>;
}

/** The offline flow answered "we will send you a secure link": nothing more to do on this page. */
class LinkLater extends Error {}
const laterOf = (r: unknown): void => {
  const x = r as { status?: string; message?: string } | null;
  if (x?.status === 'link_later') throw new LinkLater(x.message ?? '');
};

const storeKey = (publicId: string) => `gwf:${publicId}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The link token of the address (`#c=…`), read once and then removed from the address bar. */
export function takeLinkToken(): string | undefined {
  const m = /^#c=(.+)$/.exec(window.location.hash);
  if (!m) return undefined;
  window.history.replaceState(null, '', window.location.pathname);
  return m[1];
}

/**
 * The page a client sees at `/f/<id>`. It loads the published form, solves the proof of work while the person types, and
 * sends in three steps: start, one file at a time, complete. The answers and the chosen files stay in the page until the
 * submission is complete, so every retry resumes without retyping.
 */
export function PublicFormPage({ publicId, linkToken }: { publicId: string; linkToken?: string | undefined }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; retry: boolean } | null>(null);
  const [progress, setProgress] = useState('');
  const [serverErrors, setServerErrors] = useState<Record<string, FormFieldErrorCode>>({});
  const [honey, setHoney] = useState('');
  const files = useRef(new Map<string, File>());
  const answers = useRef<Answers>({});
  const sub = useRef<Submission | null>(null);
  const pow = useRef<Promise<string> | null>(null);
  const link = useRef(linkToken);
  const initial = useRef<Answers | undefined>(undefined);
  const loadedAt = useRef(Date.now());

  const load = useCallback(async () => {
    try {
      const dto = await publicApi.load(publicId, link.current);
      pow.current = solvePow(dto.session, dto.powBits);
      loadedAt.current = Date.now();
      setPhase({ kind: 'form', dto });
      return dto;
    } catch (e) {
      const d = describePublicError(e as PublicApiError);
      setPhase({ kind: 'closed', text: d.text });
      return null;
    }
  }, [publicId]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storeKey(publicId));
      if (raw) initial.current = JSON.parse(raw) as Answers;
    } catch {
      initial.current = undefined;
    }
    void load();
  }, [publicId, load]);

  // A soft keyboard covers the field being typed in: bring it back into view.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && el !== document.body) el.scrollIntoView({ block: 'center' });
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  const onAnswersChange = (a: Answers) => {
    answers.current = a;
    try {
      sessionStorage.setItem(storeKey(publicId), JSON.stringify(a));
    } catch {
      // storage can be blocked: the answers stay in the page
    }
  };

  /** Uploads what is not stored yet, then completes. Throws a PublicApiError. */
  const finish = async (s: Submission): Promise<string> => {
    const st = await publicApi.status(publicId, s.id, s.token);
    if (st.status === 'expired') throw new PublicApiError(410, 'submission_expired', 'expired', false);
    const todo = s.parts.filter((p) => st.parts.find((x) => x.index === p.index)?.state !== 'stored');
    let n = 0;
    for (const p of todo) {
      n++;
      setProgress(`Sending file ${n} of ${todo.length}…`);
      const f = files.current.get(p.field);
      if (!f) throw new PublicApiError(0, 'file_missing', 'A file must be chosen again.', false);
      laterOf(await publicApi.putPart(publicId, s.id, p.index, f, s.token));
    }
    setProgress('Finishing…');
    const out = await publicApi.complete(publicId, s.id, s.token, answers.current);
    laterOf(out);
    return out.status === 'complete' ? (out.confirmation ?? '') : (out.message ?? '');
  };

  const begin = async (dto: PublicFormDto): Promise<Submission> => {
    setProgress('Checking your files…');
    const list = dto.form.fields.flatMap((f) => {
      const file = f.type === 'file' ? files.current.get(f.id) : undefined;
      return file ? [{ field: f.id, file }] : [];
    });
    const manifest = await Promise.all(
      list.map(async ({ field, file }, index) => ({
        field,
        index: 0,
        name: file.name,
        size: file.size,
        sha256: await sha256File(file),
        pos: index,
      })),
    );
    // Not before the form has been open long enough for a person (the server enforces it too).
    await wait(Math.max(0, loadedAt.current + dto.minFillMs - Date.now()));
    const nonce = (await pow.current) ?? '0';
    const body = {
      session: dto.session,
      nonce,
      website: honey,
      ...(link.current ? { link: link.current } : {}),
      answers: Object.fromEntries(
        Object.entries(answers.current).filter(([k]) => !files.current.has(k) && !manifest.some((m) => m.field === k)),
      ),
      files: manifest.map(({ pos: _p, ...m }) => m),
    };
    const r = await publicApi.start(publicId, body);
    laterOf(r);
    return { id: r.submissionId, token: r.uploadToken, parts: r.parts.map((p, i) => ({ field: p.field, index: i })) };
  };

  const submit = async () => {
    if (phase.kind !== 'form') return;
    let dto = phase.dto;
    setBusy(true);
    setNotice(null);
    setServerErrors({});
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (!sub.current) sub.current = await begin(dto);
          const text = await finish(sub.current);
          sub.current = null;
          try {
            sessionStorage.removeItem(storeKey(publicId));
          } catch {
            // ignore
          }
          setDone(text);
          return;
        } catch (e) {
          const err = e instanceof PublicApiError ? e : new PublicApiError(0, 'network', 'failed', true);
          // The submission ran out, or the page's session was used or is stale: start again with what is kept.
          const again =
            ['submission_expired', 'submission_not_found', 'session_used', 'session_invalid', 'form_changed'].includes(err.code);
          if (!again || attempt === 2) throw err;
          sub.current = null;
          const fresh = await load();
          if (!fresh) return;
          dto = fresh;
        }
      }
    } catch (e) {
      if (e instanceof LinkLater) {
        setPhase({ kind: 'later', text: e.message });
        return;
      }
      const err = e instanceof PublicApiError ? e : new PublicApiError(0, 'network', 'failed', true);
      if (err.fields.length)
        setServerErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.code as FormFieldErrorCode])));
      const d = describePublicError(err);
      if (d.closed) setPhase({ kind: 'closed', text: d.text });
      else setNotice({ text: d.text, retry: d.retry });
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  if (phase.kind === 'loading')
    return (
      <main className="mx-auto max-w-xl p-6" data-testid="public-loading">
        <p className="text-base text-muted" role="status">
          Loading…
        </p>
      </main>
    );
  if (phase.kind === 'closed' || phase.kind === 'later')
    return (
      <main className="mx-auto max-w-xl p-6" data-testid="public-closed">
        <div className="rounded-card border border-line bg-surface p-6">
          <p className="text-base text-fg" role="alert">
            {phase.text}
          </p>
        </div>
      </main>
    );

  const dto = phase.dto;
  const status = (
    <div aria-live="polite" data-testid="public-status">
      {progress && <p className="text-sm text-muted">{progress}</p>}
      {notice && (
        <div
          role="alert"
          className="rounded-control border border-danger bg-danger-soft p-3 text-sm text-danger-soft-fg"
          data-testid="public-notice"
        >
          <p>{notice.text}</p>
          {notice.retry && (
            <button
              type="button"
              className="mt-2 min-h-11 rounded-control border border-line bg-surface px-4 text-base text-fg"
              data-testid="public-retry"
              onClick={() => void submit()}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
  const honeypot = (
    <div className="absolute left-[-9999px] h-px w-px overflow-hidden" aria-hidden="true">
      <label>
        Website
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honey}
          onChange={(e) => setHoney(e.target.value)}
        />
      </label>
    </div>
  );
  return (
    <main className="mx-auto max-w-xl p-3 sm:p-6">
      <FormRenderer
        definition={dto.form}
        logoUrl={dto.logo ?? undefined}
        mode="public"
        {...(initial.current ? { initialAnswers: initial.current } : {})}
        onAnswersChange={onAnswersChange}
        onFileChange={(id, f) => (f ? files.current.set(id, f) : files.current.delete(id))}
        onSubmit={submit}
        done={done !== null}
        busy={busy}
        status={status}
        serverErrors={serverErrors}
        extra={honeypot}
      />
    </main>
  );
}
