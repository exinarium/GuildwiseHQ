import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateInterest } from '../../api/queries/interests.ts';
import { defaultTimezone } from '../../lib/feeds.ts';
import {
  emptyValues,
  type InterestFormValues,
  toCreateRequest,
  validateInterest,
} from '../../lib/interests.ts';
import { Button, Dialog, ErrorBox } from '../ui.tsx';
import { InterestForm } from './InterestForm.tsx';
import { TasteRulesEditor } from './TasteRulesEditor.tsx';

/** "New interest": the whole statement in one dialog (a full screen sheet on phones). Opens the new interest afterwards. */
export function NewInterestDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateInterest();
  const nav = useNavigate();
  const [v, setV] = useState<InterestFormValues>(() => emptyValues(defaultTimezone()));
  const [rules, setRules] = useState<string[]>([]);
  const [errors, setErrors] = useState<ReturnType<typeof validateInterest>>({});
  const set = <K extends keyof InterestFormValues>(k: K, val: InterestFormValues[K]) =>
    setV((cur) => ({ ...cur, [k]: val }));
  const submit = () => {
    const found = validateInterest(v);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(toCreateRequest(v, rules), {
      onSuccess: (r) => {
        onClose();
        nav(`/interests/${r.id}`);
      },
    });
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="New interest"
      description="A topic you follow. It scans on its own schedule, delivers a digest when you choose, and learns from your ratings."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} data-testid="interest-save" onClick={submit}>
            Create interest
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="interest-new-dialog">
        <InterestForm v={v} set={set} errors={errors} />
        <fieldset className="flex flex-col gap-2 rounded-card border border-line p-3">
          <legend className="px-1 text-sm font-medium text-fg">Taste rules</legend>
          <TasteRulesEditor rules={rules} onChange={setRules} />
        </fieldset>
        <ErrorBox error={create.error} />
      </div>
    </Dialog>
  );
}
