import type { PackDto, PackItem } from '@aom/shared';
import { usePackDetail, useTrustPack } from '../../api/queries/capabilities.ts';
import { Badge, Button, Callout, Dialog, ErrorBox, Spinner, useToast } from '../ui.tsx';
import { shortSha } from './badges.tsx';

const KIND_ORDER = ['persona', 'playbook', 'skill'] as const;
const KIND_TITLE = { persona: 'Personas', playbook: 'Playbooks and templates', skill: 'Skills' } as const;

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * The owner's review of one exact commit: every capability with its files (script files flagged), the adapter's notes and
 * issues, and the licence. Approving posts the commit and the content hash that were shown here.
 */
export function TrustReview({ pack, onClose }: { pack: PackDto; onClose: () => void }) {
  const detail = usePackDetail(pack.id);
  const trust = useTrustPack();
  const toast = useToast();
  const snap = detail.data?.snapshot ?? null;
  const items = snap?.items ?? [];
  const approve = () => {
    if (!snap) return;
    trust.mutate(
      { id: pack.id, sha: snap.sha, contentHash: snap.contentHash },
      {
        onSuccess: () => {
          toast.success(`Approved ${pack.name}`);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Review ${pack.name}`}
      description="Nothing of this pack is used until you approve it. Read what it contains."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!snap} loading={trust.isPending} onClick={approve}>
            Approve this exact commit and content
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="trust-review">
        {detail.isPending && <Spinner label="Loading the pack" />}
        {detail.isError && <ErrorBox error={detail.error} onRetry={() => detail.refetch()} />}
        {detail.data && !snap && (
          <Callout tone="info">
            No workstation has read this pack yet. Bring a workstation online, then come back.
          </Callout>
        )}
        {snap && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">Source</dt>
              <dd className="[overflow-wrap:anywhere]">
                {pack.url} @ {snap.ref}
              </dd>
              <dt className="text-muted">Commit</dt>
              <dd>
                <code data-testid="review-sha">{shortSha(snap.sha)}</code>
              </dd>
              <dt className="text-muted">Content hash</dt>
              <dd>
                <code data-testid="review-hash">{snap.contentHash.slice(0, 12)}</code>
              </dd>
              <dt className="text-muted">Licence</dt>
              <dd>{snap.license ?? pack.license ?? 'not stated'}</dd>
            </dl>
            {pack.attribution && <p className="text-xs text-muted">{pack.attribution}</p>}
            <Callout tone="warning">
              <ul className="list-disc pl-5">
                <li>
                  Scripts stay off. Approving does not let any script run; you can enable them separately.
                </li>
                <li>
                  The text of this pack is shown to agents as outside content: it can inform them but cannot
                  give them orders, rights or tools.
                </li>
                <li>
                  Approval covers this commit and these files. Any later change needs your approval again.
                </li>
              </ul>
            </Callout>
            {snap.hasScripts && (
              <p role="alert" className="font-medium text-warning-soft-fg" data-testid="review-has-scripts">
                This pack contains script files (marked below).
              </p>
            )}
            {snap.notes.length > 0 && (
              <section aria-label="Adapter notes">
                <h3 className="font-medium text-fg">Adapter notes</h3>
                <ul className="list-disc pl-5 text-muted" data-testid="review-notes">
                  {snap.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </section>
            )}
            {snap.issues.length > 0 && (
              <Callout tone="warning" data-testid="review-issues">
                <p className="font-medium">Files that could not be read</p>
                <ul className="list-disc pl-5">
                  {snap.issues.map((i) => (
                    <li key={`${i.path}:${i.message}`}>
                      <code>{i.path}</code>: {i.message}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {KIND_ORDER.map((kind) => {
              const group = items.filter((i) => i.kind === kind);
              if (group.length === 0) return null;
              return (
                <section key={kind} aria-label={KIND_TITLE[kind]}>
                  <h3 className="font-medium text-fg">
                    {KIND_TITLE[kind]} ({group.length})
                  </h3>
                  <ul className="mt-1 flex flex-col gap-2">
                    {group.map((i) => (
                      <ReviewItem key={i.key} item={i} pack={pack.name} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        )}
        <ErrorBox error={trust.error} />
      </div>
    </Dialog>
  );
}

function ReviewItem({ item, pack }: { item: PackItem; pack: string }) {
  const key = item.key.includes(':') ? item.key : `${pack}:${item.key}`;
  return (
    <li className="rounded-control border border-line p-2" data-testid={`review-item-${key}`}>
      <div className="flex flex-wrap items-center gap-2">
        {item.icon && <span aria-hidden="true">{item.icon}</span>}
        <span className="font-medium text-fg">{item.name}</span>
        <code className="text-xs text-muted">{key}</code>
        {item.hasScripts && <Badge tone="amber">has scripts</Badge>}
      </div>
      {item.description && <p className="text-xs text-muted [overflow-wrap:anywhere]">{item.description}</p>}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted">{item.files.length} files</summary>
        <ul className="mt-1 text-xs">
          {item.files.map((f) => (
            <li
              key={f.path}
              data-testid={f.script ? 'file-script' : 'file'}
              className={f.script ? 'font-medium text-warning-soft-fg' : 'text-muted'}
            >
              <code>{f.path}</code> ({fmtSize(f.size)})
              {f.script && ' SCRIPT: not run unless you enable scripts'}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
