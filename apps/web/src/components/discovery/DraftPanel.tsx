import type { DiscoveryDoc, DiscoveryStateDto } from '@aom/shared';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMe } from '../../api/queries/auth.ts';
import { useHandToBa, useRequestDraft, useRequestValidation } from '../../api/queries/discovery.ts';
import { useChangeDocumentStatus, useDocument, useDocumentVersion } from '../../api/queries/documents.ts';
import { canUseIntake } from '../../lib/intake.ts';
import { ageLabel } from '../../lib/time.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { Badge, Button, Callout, ErrorBox, Select, Spinner } from '../ui.tsx';
import { HireBa } from './HireBa.tsx';

const STATUS_TONE = {
  draft: 'neutral',
  in_review: 'warning',
  approved: 'success',
  handed_off: 'brand',
  archived: 'neutral',
} as const;
export const DOC_STATUS_LABEL = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  handed_off: 'Handed to the BA',
  archived: 'Archived',
} as const;

/** A document's text with a version picker (any saved version can be read). */
export function DocumentBody({ id, versions }: { id: string; versions?: boolean }) {
  const doc = useDocument(id);
  const [picked, setPicked] = useState<number | null>(null);
  const older = useDocumentVersion(
    id,
    picked !== null && picked !== doc.data?.currentVersion ? picked : null,
  );
  if (doc.isPending) return <Spinner label="Loading document" />;
  if (doc.error || !doc.data) return <ErrorBox error={doc.error} />;
  const d = doc.data;
  const shownVersion = picked ?? d.currentVersion;
  const text = picked !== null && picked !== d.currentVersion ? (older.data?.content ?? '') : d.content;
  return (
    <div className="flex flex-col gap-3">
      {versions !== false && d.versions.length > 1 && (
        <Select
          label="Version"
          value={shownVersion}
          onChange={(e) => setPicked(Number(e.target.value))}
          data-testid="version-picker"
        >
          {d.versions.map((v) => (
            <option key={v.id} value={v.version}>
              {`Version ${v.version}${v.version === d.currentVersion ? ' (current)' : ''} · ${v.savedBy.kind === 'user' ? 'you' : v.savedBy.kind} · ${ageLabel(v.createdAt)}${v.note ? ` · ${v.note}` : ''}`}
            </option>
          ))}
        </Select>
      )}
      {picked !== null && picked !== d.currentVersion && older.isPending ? (
        <Spinner label="Loading version" />
      ) : (
        <div className="rounded-control border border-line bg-surface p-3" data-testid="document-text">
          <Markdown text={text || '_Empty._'} />
        </div>
      )}
    </div>
  );
}

