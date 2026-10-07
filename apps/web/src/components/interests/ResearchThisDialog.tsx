import { type InterestDto, type ResearchDepth, researchCardDefaults } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useRunInterest } from '../../api/queries/interests.ts';
import { Button, Dialog, ErrorBox, Select, TextArea } from '../ui.tsx';

const DEPTHS: Array<{ id: ResearchDepth; label: string }> = [
  { id: 'quick', label: 'Quick' },
  { id: 'standard', label: 'Standard' },
  { id: 'deep', label: 'Deep' },
];

/**
 * "Research this", on demand only: a research run of the interest (a researcher, then a fact checker), with its note
 * under the interest's `notes/` folder. Started from the interest, or from one of its items (`item`).
 */
export function ResearchThisDialog({
  interest,
  item,
  onClose,
}: {
  interest: Pick<InterestDto, 'id' | 'name' | 'description' | 'subCategory' | 'preferredSites'>;
  item?: { id: string; title: string } | undefined;
  onClose: () => void;
}) {
  const defaults = researchCardDefaults(interest);
  const [question, setQuestion] = useState(
    item ? `What should I know about "${item.title}"?` : defaults.question,
  );
  const [depth, setDepth] = useState<ResearchDepth>(defaults.depth);
  const run = useRunInterest();
  const started = run.data;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={item ? `Research this item` : `Research this: ${interest.name}`}
      description={
        item
          ? `A research run that starts from "${item.title}".`
          : 'A research run for this interest. Its note is published under the interest folder.'
      }
    >
      {started ? (
        <div className="flex flex-col gap-3" data-testid="research-created">
          <p className="text-sm">
            Research started:{' '}
            <Link
              to={`/cards/${started.ref}`}
              className="font-medium underline"
              data-testid="research-card-link"
            >
              {started.ref}
            </Link>
            . It appears in the run log.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="research-dialog">
          <TextArea
            label="Question"
            rows={3}
            value={question}
            data-testid="research-question"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Select
            label="Depth"
            value={depth}
            data-testid="research-depth"
            onChange={(e) => setDepth(e.target.value as ResearchDepth)}
          >
            {DEPTHS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </Select>
          <ErrorBox error={run.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={run.isPending}
              disabled={!question.trim()}
              data-testid="research-submit"
              onClick={() =>
                run.mutate({
                  id: interest.id,
                  body: {
                    kind: 'research',
                    question: question.trim(),
                    depth,
                    ...(item ? { sourceItemId: item.id } : {}),
                  },
                })
              }
            >
              Start research
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
