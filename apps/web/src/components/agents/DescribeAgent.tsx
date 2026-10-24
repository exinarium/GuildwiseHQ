import type { AgentDraftDto } from '@aom/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { useAgentDraft, useStartAgentDraft } from '../../api/queries/agent-ux.ts';
import { Button, Callout, Dialog, ErrorBox, Spinner, TextArea } from '../ui.tsx';
import { DraftReview } from './DraftReview.tsx';

/**
 * "Describe the agent you need": one sentence is drafted into a role by an agent turn (the Analyst, on your workstation), shown
 * for review and editing, and handed to the normal hire dialog. It never hires by itself.
 */
export function DescribeAgentDialog({
  open,
  onOpenChange,
  onContinue,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The reviewed draft; the caller opens the hire dialog with it. */
  onContinue: (d: AgentDraftDto) => void;
  projectId?: string | undefined;
}) {
  const [text, setText] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [edited, setEdited] = useState<AgentDraftDto | null>(null);
  const start = useStartAgentDraft();
  const status = useAgentDraft(threadId);
  const state = status.data;
  const draft = edited ?? (state?.status === 'ready' ? (state.draft ?? null) : null);

  const reset = () => {
    setThreadId(null);
    setEdited(null);
    start.reset();
  };
  const close = (o: boolean) => {
    if (!o) {
      reset();
      setText('');
    }
    onOpenChange(o);
  };
  const submit = () =>
    start.mutate(
      { description: text.trim(), ...(projectId ? { projectId } : {}) },
      { onSuccess: (r) => setThreadId(r.threadId) },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="lg"
      title="Describe the agent you need"
      description="One sentence is enough. An agent drafts the role; you review and edit it before anyone is hired."
      footer={
        draft ? (
          <>
            <Button variant="ghost" onClick={reset}>
              Start over
            </Button>
            <Button
              variant="primary"
              data-testid="draft-continue"
              disabled={!draft.name.trim() || draft.instructions.trim().length < 20}
              onClick={() => {
                onContinue(draft);
                reset();
                setText('');
              }}
            >
              Continue to hire
            </Button>
          </>
        ) : undefined
      }
    >
      {!threadId && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim().length >= 3) submit();
          }}
        >
          <TextArea
            label="What should it do?"
            id="describe-agent"
            rows={3}
            maxLength={600}
            placeholder="An agent that turns our merged pull requests into customer release notes every Friday"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <ErrorBox error={start.error} />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={start.isPending}
              disabled={text.trim().length < 3}
            >
              Draft the role
            </Button>
          </div>
        </form>
      )}
      {threadId && !draft && state?.status !== 'failed' && (
        <div className="flex items-center gap-2 py-6" role="status" data-testid="draft-working">
          <Spinner inline label="Drafting" />
          <span className="text-sm text-muted">
            The Analyst is drafting the role. This takes about a minute.
          </span>
        </div>
      )}
      {threadId && state?.status === 'failed' && (
        <div className="flex flex-col gap-3">
          <Callout tone="danger" role="alert" data-testid="draft-failed">
            The draft did not work: {state.error ?? 'the drafting turn failed'}.
          </Callout>
          <div>
            <Button onClick={reset}>Try again</Button>
          </div>
        </div>
      )}
      {status.isError && <p className="text-sm text-danger">{errorMessage(status.error)}</p>}
      {draft && <DraftReview draft={draft} onChange={setEdited} idPrefix="describe" />}
    </Dialog>
  );
}
