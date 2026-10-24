import { useEffect } from 'react';
import { useMyWorkstations } from '../../lib/session.ts';
import { Select } from '../ui.tsx';

/**
 * Where the session runs: the user's own active workstations (a turn runs with its owner's logins and keys, so nobody else's is
 * offered). The first online one is chosen until the user picks another.
 */
export function WorkstationPicker({
  value,
  onChange,
  open = true,
}: {
  value: string;
  onChange: (id: string) => void;
  open?: boolean;
}) {
  const { list, pending } = useMyWorkstations(open);
  const first = list[0]?.id ?? '';
  const valid = list.some((w) => w.id === value);
  useEffect(() => {
    if (!valid && first) onChange(first);
  }, [valid, first, onChange]);
  if (!pending && list.length === 0)
    return (
      <p className="text-sm text-warning" role="status" data-testid="no-workstation">
        You have no workstation yet. Pair one first: a session runs on your own workstation.
      </p>
    );
  return (
    <Select
      label="Workstation"
      value={valid ? value : first}
      onChange={(e) => onChange(e.target.value)}
      hint="The session runs on one of your own workstations."
      data-testid="workstation-picker"
    >
      {list.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
          {w.connected ? '' : ' (offline)'}
        </option>
      ))}
    </Select>
  );
}
