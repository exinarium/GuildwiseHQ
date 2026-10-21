import type { ProbeReport, planChanges } from '@aom/shared';
import { FoundChanges } from '../delivery/setup/FoundChanges.tsx';
import { Button, Select, TextInput } from '../ui.tsx';
import { type Answers, type NativeAnswers, restartWords, type Stack } from './answers.ts';
import { Choice } from './Choice.tsx';

/** "What we found" for a Docker app: which part is the app, the database, the version setting, the address to check. */
export function DockerDetails({
  answers,
  set,
  stack,
  report,
  changes,
  onCheckUrl,
  checking,
}: {
  answers: Answers;
  set: (p: Partial<Answers>) => void;
  stack: Stack | undefined;
  report: ProbeReport | null;
  changes: ReturnType<typeof planChanges>;
  onCheckUrl: (url: string) => void;
  checking: boolean;
}) {
  const parts = stack?.services ?? [];
  const urls = (report?.urls ?? []).filter((u) => u.status !== null);
  const imageVars = [
    ...new Set(
      report?.folders.flatMap((f) => (f.envKeys ?? []).filter((k) => /IMAGE|TAG|VERSION/.test(k))) ?? [],
    ),
  ];
  const status = report?.urls.find((u) => u.url === answers.healthUrl)?.status;
  const server = answers.hosting === 'ssh';
  return (
    <section className="flex flex-col gap-4" data-testid="env-details">
      <h3 className="text-lg font-semibold text-fg">What we found</h3>
      <FoundChanges items={changes} />
      <div className="flex flex-col gap-3 rounded-control border border-line p-3">
        <Select
          label="Which part is your app?"
          value={answers.appService}
          onChange={(e) => set({ appService: e.target.value })}
          data-testid="details-app"
        >
          {parts.length === 0 && <option value={answers.appService}>{answers.appService || 'Choose'}</option>}
          {parts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.build ? ' (built from your code)' : p.image ? ` (${p.image})` : ''}
            </option>
          ))}
        </Select>
        <Select
          label="Which part is the database? (it gets a backup before every update)"
          value={answers.dbService}
          onChange={(e) => set({ dbService: e.target.value })}
          data-testid="details-db"
        >
          <option value="">None: no backup</option>
          {parts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.database ? ` (${p.database})` : ''}
            </option>
          ))}
        </Select>
        {server && (
          <Select
            label="How is the version of the app named on the server?"
            value={answers.imageVar}
            onChange={(e) => set({ imageVar: e.target.value })}
            hint={
              answers.imageVar
                ? 'The setting in the .env file is changed to the new version.'
                : 'Your files are not edited: the new version is named in an extra file next to the compose file.'
            }
            data-testid="details-imagevar"
          >
            <option value="">In an extra file next to the compose file (recommended)</option>
            {[...new Set([answers.imageVar, ...imageVars].filter(Boolean))].map((k) => (
              <option key={k} value={k}>
                The setting {k} in the .env file
              </option>
            ))}
          </Select>
        )}
        <HealthField
          answers={answers}
          set={set}
          urls={urls}
          status={status}
          onCheckUrl={onCheckUrl}
          checking={checking}
        />
        <TextInput
          label="Web address people use (optional)"
          value={answers.appUrl}
          placeholder="https://your-site.example.com"
          hint="Shown on the card so you can open the site in one tap."
          onChange={(e) => set({ appUrl: e.target.value.trim() })}
          data-testid="details-appurl"
        />
        <TextInput
          label="Database updates before the app restarts (optional)"
          value={answers.migrateCmd}
          placeholder="npm run migrate"
          hint={
            answers.migrateCmd.trim() && !answers.dbService
              ? 'Choose the database part above first: it is backed up before this runs.'
              : 'A command your app uses to update its database for the new version. It runs after the backup and before the restart. If it fails, the app is not restarted. The database is never rolled back automatically.'
          }
          onChange={(e) => set({ migrateCmd: e.target.value })}
          autoCapitalize="none"
          spellCheck={false}
          data-testid="details-migrate"
        />
      </div>
    </section>
  );
}

