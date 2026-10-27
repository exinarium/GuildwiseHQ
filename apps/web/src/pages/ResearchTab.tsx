import { BookOpenText, FlaskConical } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useBoard } from '../api/queries/board.ts';
import { useProjectPublications, useProjects } from '../api/queries/projects.ts';
import { PublicationPanel } from '../components/PublicationPanel.tsx';
import { projectTypeLabel } from '../components/shell/ProjectSwitcher.tsx';
import {
  Badge,
  ButtonLink,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  PageSkeleton,
  Panel,
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';

/**
 * The Research tab of a project that has research notes or started as research (docs/design/restructure.md owner
 * decision 15): the open research cards, then every published note with its citations and transcripts. The notes
 * themselves live in the project's vault folder; PROJECT.md lists them for the agents.
 */
export function ResearchTab() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const notes = useProjectPublications(project?.id);
  const board = useBoard(project?.id);

  if (projects.isPending) return <PageSkeleton label="Loading the research" />;
  if (!project)
    return (
      <EmptyState
        icon={FlaskConical}
        tone="warning"
        title="That project does not exist or you do not have access"
        description={`Nothing is called ${projectKey}.`}
        action={
          <ButtonLink to="/projects" variant="primary">
            Browse projects
          </ButtonLink>
        }
      />
    );

  const open = (board.data?.columns ?? [])
    .filter((c) => c.name !== 'Done')
    .flatMap((c) => c.cards.map((card) => ({ ...card, column: c.name })))
    .filter((c) => c.cardType === 'research');
  const started = project.startedAs ?? project.workflowKey;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5" data-testid="research-tab">
      <PageHeader
        title={`${project.name} research`}
        documentTitle={`${project.name} research`}
        sub={
          <span className="tnum">
            {project.key} · {projectTypeLabel(project.workflowKey)}
            {started !== project.workflowKey && ` · started as ${projectTypeLabel(started)}`}
          </span>
        }
        actions={
          <ButtonLink to={`/cards/new?project=${project.key}&type=research`} variant="primary">
            New research card
          </ButtonLink>
        }
      />

      {open.length > 0 && (
        <Panel title={`In progress (${open.length})`}>
          <ul className="flex flex-col divide-y divide-line" data-testid="research-open">
            {open.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-2 text-sm first:pt-0 last:pb-0">
                <Link to={`/cards/${c.ref}`} className="font-mono text-xs text-brand-text underline">
                  {c.ref}
                </Link>
                <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
                <Badge>{c.column}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <section aria-labelledby="research-notes" className="flex flex-col gap-3">
        <h2 id="research-notes" className="text-lg font-semibold text-fg">
          Published notes{notes.data ? ` (${notes.data.length})` : ''}
        </h2>
        {notes.isPending && <ListSkeleton rows={3} />}
        {notes.isError && <ErrorBox error={notes.error} onRetry={() => notes.refetch()} />}
        {notes.data && notes.data.length === 0 && (
          <EmptyState
            data-testid="research-empty"
            icon={BookOpenText}
            title="No notes published yet"
            description="A note is published when the checker has verified every claim against its citations. Create a research card to start."
            action={
              <ButtonLink to={`/cards/new?project=${project.key}&type=research`} variant="primary">
                New research card
              </ButtonLink>
            }
          />
        )}
        {notes.data?.map((n) => (
          <div key={n.id} className="flex flex-col gap-1" data-testid="research-note">
            <p className="flex flex-wrap items-center gap-2 text-xs text-subtle">
              <Link to={`/cards/${n.cardRef}`} className="font-mono text-brand-text underline">
                {n.cardRef}
              </Link>
              <span>{formatDateTime(n.createdAt)}</span>
            </p>
            <PublicationPanel publication={n} />
          </div>
        ))}
      </section>
    </div>
  );
}
