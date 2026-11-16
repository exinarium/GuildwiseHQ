import type { VideoShare } from '@aom/shared';
import { Button, Callout } from '../ui.tsx';

/** An Instagram share whose file Instagram refused: only a new render helps, so there is no "retry" for it. */
export const needsRerender = (s: Pick<VideoShare, 'status' | 'fileRejection'> | undefined): boolean =>
  s?.status === 'failed' &&
  (s.fileRejection === 'needs_rerender' ||
    s.fileRejection === 'rejected_compliant' ||
    s.fileRejection === 'check_failed');

/**
 * "Instagram needs a new render", with the reasons from the Reels check as visible text (no tooltip, nothing that needs
 * hover: it reads the same on a touch screen) and the Re-render action.
 */
export function RerenderNotice({
  share,
  onRerender,
  loading,
}: {
  share: VideoShare;
  onRerender: () => void;
  loading?: boolean;
}) {
  const failed = share.reelsCheck?.failed ?? [];
  return (
    <Callout
      tone="warning"
      title="Instagram needs a new render"
      data-testid="needs-rerender"
      actions={
        <Button size="sm" loading={loading} onClick={onRerender} data-testid="rerender-instagram">
          Re-render
        </Button>
      }
    >
      {share.fileRejection === 'rejected_compliant' ? (
        <p>
          The file meets the Reels rules; Instagram still refused it twice. Re-render it or check the account.
        </p>
      ) : share.fileRejection === 'check_failed' ? (
        <p>Instagram refused the file and it could not be checked. Re-render it.</p>
      ) : failed.length > 0 ? (
        <ul className="list-disc pl-4" data-testid="rerender-reasons">
          {failed.map((f) => (
            <li key={f.rule}>{f.message}</li>
          ))}
        </ul>
      ) : (
        <p>{share.error ?? 'Instagram refused the video file.'}</p>
      )}
    </Callout>
  );
}