function DocBlock({
  doc,
  state,
  canManage,
}: {
  doc: DiscoveryDoc;
  state: DiscoveryStateDto;
  canManage: boolean;
}) {
  const me = useMe();
  const id = state.threadId;
  const status = useChangeDocumentStatus(doc.id);
  const validate = useRequestValidation(id);
  const handoff = useHandToBa(id);
  const full = useDocument(doc.id).data;
  const v = state.config.prdValidation;
  const isPrd = doc.kind === 'prd';
  const approve = async () => {
    if (doc.status === 'draft') await status.mutateAsync({ status: 'in_review' });
    await status.mutateAsync({ status: 'approved' });
  };
  const err = status.error ?? validate.error ?? handoff.error;
  return (
    <div className="flex flex-col gap-3" data-testid={`doc-${doc.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <FileText aria-hidden="true" className="size-4 text-muted" />
        <Link
          to={`/documents/${doc.id}`}
          className="min-w-0 flex-1 truncate font-medium text-brand-text hover:underline"
        >
          {doc.title}
        </Link>
        <Badge tone={STATUS_TONE[doc.status]} data-testid="doc-status">
          {DOC_STATUS_LABEL[doc.status]}
        </Badge>
        <span className="tnum text-xs text-subtle">v{doc.currentVersion}</span>
      </div>
      {isPrd && v && v.docId === doc.id && (
        <div
          className="rounded-control border border-line bg-sunken/50 p-3 text-sm"
          data-testid="prd-validation"
        >
          <p className="font-medium">
            Checklist result{' '}
            <span className="font-normal text-muted">
              (version {v.version}
              {v.version !== doc.currentVersion ? `, the draft is at ${doc.currentVersion} now` : ''})
            </span>
          </p>
          {v.summary && <p className="mt-0.5 text-muted">{v.summary}</p>}
          <ul className="mt-2 flex flex-col gap-1">
            {v.items.map((i) => (
              <li key={`${i.criterion}-${i.status}`} className="flex items-start gap-2">
                <Badge tone={i.status === 'pass' ? 'success' : i.status === 'fail' ? 'danger' : 'neutral'}>
                  {i.status === 'n/a' ? 'n/a' : i.status}
                </Badge>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {i.criterion}
                  {i.note && <span className="text-muted"> · {i.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {canManage && isPrd && (doc.status === 'draft' || doc.status === 'in_review') && (
          <Button
            onClick={() => validate.mutate()}
            loading={validate.isPending}
            disabled={state.busy}
            data-testid="validate-prd"
          >
            Validate against the checklist
          </Button>
        )}
        {canManage && (doc.status === 'draft' || doc.status === 'in_review') && (
          <Button
            variant="primary"
            onClick={() => void approve().catch(() => undefined)}
            loading={status.isPending}
            data-testid="approve-doc"
          >
            Approve
          </Button>
        )}
        {canManage && doc.status === 'approved' && (
          <>
            {isPrd && !state.config.intakeId && !state.config.handoff && (
              <Button
                variant="primary"
                onClick={() => handoff.mutate()}
                loading={handoff.isPending}
                data-testid="hand-to-ba"
              >
                Hand to BA
              </Button>
            )}
            <Button onClick={() => status.mutate({ status: 'draft' })} loading={status.isPending}>
              Reopen
            </Button>
          </>
        )}
        {doc.status === 'handed_off' && !state.config.intakeId && state.config.handoff && (
          <p className="text-sm text-muted" data-testid="handoff-queued">
            Handed off. Waiting for a BA to come online; the intake starts on its own.
          </p>
        )}
        {doc.status === 'handed_off' && state.config.intakeId && canUseIntake(me.data?.activeOrg) && (
          <Link
            to={`/intake/${state.config.intakeId}`}
            className="inline-flex h-9 items-center rounded-control border border-control px-3 text-sm font-medium hover:bg-sunken"
            data-testid="open-intake"
          >
            Open the BA's intake
          </Link>
        )}
      </div>
      {doc.status === 'approved' && full && full.publishState !== 'queued' && (
        <p className="text-xs text-subtle">
          It will be copied to your vault as soon as a workstation is available.
        </p>
      )}
      <ErrorBox error={err} />
      <DocumentBody id={doc.id} />
    </div>
  );
}

/** The brief and the PRD of the session: text, versions, checklist, approval and the hand-over to the BA. */
export function DraftPanel({
  state,
  canManage = true,
  canHire = false,
}: {
  state: DiscoveryStateDto;
  canManage?: boolean;
  canHire?: boolean;
}) {
  const draft = useRequestDraft(state.threadId);
  const docs = state.documents.filter((d) => d.kind === 'prd' || d.kind === 'brief');
  const hasPrd = docs.some((d) => d.kind === 'prd');
  const hasBrief = docs.some((d) => d.kind === 'brief');
  return (
    <div className="flex flex-col gap-4" data-testid="session-drafts">
      {docs.length === 0 && (
        <Callout tone="info" title="No draft yet">
          The analyst writes the brief or the PRD in the capture phase. You can also ask for it now.
        </Callout>
      )}
      {docs.map((d) => (
        <DocBlock key={d.id} doc={d} state={state} canManage={canManage} />
      ))}
      {state.config.handoff && state.baStatus === 'none' && (
        <HireBa canHire={canHire} projectId={state.projectId} />
      )}
      <div className="flex flex-wrap gap-2">
        {canManage && !hasPrd && (
          <Button
            onClick={() => draft.mutate('prd')}
            loading={draft.isPending}
            disabled={state.busy || state.waitingFor === 'paused'}
            data-testid="draft-prd"
          >
            Draft the PRD now
          </Button>
        )}
        {canManage && !hasBrief && (
          <Button
            onClick={() => draft.mutate('brief')}
            loading={draft.isPending}
            disabled={state.busy || state.waitingFor === 'paused'}
            data-testid="draft-brief"
          >
            Draft a product brief
          </Button>
        )}
      </div>
      <ErrorBox error={draft.error} />
    </div>
  );
}
