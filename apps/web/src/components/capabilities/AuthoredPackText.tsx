import { authoredTreeContentHash, type PackDto, type PackReadContent } from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { readPackContent } from '../../api/queries/my-capabilities.ts';
import { useReviewWait } from '../../api/queries/review-wait.ts';
import { Button, Callout, Spinner } from '../ui.tsx';
import { PackVersionDiff } from './PackVersionDiff.tsx';

export type AuthoredReviewState =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'waiting'; workstation: string }
  | { state: 'error'; error: string; retry: () => void }
  | { state: 'mismatch'; retry: () => void }
  | { state: 'ready'; content: PackReadContent };

/**
 * Q57: the text of an authored organization pack for the reviewer. The author's workstation seals the files to a one-time key of
 * this page; the page checks them against the content hash it is about to approve, so what is approved is exactly what was read.
 * `expectedSha` is the revision under review (an authored revision is named by its content hash). Git packs have no such read.
 */
export function useAuthoredReview(
  pack: PackDto,
  expectedSha: string | null | undefined,
): AuthoredReviewState {
  const enabled = pack.source === 'authored' && pack.visibility === 'org' && !!expectedSha;
  const q = useQuery({
    enabled,
    queryKey: ['packs', 'review-read', pack.id, expectedSha],
    queryFn: ({ signal }) => readPackContent(pack.id, { mode: 'review', withPinned: true, signal }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // the plain text is not kept around once the dialog is closed
    gcTime: 0,
  });
  // Q67: the text lives only on the author's workstation; offline, the read waits and the reviewer is told when it is back
  const wait = useReviewWait(pack.id, enabled && q.isPending);
  if (!enabled) return { state: 'none' };
  if (q.isPending)
    return wait.data?.waiting
      ? { state: 'waiting', workstation: wait.data.workstationName ?? "the author's workstation" }
      : { state: 'loading' };
  if (q.isError)
    return {
      state: 'error',
      error: q.error instanceof Error ? q.error.message : String(q.error),
      retry: () => void q.refetch(),
    };
  if (authoredTreeContentHash(pack.name, q.data.tree) !== expectedSha)
    return { state: 'mismatch', retry: () => void q.refetch() };
  return { state: 'ready', content: q.data };
}

/** The reviewer's view of the files (and of what changed since the approved revision, when there is one). */
export function AuthoredPackText({ review }: { review: AuthoredReviewState }) {
  if (review.state === 'none') return null;
  if (review.state === 'loading') return <Spinner label="Reading the files from the author's workstation" />;
  if (review.state === 'waiting')
    return (
      <Callout tone="info" role="status" data-testid="authored-read-waiting">
        <p>
          Waiting for {review.workstation}. The text of this pack lives only on that workstation (the server
          keeps no copy), so it can be read once the workstation is online. You will get a note on your desk
          when it is, and you can close this and come back.
        </p>
      </Callout>
    );
  if (review.state === 'error')
    return (
      <Callout tone="warning" role="alert" data-testid="authored-read-error">
        <p>
          The files could not be read from the author's workstation ({review.error}). An authored pack cannot
          be approved unread: it waits for that workstation, and you get a note on your desk when it is
          online.
        </p>
        <Button size="sm" className="mt-2" onClick={review.retry}>
          Try again
        </Button>
      </Callout>
    );
  if (review.state === 'mismatch')
    return (
      <Callout tone="danger" role="alert" data-testid="authored-read-mismatch">
        <p>
          The files the author's workstation holds are not the content that was submitted for review, so they
          are not shown as approvable. Ask the author to save again.
        </p>
        <Button size="sm" className="mt-2" onClick={review.retry}>
          Read again
        </Button>
      </Callout>
    );
  const { content } = review;
  return (
    <section aria-label="Pack files" data-testid="authored-files" className="flex flex-col gap-2">
      <h3 className="font-medium text-fg">The files</h3>
      <p className="text-xs text-muted">
        Read from the author's workstation, sealed to this page. The server never held the text, and these
        files hash to the content shown above.
      </p>
      <PackVersionDiff before={content.pinned?.tree ?? null} after={content.tree} />
    </section>
  );
}