function HealthField({
  answers,
  set,
  urls,
  status,
  onCheckUrl,
  checking,
}: {
  answers: Answers;
  set: (p: Partial<Answers>) => void;
  urls: Array<{ url: string; status: number | null }>;
  status: number | null | undefined;
  onCheckUrl: (url: string) => void;
  checking: boolean;
}) {
  return (
    <div>
      <TextInput
        label="Address Guildwise checks after an update"
        value={answers.healthUrl}
        placeholder="https://your-site.example.com/ready"
        hint={
          status
            ? `This address answered ${status} when we looked.`
            : 'If it does not answer after an update, the previous version is put back. Leave empty for no check.'
        }
        onChange={(e) => set({ healthUrl: e.target.value.trim() })}
        data-testid="details-health"
      />
      <div className="mt-1 flex flex-wrap gap-2">
        {urls.slice(0, 4).map((u) => (
          <button
            key={u.url}
            type="button"
            className="min-h-8 text-xs underline"
            onClick={() => set({ healthUrl: u.url })}
          >
            {u.url} ({u.status})
          </button>
        ))}
        {/^https?:\/\//.test(answers.healthUrl) && (
          <Button size="sm" variant="ghost" loading={checking} onClick={() => onCheckUrl(answers.healthUrl)}>
            Check this address
          </Button>
        )}
      </div>
    </div>
  );
}

/** "What we found" for an app that runs directly on the machine: name, folder, port and the way it is restarted. */
export function NativeDetails({
  answers,
  set,
  setNative,
  changes,
  urls,
  onCheckUrl,
  checking,
}: {
  answers: Answers;
  set: (p: Partial<Answers>) => void;
  setNative: (p: Partial<NativeAnswers>) => void;
  changes: ReturnType<typeof planChanges>;
  urls: Array<{ url: string; status: number | null }>;
  onCheckUrl: (url: string) => void;
  checking: boolean;
}) {
  const n = answers.native;
  const where = answers.hosting === 'ssh' ? 'the server' : 'this computer';
  return (
    <section className="flex flex-col gap-4" data-testid="native-details">
      <h3 className="text-lg font-semibold text-fg">What we found</h3>
      <FoundChanges items={changes} />
      <div className="flex flex-col gap-3 rounded-control border border-line p-3">
        <p className="text-sm text-muted" data-testid="native-how">
          Each update gets the new version of the code, builds it in a new folder, switches to it and restarts
          the app. The last {n.keepReleases} versions are kept, so you can go back.
        </p>
        <TextInput
          label="Name of the app"
          value={n.name}
          onChange={(e) => setNative({ name: e.target.value })}
          placeholder="invoice-web"
          data-testid="native-name"
        />
        <TextInput
          label={`Folder on ${where}`}
          value={n.folder}
          onChange={(e) => setNative({ folder: e.target.value.trim() })}
          hint="The folder the app runs from, for example /srv/invoice."
          placeholder="/srv/invoice"
          autoCapitalize="none"
          spellCheck={false}
          data-testid="native-folder"
        />
        <TextInput
          label="Port the app answers on (optional)"
          value={n.port}
          inputMode="numeric"
          onChange={(e) => setNative({ port: e.target.value.replace(/\D/g, '') })}
          placeholder="3000"
          data-testid="native-port"
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-fg">How is it restarted?</legend>
          <Choice
            name="native-restart"
            checked={n.restartVia === 'service'}
            onSelect={() => setNative({ restartVia: 'service' })}
            title="It is a system service"
            testId="restart-service"
          >
            Guildwise restarts the service by its name.
          </Choice>
          <Choice
            name="native-restart"
            checked={n.restartVia === 'pm2'}
            onSelect={() => setNative({ restartVia: 'pm2' })}
            title="It runs with pm2"
            testId="restart-pm2"
          >
            Guildwise restarts it with pm2 by its name.
          </Choice>
          <Choice
            name="native-restart"
            checked={n.restartVia === 'command'}
            onSelect={() => setNative({ restartVia: 'command' })}
            title="I restart it with a command"
            testId="restart-command"
          >
            You type the command. It runs in the app's folder.
          </Choice>
          <TextInput
            label={
              n.restartVia === 'service'
                ? 'Name of the service'
                : n.restartVia === 'pm2'
                  ? 'Name in pm2'
                  : 'Command that restarts it'
            }
            value={n.restartTarget}
            onChange={(e) => setNative({ restartTarget: e.target.value })}
            placeholder={
              n.restartVia === 'service'
                ? 'invoice-web.service'
                : n.restartVia === 'pm2'
                  ? 'crm-api'
                  : 'npm run restart'
            }
            autoCapitalize="none"
            spellCheck={false}
            hint={`Each update will ${restartWords(n)}.`}
            data-testid="native-restart-target"
          />
        </fieldset>
        <HealthField
          answers={answers}
          set={set}
          urls={urls}
          status={undefined}
          onCheckUrl={onCheckUrl}
          checking={checking}
        />
      </div>
    </section>
  );
}
