import type { PackTeamResponse } from '@aom/shared';

type TeamAgent = PackTeamResponse['agents'][number];

/** The skills a hire gets besides its seat's, from what the person ticked (`null`: untouched, so the agent's defaults). */
export const hireSkills = (a: TeamAgent, picked: string[] | null): string[] =>
  (picked ?? a.defaultSkills).filter((k) => k !== a.agentSkill);

/** The skills offered for a pack agent: its own defaults first, then the ones its files mention. */
const offered = (a: TeamAgent) => [
  ...a.defaultSkills.filter((k) => k !== a.agentSkill).map((k) => ({ key: k, mentioned: false })),
  ...a.skillRefs
    .filter((k) => k !== a.agentSkill && !a.defaultSkills.includes(k))
    .map((k) => ({ key: k, mentioned: true })),
];

/**
 * The skills of a pack agent: its own skill (always, locked), its default skills (ticked), and the ones its files merely
 * mention (unticked, optional). Whatever is ticked here is sent as the final `skills` list.
 */
export function PackAgentSkills({
  agent,
  picked,
  onChange,
  testId,
}: {
  agent: TeamAgent;
  picked: string[] | null;
  onChange: (v: string[]) => void;
  testId?: string;
}) {
  const current = hireSkills(agent, picked);
  const list = offered(agent);
  if (!agent.agentSkill && list.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-1 text-sm" data-testid={testId}>
      <legend className="font-medium">Skills</legend>
      {agent.agentSkill && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4"
            checked
            disabled
            aria-label={`Skill ${agent.agentSkill} (always)`}
          />
          <code>{agent.agentSkill}</code>
          <span className="text-xs text-subtle">the agent itself, always</span>
        </label>
      )}
      {list.map(({ key, mentioned }) => (
        <label key={key} className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4"
            checked={current.includes(key)}
            onChange={(e) =>
              onChange(e.target.checked ? [...new Set([...current, key])] : current.filter((x) => x !== key))
            }
            aria-label={`Skill ${key}`}
          />
          <code>{key}</code>
          {mentioned && <span className="text-xs text-subtle">mentioned by the agent</span>}
        </label>
      ))}
    </fieldset>
  );
}
