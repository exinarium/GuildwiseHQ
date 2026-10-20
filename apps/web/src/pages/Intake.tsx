import { BriefcaseBusiness } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useCeoChat } from '../api/queries/ceo.ts';
import { useCreateIntake, useIntake, useIntakes } from '../api/queries/intake.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { AgentAvatar } from '../components/Face.tsx';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Callout,
  ConnectionDot,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  TextArea,
} from '../components/ui.tsx';
import { describeSource, intakeStatusText } from '../lib/intake.ts';
import { openCeoChat } from '../lib/openCeoChat.ts';
import { useActiveOrgRole } from '../lib/orgRole.ts';
import { ageLabel } from '../lib/time.ts';
import { BatchForm, BatchList } from './IntakeBatch.tsx';

/** Start an intake: paste a Jira key or GitHub issue (or describe the need) and talk to the BA about it. */
export function IntakeNew() {
  const nav = useNavigate();
  const create = useCreateIntake();
  const intakes = useIntakes();
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'chat' | 'batch'>('chat');
  const source = describeSource(note);
  const isOwner = useActiveOrgRole() === 'owner';
  const ceoChat = useCeoChat();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    create.mutate({ note: note.trim() }, { onSuccess: (i) => nav(`/intake/${i.id}`) });
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Bring work in from Jira or GitHub"
        documentTitle="Intake"
        back={{ to: '/desk', label: 'Back to the desk' }}
        sub="Paste a ticket or describe the need. Your business analyst turns it into cards and asks you what it cannot decide."
      />
      <div role="tablist" aria-label="Intake mode" className="mb-3 flex gap-2">
        {(['chat', 'batch'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`min-h-11 flex-1 rounded-card border px-3 py-1.5 text-sm font-medium md:min-h-0 md:flex-none ${mode === m ? 'border-brand bg-brand-soft text-brand-soft-fg' : 'border-line text-muted hover:border-control'}`}
          >
            {m === 'chat' ? 'One ticket (chat)' : 'Batch'}
          </button>
        ))}
      </div>
      {mode === 'batch' && <BatchForm />}
      {mode === 'chat' && (
        <Panel>
          <form onSubmit={submit} aria-label="Start an intake" className="flex flex-col gap-3" noValidate>
            <TextArea
              label="Ticket or need"
              rows={3}
              placeholder="ABC-123, acme/web#12, an issue URL, or describe what you need"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {note.trim() && (
              <p className="flex items-center gap-2 text-sm text-muted" data-testid="intake-source">
                <Badge tone="brand">Detected</Badge>
                {source.label}
              </p>
            )}
            <ErrorBox error={create.error ?? ceoChat.error} />
            <div className="flex flex-wrap gap-2">
              {isOwner && (
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  className="max-md:w-full md:h-9 md:px-3.5 md:text-sm"
                  data-testid="intake-via-ceo"
                  disabled={!note.trim()}
                  loading={ceoChat.isPending}
                  onClick={() =>
                    ceoChat.mutate(undefined, {
                      onSuccess: (c) =>
                        openCeoChat(nav, c.threadId, { prefill: `New intake: ${note.trim()}` }),
                    })
                  }
                >
                  Tell your CEO
                </Button>
              )}
              <Button
                type="submit"
                variant={isOwner ? 'secondary' : 'primary'}
                size="lg"
                className="max-md:w-full md:h-9 md:px-3.5 md:text-sm"
                disabled={!note.trim()}
                loading={create.isPending}
              >
                {isOwner ? 'Work with the BA directly' : 'Start intake'}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <BatchList />
      {(intakes.data?.length ?? 0) > 0 && (
        <section className="mt-8" aria-label="Earlier intakes">
          <h2 className="mb-2 text-lg font-semibold text-fg">Earlier intakes</h2>
          <ul
            className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface"
            data-testid="intake-list"
          >
            {intakes.data?.map((i) => (
              <li key={i.id}>
                <Link
                  to={`/intake/${i.id}`}
                  className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-sunken"
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">
                    {i.externalKey ?? 'No ticket'}
                  </span>
                  <span className="text-xs text-subtle">{intakeStatusText(i)}</span>
                  <span className="text-xs text-subtle">{i.cards.length} card(s)</span>
                  <span className="text-xs text-subtle">{ageLabel(i.createdAt)} ago</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One intake: the conversation with the BA beside the cards it created. */
export function IntakeView() {
  const { id = '' } = useParams();
  const intake = useIntake(id);
  if (intake.isPending) return <PageSkeleton label="Loading intake" panels={1} />;
  const i = intake.data;
  if (!i)
    return (
      <EmptyState
        icon={BriefcaseBusiness}
        title="This intake was not found"
        action={<ButtonLink to="/intake">All intakes</ButtonLink>}
      />
    );
  return (
    <div className="mx-auto flex h-[calc(100dvh-8.5rem)] min-h-[30rem] max-w-5xl flex-col max-md:h-[calc(100dvh-5.5rem-var(--app-bottom-inset,0px))]">
      <PageHeader
        title={`Intake ${i.externalKey ?? ''}`.trim()}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
            <span className="inline-flex items-center gap-1.5">
              <AgentAvatar agentId={i.baAgentId} name={i.baAgentName} size={20} />
              BA {i.baAgentName}
            </span>
            <ConnectionDot connected={i.workstationOnline} />
            <Badge tone={i.status === 'mapped' ? 'green' : i.status === 'unmapped' ? 'amber' : 'neutral'}>
              <span data-testid="intake-status">{intakeStatusText(i)}</span>
            </Badge>
            <Link to="/intake" className="text-brand-text hover:underline">
              All intakes
            </Link>
            <Link to="/desk" className="text-brand-text hover:underline">
              Back to the desk
            </Link>
          </span>
        }
      />
      {i.status === 'unmapped' && i.mappingDeskItemId && (
        <Callout tone="warning" role="status" data-testid="intake-mapping-note" className="mb-3">
          The BA could not map this ticket to a project and asked you on the desk.{' '}
          <Link to={`/desk#desk-item-${i.mappingDeskItemId}`} className="font-medium underline">
            Pick the project
          </Link>
          ; the BA then carries on in this conversation.
        </Callout>
      )}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_18rem]">
        <ChatPanel threadId={i.threadId} agentName={i.baAgentName} online={i.workstationOnline} />
        <aside
          aria-label="Cards from this intake"
          className="flex flex-col gap-2 overflow-y-auto max-lg:max-h-48"
        >
          <h2 className="text-lg font-semibold text-fg">Cards created</h2>
          {i.cards.length === 0 ? (
            <p className="text-sm text-subtle" data-testid="intake-no-cards">
              None yet. The BA drafts them as you talk.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="intake-cards">
              {i.cards.map((c) => (
                <li key={c.id} data-testid={`intake-card-${c.ref}`}>
                  <Link
                    to={`/cards/${c.ref}`}
                    className="block rounded-card border border-line bg-surface p-3 text-sm hover:border-control hover:shadow-md"
                  >
                    <span className="font-mono text-xs font-semibold text-muted">{c.ref}</span>{' '}
                    <span className="font-medium text-fg">{c.title}</span>
                    <span className="mt-0.5 block text-xs text-subtle">
                      {c.stage} · {c.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
