import { useEffect } from 'react';
import { useAgents } from '../api/queries/agents.ts';
import { setAgentFaces } from '../lib/agentFaces.ts';
import { preloadFaces } from '../lib/faces.ts';

/** Keeps the roster of agent faces in step with the agents list (rendered once, in the app shell). */
export function AgentFacesSync() {
  const agents = useAgents();
  useEffect(() => {
    void preloadFaces();
  }, []);
  useEffect(() => {
    if (agents.data) setAgentFaces(agents.data);
  }, [agents.data]);
  return null;
}
