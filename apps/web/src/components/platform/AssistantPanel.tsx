import { Bot } from 'lucide-react';
import { useState } from 'react';
import { usePlatformAssistant, useSetPlatformAssistant } from '../../api/queries/assistant.ts';
import { Badge, Button, ErrorBox, Panel, TextInput } from '../ui.tsx';

/** The super admin's switch for the landing-page assistant ("Ask Guildwise"), with today's spend against the cap. */
export function AssistantPanel() {
  const q = usePlatformAssistant();
  const set = useSetPlatformAssistant();
  const a = q.data;
  const [draft, setDraft] = useState<string | null>(null);
  if (!a || typeof a.live !== 'boolean') return null;
  const why =
    a.mode === 'off'
      ? a.keyConfigured
        ? 'It is switched off by the server setting AOM_ASSISTANT.'
        : 'No Anthropic API key is set on the server (ANTHROPIC_API_KEY), so it is off.'
      : null;
  return (
    <div className="mb-4" data-testid="assistant-panel">
      <Panel>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
            <Bot aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-fg">
              Landing-page assistant
              <Badge tone={a.live ? 'green' : 'neutral'}>
                {a.live ? 'Answering visitors' : 'Not answering'}
              </Badge>
            </h2>
            <p className="text-sm text-muted">
              "Ask Guildwise" answers questions about the product on the public landing page. Today:{' '}
              <span className="tnum">{a.messagesToday}</span> messages,{' '}
              <span className="tnum">${a.spentTodayUsd.toFixed(2)}</span> of{' '}
              <span className="tnum">${a.dailyCapUsd.toFixed(2)}</span> daily budget. No conversations are
              stored.
            </p>
            {why && <p className="text-sm text-muted">{why}</p>}
            {a.mode === 'public' && a.enabled && !a.live && (
              <p className="text-sm text-muted">
                Today's budget is used up; it answers again tomorrow (UTC).
              </p>
            )}
          </div>
          <Button
            variant={a.enabled ? 'secondary' : 'primary'}
            loading={set.isPending}
            data-testid="assistant-toggle"
            onClick={() => set.mutate(!a.enabled)}
          >
            {a.enabled ? 'Turn off' : 'Turn on'}
          </Button>
        </div>
        <form
          aria-label="Daily budget"
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(draft);
            if (draft !== null && draft.trim() !== '' && Number.isFinite(n) && n >= 0)
              set.mutate({ dailyCapUsd: n }, { onSuccess: () => setDraft(null) });
          }}
        >
          <div className="w-44">
            <TextInput
              label="Daily budget (US$)"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.5"
              value={draft ?? String(a.dailyCapUsd)}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="assistant-cap-input"
            />
          </div>
          <Button type="submit" variant="primary" loading={set.isPending} data-testid="assistant-cap-save">
            Save budget
          </Button>
          {a.capOverridden && (
            <Button
              type="button"
              data-testid="assistant-cap-reset"
              onClick={() => set.mutate({ dailyCapUsd: null }, { onSuccess: () => setDraft(null) })}
            >
              Use the default (${(a.defaultCapUsd ?? 2).toFixed(2)})
            </Button>
          )}
        </form>
        <p className="mt-1 text-xs text-subtle">
          The most the assistant may spend per day (UTC). Once it is reached, the chat says it is busy until
          tomorrow.
        </p>
        <ErrorBox error={set.error} />
      </Panel>
    </div>
  );
}
