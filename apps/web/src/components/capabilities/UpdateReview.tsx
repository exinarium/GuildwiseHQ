import type { PackDto } from '@aom/shared';
import { useAcceptPackUpdate } from '../../api/queries/capabilities.ts';
import { Button, Dialog, ErrorBox, useToast } from '../ui.tsx';
import { shortSha } from './badges.tsx';
import { PackDiffView } from './PackDiffView.tsx';

/** The update a check found: the diff against the approved commit, and Accept (which names the commit that was shown). */
export function UpdateReview({ pack, onClose }: { pack: PackDto; onClose: () => void }) {
  const accept = useAcceptPackUpdate();
  const toast = useToast();
  const update = pack.update;
  if (!update) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Update for ${pack.name}`}
      description={`${update.ref} at ${shortSha(update.sha)}, compared with ${shortSha(pack.pinnedSha)}.`}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button
            variant="primary"
            loading={accept.isPending}
            onClick={() =>
              accept.mutate(
                { id: pack.id, sha: update.sha },
                {
                  onSuccess: () => {
                    toast.success('Update accepted');
                    onClose();
                  },
                },
              )
            }
          >
            Accept update {shortSha(update.sha)}
          </Button>
        </>
      }
    >
      <PackDiffView diff={update.diff} />
      <ErrorBox error={accept.error} />
    </Dialog>
  );
}
