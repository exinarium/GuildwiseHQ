import { type InterestDto, type ResearchDepth, researchCardDefaults } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useCreateCard } from '../../api/queries/cards.ts';
import { usePatchInterest } from '../../api/queries/interests.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { parseSites } from '../../lib/feeds.ts';
import { Button, Dialog, ErrorBox, Select, TextArea, TextInput } from '../ui.tsx';

const DEPTHS: Array<{ id: ResearchDepth; label: string }> = [
  { id: 'quick', label: 'Quick' },
  { id: 'standard', label: 'Standard' },
  { id: 'deep', label: 'Deep' },
];

/** "Research this": a research card prefilled from the interest; created through the ordinary card API with `interestId`. */
export function ResearchThisDialog({ interest, onClose }: { interest: InterestDto; onClose: () => void }) {
  const defaults = researchCardDefaults({
    name: interest.name,
    description: interest.description,
    subCategory: interest.subCategory,
    preferredSites: interest.preferredSites,
  });
  const projects = useProjects();
  const research = (projects.data ?? []).filter((p) => p.workflowKey === 'research');
  const [projectId, setProjectId] = useState(interest.researchProject?.id ?? '');
  const [remember, setRemember] = useState(false);
  const [title, setTitle] = useState(defaults.title);
  const [question, setQuestion] = useState(defaults.question);
  const [scope, setScope] = useState(defaults.scope);
  const [depth, setDepth] = useState<ResearchDepth>(defaults.depth);
  const [subCategory, setSubCategory] = useState(defaults.subCategory);
  const [sites, setSites] = useState(defaults.preferredSites.join('\n'));
  const [err, setErr] = useState('');
  const create = useCreateCard();
  const patch = usePatchInterest();
  const chosen = projectId || research[0]?.id || '';

  const submit = (specify: boolean) => {
    if (!chosen) return setErr('Choose a research project');
    if (!title.trim() || !question.trim()) return setErr('A title and a question are required');
    setErr('');
    const preferredSites = parseSites(sites);
    create.mutate(
      {
        projectId: chosen,
        title: title.trim(),
        cardType: 'research',
        fields: {
          question: question.trim(),
          ...(scope.trim() ? { scope: scope.trim() } : {}),
          depth,
          ...(subCategory.trim() ? { subCategory: subCategory.trim() } : {}),
          ...(preferredSites.length ? { preferredSites } : {}),
        },
        interestId: interest.id,
        specify,
      },
      {
        onSuccess: () => {
          if (remember && !interest.researchProject)
            patch.mutate({ id: interest.id, body: { researchProjectId: chosen } });
        },
      },
    );
  };

  const created = create.data?.card;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Research this: ${interest.name}`}
      description="Creates a research card about this interest."
    >
      {created ? (
        <div className="flex flex-col gap-3" data-testid="research-created">
          <p className="text-sm">
            Created{' '}
            <Link
              to={`/cards/${created.id}`}
              className="font-medium underline"
              data-testid="research-card-link"
            >
              {created.ref}
            </Link>
            .
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="research-dialog">
          <Select
            label="Project"
            value={chosen}
            data-testid="research-project"
            onChange={(e) => setProjectId(e.target.value)}
          >
            {research.length === 0 && <option value="">No research project</option>}
            {research.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} {p.name}
              </option>
            ))}
          </Select>
          {!interest.researchProject && chosen && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember this project for the interest
            </label>
          )}
          <TextInput
            label="Title"
            value={title}
            data-testid="research-title"
            onChange={(e) => setTitle(e.target.value)}
          />
          <TextArea
            label="Question"
            rows={2}
            value={question}
            data-testid="research-question"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <TextArea label="Scope" rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
          <Select label="Depth" value={depth} onChange={(e) => setDepth(e.target.value as ResearchDepth)}>
            {DEPTHS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </Select>
          <TextInput
            label="Sub-category"
            value={subCategory}
            onChange={(e) => setSubCategory(e.target.value)}
          />
          <TextArea
            label="Preferred sites (one per line)"
            rows={2}
            value={sites}
            onChange={(e) => setSites(e.target.value)}
          />
          {err && (
            <p role="alert" className="text-xs font-medium text-danger">
              {err}
            </p>
          )}
          <ErrorBox error={create.error ?? patch.error} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button disabled={create.isPending} data-testid="research-draft" onClick={() => submit(false)}>
              Save as draft
            </Button>
            <Button
              variant="primary"
              disabled={create.isPending}
              data-testid="research-submit"
              onClick={() => submit(true)}
            >
              Create and queue
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
