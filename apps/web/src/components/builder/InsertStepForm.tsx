import { type RoleDefinition, roleClaimsStage } from '@aom/shared';
import { useState } from 'react';
import { type EditorInsertion, investigateInsertion, slugId } from '../../lib/workflowVariant.ts';
import { Button, Select, TextArea, TextInput } from '../ui.tsx';

type Template = 'investigate' | 'custom';

/**
 * "Insert step after X" in project-variant scope: a template (Investigate & design for the architect, or a custom
 * step), the step's name, who works it and what done means. The result is one insertion for the variant's spec.
 */
export function InsertStepForm({
  after,
  variantKey,
  roles,
  taken,
  onAdd,
  onCancel,
}: {
  after: { id: string; label: string };
  variantKey: string;
  roles: readonly RoleDefinition[];
  /** Step ids in use. */
  taken: readonly string[];
  onAdd: (ins: EditorInsertion) => void;
  onCancel: () => void;
}) {
  const hasArchitect = roles.some((r) => r.key === 'architect');
  const [template, setTemplate] = useState<Template>(hasArchitect ? 'investigate' : 'custom');
  const [label, setLabel] = useState(template === 'investigate' ? 'Investigate & design' : '');
  const [role, setRole] = useState(template === 'investigate' ? 'architect' : '');
  const [criteria, setCriteria] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pick = (t: Template) => {
    setTemplate(t);
    setError(null);
    if (t === 'investigate') {
      setLabel('Investigate & design');
      setRole('architect');
      setCriteria('');
    } else {
      setLabel('');
      setRole('');
    }
  };
  const id = template === 'investigate' ? `investigate_after_${after.id}` : slugId(label);
  const can = (r: RoleDefinition) => roleClaimsStage(r, variantKey, id);

  const add = () => {
    if (!label.trim()) return setError('Give the step a label');
    if (!id) return setError('The label needs letters or digits');
    if (taken.includes(id)) return setError(`A step '${id}' exists already: pick another label`);
    if (!role) return setError('Pick the role that works this step');
    if (template === 'custom' && !criteria.trim()) return setError('Say what done means for this step');
    if (template === 'investigate') {
      const t = investigateInsertion(after.id);
      onAdd({ ...t, stage: { ...t.stage, label: label.trim(), claimRole: role } });
      return;
    }
    onAdd({
      after: after.id,
      stage: { id, label: label.trim(), claimRole: role, doneCriteria: criteria.trim() },
    });
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-control border border-dashed border-line p-3"
      role="group"
      aria-label={`Insert a step after ${after.label}`}
    >
      <Select label="Template" value={template} onChange={(e) => pick(e.target.value as Template)}>
        {hasArchitect && <option value="investigate">Investigate &amp; design (architect)</option>}
        <option value="custom">Custom step</option>
      </Select>
      <TextInput label="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <Select
        label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value)}
        disabled={template === 'investigate'}
      >
        <option value="">Pick a role</option>
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
            {id && !can(r) ? ' (cannot claim this step yet)' : ''}
          </option>
        ))}
      </Select>
      {template === 'custom' && (
        <>
          <TextArea
            label="Done when"
            hint="What the agent must have achieved before it reports the step done."
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
          {id && roles.length > 0 && !roles.some(can) && (
            <p className="text-xs text-subtle">
              No role may claim{' '}
              <span className="font-mono">
                {variantKey}.{id}
              </span>{' '}
              yet. Create or extend a role in the role builder that claims it, then come back.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={add}>
          Add step
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
