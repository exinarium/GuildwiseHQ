import type {
  PatchVideoSettingsRequest,
  VideoPost,
  VideoPostStatus,
  VideoSettings,
  VideoStatus,
} from '@aom/shared';
import { Video } from 'lucide-react';
import { useState } from 'react';
import {
  useAddVideoTopic,
  useImportLibrary,
  useMoveVideoTopic,
  usePatchVideoSettings,
  useReflowVideos,
  useRejectVideoTopic,
  useSubmitVideo,
  useVideoLibrary,
  useVideoList,
  useVideosNeeded,
  useVideoTopics,
} from '../../api/queries/video.ts';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorBox,
  FilterChip,
  ListSkeleton,
  Panel,
  Select,
  Tabs,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui.tsx';
import { QueueCalendar } from '../../components/video/QueueCalendar.tsx';
import { ScheduleSettings } from '../../components/video/ScheduleSettings.tsx';
import { StatusStrip, workerStates } from '../../components/video/StatusStrip.tsx';
import { VideoReview } from '../../components/video/VideoReview.tsx';
import { ext } from '../../extension/index.ts';
import { formatDateTime } from '../../lib/time.ts';
import { weeklyCapText } from '../../lib/video-schedule.ts';

const STATUS: Array<{ id: VideoPostStatus; label: string }> = [
  { id: 'in_review', label: 'In review' },
  { id: 'draft', label: 'Drafts' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];
const TONE = { draft: 'neutral', in_review: 'warning', approved: 'success', rejected: 'danger' } as const;

/** Problems that stop the push, always visible above the tabs. */
function Problems({ status }: { status: VideoStatus }) {
  const down = workerStates(status.worker).filter((w) => !w.running);
  return (
    <>
      {down.length > 0 && (
        <Callout tone="warning" title="Video worker not running" role="alert" data-testid="video-worker-down">
          Nothing is{' '}
          {down.length === 1 && down[0]?.label === 'Render worker' ? 'rendered' : 'rendered or uploaded'}{' '}
          until the video worker runs (the Docker Compose profile <code>video</code>; see the deploy guide).
          {down.length > 1 || down[0]?.label === 'Video worker'
            ? ''
            : ` Offline: ${down.map((w) => w.label).join(', ')}.`}
          {down[0]?.lastSeen
            ? ` Last seen ${formatDateTime(down[0].lastSeen)}.`
            : ' It has never reported in.'}
        </Callout>
      )}
      {!status.channel.connected && (
        <Callout tone="info" data-testid="video-no-channel">
          No YouTube channel is connected. Paste its refresh token under Social sharing on the Posts tab.
          Until then nothing is drafted by the writer, rendered or uploaded, whatever the switch below says.
        </Callout>
      )}
      {status.channel.status === 'needs_reconnect' && (
        <Callout tone="danger" role="alert">
          The YouTube token was refused. Paste a fresh refresh token under Social sharing; uploads wait until
          then.
        </Callout>
      )}
      {status.lockedPrivate > 0 && (
        <Callout tone="danger" role="alert" data-testid="video-locked">
          YouTube kept {status.lockedPrivate} uploaded video{status.lockedPrivate === 1 ? '' : 's'} private.
          Uploads are paused; open the video to see what to do.
        </Callout>
      )}
    </>
  );
}

/** "N videos sit on slots no longer in your schedule": re-flow puts them on the current slots, in order. */
function OffScheduleBanner({ count }: { count: number }) {
  const reflow = useReflowVideos();
  const toast = useToast();
  if (count <= 0) return null;
  return (
    <Callout
      tone="warning"
      role="status"
      data-testid="video-offschedule"
      actions={
        <Button
          size="sm"
          loading={reflow.isPending}
          data-testid="video-reflow"
          onClick={() =>
            reflow.mutate(undefined, {
              onSuccess: (r) =>
                toast.success(`${r.moved} video${r.moved === 1 ? '' : 's'} moved onto the schedule`),
            })
          }
        >
          Re-flow
        </Button>
      }
    >
      {count} video{count === 1 ? ' sits' : 's sit'} on slots no longer in your schedule. Re-flow moves every
      scheduled video that has not started onto the current slots, in order.
      <ErrorBox error={reflow.error} />
    </Callout>
  );
}

/** The switches and defaults of the YouTube push. */
function SettingsPanel({ status }: { status: VideoStatus }) {
  const patch = usePatchVideoSettings();
  const s = status.settings;
  const set = (v: PatchVideoSettingsRequest) => patch.mutate(v);
  const [playlists, setPlaylists] = useState(s.playlists);
  return (
    <Panel title="YouTube" data-testid="video-status">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-fg">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
              data-testid="video-enabled"
            />
            Videos on
          </label>
          {status.channel.connected && (
            <span className="text-sm text-muted">Channel: {status.channel.accountName}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ['articleVideos', 'Videos of articles'],
              ['releaseVideos', 'Videos of releases'],
              ['tutorials', 'Tutorials'],
              ['shorts', 'Shorts'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={s[k]} onChange={(e) => set({ [k]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Privacy"
            value={s.privacy}
            onChange={(e) => set({ privacy: e.target.value as VideoSettings['privacy'] })}
          >
            <option value="public">Public at its slot</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </Select>
          <TextInput
            label="Category id"
            value={s.categoryId}
            onChange={(e) => set({ categoryId: e.target.value })}
            hint="28 is Science and Technology"
          />
        </div>
        <p className="text-sm text-muted">{weeklyCapText(s.schedule)} Tick the days below to change it.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(['article', 'release', 'tutorial'] as const).map((k) => (
            <TextInput
              key={k}
              label={`Playlist id: ${k}s`}
              value={playlists[k] ?? ''}
              onChange={(e) => setPlaylists((p) => ({ ...p, [k]: e.target.value }))}
              onBlur={() => set({ playlists: { [k]: playlists[k] ?? '' } })}
              hint="Optional"
            />
          ))}
        </div>
        <ErrorBox error={patch.error} />
      </div>
    </Panel>
  );
}

/** Paste a script by hand (the cloud writer submits the same JSON). */
function SubmitByHand({ onDone }: { onDone: () => void }) {
  const submit = useSubmitVideo();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const go = () => {
    setError('');
    let script: { kind?: string; format?: string; ref?: string };
    try {
      script = JSON.parse(json);
    } catch {
      setError('That is not valid JSON.');
      return;
    }
    if (!script.kind || !script.format || !script.ref) {
      setError('The script needs kind, format and ref.');
      return;
    }
    submit.mutate(
      {
        kind: script.kind as 'article',
        format: script.format as 'long',
        ref: script.ref,
        script: script as never,
      },
      {
        onSuccess: () => {
          toast.success('Added: it renders now');
          setJson('');
          setOpen(false);
          onDone();
        },
      },
    );
  };
  return (
    <div>
      <Button onClick={() => setOpen((o) => !o)} data-testid="video-add">
        {open ? 'Cancel' : 'Add a script by hand'}
      </Button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <TextArea
            label="Video script (JSON: kind, format, ref, title, cues, chapters, meta)"
            rows={10}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            data-testid="video-script-json"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <ErrorBox error={submit.error} />
          <div>
            <Button
              variant="primary"
              loading={submit.isPending}
              onClick={go}
              data-testid="video-script-submit"
            >
              Add and render
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function LibraryButton({ enabled }: { enabled: boolean }) {
  const lib = useVideoLibrary(enabled);
  const imp = useImportLibrary();
  const toast = useToast();
  const todo = lib.data?.videos.filter((v) => !v.imported).length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        loading={imp.isPending}
        disabled={!enabled || todo === 0}
        onClick={() =>
          imp.mutate(
            {},
            {
              onSuccess: (r) =>
                toast.success(`${r.created} help video${r.created === 1 ? '' : 's'} imported`),
            },
          )
        }
        data-testid="video-library-import"
      >
        Library: import help videos{todo ? ` (${todo})` : ''}
      </Button>
      <span className="text-xs text-muted">
        {lib.data?.videos.length
          ? 'Each existing help video becomes a tutorial draft; its recorded MP4 is uploaded as it is.'
          : 'No help videos found on this server.'}
      </span>
      <ErrorBox error={imp.error} />
    </div>
  );
}

function VideoTopics({ enabled }: { enabled: boolean }) {
  const q = useVideoTopics();
  const add = useAddVideoTopic();
  const reject = useRejectVideoTopic();
  const move = useMoveVideoTopic();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const Drafter = ext.VideoDrafter;
  return (
    <Panel title="Video topics" data-testid="video-topics">
      <p className="mb-3 text-sm text-muted">
        Ideas for new showcase videos of awesome things you can do with Guildwise HQ. The writer takes the
        oldest queued topic, narrates it over clips of the help videos and sends it to review. It may propose
        topics too.
      </p>
      <form
        className="mb-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { title: title.trim(), brief: brief.trim() },
            {
              onSuccess: (r) => {
                toast.success(r.duplicate ? 'Already on the list' : 'Topic added');
                setTitle('');
                setBrief('');
              },
            },
          );
        }}
      >
        <TextInput
          label="Topic"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Run a night shift of agents"
          required
          minLength={5}
          maxLength={200}
          data-testid="video-topic-title"
        />
        <TextInput
          label="Angle (optional)"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={800}
        />
        <div>
          <Button
            type="submit"
            disabled={!title.trim()}
            loading={add.isPending}
            data-testid="video-topic-add"
          >
            Add topic
          </Button>
        </div>
        <ErrorBox error={add.error ?? reject.error ?? move.error} />
      </form>
      {q.isPending && <ListSkeleton label="Loading topics" rows={2} />}
      {q.data && q.data.topics.length === 0 && <p className="text-sm text-muted">No topics yet.</p>}
      <ul className="divide-y divide-line">
        {q.data?.topics.map((t) => (
          <li
            key={t.id}
            className="flex flex-wrap items-center gap-2 py-2"
            data-testid={`video-topic-${t.id}`}
          >
            <span className="font-medium text-fg">{t.title}</span>
            <Badge
              tone={
                t.status === 'queued'
                  ? 'warning'
                  : t.status === 'drafted'
                    ? 'success'
                    : t.status === 'rejected'
                      ? 'danger'
                      : 'info'
              }
            >
              {t.status}
            </Badge>
            <span className="text-xs text-muted">
              {t.origin === 'writer' ? 'proposed by the writer' : 'yours'}
            </span>
            {t.brief && <span className="w-full text-sm text-muted">{t.brief}</span>}
            {t.reason && <span className="w-full text-xs text-subtle">{t.reason}</span>}
            {t.status === 'queued' && (
              <span className="ml-auto flex gap-2">
                {Drafter && enabled && <Drafter kind="tutorial" ref={t.id} onDone={() => q.refetch()} />}
                <Button size="sm" variant="ghost" onClick={() => move.mutate(t.id)}>
                  Move up
                </Button>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onClick={() => reject.mutate({ id: t.id, reason: 'Not wanted' })}
                >
                  Remove
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Articles and releases without a video: the hosting business's drafter button goes here. */
function Needed({ enabled }: { enabled: boolean }) {
  const Drafter = ext.VideoDrafter;
  const q = useVideosNeeded(!!Drafter && enabled);
  if (!Drafter || !enabled || !q.data || (q.data.articles.length === 0 && q.data.releases.length === 0))
    return null;
  return (
    <Panel title="Without a video yet" data-testid="video-needed">
      <ul className="divide-y divide-line">
        {q.data.articles.map((a) => (
          <li key={a.slug} className="flex items-center gap-2 py-2">
            <span className="text-fg">{a.title}</span>
            <span className="text-xs text-muted">article</span>
            <span className="ml-auto">
              <Drafter kind="article" ref={a.slug} onDone={() => q.refetch()} />
            </span>
          </li>
        ))}
        {q.data.releases.map((r) => (
          <li key={r.version} className="flex items-center gap-2 py-2">
            <span className="text-fg">Guildwise HQ {r.version}</span>
            <span className="text-xs text-muted">release</span>
            <span className="ml-auto">
              <Drafter kind="release" ref={r.version} onDone={() => q.refetch()} />
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function PostRow({
  p,
  workerRunning,
  status,
}: {
  p: VideoPost;
  workerRunning: boolean;
  status: VideoStatus;
}) {
  const [open, setOpen] = useState(false);
  const r = p.render;
  return (
    <li className="px-4 py-3" data-testid={`video-row-${p.ref}-${p.format}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-fg">{p.title}</span>
        <Badge tone={TONE[p.status]}>{p.status === 'in_review' ? 'In review' : p.status}</Badge>
        <span className="text-sm text-muted">
          {p.kind} · {p.format}
        </span>
        {r && r.status !== 'rendered' && (
          <Badge tone={r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Badge>
        )}
        {r?.status === 'rendered' && p.status !== 'approved' && <Badge tone="success">ready to review</Badge>}
        {p.upload && (
          <Badge
            tone={
              p.upload.status === 'sent'
                ? 'success'
                : p.upload.status === 'locked_private' || p.upload.status === 'failed'
                  ? 'danger'
                  : 'warning'
            }
          >
            youtube: {p.upload.status}
          </Badge>
        )}
        <span className="ml-auto">
          <Button
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            data-testid={`video-open-${p.ref}-${p.format}`}
          >
            {open ? 'Close' : p.status === 'approved' ? 'View' : 'Review'}
          </Button>
        </span>
      </div>
      {open && (
        <div className="mt-3">
          <VideoReview post={p} workerRunning={workerRunning} status={status} />
        </div>
      )}
    </li>
  );
}

type Section = 'review' | 'queue' | 'settings';

/** Platform > Blog > Videos: the YouTube push (faceless videos of articles, releases and tutorials). */
export function PlatformVideo() {
  const [section, setSection] = useState<Section>('review');
  const [status, setStatus] = useState<VideoPostStatus | undefined>();
  const list = useVideoList(status);
  const all = useVideoList(undefined);
  const d = list.data;
  const st = d?.status ?? all.data?.status;
  // Shorts are shown under their long video
  const posts = d?.posts.filter(
    (p) => !(p.format === 'short' && p.parentId && d.posts.some((x) => x.id === p.parentId)),
  );
  return (
    <div className="flex flex-col gap-5" data-testid="video-panel">
      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {st && <Problems status={st} />}
      {st && <StatusStrip status={st} posts={all.data?.posts ?? d?.posts ?? []} />}
      {st && <OffScheduleBanner count={st.offSchedule} />}
      <Tabs
        label="Videos"
        prefix="videosub"
        value={section}
        onChange={(v) => setSection(v as Section)}
        className="!mb-0"
        tabs={[
          { id: 'review', label: 'Review', testId: 'video-tab-review' },
          { id: 'queue', label: 'Queue', testId: 'video-tab-queue' },
          { id: 'settings', label: 'Settings', testId: 'video-tab-settings' },
        ]}
      />
      {section === 'settings' && st && (
        <div
          role="tabpanel"
          id="videosub-panel-settings"
          aria-labelledby="videosub-tab-settings"
          className="flex flex-col gap-5"
        >
          <SettingsPanel status={st} />
          <ScheduleSettings status={st} />
        </div>
      )}
      {section === 'queue' && (
        <div role="tabpanel" id="videosub-panel-queue" aria-labelledby="videosub-tab-queue">
          {st && all.data ? (
            <QueueCalendar posts={all.data.posts} status={st} />
          ) : (
            <ListSkeleton label="Loading the queue" rows={3} />
          )}
        </div>
      )}
      {section === 'review' && (
        <div
          role="tabpanel"
          id="videosub-panel-review"
          aria-labelledby="videosub-tab-review"
          className="flex flex-col gap-5"
        >
          <Needed enabled={!!st?.active} />
          <div className="flex flex-wrap items-start gap-4">
            <SubmitByHand onDone={() => list.refetch()} />
            <LibraryButton enabled={!!st?.settings.enabled} />
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Video status">
            <FilterChip pressed={!status} onClick={() => setStatus(undefined)}>
              All
            </FilterChip>
            {STATUS.map((s) => (
              <FilterChip
                key={s.id}
                pressed={status === s.id}
                {...(s.id === 'in_review' && st ? { count: st.pending } : {})}
                onClick={() => setStatus(s.id)}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
          {list.isPending && <ListSkeleton label="Loading videos" rows={3} />}
          {posts?.length === 0 && (
            <EmptyState
              icon={Video}
              title="No videos here"
              description="Videos of articles and releases arrive from the writer, tutorials from the Library or the topics below, or add a script by hand."
            />
          )}
          {d && posts && posts.length > 0 && (
            <Panel padding="none">
              <ul className="divide-y divide-line" data-testid="video-list">
                {posts.map((p) => (
                  <PostRow
                    key={p.id}
                    p={p}
                    workerRunning={workerStates(d.status.worker).every((w) => w.running)}
                    status={d.status}
                  />
                ))}
              </ul>
            </Panel>
          )}
          <VideoTopics enabled={!!st?.settings.enabled} />
        </div>
      )}
    </div>
  );
}
