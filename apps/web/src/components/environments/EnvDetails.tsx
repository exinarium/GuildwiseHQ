import type { ProbeReport, planChanges } from '@aom/shared';
import { FoundChanges } from '../delivery/setup/FoundChanges.tsx';
import { Button, Callout, Select, TextArea, TextInput } from '../ui.tsx';
import { type Answers, missingShared, type NativeAnswers, restartWords, type Stack } from './answers.ts';
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

/** "What we found" for an app that runs directly on the machine: its folder, how it is restarted and how a new version is built. */
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
  const plainFolder = !n.releaseLayout && !!n.workingDir;
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
        {n.workingDir ? (
          <p className="text-sm text-fg" data-testid="native-runs-from">
            It runs from <span className="font-mono text-xs [overflow-wrap:anywhere]">{n.workingDir}</span> on{' '}
            {where}.
          </p>
        ) : (
          <TextInput
            label={`Folder on ${where}`}
            value={n.appDir}
            onChange={(e) =>
              setNative({
                appDir: e.target.value.trim(),
                workingDir: `${e.target.value.trim()}/current`,
                releaseLayout: true,
              })
            }
            hint="The folder the app runs from, for example /srv/invoice."
            placeholder="/srv/invoice"
            autoCapitalize="none"
            spellCheck={false}
            data-testid="native-folder"
          />
        )}
        {plainFolder && (
          <div className="flex flex-col gap-2 rounded-control bg-sunken p-3" data-testid="native-adopt">
            <TextInput
              label="Folder for the versions"
              value={n.appDir}
              onChange={(e) => setNative({ appDir: e.target.value.trim() })}
              hint="A new folder next to the app. Each version gets its own folder in it."
              autoCapitalize="none"
              spellCheck={false}
              data-testid="native-appdir"
            />
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={n.adoptFolder}
                onChange={(e) => setNative({ adoptFolder: e.target.checked })}
                data-testid="native-adopt-confirm"
              />
              <span>
                The first update moves the folder {n.workingDir} to {n.appDir}/releases/initial and puts a
                link with the same name in its place. Nothing is deleted or copied; the app keeps running from
                the same files.
              </span>
            </label>
          </div>
        )}
        {missingShared(n).length > 0 && (
          <Callout
            tone="warning"
            title="Some files look like data the app writes itself"
            data-testid="native-state-paths"
          >
            <p>
              A new version starts in a fresh folder, so these would be left behind. Mark them as kept between
              versions first:
            </p>
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {missingShared(n).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="mt-2">
              <Button
                size="sm"
                variant="primary"
                data-testid="native-keep-state"
                onClick={() =>
                  setNative({
                    shared: [...n.shared.split(/[\s,]+/).filter(Boolean), ...missingShared(n)].join(' '),
                  })
                }
              >
                Keep these between versions
              </Button>
            </div>
          </Callout>
        )}
        {n.releaseLayout && n.workingDir && (
          <p className="text-xs text-muted">
            It already keeps its versions in a releases folder: nothing to convert.
          </p>
        )}
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
            onSelect={() =>
              setNative({
                restartVia: 'service',
                restartTarget: n.restartVia === 'service' ? n.restartTarget : `${n.name}.service`,
              })
            }
            title="It is a system service"
            testId="restart-service"
          >
            Guildwise restarts the service by its name.
          </Choice>
          <Choice
            name="native-restart"
            checked={n.restartVia === 'pm2'}
            onSelect={() =>
              setNative({
                restartVia: 'pm2',
                restartTarget: n.restartVia === 'pm2' ? n.restartTarget : n.name,
              })
            }
            title="It runs with pm2"
            testId="restart-pm2"
          >
            Guildwise restarts it with pm2 by its name.
          </Choice>
          <Choice
            name="native-restart"
            checked={n.restartVia === 'command'}
            onSelect={() =>
              setNative({
                restartVia: 'command',
                restartTarget: n.restartVia === 'command' ? n.restartTarget : '',
              })
            }
            title="I restart it with a command"
            testId="restart-command"
          >
            You type the command. Guildwise never edits a service file.
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
            hint={`Each update will ${restartWords(n)}. Please check that this is right.`}
            data-testid="native-restart-target"
          />
          {n.restartVia !== 'pm2' && n.scope === 'system' && (
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={n.sudo}
                onChange={(e) => setNative({ sudo: e.target.checked })}
                data-testid="native-sudo"
              />
              <span>
                <strong>Restarting needs administrator rights (sudo)</strong>
                <span className="block text-muted">
                  Only tick this if you know it does. It needs sudo without a password.
                </span>
              </span>
            </label>
          )}
        </fieldset>
        <TextArea
          label="How is a new version built? (one command per line)"
          value={n.build}
          rows={3}
          onChange={(e) => setNative({ build: e.target.value })}
          placeholder={'npm ci\nnpm run build'}
          hint="They run in the new folder, in this order. If one fails, nothing is switched."
          data-testid="native-build"
        />
        <TextInput
          label="Files that stay between versions (optional)"
          value={n.shared}
          onChange={(e) => setNative({ shared: e.target.value })}
          placeholder=".env uploads"
          hint="Settings files and folders that are kept on the machine and linked into every version."
          autoCapitalize="none"
          data-testid="native-shared"
        />
        <Select
          label="Back up a database first (optional)"
          value={n.dbEngine}
          onChange={(e) => setNative({ dbEngine: e.target.value as NativeAnswers['dbEngine'] })}
          data-testid="native-db"
        >
          <option value="">No backup</option>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL or MariaDB</option>
          <option value="sqlite">SQLite file</option>
        </Select>
        {n.dbEngine && n.dbEngine !== 'sqlite' && (
          <TextInput
            label="Database name"
            value={n.dbName}
            onChange={(e) => setNative({ dbName: e.target.value.trim() })}
            data-testid="native-db-name"
          />
        )}
        {n.dbEngine === 'sqlite' && (
          <TextInput
            label="Database file"
            value={n.dbFile}
            onChange={(e) => setNative({ dbFile: e.target.value.trim() })}
            data-testid="native-db-file"
          />
        )}
        {n.dbEngine && (
          <TextInput
            label="Folder for the backups"
            value={n.dbDir}
            onChange={(e) => setNative({ dbDir: e.target.value.trim() })}
            hint="If the backup fails, nothing else happens."
            data-testid="native-db-dir"
          />
        )}
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
