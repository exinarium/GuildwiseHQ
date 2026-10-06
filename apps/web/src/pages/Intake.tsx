import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useCreateIntake, useIntake, useIntakes } from '../api/queries/intake.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import {
  Badge,
  Button,
  ConnectionDot,
  ErrorBox,
  PageHeader,
  Panel,
  Spinner,
  TextArea,
} from '../components/ui.tsx';
import { describeSource, intakeStatusText } from '../lib/intake.ts';
import { ageLabel } from '../lib/time.ts';

/** Start an intake: paste a Jira key or GitHub issue (or describe the need) and talk to the BA about it. */
export function IntakeNew() {
  const nav = useNavigate();
  const create = useCreateIntake();
  const intakes = useIntakes();
  const [note, setNote] = useState('');
  const source = describeSource(note);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    create.mutate({ note: note.trim() }, { onSuccess: (i) => nav(`/intake/${i.id}`) });
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Intake"
        sub={
          <Link to="/desk" className="underline">
            Back to the desk
          </Link>
        }
      />
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
            <p className="text-xs text-subtle" data-testid="intake-source">
              {source.label}
            </p>
          )}
          <ErrorBox error={create.error} />
          <div>
            <Button type="submit" variant="primary" disabled={!note.trim() || create.isPending}>
              Start intake
            </Button>
          </div>
        </form>
      </Panel>
      {(intakes.data?.length ?? 0) > 0 && (
        <section className="mt-6" aria-label="Earlier intakes">
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-subtle uppercase">Earlier intakes</h2>
          <ul className="flex flex-col gap-1" data-testid="intake-list">
            {intakes.data?.map((i) => (
              <li key={i.id}>
                <Link
                  to={`/intake/${i.id}`}
                  className="flex items-center gap-2 rounded-control border border-line px-3 py-2 text-sm hover:bg-sunken"
                >
                  <span className="flex-1 truncate font-medium">{i.externalKey ?? 'No ticket'}</span>
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
  if (intake.isPending) return <Spinner label="Loading intake" />;
  const i = intake.data;
  if (!i) return <p className="text-sm text-subtle">This intake was not found.</p>;
  return (
    <div className="mx-auto flex h-[calc(100dvh-6rem)] max-w-5xl flex-col">
      <PageHeader
        title={`Intake ${i.externalKey ?? ''}`.trim()}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <ConnectionDot connected={i.workstationOnline} />
            <span>BA {i.baAgentName}</span>
            <Badge tone={i.status === 'mapped' ? 'green' : i.status === 'unmapped' ? 'amber' : 'neutral'}>
              <span data-testid="intake-status">{intakeStatusText(i)}</span>
            </Badge>
            <Link to="/intake" className="underline">
              All intakes
            </Link>
            <Link to="/desk" className="underline">
              Back to the desk
            </Link>
          </span>
        }
      />
      {i.status === 'unmapped' && i.mappingDeskItemId && (
        <p
          role="status"
          data-testid="intake-mapping-note"
          className="mb-2 rounded-control border border-warning-fill/40 bg-warning-soft px-3 py-2 text-sm text-warning-soft-fg"
        >
          The BA could not map this ticket to a project and asked you on the desk.{' '}
          <Link to={`/desk#desk-item-${i.mappingDeskItemId}`} className="font-medium underline">
            Pick the project
          </Link>
          ; the BA then carries on in this conversation.
        </p>
      )}
      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[1fr_16rem]">
        <ChatPanel threadId={i.threadId} agentName={i.baAgentName} online={i.workstationOnline} />
        <aside aria-label="Cards from this intake" className="flex flex-col gap-2 overflow-y-auto">
          <h2 className="text-xs font-semibold tracking-wide text-subtle uppercase">Cards created</h2>
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
                    className="block rounded-control border border-line p-2 text-sm hover:bg-sunken"
                  >
                    <span className="font-medium">{c.ref}</span> {c.title}
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
