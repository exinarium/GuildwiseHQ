import type { VideoPost, VideoPrivacy } from '@aom/shared';
import { useEffect, useState } from 'react';
import { useSocialPostAction } from '../../api/queries/blog.ts';
import { useEditVideo, useVideoAction, useVideoPost, videoFileUrl } from '../../api/queries/video.ts';
import { formatDateTime } from '../../lib/time.ts';
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  ErrorBox,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../ui.tsx';

const STATUS_LABEL = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
} as const;
const STATUS_TONE = {
  draft: 'neutral',
  in_review: 'warning',
  approved: 'success',
  rejected: 'danger',
} as const;
const UPLOAD_TONE = {
  pending: 'warning',
  posting: 'warning',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
  locked_private: 'danger',
} as const;
const UPLOAD_LABEL = {
  pending: 'Waiting to upload',
  posting: 'Uploading',
  sent: 'On YouTube',
  failed: 'Upload failed',
  skipped: 'Skipped',
  locked_private: 'Kept private by YouTube',
} as const;
const AUDIT_FORM = 'https://support.google.com/youtube/contact/yt_api_form';

const size = (bytes: number | null) => (bytes === null ? '' : `${(bytes / 1_000_000).toFixed(1)} MB`);
const clock = (s: number | null) =>
  s === null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/**
 * Review of one video post: the rendered video with its caption track, the script, the YouTube metadata, the render and
 * upload state. ONE gate: Approve is disabled until the current revision is rendered. A change to the script, title,
 * description or hashtags renders the video again (at most 3 renders); tags and privacy are saved in place.
 */
