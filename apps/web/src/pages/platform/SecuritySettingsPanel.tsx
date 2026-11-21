import type { SecuritySettingKey, SecuritySettingState } from '@aom/shared';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { usePatchSecuritySettings, useSecuritySettings } from '../../api/queries/security-settings.ts';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog.tsx';
import { ErrorBox, ListSkeleton, Panel } from '../../components/ui.tsx';

const SOURCE: Record<SecuritySettingState['source'], string> = {
  locked: 'Set by Guildwise Cloud',
  platform: 'Set here',
  env: 'From the server configuration',
  default: 'Default',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The "Security settings" tab of Platform > Security (R27, R28): "Only signed runners" and "Require two-factor login",
 * both off by default on a self-hosted install. A hosted build locks them on: the switches are then disabled with a lock
 * and say so. Turning signed runners on first says how many workstations it unlinks and asks to confirm.
 */
export function SecuritySettingsPanel() {
  const settings = useSecuritySettings();
  const save = usePatchSecuritySettings();
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  if (settings.isPending) return <ListSkeleton label="Loading" rows={2} />;
  if (settings.isError) return <ErrorBox error={settings.error} onRetry={() => settings.refetch()} />;
  const s = settings.data;

  const change = (key: SecuritySettingKey, value: boolean) => {
    if (key === 'requireSignedRunners' && value && s.unsignedWorkstations > 0) {
      setConfirmUnlink(true);
      return;
    }
    save.mutate({ [key]: value });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="security-settings">
      <SettingRow
        id="requireSignedRunners"
        title="Only signed runners"
        state={s.requireSignedRunners}
        pending={save.isPending}
        onChange={change}
        detail={
          s.requireSignedRunners.value
            ? 'Workstations must run a signed runner release from 1.10.0 on. Older and unsigned runners are refused, and the old update paths are closed.'
            : 'When on, workstations must run a signed runner release from 1.10.0 on. Unsigned and older runners are unpaired and must be reinstalled from this server’s installer. Sign your own runner builds, or use the official image, before you turn this on.'
        }
        count={
          s.unsignedWorkstations > 0
            ? `${plural(s.unsignedWorkstations, 'workstation runs', 'workstations run')} an unsigned or outdated runner.`
            : 'Every workstation runs a signed runner.'
        }
      />
      <SettingRow
        id="enforceTwoFactor"
        title="Require two-factor login"
        state={s.enforceTwoFactor}
        pending={save.isPending}
        onChange={change}
        detail="Everyone without two-factor login sets it up before anything else. Accounts that only belong to simulation organizations are exempt."
        count={
          s.usersWithout2fa > 0
            ? `${plural(s.usersWithout2fa, 'account has', 'accounts have')} no two-factor login yet.`
            : 'Every account has two-factor login.'
        }
      />
      {s.refuseLegacyTwoFactor ? (
        <SettingRow
          id="refuseLegacyTwoFactor"
          title="Refuse legacy two-factor"
          state={s.refuseLegacyTwoFactor}
          pending={save.isPending}
          onChange={change}
          detail="When on, recovery codes made before 1.10.0 and authenticator apps set up with the key kept in the database are refused at sign-in, password reset and when you confirm it's you. Those users reset two-factor login by email and set it up again. Needs AOM_TWO_FACTOR_KEY (or AOM_SECRET_KEY) on the server."
          count={
            s.refuseLegacyTwoFactor.value
              ? 'Old recovery codes and authenticator apps are refused.'
              : 'Old recovery codes and authenticator apps keep working.'
          }
        />
      ) : null}
      <ErrorBox error={save.error} />
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Unpair unsigned workstations?"
        description={`${plural(s.unsignedWorkstations, 'workstation runs', 'workstations run')} an unsigned or outdated runner. Turning this on unpairs them now: their claims are released, their shifts stop, and their owners get a mail to reinstall the runner.`}
        confirmLabel="Turn on and unpair"
        pending={save.isPending}
        onConfirm={() =>
          save.mutate(
            { requireSignedRunners: true, confirmUnlink: true },
            { onSettled: () => setConfirmUnlink(false) },
          )
        }
      />
    </div>
  );
}

function SettingRow({
  id,
  title,
  state,
  detail,
  count,
  pending,
  onChange,
}: {
  id: SecuritySettingKey;
  title: string;
  state: SecuritySettingState;
  detail: string;
  count: string;
  pending: boolean;
  onChange: (key: SecuritySettingKey, value: boolean) => void;
}) {
  return (
    <Panel title={title}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start" data-testid={`setting-${id}`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">{detail}</p>
          <p className="mt-2 text-sm text-fg" data-testid={`setting-${id}-count`}>
            {count}
          </p>
          {state.locked ? (
            <p
              className="mt-2 flex items-center gap-1.5 text-sm text-muted"
              data-testid={`setting-${id}-locked`}
            >
              <Lock aria-hidden="true" className="size-4" />
              Set by Guildwise Cloud; cannot be changed here.
            </p>
          ) : (
            <p className="mt-2 text-xs text-subtle">{SOURCE[state.source]}</p>
          )}
        </div>
        <label className="flex items-center gap-2.5 text-sm font-medium text-fg">
          <input
            type="checkbox"
            role="switch"
            aria-checked={state.value}
            aria-label={title}
            data-testid={`setting-${id}-toggle`}
            className="size-5"
            checked={state.value}
            disabled={state.locked || pending}
            onChange={(e) => onChange(id, e.target.checked)}
          />
          {state.value ? 'On' : 'Off'}
        </label>
      </div>
    </Panel>
  );
}
