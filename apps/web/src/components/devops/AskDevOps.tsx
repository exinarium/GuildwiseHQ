import type { DevOpsRequestOrigin } from '@aom/shared';
import { Wrench } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useCeoChat } from '../../api/queries/ceo.ts';
import { openCeoChat } from '../../lib/openCeoChat.ts';
import { useCeoName } from '../ceo/useCeoName.ts';
import { useCurrentProject } from '../shell/useCurrentProject.ts';
import { Button, Dialog, ErrorBox, TextArea } from '../ui.tsx';

/**
 * "Ask DevOps" from anywhere. DevOps works through the CEO (docs/design/ceo-front-door.md section 8): every entry point
 * (header, command palette, card, desk item, Workstations page) opens this one dialog with what the user was looking at
 * attached, and "Ask <CEO>" opens the CEO chat with the message and context prefilled. The user can drop any context.
 */
export interface AskDevOpsRequest {
  origin?: DevOpsRequestOrigin;
  workstationId?: string;
  projectId?: string;
  projectLabel?: string;
  cardId?: string;
  cardLabel?: string;
  deskItemId?: string;
  deskLabel?: string;
  repoId?: string;
  repoLabel?: string;
  errorText?: string;
  /** Text to start the instruction with. */
  suggestion?: string;
  /** Set by the provider: the page the user was on. */
  route?: string;
}

type ChipId = 'route' | 'project' | 'card' | 'desk' | 'repo' | 'error';
interface Chip {
  id: ChipId;
  label: string;
  value: string;
}

const AskContext = createContext<(r?: AskDevOpsRequest) => void>(() => {});

/** Opens the Ask DevOps dialog. Without a provider (a page rendered on its own) it does nothing. */
export const useAskDevOps = () => useContext(AskContext);

export function AskDevOpsProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<AskDevOpsRequest | null>(null);
  const { pathname, search } = useLocation();
  const { project } = useCurrentProject();
  const open = useCallback(
    (r: AskDevOpsRequest = {}) =>
      setRequest({
        origin: 'app',
        route: `${pathname}${search}`,
        ...(project ? { projectId: project.id, projectLabel: `${project.name} (${project.key})` } : {}),
        ...r,
      }),
    [pathname, search, project],
  );
  return (
    <AskContext.Provider value={open}>
      {children}
      {request && (
        <AskDevOpsDialog key={JSON.stringify(request)} request={request} onClose={() => setRequest(null)} />
      )}
    </AskContext.Provider>
  );
}

function chipsOf(r: AskDevOpsRequest): Chip[] {
  const out: Chip[] = [];
  if (r.route) out.push({ id: 'route', label: 'Page', value: r.route });
  if (r.projectId) out.push({ id: 'project', label: 'Project', value: r.projectLabel ?? r.projectId });
  if (r.cardId) out.push({ id: 'card', label: 'Card', value: r.cardLabel ?? r.cardId });
  if (r.deskItemId) out.push({ id: 'desk', label: 'Desk item', value: r.deskLabel ?? r.deskItemId });
  if (r.repoId) out.push({ id: 'repo', label: 'Repository', value: r.repoLabel ?? r.repoId });
  if (r.errorText) out.push({ id: 'error', label: 'Last error', value: r.errorText });
  return out;
}

function AskDevOpsDialog({ request, onClose }: { request: AskDevOpsRequest; onClose: () => void }) {
  const ceoName = useCeoName();
  const openChat = useCeoChat();
  const nav = useNavigate();
  const [text, setText] = useState(request.suggestion ?? '');
  const [dropped, setDropped] = useState<ChipId[]>([]);
  const [err, setErr] = useState<string | undefined>();
  const chips = chipsOf(request).filter((c) => !dropped.includes(c.id));

  const go = () => {
    if (!text.trim()) {
      setErr('Describe what you need');
      return;
    }
    setErr(undefined);
    openChat.mutate(undefined, {
      onSuccess: (c) => {
        openCeoChat(nav, c.threadId, {
          prefill: `Ask DevOps: ${text.trim()}`,
          context: chips.map((x) => `${x.label}: ${x.value}`),
        });
        onClose();
      },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Ask DevOps"
      description={`DevOps works through ${ceoName} now. Say what you need (install tools, fix the build, start the app, deploy): ${ceoName} delegates it to DevOps and tells you the result.`}
      size="lg"
    >
      <form
        className="flex flex-col gap-3"
        aria-label="Ask DevOps"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <TextArea
          label="What do you need?"
          rows={4}
          placeholder="e.g. start the app, install Docker, fix the build, deploy to staging"
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={err}
        />
        {chips.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium text-fg">Attached context</p>
            <ul className="flex flex-wrap gap-2" data-testid="ask-devops-context">
              {chips.map((c) => (
                <li
                  key={c.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-sunken py-0.5 pr-1 pl-2.5 text-xs"
                >
                  <span className="truncate">
                    <span className="text-subtle">{c.label}:</span> {c.value.slice(0, 60)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${c.label}`}
                    onClick={() => setDropped((d) => [...d, c.id])}
                    className="inline-flex size-5 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorBox error={openChat.error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={openChat.isPending}>
            Ask {ceoName}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The header / page button. */
export function AskDevOpsButton({
  request,
  label = 'Ask DevOps',
  className,
  variant = 'default',
}: {
  request?: AskDevOpsRequest;
  label?: string;
  className?: string;
  variant?: 'default' | 'quiet';
}) {
  const ask = useAskDevOps();
  const props = useMemo(() => request, [request]);
  return (
    <Button
      type="button"
      {...(variant === 'quiet' ? { variant: 'ghost' as const } : {})}
      {...(className ? { className } : {})}
      onClick={() => ask(props)}
    >
      <Wrench aria-hidden="true" className="size-4" />
      {label}
    </Button>
  );
}
