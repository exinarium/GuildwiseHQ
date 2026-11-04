import { type VideoReportEntry, VideoStepReportSchema } from '@aom/shared';
import { Badge } from '../ui.tsx';

const ACTION: Record<VideoReportEntry['action'], string> = {
  regenerate: 'Re-render',
  create: 'New',
  up_to_date: 'Up to date',
  reused: 'Reused',
};
const STATE_TONE: Record<VideoReportEntry['state'], 'success' | 'danger' | 'neutral' | 'info'> = {
  rendered: 'success',
  failed: 'danger',
  skipped: 'neutral',
  pending: 'info',
};

/** The Generate videos report of one repository: the voice, the rule, and each video with its reasons and result. */
export function VideoStepReport({ report }: { report: Record<string, unknown> }) {
  const parsed = VideoStepReportSchema.safeParse(report);
  if (!parsed.success) return null;
  const r = parsed.data;
  if (!r.harness)
    return (
      <p className="mt-2 text-xs text-subtle" data-testid="video-report-no-harness">
        Videos: skipped: no videos
      </p>
    );
  const hasNew = r.videos.some((v) => v.action === 'create');
  return (
    <div className="mt-2 flex flex-col gap-2 text-sm" data-testid="video-report">
      <p className="text-xs text-subtle">
        Videos{r.voice ? ` · voice ${r.voice}` : ''}
        {r.videos.length === 0 ? ' · no video shows a changed screen' : ''}
      </p>
      {r.rule && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-xs sm:min-h-0 sm:py-0">
            How videos are chosen
          </summary>
          <p className="mt-1 text-xs text-subtle">{r.rule}</p>
        </details>
      )}
      {r.videos.length > 0 && (
        <ul className="flex flex-col gap-2">
          {r.videos.map((v) => (
            <li
              key={v.slug}
              className="rounded-control border border-line p-2"
              data-testid={`video-report-${v.slug}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{v.slug}</span>
                {v.title && <span className="text-fg">{v.title}</span>}
                <Badge tone="neutral">{ACTION[v.action]}</Badge>
                <Badge tone={STATE_TONE[v.state]}>{v.state}</Badge>
              </div>
              <ul className="mt-1 list-disc pl-5 text-xs text-subtle">
                {v.reasons.map((reason) => (
                  <li key={reason} className="break-words">
                    {reason}
                  </li>
                ))}
              </ul>
              {v.error && (
                <details open={v.state === 'failed'} className="mt-1">
                  <summary className="min-h-11 cursor-pointer py-2 text-xs text-danger-soft-fg sm:min-h-0 sm:py-0">
                    {v.error.split('\n')[0]}
                  </summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                    {v.error}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {hasNew && (
        <p className="text-xs text-subtle">
          New video: watch it on the test site before you approve Ship release.
        </p>
      )}
      {r.shared.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-xs sm:min-h-0 sm:py-0">
            Shared UI changed ({r.shared.length}): no video re-rendered by rule
          </summary>
          <ul className="mt-1 font-mono text-xs text-subtle">
            {r.shared.map((p) => (
              <li key={p} className="break-all">
                {p}
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.unmapped.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-xs sm:min-h-0 sm:py-0">
            UI files with no video ({r.unmapped.length}): nothing selected
          </summary>
          <ul className="mt-1 font-mono text-xs text-subtle">
            {r.unmapped.map((p) => (
              <li key={p} className="break-all">
                {p}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
