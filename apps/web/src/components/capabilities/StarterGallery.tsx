import type { AgentDraftDto, StarterEntry } from '@aom/shared';
import { BookOpen, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useStarterDraft, useStarterGallery } from '../../api/queries/agent-ux.ts';
import { useRunPlaybook } from '../../api/queries/playbooks.ts';
import { DraftReview } from '../agents/DraftReview.tsx';
import { HireDialog } from '../agents/HireDialog.tsx';
import { Button, Dialog, EmptyState, ErrorBox, ListSkeleton, Panel } from '../ui.tsx';

/** The gallery as the page shows it: entries by group, each with its one-line outcome and a "Use" button. */
export function StarterGalleryList({
  entries,
}: {
  entries: ReadonlyArray<Omit<StarterEntry, 'group'> & { group: string }>;
}) {
  const navigate = useNavigate();
  const run = useRunPlaybook();
  const draftOf = useStarterDraft();
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<{ key: string; draft: AgentDraftDto } | null>(null);
  const [hiring, setHiring] = useState<{ key: string; draft: AgentDraftDto } | null>(null);
  const groups = [...new Set(entries.map((e) => e.group))];

  const use = (e: (typeof entries)[number]) => {
    setBusy(`${e.kind}:${e.key}`);
    if (e.kind === 'playbook')
      run.mutate(
        { key: e.key, input: '' },
        { onSuccess: (r) => navigate(r.path), onSettled: () => setBusy(null) },
      );
    else
      draftOf.mutate(e.key, {
        onSuccess: (r) => setReview({ key: e.key, draft: r.draft }),
        onSettled: () => setBusy(null),
      });
  };

  return (
    <div className="flex flex-col gap-5" data-testid="starter-gallery">
      {groups.map((g) => (
        <section key={g} aria-label={g}>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-subtle">{g}</h3>
          <ul className="grid gap-3 sm:grid-cols-2">
            {entries
              .filter((e) => e.group === g)
              .map((e) => (
                <li key={`${e.kind}:${e.key}`}>
                  <Panel className="flex h-full flex-col gap-2" data-testid={`starter-${e.kind}-${e.key}`}>
                    <div className="flex items-center gap-2">
                      {e.kind === 'playbook' ? (
                        <BookOpen aria-hidden="true" className="size-4 text-subtle" />
                      ) : (
                        <UserPlus aria-hidden="true" className="size-4 text-subtle" />
                      )}
                      <h4 className="font-medium text-fg">{e.title}</h4>
                      <span className="ml-auto text-xs text-subtle">
                        {e.kind === 'playbook' ? 'Playbook' : 'Persona'}
                      </span>
                    </div>
                    <p className="text-sm text-muted">{e.outcome}</p>
                    <div className="mt-auto pt-1">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === `${e.kind}:${e.key}`}
                        aria-label={`Use ${e.title}`}
                        data-testid={`use-${e.kind}-${e.key}`}
                        onClick={() => use(e)}
                      >
                        {e.kind === 'playbook' ? 'Run it' : 'Hire it'}
                      </Button>
                    </div>
                  </Panel>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <ErrorBox error={run.error ?? draftOf.error} />
      {review && (
        <Dialog
          open
          size="lg"
          onOpenChange={(o) => !o && setReview(null)}
          title="Review before hiring"
          description="This starter persona becomes an agent of your own. Change anything you like; nothing is hired until the next step."
          footer={
            <>
              <Button variant="ghost" onClick={() => setReview(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="starter-continue"
                onClick={() => {
                  setHiring(review);
                  setReview(null);
                }}
              >
                Continue to hire
              </Button>
            </>
          }
        >
          <DraftReview
            draft={review.draft}
            onChange={(d) => setReview({ key: review.key, draft: d })}
            idPrefix="starter"
          />
        </Dialog>
      )}
      {hiring && (
        <HireDialog
          open
          onOpenChange={(o) => !o && setHiring(null)}
          draft={hiring.draft}
          starterKey={hiring.key}
        />
      )}
    </div>
  );
}

/** Settings > Capabilities > Starter gallery. */
export function StarterGalleryTab() {
  const q = useStarterGallery();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        A short list of built-in personas and playbooks worth trying first. A playbook starts a guided
        session; a persona is reviewed and then hired as an agent of your own.
      </p>
      {q.isPending && <ListSkeleton label="Loading the gallery" rows={3} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.entries.length === 0 && (
        <EmptyState title="Nothing to show" description="No starter capabilities are available." />
      )}
      {q.data && <StarterGalleryList entries={q.data.entries} />}
    </div>
  );
}

/** First run: the gallery above the agents, until the organization hired an agent or started a session. */
export function FirstRunGallery() {
  const q = useStarterGallery();
  const [open, setOpen] = useState(true);
  if (!q.data?.firstRun || q.data.entries.length === 0) return null;
  return (
    <section
      className="mb-6 rounded-card border border-line bg-surface p-4"
      aria-label="Get going"
      data-testid="first-run-gallery"
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-fg">Get going with a starter</h2>
          <p className="text-sm text-muted">
            Pick one to try: a guided playbook, or a persona to hire as an agent.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open && <StarterGalleryList entries={q.data.entries} />}
    </section>
  );
}
