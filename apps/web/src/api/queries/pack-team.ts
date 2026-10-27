import type {
  HirePackAgentsRequest,
  HirePackAgentsResponse,
  PackClassification,
  PackTeamResponse,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

export const packTeamKey = (packId: string | null) => ['packs', 'team', packId] as const;

/** A pack's agents with a suggested seat each, its skills with their class, and the Owner's classification (any member). */
export function usePackTeam(packId: string | null) {
  return useQuery({
    enabled: !!packId,
    queryKey: packTeamKey(packId),
    queryFn: () => get<PackTeamResponse>(`/packs/${packId}/team`),
  });
}

/** Saves the Owner's toggles: the full lists of skills that are agents and skills that are playbooks. */
export function useSetClassification(packId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PackClassification) => put<PackTeamResponse>(`/packs/${packId}/classification`, b),
    onSuccess: (data) => {
      qc.setQueryData(packTeamKey(packId), data);
      // marking a playbook changes the `/` menu and the registry
      void qc.invalidateQueries({ queryKey: ['playbooks'] });
      void qc.invalidateQueries({ queryKey: ['capabilities'] });
    },
  });
}

function useAfterHire() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['agents', 'hr', 'org', 'org-chart']) void qc.invalidateQueries({ queryKey: [k] });
    void qc.invalidateQueries({ queryKey: ['packs', 'team'] });
  };
}

/** The whole pack (or several of its agents) at once: Owner and Admin, all or nothing. */
export function useHirePackTeam(packId: string) {
  const after = useAfterHire();
  return useMutation({
    mutationFn: (b: HirePackAgentsRequest) => post<HirePackAgentsResponse>(`/packs/${packId}/team/hire`, b),
    onSuccess: after,
  });
}

/** One pack agent (any member within the normal hire rule). */
export function useHirePackAgent(packId: string) {
  const after = useAfterHire();
  return useMutation({
    mutationFn: (b: HirePackAgentsRequest) => post<HirePackAgentsResponse>(`/packs/${packId}/agents/hire`, b),
    onSuccess: after,
  });
}

/** Messages for the errors the hire endpoints answer with, by code. */
export const PACK_HIRE_ERRORS: Record<string, string> = {
  limit_reached: 'Your plan has no room for that many agents. Retire an agent or ask for a higher limit.',
  unsandboxed_ack_required: 'Confirm below that you accept hiring onto an unsandboxed workstation.',
  sandbox_unavailable:
    'That workstation cannot sandbox agents, so nothing was hired. Pick another workstation.',
  name_taken: 'An agent already has one of these names. Change the name and try again.',
  role_key_taken: 'A role with the name of this pack agent already exists and is not from this pack.',
  pack_not_trusted: 'This pack is not approved at its pinned commit. Approve it first.',
  unknown_agent: 'The pack no longer has one of these agents. Reload the pack and try again.',
  unknown_skill: 'The pack no longer has one of these skills. Reload the pack and try again.',
  unknown_project: 'One of the chosen projects does not exist.',
  too_many: 'You can hire at most 60 agents at once. Untick some.',
  runner_too_old: "This workstation's runner is too old for pack agents: update it to 0.1.62 or later.",
  project_pack: 'This pack belongs to one project: give the agent access to that project.',
  invalid_agent: 'One of these pack agents cannot be hired. Untick it.',
  builtin_key: 'One of these pack agents has a name that belongs to a built-in role. Untick it.',
};

/** The sentence to show for a failed hire: ours for a known code, else the server's message. */
export function packHireMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  const known = code ? PACK_HIRE_ERRORS[code] : undefined;
  if (known) return known;
  return e instanceof Error ? e.message : 'The hire failed.';
}
