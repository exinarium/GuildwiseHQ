import { DOCUMENT_KINDS, DOCUMENT_STATUSES, type DocumentKind, type DocumentStatus } from '@aom/shared';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useChangeDocumentStatus, useDocument, useDocuments } from '../api/queries/documents.ts';
import { DOC_STATUS_LABEL, DocumentBody } from '../components/discovery/DraftPanel.tsx';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  FilterChip,
  ListSkeleton,
  PageHeader,
  PageSkeleton,
  Panel,
} from '../components/ui.tsx';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { ageLabel } from '../lib/time.ts';

const KIND_LABEL: Record<DocumentKind, string> = {
  brief: 'Product brief',
  prd: 'PRD',
  minutes: 'Minutes',
  session_log: 'Session log',
};
const STATUS_TONE = {
  draft: 'neutral',
  in_review: 'warning',
  approved: 'success',
  handed_off: 'brand',
  archived: 'neutral',
} as const;

/** Briefs, PRDs, minutes and session logs of the organization. */
export function DocumentsList() {
  const [kind, setKind] = useState<DocumentKind | null>(null);
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const docs = useDocuments({ ...(kind ? { kind } : {}), ...(status ? { status } : {}) });
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Documents"
        sub="Briefs and PRDs from your discovery sessions. Approved ones are copied to your vault."
      />
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <FilterChip pressed={kind === null} onClick={() => setKind(null)}>
            All kinds
          </FilterChip>
          {DOCUMENT_KINDS.map((k) => (
            <FilterChip key={k} pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
              {KIND_LABEL[k]}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterChip pressed={status === null} onClick={() => setStatus(null)}>
            Any status
          </FilterChip>
          {DOCUMENT_STATUSES.map((st) => (
            <FilterChip key={st} pressed={status === st} onClick={() => setStatus(status === st ? null : st)}>
              {DOC_STATUS_LABEL[st]}
            </FilterChip>
          ))}
        </div>
      </div>
      {docs.isPending && <ListSkeleton rows={3} />}
      <ErrorBox error={docs.error} onRetry={() => void docs.refetch()} />
      {docs.data && docs.data.length === 0 && (
        <EmptyState
          icon={FileText}
          tone="neutral"
          title="No documents yet"
          description="A discovery session writes a brief or a PRD here."
        />
      )}
      {docs.data && docs.data.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Documents">
          {docs.data.map((d) => (
            <li key={d.id}>
              <Link
                to={`/documents/${d.id}`}
                data-testid="document-row"
                className="flex min-h-14 flex-col gap-1 rounded-card border border-line bg-surface px-4 py-3 hover:border-control sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{d.title}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge>{KIND_LABEL[d.kind]}</Badge>
                  <Badge tone={STATUS_TONE[d.status]}>{DOC_STATUS_LABEL[d.status]}</Badge>
                  <span className="tnum">v{d.currentVersion}</span>
                  <span>{ageLabel(d.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One document: its text as markdown, its versions, its status and the sessions it came from. */
export function DocumentView() {
  const { id = '' } = useParams();
  const doc = useDocument(id);
  const status = useChangeDocumentStatus(id);
  const canManage = useCanManageOrg();
  if (doc.isPending) return <PageSkeleton label="Loading the document" panels={1} />;
  if (!doc.data)
    return (
      <EmptyState
        icon={FileText}
        tone="neutral"
        title="Document not found"
        description="It may have been removed, or you may not have access to its project."
      />
    );
  const d = doc.data;
  return (
    <div className="mx-auto max-w-3xl" data-testid="document-view">
      <PageHeader
        title={d.title}
        back={{ to: '/documents', label: 'All documents' }}
        sub={
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{KIND_LABEL[d.kind]}</Badge>
            <Badge tone={STATUS_TONE[d.status]} data-testid="document-status">
              {DOC_STATUS_LABEL[d.status]}
            </Badge>
            <span className="tnum">version {d.currentVersion}</span>
            {d.vaultPath && d.publishedVersion !== null && <span>Copied to the vault as {d.vaultPath}</span>}
          </span>
        }
        actions={
          canManage ? (
            <>
              {d.status === 'draft' && (
                <Button onClick={() => status.mutate({ status: 'in_review' })} loading={status.isPending}>
                  Send for review
                </Button>
              )}
              {(d.status === 'draft' || d.status === 'in_review') && (
                <Button
                  variant="primary"
                  loading={status.isPending}
                  onClick={async () => {
                    if (d.status === 'draft') await status.mutateAsync({ status: 'in_review' });
                    await status.mutateAsync({ status: 'approved' });
                  }}
                >
                  Approve
                </Button>
              )}
              {(d.status === 'approved' || d.status === 'archived') && (
                <Button onClick={() => status.mutate({ status: 'draft' })} loading={status.isPending}>
                  Reopen
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <ErrorBox error={status.error} />
      <Panel>
        <DocumentBody id={id} />
      </Panel>
      {d.sourceThreadIds.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          From{' '}
          {d.sourceThreadIds.map((t, i) => (
            <span key={t}>
              {i > 0 && ', '}
              <Link to={`/discovery/${t}`} className="text-brand-text hover:underline">
                a discovery session
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
