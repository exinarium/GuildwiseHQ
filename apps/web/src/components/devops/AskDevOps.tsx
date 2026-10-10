import type { AgentDto, DevOpsRequestContext, DevOpsRequestOrigin } from '@aom/shared';
import { Wrench } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useAgents } from '../../api/queries/agents.ts';
import { useCreateChat } from '../../api/queries/chats.ts';
import { useCreateDevOpsRequest } from '../../api/queries/devops.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { ChatPanel } from '../ChatPanel.tsx';
import { useCurrentProject } from '../shell/useCurrentProject.ts';
import { Button, Callout, Dialog, ErrorBox, Select, TextArea } from '../ui.tsx';

/**
 * "Ask DevOps" from anywhere (docs/design/git-free-and-devops-instructions.md, part 2): the DevOps engineer runs on the
 * workstation as the user, so commands, installs, docker builds and deploys can be asked for in a conversation. Every
 * entry point (header, command palette, card, desk item, Workstations page) opens this one dialog with what the
 * user was looking at attached. The user can drop any of it before sending.
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

/** The DevOps engineer to ask when it is obvious: the one on the named workstation, else the only one. */
export function pickDevopsAgent(
  agents: AgentDto[],
  workstationId?: string,
  ownWorkstationIds: string[] = [],
): AgentDto | undefined {
  const devops = agents.filter((a) => a.isDevops && a.status === 'active');
  if (workstationId) return devops.find((a) => a.workstationId === workstationId);
  if (devops.length === 1) return devops[0];
  const own = devops.filter((a) => a.workstationId && ownWorkstationIds.includes(a.workstationId));
  return own.length === 1 ? own[0] : undefined;
}

function AskDevOpsDialog({ request, onClose }: { request: AskDevOpsRequest; onClose: () => void }) {
  const agents = useAgents();
  const workstations = useWorkstations();
  const createChat = useCreateChat();
  const createRequest = useCreateDevOpsRequest();
  const [text, setText] = useState(request.suggestion ?? '');
  const [dropped, setDropped] = useState<ChipId[]>([]);
  const [chosen, setChosen] = useState('');
  const [thread, setThread] = useState<{ id: string; message: string } | null>(null);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const own = (workstations.data ?? []).map((w) => w.id);
  const nameOf = (id: string | null) => workstations.data?.find((w) => w.id === id)?.name;
  const devopsAgents = (agents.data ?? []).filter((a) => a.isDevops && a.status === 'active');
  const auto = pickDevopsAgent(agents.data ?? [], request.workstationId, own);
  const agent = auto ?? devopsAgents.find((a) => a.id === chosen);
  const chips = chipsOf(request).filter((c) => !dropped.includes(c.id));
  const has = (id: ChipId) => chips.some((c) => c.id === id);
  const canTask = !!agent?.workstationId && own.includes(agent.workstationId);

  const message = () =>
    chips.length
      ? `${text.trim()}\n\nContext (from the page I was on):\n${chips.map((c) => `- ${c.label}: ${c.value}`).join('\n')}`
      : text.trim();

  const check = (): boolean => {
    if (!agent) {
      setErr('Choose which workstation to ask');
      return false;
    }
    if (!text.trim()) {
      setErr('Describe what you need');
      return false;
    }
    setErr(undefined);
    return true;
  };

  const startChat = () => {
    if (!check() || !agent) return;
    createChat.mutate(
      {
        agentId: agent.id,
        ...(has('project') && request.projectId ? { projectId: request.projectId } : {}),
        ...(has('card') && request.cardId ? { cardId: request.cardId } : {}),
      },
      { onSuccess: (c) => setThread({ id: c.threadId, message: message() }) },
    );
  };

  const sendTask = () => {
    if (!check() || !agent?.workstationId) return;
    const context: DevOpsRequestContext = {
      ...(has('route') && request.route ? { route: request.route } : {}),
      ...(has('project') && request.projectId ? { projectId: request.projectId } : {}),
      ...(has('card') && request.cardId ? { cardId: request.cardId } : {}),
      ...(has('desk') && request.deskItemId ? { deskItemId: request.deskItemId } : {}),
      ...(has('repo') && request.repoId ? { repoId: request.repoId } : {}),
      ...(has('error') && request.errorText ? { errorText: request.errorText } : {}),
    };
    createRequest.mutate(
      {
        workstationId: agent.workstationId,
        summary: text.trim(),
        origin: request.origin ?? 'app',
        context,
        ...(has('card') && request.cardId ? { cardId: request.cardId } : {}),
      },
      { onSuccess: () => setSent(true) },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Ask DevOps"
      description="DevOps works on your workstation as you: it can run commands, install tools, build and deploy. Say what you need."
      size="lg"
    >
      {thread ? (
        <div className="flex h-[min(60dvh,32rem)] flex-col" data-testid="ask-devops-chat">
          <ChatPanel threadId={thread.id} initialMessage={thread.message} />
        </div>
      ) : sent ? (
        <Callout tone="success" role="status">
          Request sent to {agent?.name}. Follow it under{' '}
          <Link to="/workstations" onClick={onClose} className="underline">
            Workstations
          </Link>
          ; if it needs your approval it appears on the desk.
        </Callout>
      ) : (
        <form
          className="flex flex-col gap-3"
          aria-label="Ask DevOps"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startChat();
          }}
        >
          {auto ? (
            <p className="text-sm text-muted" data-testid="ask-devops-target">
              Asking <strong>{auto.name}</strong>
              {nameOf(auto.workstationId) ? ` on ${nameOf(auto.workstationId)}` : ''}.
            </p>
          ) : (
            <Select label="Workstation" value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">Choose a workstation</option>
              {devopsAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {nameOf(a.workstationId) ?? a.name} ({a.name})
                </option>
              ))}
            </Select>
          )}
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
          <ErrorBox error={createChat.error ?? createRequest.error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {canTask && (
              <Button type="button" onClick={sendTask} disabled={createRequest.isPending}>
                Send as a task
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={createChat.isPending}>
              Start chat
            </Button>
          </div>
        </form>
      )}
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
