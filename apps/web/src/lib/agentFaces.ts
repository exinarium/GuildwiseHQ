import type { AgentDto, AvatarStyle } from '@aom/shared';
import { useSyncExternalStore } from 'react';

export interface AgentFace {
  seed: string;
  style: AvatarStyle;
}

/**
 * The roster of agent faces by id and by name. `<AgentFacesSync />` (mounted in the app shell) fills it from the agents
 * list, so every `AgentAvatar` finds its agent's face without each call site carrying it.
 */
let byId = new Map<string, AgentFace>();
let byName = new Map<string, AgentFace>();
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

export function setAgentFaces(
  agents: Array<Pick<AgentDto, 'id' | 'name' | 'avatarSeed' | 'avatarStyle'>>,
): void {
  const ids = new Map<string, AgentFace>();
  const names = new Map<string, AgentFace>();
  for (const a of agents) {
    const face: AgentFace = { seed: a.avatarSeed ?? a.id, style: a.avatarStyle ?? 'notionists' };
    ids.set(a.id, face);
    names.set(a.name.toLowerCase(), face);
  }
  byId = ids;
  byName = names;
  loaded = true;
  version++;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The face of an agent by id, else by name; null until the roster is known and when the agent is not in it. */
export function useAgentFace(
  agentId: string | null | undefined,
  name: string,
): { face: AgentFace | null; known: boolean } {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const face = (agentId ? byId.get(agentId) : undefined) ?? byName.get(name.toLowerCase()) ?? null;
  return { face, known: loaded };
}
