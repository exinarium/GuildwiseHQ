import {
  filterSlashCommands,
  playbookChatInstruction,
  type SlashCommand,
  type SlashContext,
  skillChatInstruction,
  slashInvocationOf,
  slashQueryOf,
} from '@aom/shared';
import { BookOpen, Lock, Wand2 } from 'lucide-react';
import { type MutableRefObject, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useRunPlaybook, useSlashCommands } from '../../api/queries/playbooks.ts';
import { cx } from '../ui/cx.ts';

/** What a composer says about its `/` menu: where it is (chat or session composer) and the project it is about. */
export interface SlashConfig {
  context: SlashContext;
  projectId?: string;
  /** The agent of a chat: only what it can load is offered (a private pack granted to it). */
  agentId?: string;
}

/** A handler the composer calls for a key press first: true when the menu used it. */
export type SlashKeyHandler = (e: { key: string }) => boolean;

/**
 * The `/` menu of a composer: typing `/` at the start opens the playbooks and skills the person may use (the registry's own
 * visibility rules decide, private packs included), typing more narrows them. A skill puts an instruction for the agent into
 * the box. A playbook runs "in this chat" (an instruction to the agent, to send) or "as a new session" (a guided Discovery
 * session on that playbook). Only mounted when the composer asked for it.
 */
export function SlashMenu({
  value,
  onChange,
  config,
  keys,
}: {
  value: string;
  onChange: (v: string) => void;
  config: SlashConfig;
  /** The composer's key handler slot: the menu fills it while it is open. */
  keys: MutableRefObject<SlashKeyHandler | null>;
}) {
  const query = slashQueryOf(value);
  const typing = value.startsWith('/');
  const list = useSlashCommands(config.context, {
    enabled: typing,
    ...(config.projectId ? { projectId: config.projectId } : {}),
  });
  const run = useRunPlaybook();
  const navigate = useNavigate();
  // "/brainstorm pricing for teams": the text after a command's key is what the person wants out of it
  const invoked = useMemo(() => slashInvocationOf(value, list.data?.items ?? []), [value, list.data]);
  const open = query !== null || invoked !== null;
  const items = useMemo(
    () => (invoked ? [invoked.command] : filterSlashCommands(list.data?.items ?? [], query ?? '')),
    [list.data, query, invoked],
  );
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the first row when the search changes
  useEffect(() => setActive(0), [query]);

  const typed = invoked?.input ?? '';
  const inChat = (c: SlashCommand) =>
    onChange(
      c.kind === 'skill'
        ? skillChatInstruction({ key: c.key, name: c.name, input: typed })
        : playbookChatInstruction({ key: c.key, name: c.name, input: typed, loadAs: c.loadAs }),
    );
  const asSession = (c: SlashCommand) =>
    run.mutate(
      { key: c.key, input: typed, ...(config.projectId ? { projectId: config.projectId } : {}) },
      { onSuccess: (r) => navigate(r.path) },
    );
  const choose = (c: SlashCommand) => {
    if (c.kind === 'skill') return inChat(c);
    return config.context === 'session' ? asSession(c) : inChat(c);
  };

  useEffect(() => {
    keys.current = open
      ? (e) => {
          if (dismissed === value) return false;
          if (e.key === 'Escape') {
            setDismissed(value);
            return true;
          }
          if (!items.length) return false;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setActive((a) => (a + step + items.length) % items.length);
            return true;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            const c = items[active];
            if (c) choose(c);
            return true;
          }
          return false;
        }
      : null;
    return () => {
      keys.current = null;
    };
  });

  if (!open || dismissed === value) return null;
  return (
    <section
      aria-label="Playbooks and skills"
      data-testid="slash-menu"
      className="max-h-72 overflow-y-auto rounded-control border border-line bg-surface p-1 shadow-sm"
    >
      {list.isPending && <p className="px-3 py-2 text-sm text-subtle">Loading…</p>}
      {list.isError && <p className="px-3 py-2 text-sm text-danger">The list could not be loaded.</p>}
      {!list.isPending && !list.isError && items.length === 0 && (
        <p className="px-3 py-2 text-sm text-subtle" data-testid="slash-empty">
          Nothing matches “{query}”. Playbooks and skills you may use appear here.
        </p>
      )}
      {run.isError && (
        <p role="alert" className="px-3 py-2 text-sm text-danger">
          {run.error instanceof Error ? run.error.message : 'The session could not be started.'}
        </p>
      )}
      {invoked && (
        <p className="px-3 py-1 text-xs text-muted" data-testid="slash-input">
          {config.context === 'session' && invoked.command.kind === 'playbook'
            ? 'Enter starts it with'
            : 'Enter uses it with'}{' '}
          “{invoked.input}”
        </p>
      )}
      <ul className="flex flex-col">
        {items.map((c, i) => {
          const Icon = c.kind === 'playbook' ? BookOpen : Wand2;
          return (
            <li key={`${c.kind}:${c.key}`} aria-current={i === active ? 'true' : undefined}>
              <div
                data-testid={`slash-${c.kind}-${c.key}`}
                className={cx(
                  'flex items-start gap-2 rounded-control px-2 py-1.5',
                  i === active ? 'bg-brand-soft' : 'hover:bg-sunken',
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 text-left [@media(pointer:coarse)]:min-h-11"
                  onClick={() => choose(c)}
                >
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-subtle" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                      /{c.key}
                      <span className="text-xs font-normal text-subtle">{c.kind}</span>
                      {c.packName && (
                        <span className="text-xs font-normal text-subtle" data-testid={`slash-pack-${c.key}`}>
                          from {c.packName}
                        </span>
                      )}
                      {c.visibility === 'private' && (
                        <span className="inline-flex items-center gap-0.5 text-xs font-normal text-subtle">
                          <Lock aria-hidden="true" className="size-3" /> private
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted">{c.description}</span>
                  </span>
                </button>
                {c.kind === 'playbook' && c.canStartSession && config.context === 'chat' && (
                  <button
                    type="button"
                    data-testid={`slash-session-${c.key}`}
                    onClick={() => asSession(c)}
                    disabled={run.isPending}
                    className="shrink-0 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-fg hover:bg-sunken [@media(pointer:coarse)]:min-h-11"
                  >
                    As a new session
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
