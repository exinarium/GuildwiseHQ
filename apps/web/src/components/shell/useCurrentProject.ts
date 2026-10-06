import { matchPath, useLocation } from 'react-router';
import { useProjects } from '../../api/queries/projects.ts';
import { getLastProjectKey } from '../../lib/lastProject.ts';

/** The project the user is "in": from the URL (board, feed, phase, card ref) else the last one used, else the first. */
export function useCurrentProject() {
  const { pathname } = useLocation();
  const projects = useProjects();
  const byKey = matchPath('/p/:key/*', pathname)?.params.key;
  const ref = matchPath('/cards/:ref', pathname)?.params.ref;
  const refKey = ref && ref !== 'new' ? ref.slice(0, Math.max(0, ref.lastIndexOf('-'))) : undefined;
  const list = projects.data ?? [];
  const found = [byKey, refKey, getLastProjectKey()]
    .map((k) => (k ? list.find((p) => p.key === k) : undefined))
    .find(Boolean);
  return { project: found ?? list[0] ?? null, projects: list, isPending: projects.isPending };
}
