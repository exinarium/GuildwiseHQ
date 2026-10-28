import type { ReleaseRow, SocialCaptions, SocialPost, SocialPostStatus } from '@aom/shared';
import { useEffect, useState } from 'react';
import {
  useCreateReleasePost,
  useEditSocialPost,
  useReleases,
  useSocialPostAction,
} from '../../api/queries/blog.ts';
import { ext } from '../../extension/index.ts';
import { formatDateTime } from '../../lib/time.ts';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Panel,
  TextArea,
  TextInput,
  useToast,
} from '../ui.tsx';
import { SocialCaptionsEditor } from './SocialCaptionsEditor.tsx';

const STATUS_LABEL: Record<SocialPostStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
};
const STATUS_TONE: Record<SocialPostStatus, 'neutral' | 'warning' | 'success' | 'danger'> = {
  draft: 'neutral',
  in_review: 'warning',
  approved: 'success',
  rejected: 'danger',
};
const SHARE_TONE = { sent: 'success', failed: 'danger', skipped: 'neutral', pending: 'warning' } as const;

/** Edit, send to review, approve or reject one release post. A release post never goes out without this approval. */
function PostEditor({ post }: { post: SocialPost }) {
  const toast = useToast();
  const edit = useEditSocialPost(post.id);
  const act = useSocialPostAction(post.id);
  const [title, setTitle] = useState(post.content.title);
  const [summary, setSummary] = useState(post.content.summary);
  const [captions, setCaptions] = useState<SocialCaptions>(post.content.captions);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form when the stored revision changes
  useEffect(() => {
    setTitle(post.content.title);
    setSummary(post.content.summary);
    setCaptions(post.content.captions);
  }, [post.updatedAt]);
  const locked = post.status === 'approved';
  const save = () => edit.mutate({ title, summary, captions }, { onSuccess: () => toast.success('Saved') });
  const run = (action: 'submit' | 'approve' | 'reject', done: string) =>
    act.mutate(action === 'reject' ? { action, reason: reason.trim() } : { action }, {
      onSuccess: () => {
        toast.success(done);
        setRejecting(false);
        setReason('');
      },
    });
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid={`release-post-${post.ref}`}>
      <ErrorBox error={edit.error ?? act.error} />
      {post.rejectionReason && (
        <Callout tone="danger" title="Rejected">
          {post.rejectionReason}
        </Callout>
      )}
      {locked && (
        <Callout tone="info">
          Approved {post.approvedAt ? formatDateTime(post.approvedAt) : ''}. It is shared within a few minutes
          to the connected networks and can no longer be edited.
        </Callout>
      )}
      <TextInput
        label="Title (the link card)"
        value={title}
        disabled={locked}
        onChange={(e) => setTitle(e.target.value)}
      />
      <TextArea
        label="Summary (the link card text)"
        rows={2}
        value={summary}
        disabled={locked}
        onChange={(e) => setSummary(e.target.value)}
      />
      <fieldset disabled={locked} className="contents">
        <SocialCaptionsEditor value={captions} onChange={setCaptions} fallback={summary} />
      </fieldset>
      <p className="text-xs text-muted">
        The link to the release page is added for you, with the network as its source. Bluesky shows it as a
        link card.
      </p>
      {!locked && (
        <div className="flex flex-wrap gap-2">
          <Button loading={edit.isPending} onClick={save} data-testid="release-save">
            Save changes
          </Button>
          {(post.status === 'draft' || post.status === 'rejected') && (
            <Button
              loading={act.isPending}
              onClick={() => run('submit', 'Sent to review')}
              data-testid="release-submit"
            >
              Send to review
            </Button>
          )}
          {post.status !== 'rejected' && (
            <Button
              variant="primary"
              loading={act.isPending}
              onClick={() => run('approve', 'Approved: it will be shared shortly')}
              data-testid="release-approve"
            >
              Approve and share
            </Button>
          )}
          {post.status !== 'rejected' && (
            <Button variant="danger" onClick={() => setRejecting((v) => !v)} data-testid="release-reject">
              Reject
            </Button>
          )}
        </div>
      )}
      {rejecting && (
        <div className="flex flex-col gap-2">
          <TextArea
            label="Reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="release-reject-reason"
          />
          <div>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={act.isPending}
              onClick={() => run('reject', 'Rejected')}
              data-testid="release-reject-confirm"
            >
              Reject this post
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReleaseItem({ r, onChanged }: { r: ReleaseRow; onChanged: () => void }) {
  const create = useCreateReleasePost();
  const [open, setOpen] = useState(false);
  const Drafter = ext.ReleaseDrafter;
  const post = r.post;
  return (
    <li className="px-4 py-3" data-testid={`release-${r.version}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-fg">Guildwise HQ {r.version}</span>
        <span className="text-sm text-muted">{r.date}</span>
        {post ? (
          <Badge tone={STATUS_TONE[post.status]}>{STATUS_LABEL[post.status]}</Badge>
        ) : (
          <Badge tone="neutral">No post yet</Badge>
        )}
        {post?.shares.map((s) => (
          <Badge key={s.network} tone={SHARE_TONE[s.status]} title={s.error ?? ''}>
            {s.network}: {s.status}
          </Badge>
        ))}
        <a
          href={`/releases/${r.version}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-brand hover:underline"
        >
          Release page
        </a>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {!post && Drafter && <Drafter version={r.version} onDone={onChanged} />}
          {!post && (
            <Button
              variant={Drafter ? 'ghost' : 'secondary'}
              loading={create.isPending}
              onClick={() =>
                create.mutate(r.version, {
                  onSuccess: () => {
                    setOpen(true);
                    onChanged();
                  },
                })
              }
              data-testid={`release-write-${r.version}`}
            >
              {Drafter ? 'Write by hand' : 'Draft release post'}
            </Button>
          )}
          {post && (
            <Button
              variant="ghost"
              onClick={() => setOpen((v) => !v)}
              data-testid={`release-open-${r.version}`}
            >
              {open ? 'Close' : post.status === 'approved' ? 'View' : 'Review'}
            </Button>
          )}
        </span>
      </div>
      <ErrorBox error={create.error} />
      {post && open && <PostEditor post={post} />}
    </li>
  );
}

/** Platform > Blog > Releases: one row per release of the product with its announcement post. */
export function ReleasesPanel() {
  const q = useReleases();
  if (q.isPending) return <ListSkeleton label="Loading releases" rows={3} />;
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const { releases, pending } = q.data;
  return (
    <Panel title="Release announcements" padding="none" data-testid="releases-panel">
      <p className="px-4 pt-3 text-sm text-muted">
        Each release of Guildwise HQ can be announced on the connected networks. A release post is always
        approved by you first; it is never posted by itself, and a release is announced once.
        {pending > 0 && <strong> {pending} waiting for your approval.</strong>}
      </p>
      {releases.length === 0 ? (
        <EmptyState title="No releases found" description="The changelog lists no released version." />
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {releases.map((r) => (
            <ReleaseItem key={r.version} r={r} onChanged={() => q.refetch()} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
