import { useParams } from 'react-router';
import { useWorkstationDevopsLog } from '../api/queries/leastPrivilege.ts';
import { DevopsCommandLog } from '../components/DevopsCommandLog.tsx';
import { PageHeader } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/** `/workstations/:id/devops-log`: the workstation owner's log of every DevOps command run on the machine (R17-4). */
export function WorkstationDevopsLog() {
  usePageTitle('DevOps commands');
  const { id = '' } = useParams();
  const log = useWorkstationDevopsLog(id);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader title="DevOps commands" back={{ to: '/workstations', label: 'Workstations' }} />
      <DevopsCommandLog
        title="Commands on this workstation"
        intro="Every command a DevOps session ran here, for every organization it serves, and the ones the runner refused. Only you see this log."
        query={log}
        showWorkstation={false}
      />
    </div>
  );
}