export function VideoReview({
  post,
  workerRunning = true,
  nested = false,
}: {
  post: VideoPost;
  workerRunning?: boolean;
  /** The Short shown under its long video. */
  nested?: boolean;
}) {
  const toast = useToast();
  const edit = useEditVideo(post.id);
  const act = useVideoAction(post.id);
  const [title, setTitle] = useState(post.meta.title);
  const [description, setDescription] = useState(post.meta.description);
  const [tags, setTags] = useState(post.meta.tags.join(', '));
  const [hashtags, setHashtags] = useState(post.meta.hashtags.join(' '));
  const [privacy, setPrivacy] = useState<VideoPrivacy | ''>(post.meta.privacy ?? '');
  const [cues, setCues] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form when the stored revision changes
  useEffect(() => {
    setTitle(post.meta.title);
    setDescription(post.meta.description);
    setTags(post.meta.tags.join(', '));
    setHashtags(post.meta.hashtags.join(' '));
    setPrivacy(post.meta.privacy ?? '');
    setCues({});
  }, [post.updatedAt, post.revision]);

  const locked = post.status === 'approved';
  const r = post.render;
  const rendered = r?.status === 'rendered';
  const short = post.format === 'short';
  const tagList = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const hashList = hashtags
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((h) => (h.startsWith('#') ? h : `#${h}`));
  const scriptEdited = Object.keys(cues).some(
    (id) => cues[id] !== post.script?.cues.find((c) => c.id === id)?.text,
  );
  const rerenders =
    !post.library &&
    (scriptEdited ||
      title.trim() !== post.meta.title ||
      description.trim() !== post.meta.description ||
      hashList.join(' ') !== post.meta.hashtags.join(' '));
  const changed =
    rerenders ||
    tagList.join(',') !== post.meta.tags.join(',') ||
    (privacy || undefined) !== post.meta.privacy ||
    (post.library &&
      (title.trim() !== post.meta.title ||
        description.trim() !== post.meta.description ||
        hashList.join(' ') !== post.meta.hashtags.join(' ')));

  const save = () => {
    const script = post.script
      ? scriptEdited
        ? {
            ...post.script,
            cues: post.script.cues.map((c) =>
              cues[c.id] !== undefined ? { ...c, text: cues[c.id] as string } : c,
            ),
          }
        : undefined
      : undefined;
    edit.mutate(
      {
        ...(script ? { script } : {}),
        meta: { title: title.trim(), description: description.trim(), tags: tagList, hashtags: hashList },
        privacy: privacy || null,
      },
      { onSuccess: () => toast.success(rerenders ? 'Saved: the video renders again' : 'Saved') },
    );
  };
  const run = (
    action: 'approve' | 'reject' | 'retry-render' | 'retry-upload' | 'resolve-locked' | 'crosspost',
    done: string,
  ) =>
    act.mutate(action === 'reject' ? { action, reason: reason.trim() } : { action }, {
      onSuccess: () => {
        toast.success(done);
        setRejecting(false);
        setReason('');
      },
    });

  const videoName = short ? 'short.mp4' : 'video.mp4';
  // A library video is a recorded help video: the app has no copy, the media service serves it at /videos/<slug>.
  const libSlug = post.library ? post.ref.replace(/^lib:/, '') : null;
  const videoSrc = libSlug ? `/videos/${libSlug}.mp4` : r ? videoFileUrl(post.id, videoName, r.revision) : '';
  const captionsSrc = libSlug
    ? `/videos/${libSlug}.vtt`
    : r
      ? videoFileUrl(post.id, 'captions.vtt', r.revision)
      : '';
  const u = post.upload;
  const failedRender = r?.status === 'failed';
  return (
    <div
      className={nested ? 'mt-4 rounded-card border border-line p-3' : 'flex flex-col gap-4'}
      data-testid={`video-review-${post.format}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={nested ? 'text-base font-semibold text-fg' : 'text-lg font-semibold text-fg'}>
          {short ? 'Short' : post.title}
        </h2>
        <Badge tone={STATUS_TONE[post.status]}>{STATUS_LABEL[post.status]}</Badge>
        {post.library && <Badge tone="info">Library video</Badge>}
        <span className="text-sm text-muted">
          {post.kind} · {post.ref} · revision {post.revision} · from {post.origin ?? 'the platform'}
        </span>
      </div>
      <ErrorBox error={edit.error ?? act.error} />
      {post.rejectionReason && (
        <Callout tone="danger" title="Rejected">
          {post.rejectionReason}. Edit it to send it back to review.
        </Callout>
      )}

      {/* the render */}
      <div data-testid="video-render">
        {!r && <Callout tone="warning">No render yet.</Callout>}
        {r && (r.status === 'queued' || r.status === 'rendering') && (
          <Callout tone="info" title={r.status === 'queued' ? 'Waiting to be rendered' : 'Rendering'}>
            {r.status === 'queued'
              ? 'The video worker picks it up next; a render takes a few minutes. Approve unlocks when it is done.'
              : `Attempt ${r.attempts} of 3.`}
            {!workerRunning && <strong> The video worker is not running.</strong>}
          </Callout>
        )}
        {failedRender && (
          <Callout
            tone="danger"
            title="The render failed"
            actions={
              <Button size="sm" loading={act.isPending} onClick={() => run('retry-render', 'Queued again')}>
                Try again
              </Button>
            }
          >
            {r.error}
          </Callout>
        )}
        {rendered && r && !post.library && !r.files.includes('video') && (
          <Callout tone="info">
            The video file was removed by the clean-up (30 days after the upload). The captions and script are
            kept.
          </Callout>
        )}
        {rendered && r && (post.library || r.files.includes('video')) && (
          <>
            {/* biome-ignore lint/a11y/useMediaCaption: the caption track is added below when the render has one (library videos may not) */}
            <video
              key={`${post.id}-${r.revision}`}
              controls
              preload="metadata"
              className={short ? 'max-h-[28rem] rounded-card bg-black' : 'w-full rounded-card bg-black'}
              poster={r.files.includes('thumb') ? videoFileUrl(post.id, 'thumb.png', r.revision) : undefined}
              src={videoSrc}
              data-testid="video-player"
            >
              {r.files.includes('captionsVtt') && (
                <track kind="captions" src={captionsSrc} srcLang="en" label="English" default />
              )}
            </video>
            <p className="mt-1 text-sm text-muted">
              {clock(r.durationSeconds)} · {size(r.bytes)} · rendered{' '}
              {r.finishedAt ? formatDateTime(r.finishedAt) : ''}
              {' · '}
              <a
                className="text-brand hover:underline"
                href={videoSrc}
                download={libSlug ? `${libSlug}.mp4` : videoName}
                data-testid="video-download"
              >
                Download MP4
              </a>
              {post.library && ' · the recorded help video, nothing was rendered'}
            </p>
          </>
        )}
        {!post.library && (
          <p className="mt-1 text-xs text-subtle">
            Renders used: {post.rendersUsed} of 3. Editing the script, title, description or hashtags renders
            again.
          </p>
        )}
      </div>

      {/* the metadata */}
      <fieldset disabled={locked} className="flex flex-col gap-3" data-testid="video-meta">
        <TextInput
          label="YouTube title"
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextArea
          label="Description (the hook; links, chapters and hashtags are added)"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Tags (comma separated)" value={tags} onChange={(e) => setTags(e.target.value)} />
          <TextInput
            label="Hashtags (3 to 5)"
            value={hashtags}
            onChange={(e) => setHashtags(e.target.value)}
          />
        </div>
        <Select
          label="Privacy"
          value={privacy}
          onChange={(e) => setPrivacy(e.target.value as VideoPrivacy | '')}
          hint="Public goes live at the next daily slot, 10:00 SAST."
        >
          <option value="">Use the setting</option>
          <option value="public">Public (scheduled)</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </Select>
        <p className="text-xs text-muted">
          Made for kids: no. Contains synthetic media: no (the description says the voice is synthetic).
          Category: Education.
        </p>
      </fieldset>

      {post.script && (
        <Disclosure summary={`Script (${post.script.cues.length} cues)`} data-testid="video-script">
          <ol className="flex flex-col gap-2">
            {post.script.cues.map((c, i) => (
              <li key={c.id}>
                <TextArea
                  label={`${i + 1}. ${c.scene.type}${post.script?.chapters.find((ch) => ch.fromCue === i) ? ` · chapter: ${post.script.chapters.find((ch) => ch.fromCue === i)?.title}` : ''}`}
                  rows={2}
                  disabled={locked}
                  value={cues[c.id] ?? c.text}
                  onChange={(e) => setCues((v) => ({ ...v, [c.id]: e.target.value }))}
                />
              </li>
            ))}
          </ol>
        </Disclosure>
      )}

      {!locked && (
        <div className="flex flex-wrap gap-2">
          <Button loading={edit.isPending} disabled={!changed} onClick={save} data-testid="video-save">
            {rerenders ? 'Save and render again' : 'Save changes'}
          </Button>
          {post.status !== 'rejected' && (
            <Button
              variant="primary"
              loading={act.isPending}
              disabled={!rendered || changed}
              title={
                !rendered ? 'Available when the video is rendered' : changed ? 'Save your changes first' : ''
              }
              onClick={() => run('approve', 'Approved: it uploads at the next free slot')}
              data-testid="video-approve"
            >
              Approve and upload
            </Button>
          )}
          {post.status !== 'rejected' && (
            <Button variant="danger" onClick={() => setRejecting((v) => !v)} data-testid="video-reject">
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
            data-testid="video-reject-reason"
          />
          <div>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={act.isPending}
              onClick={() => run('reject', 'Rejected')}
              data-testid="video-reject-confirm"
            >
              Reject this video
            </Button>
          </div>
        </div>
      )}

      {/* the upload */}
      {u && (
        <div className="flex flex-col gap-2" data-testid="video-upload">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={UPLOAD_TONE[u.status]}>{UPLOAD_LABEL[u.status]}</Badge>
            {u.url && (
              <a
                href={u.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-brand hover:underline"
              >
                Open on YouTube
              </a>
            )}
            {u.publishAt && <span className="text-sm text-muted">public {formatDateTime(u.publishAt)}</span>}
            {u.status === 'failed' && (
              <Button size="sm" loading={act.isPending} onClick={() => run('retry-upload', 'Queued again')}>
                Try the upload again
              </Button>
            )}
          </div>
          {u.error && <p className="text-sm text-danger">{u.error}</p>}
          {u.warnings.map((w) => (
            <Callout key={w} tone="warning">
              {w}
            </Callout>
          ))}
          {u.status === 'locked_private' && (
            <Callout
              tone="danger"
              title="YouTube kept this video private"
              role="alert"
              actions={
                <Button
                  size="sm"
                  loading={act.isPending}
                  onClick={() => run('resolve-locked', 'Uploads continue')}
                >
                  I dealt with it
                </Button>
              }
            >
              Videos uploaded through an API project that has not passed the compliance audit are locked to
              private. Request the audit with{' '}
              <a className="underline" href={AUDIT_FORM} target="_blank" rel="noopener noreferrer">
                Google's form
              </a>
              , or make the video public by hand in YouTube Studio. No more videos are uploaded until you say
              you dealt with it.
            </Callout>
          )}
        </div>
      )}

      {post.kind === 'tutorial' && post.format === 'long' && u?.status === 'sent' && (
        <CrossPost post={post} onCreate={() => run('crosspost', 'Cross-post drafted')} busy={act.isPending} />
      )}

      {!nested && post.shortId && <ShortOfPost id={post.shortId} workerRunning={workerRunning} />}
    </div>
  );
}

function ShortOfPost({ id, workerRunning }: { id: string; workerRunning: boolean }) {
  const q = useVideoPost(id);
  if (!q.data) return q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null;
  return <VideoReview post={q.data} workerRunning={workerRunning} nested />;
}

/** The optional cross-post of a tutorial to the other networks: a link to the YouTube video, approved on its own. */
function CrossPost({ post, onCreate, busy }: { post: VideoPost; onCreate: () => void; busy: boolean }) {
  const cp = post.crossPost;
  const act = useSocialPostAction(cp?.id ?? '');
  const [reason, setReason] = useState('');
  const toast = useToast();
  return (
    <div className="rounded-card border border-line p-3" data-testid="video-crosspost">
      <h3 className="text-sm font-semibold text-fg">Cross-post to the other networks</h3>
      {!cp ? (
        <>
          <p className="mt-1 text-sm text-muted">
            Optional: announce this tutorial on Facebook, LinkedIn, X and Bluesky with a link to the YouTube
            video. It is approved on its own.
          </p>
          <Button className="mt-2" loading={busy} onClick={onCreate} data-testid="video-crosspost-create">
            Draft the cross-post
          </Button>
        </>
      ) : (
        <div className="mt-1 flex flex-col gap-2">
          <p className="text-sm text-muted">
            {cp.title} ·{' '}
            <Badge
              tone={cp.status === 'approved' ? 'success' : cp.status === 'rejected' ? 'danger' : 'warning'}
            >
              {cp.status}
            </Badge>
            {cp.shares.map((s) => (
              <Badge
                key={s.network}
                className="ml-1"
                tone={s.status === 'sent' ? 'success' : 'neutral'}
                title={s.error ?? ''}
              >
                {s.network}: {s.status}
              </Badge>
            ))}
          </p>
          <ErrorBox error={act.error} />
          {cp.status !== 'approved' && cp.status !== 'rejected' && (
            <div className="flex flex-wrap items-end gap-2">
              <Button
                variant="primary"
                loading={act.isPending}
                data-testid="video-crosspost-approve"
                onClick={() =>
                  act.mutate(
                    { action: 'approve' },
                    { onSuccess: () => toast.success('Approved: it is shared shortly') },
                  )
                }
              >
                Approve and share
              </Button>
              <TextInput
                label="Reason to reject"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                variant="danger"
                disabled={!reason.trim()}
                loading={act.isPending}
                onClick={() => act.mutate({ action: 'reject', reason: reason.trim() })}
              >
                Reject
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
