import { useSetupState } from '../../api/queries/deploy-setup.ts';
import { ButtonLink, Panel } from '../ui.tsx';
import { allEnvironments, placesOf, roleOf } from './model.ts';

/** The one-line card in project settings: where the environments went (docs/design/environments-ux.md section 2). */
export function EnvironmentsPointer({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const q = useSetupState(projectId);
  const items = q.data ? allEnvironments(q.data) : [];
  const count = (role: 'live' | 'test' | 'other') => items.filter((i) => roleOf(i.env) === role).length;
  const places = q.data ? placesOf(q.data).filter((p) => p.role === 'active').length : 0;
  const parts = [
    count('live') ? `${count('live')} live` : null,
    count('test') ? `${count('test')} test` : null,
    count('other') ? `${count('other')} extra` : null,
    `${places} ${places === 1 ? 'place' : 'places'}`,
  ].filter(Boolean);
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="environments-pointer">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-fg">Environments</h2>
          <p className="text-sm text-muted">
            {q.data ? `${parts.join(', ')}. ` : ''}Where your app runs, how to start it, and the live and test
            sites live on their own page now.
          </p>
        </div>
        <ButtonLink to={`/p/${projectKey}/environments`} variant="primary" data-testid="open-environments">
          Open Environments
        </ButtonLink>
      </div>
    </Panel>
  );
}
