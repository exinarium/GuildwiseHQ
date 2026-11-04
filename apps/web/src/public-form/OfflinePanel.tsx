import { useEffect, useRef, useState } from 'react';

/**
 * Shown instead of the form fields when the firm's runner is offline. It asks for one email address, nothing else: the
 * answers and files are never sent. Touch first: the field is the only content, 16 px text (no zoom on iOS), 44 px targets.
 */
export function OfflinePanel({
  firm,
  logoUrl,
  initialEmail,
  state,
  error,
  onSend,
  honeypot,
}: {
  firm: string;
  logoUrl?: string | undefined;
  initialEmail?: string | undefined;
  state: 'ask' | 'sending' | 'sent';
  error?: string | null | undefined;
  onSend: (email: string) => void;
  honeypot?: React.ReactNode;
}) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setEmail((cur) => cur || (initialEmail ?? ''));
  }, [initialEmail]);

  return (
    <main className="mx-auto max-w-xl p-3 sm:p-6" data-testid="public-offline">
      <div className="rounded-card border border-line bg-surface p-5 sm:p-6">
        {logoUrl && <img src={logoUrl} alt="" className="mb-4 max-h-16 w-auto" data-testid="form-logo" />}
        <h2 className="text-2xl font-semibold text-fg">{firm}</h2>
        {state === 'sent' ? (
          <div aria-live="polite" data-testid="public-offline-sent">
            <p className="mt-3 text-base text-fg">
              Thanks. We'll email you a secure link when {firm} is back online.
            </p>
          </div>
        ) : (
          <form
            className="mt-3 flex flex-col gap-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (state === 'sending') return;
              onSend(email.trim());
            }}
          >
            <p className="text-base text-fg">
              {firm} can't receive forms right now. Enter your email address and we'll send you a secure link
              as soon as they are back online. You'll need to fill in the form again with that link.
            </p>
            <label className="flex flex-col gap-1 text-base text-fg">
              Your email address
              <input
                ref={input}
                type="email"
                inputMode="email"
                autoComplete="email"
                enterKeyHint="send"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={() => input.current?.scrollIntoView({ block: 'center' })}
                aria-describedby={error ? 'offline-error' : undefined}
                aria-invalid={error ? true : undefined}
                data-testid="offline-email"
                className="min-h-11 w-full rounded-control border border-line bg-surface px-3 text-base text-fg"
              />
            </label>
            {error && (
              <p
                id="offline-error"
                role="alert"
                className="text-sm text-danger-soft-fg"
                data-testid="offline-error"
              >
                {error}
              </p>
            )}
            {honeypot}
            <button
              type="submit"
              disabled={state === 'sending' || !email.trim()}
              data-testid="offline-send"
              className="min-h-11 rounded-control bg-brand px-4 text-base font-medium text-brand-fg disabled:opacity-60"
            >
              {state === 'sending' ? 'Sending…' : 'Send me the link'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
