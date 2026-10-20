import {
  buildFromTemplate,
  DOCKER_IMAGE_PRESETS,
  formatCommandLine,
  PACKAGE_MANAGERS,
  type PackageManager,
  parseCommandLine,
  type ReadyCheck,
  type RunPlanItem,
  type RunService,
  type RunSetupStep,
  type RunTemplateId,
  type RunTemplateParams,
  type StepWhen,
  templateInfo,
  templateParams,
  uniqueServiceName,
} from '@aom/shared';
import { useId, useState } from 'react';
import { Callout, Disclosure, Select, TextArea, TextInput } from '../ui.tsx';

/**
 * The questions of one step template, in plain words (docs/design/deploy-run-ux-design.md section 3.1 R1). It asks only what
 * the template needs and builds the plan item with `buildFromTemplate`. "Technical details" shows the real command, the
 * environment, the stop command and the Docker flag of the same item for developers; what is typed there wins.
 */

export interface RunFormContext {
  repos: Array<{ repoId: string; name: string }>;
  /** Names of the parts that already exist (for "Start after" and unique names). */
  serviceNames: string[];
  /** Folders used elsewhere in the plan, offered as suggestions. */
  folders: string[];
}

interface F {
  label: string;
  name: string;
  repoId: string;
  folder: string;
  manager: PackageManager;
  command: string;
  whenKind: StepWhen['kind'];
  pattern: string;
  port: string;
  usePortVar: boolean;
  portVar: string;
  ready: ReadyCheck['kind'];
  path: string;
  logText: string;
  waitSec: string;
  after: string[];
  envFile: string;
  preset: string;
  image: string;
  containerPort: string;
  composeFile: string;
  composeServices: string;
  readyPort: string;
}

const blank = (repoId: string): F => ({
  label: '',
  name: '',
  repoId,
  folder: '.',
  manager: 'npm',
  command: '',
  whenKind: 'always',
  pattern: '',
  port: '',
  usePortVar: true,
  portVar: 'PORT',
  ready: 'page',
  path: '/',
  logText: '',
  waitSec: '5',
  after: [],
  envFile: '',
  preset: 'postgres',
  image: '',
  containerPort: '',
  composeFile: 'docker-compose.yml',
  composeServices: '',
  readyPort: '',
});

function fromParams(base: F, p: RunTemplateParams): F {
  const f = { ...base };
  const q = p.params as unknown as Record<string, unknown>;
  const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
  f.repoId = str('repoId') ?? f.repoId;
  f.folder = str('folder') ?? f.folder;
  f.label = str('label') ?? f.label;
  f.name = str('name') ?? f.name;
  f.command = str('command') ?? f.command;
  if (p.template === 'install_packages') f.manager = p.params.manager;
  const when = q.when as StepWhen | undefined;
  if (when) {
    f.whenKind = when.kind;
    if (when.kind === 'changed') f.pattern = when.pattern;
  }
  if (typeof q.port === 'number') f.port = String(q.port);
  if (typeof q.portEnvVar === 'string') {
    f.usePortVar = true;
    f.portVar = q.portEnvVar;
  } else if (p.template === 'web_app' || p.template === 'custom_service') f.usePortVar = false;
  const ready = q.ready as ReadyCheck | undefined;
  if (ready) {
    f.ready = ready.kind;
    if (ready.kind === 'page') f.path = ready.path;
    if (ready.kind === 'log') f.logText = ready.text;
    if (ready.kind === 'wait') f.waitSec = String(ready.seconds);
  }
  if (Array.isArray(q.after)) f.after = q.after as string[];
  f.envFile = str('envFile') ?? f.envFile;
  if (p.template === 'docker_service') {
    f.image = p.params.image;
    f.containerPort = String(p.params.containerPort);
    const preset = DOCKER_IMAGE_PRESETS.find((x) => x.image === p.params.image);
    f.preset = preset?.id ?? 'other';
  }
  if (p.template === 'compose_stack') {
    f.composeFile = p.params.composeFile;
    f.composeServices = p.params.services.join(' ');
    f.readyPort = p.params.readyPort ? String(p.params.readyPort) : '';
  }
  return f;
}

function readyOf(f: F): ReadyCheck {
  if (f.ready === 'page') return { kind: 'page', path: f.path.trim() || '/' };
  if (f.ready === 'port') return { kind: 'port' };
  if (f.ready === 'log') {
    if (!f.logText.trim()) throw new Error('Type the line that shows the app is ready.');
    return { kind: 'log', text: f.logText.trim() };
  }
  return { kind: 'wait', seconds: Math.max(0, Number(f.waitSec) || 0) };
}

function whenOf(f: F): StepWhen {
  if (f.whenKind === 'first') return { kind: 'first' };
  if (f.whenKind === 'changed') {
    if (!f.pattern.trim()) throw new Error('Name the file whose change should run this step again.');
    return { kind: 'changed', pattern: f.pattern.trim() };
  }
  return { kind: 'always' };
}

const portOf = (f: F, required: boolean): number | undefined => {
  if (!f.port.trim()) {
    if (required) throw new Error('Which port does the app use? Type a number, usually 3000 or 5173.');
    return undefined;
  }
  const n = Number(f.port);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error('The port is a number between 1 and 65535.');
  return n;
};

function toParams(t: RunTemplateId, f: F, ctx: RunFormContext, editing: boolean): RunTemplateParams {
  const common = { repoId: f.repoId, folder: f.folder };
  const label = f.label.trim() || undefined;
  const name = (fallback: string) =>
    editing && f.name ? f.name : uniqueServiceName(label ?? fallback, ctx.serviceNames);
  switch (t) {
    case 'install_packages':
      return { template: t, params: { ...common, manager: f.manager } };
    case 'build':
    case 'prepare_db':
      return {
        template: t,
        params: { ...common, command: f.command, ...(label ? { label } : {}), when: whenOf(f) },
      };
    case 'custom_step':
      return {
        template: t,
        params: {
          ...common,
          name: f.name || label || 'Run a command',
          command: f.command,
          ...(label ? { label } : {}),
          when: whenOf(f),
        },
      };
    case 'web_app':
      return {
        template: t,
        params: {
          ...common,
          name: name('web'),
          command: f.command,
          port: portOf(f, true) as number,
          ...(f.usePortVar && f.portVar.trim() ? { portEnvVar: f.portVar.trim() } : {}),
          ready: readyOf(f),
          after: f.after,
          ...(f.envFile.trim() ? { envFile: f.envFile.trim() } : {}),
          ...(label ? { label } : {}),
        },
      };
    case 'custom_service': {
      const port = portOf(f, false);
      return {
        template: t,
        params: {
          ...common,
          name: name('service'),
          command: f.command,
          ...(port !== undefined ? { port } : {}),
          ...(port !== undefined && f.usePortVar && f.portVar.trim() ? { portEnvVar: f.portVar.trim() } : {}),
          ready: readyOf(f),
          after: f.after,
          ...(f.envFile.trim() ? { envFile: f.envFile.trim() } : {}),
          ...(label ? { label } : {}),
        },
      };
    }
    case 'docker_service': {
      const preset = DOCKER_IMAGE_PRESETS.find((x) => x.id === f.preset);
      const containerPort = preset?.containerPort ?? Number(f.containerPort);
      if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535)
        throw new Error('Which port does it use inside Docker? For example 5432 for PostgreSQL.');
      const image = preset?.image ?? f.image.trim();
      if (!image) throw new Error('Which Docker image should be started, for example postgres:16?');
      return {
        template: t,
        params: {
          repoId: f.repoId,
          name: name(preset?.id ?? 'service'),
          image,
          containerPort,
          env: preset?.env ?? {},
          after: f.after,
          ...(label ? { label } : {}),
        },
      };
    }
    case 'compose_stack': {
      const readyPort = portOf({ ...f, port: f.readyPort }, false);
      return {
        template: t,
        params: {
          ...common,
          name: name('stack'),
          composeFile: f.composeFile,
          services: f.composeServices.split(/[\s,]+/).filter(Boolean),
          ...(readyPort !== undefined ? { readyPort } : {}),
          ...(label ? { label } : {}),
        },
      };
    }
  }
}

const envLines = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

export function RunStepForm({
  template,
  initial,
  ctx,
  banner,
  onSubmit,
  formId,
}: {
  template: RunTemplateId;
  /** The item being edited (absent: a new one). */
  initial?: RunPlanItem;
  ctx: RunFormContext;
  /** What DevOps asked about this part. */
  banner?: string[];
  onSubmit: (item: RunPlanItem) => void;
  formId?: string;
}) {
  const uid = useId();
  const info = templateInfo(template);
  const start = (): F => {
    const b = blank(ctx.repos[0]?.repoId ?? '');
    if (!initial) return b;
    const p = templateParams(initial.kind, initial.item);
    return p && p.template === template ? fromParams(b, p) : { ...b, repoId: initial.item.repoId };
  };
  const [f, setF] = useState<F>(start);
  const [error, setError] = useState<string | undefined>();
  // Technical details: typed overrides of the built item.
  const [cmdText, setCmdText] = useState<string | undefined>();
  const [envText, setEnvText] = useState<string | undefined>();
  const [stopText, setStopText] = useState<string | undefined>();
  const [timeoutText, setTimeoutText] = useState<string | undefined>();
  const set = (patch: Partial<F>) => setF((cur) => ({ ...cur, ...patch }));
  const editing = !!initial;

  const preview = (): RunPlanItem | null => {
    try {
      return buildFromTemplate(toParams(template, f, ctx, editing));
    } catch {
      return null;
    }
  };
  const built = preview();
  const initialEnv = initial?.kind === 'service' ? initial.item.env : {};

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    let out: RunPlanItem;
    try {
      out = buildFromTemplate(toParams(template, f, ctx, editing));
      if (!f.repoId) throw new Error('This project has no repository to run yet.');
      if (cmdText !== undefined) {
        const cmd = parseCommandLine(cmdText);
        if (cmd.length === 0) throw new Error('The command cannot be empty.');
        out = { ...out, item: { ...out.item, cmd } } as RunPlanItem;
      }
      if (timeoutText !== undefined && timeoutText.trim()) {
        const t = Number(timeoutText);
        if (!Number.isInteger(t) || t < 1) throw new Error('The time limit is a whole number of seconds.');
        if (out.kind === 'step') out = { kind: 'step', item: { ...out.item, timeoutSec: t } };
        else out = { kind: 'service', item: { ...out.item, startTimeoutSec: t } };
      }
      if (out.kind === 'service') {
        const svc: RunService = { ...out.item };
        if (envText !== undefined) {
          const env: Record<string, string> = {};
          for (const line of envText.split('\n')) {
            const l = line.trim();
            if (!l) continue;
            const eq = l.indexOf('=');
            if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(l.slice(0, eq)))
              throw new Error(`"${l}" is not NAME=value.`);
            env[l.slice(0, eq)] = l.slice(eq + 1);
          }
          svc.env = env;
        } else if (editing) svc.env = initialEnv;
        if (stopText !== undefined) {
          const stop = parseCommandLine(stopText);
          if (stop.length) svc.stopCmd = stop;
          else delete svc.stopCmd;
        } else if (editing && initial?.kind === 'service' && initial.item.stopCmd && !svc.stopCmd)
          svc.stopCmd = initial.item.stopCmd;
        out = { kind: 'service', item: svc };
      } else if (editing && initial?.kind === 'step' && timeoutText === undefined) {
        out = { kind: 'step', item: { ...out.item, timeoutSec: initial.item.timeoutSec } as RunSetupStep };
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    onSubmit(out);
  };

  const others = ctx.serviceNames.filter((n) => n !== f.name);
  const isService = info?.kind === 'service';
  const showCommand = ['build', 'prepare_db', 'custom_step', 'web_app', 'custom_service'].includes(template);
  const showPort = template === 'web_app' || template === 'custom_service';
  const listId = `${uid}-folders`;

  return (
    <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label={info?.title}>
      {banner && banner.length > 0 && (
        <Callout tone="warning" title="DevOps asks" data-testid="step-banner">
          <ul className="list-disc pl-4">
            {banner.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Callout>
      )}
      {ctx.repos.length > 1 && (
        <Select
          label="Which project code?"
          value={f.repoId}
          onChange={(e) => set({ repoId: e.target.value })}
        >
          {ctx.repos.map((r) => (
            <option key={r.repoId} value={r.repoId}>
              {r.name}
            </option>
          ))}
        </Select>
      )}

      {template === 'install_packages' && (
        <>
          <FolderField f={f} set={set} listId={listId} ctx={ctx} />
          <Select
            label="How are the packages installed?"
            value={f.manager}
            onChange={(e) => set({ manager: e.target.value as PackageManager })}
            hint="Look for package-lock.json (npm), pnpm-lock.yaml (pnpm), yarn.lock (Yarn), requirements.txt (pip)."
          >
            {PACKAGE_MANAGERS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </>
      )}

      {(template === 'build' || template === 'prepare_db' || template === 'custom_step' || isService) && (
        <TextInput
          label={isService ? 'What do you call this part?' : 'What is this step called?'}
          value={f.label}
          placeholder={
            template === 'web_app'
              ? 'The website'
              : template === 'docker_service'
                ? 'The database'
                : template === 'build'
                  ? 'Build'
                  : template === 'prepare_db'
                    ? 'Prepare the database'
                    : ''
          }
          onChange={(e) => set({ label: e.target.value })}
        />
      )}

      {template !== 'docker_service' && template !== 'compose_stack' && template !== 'install_packages' && (
        <FolderField f={f} set={set} listId={listId} ctx={ctx} />
      )}

      {showCommand && (
        <TextInput
          label={
            isService
              ? 'What command starts it?'
              : template === 'prepare_db'
                ? 'What command updates the database?'
                : 'What command does it run?'
          }
          value={f.command}
          placeholder={
            template === 'web_app'
              ? 'npm run dev'
              : template === 'prepare_db'
                ? 'npm run migrate'
                : 'npm run build'
          }
          hint="Type it the way you would in a terminal. Guildwise runs it in the folder above."
          onChange={(e) => set({ command: e.target.value })}
        />
      )}

      {!isService && template !== 'install_packages' && (
        <div className="flex flex-col gap-2">
          <Select
            label="When does it run?"
            value={f.whenKind}
            onChange={(e) => set({ whenKind: e.target.value as StepWhen['kind'] })}
          >
            <option value="always">Every time the app starts</option>
            <option value="first">Only the first time</option>
            <option value="changed">When certain files change</option>
          </Select>
          {f.whenKind === 'changed' && (
            <TextInput
              label="Which files?"
              value={f.pattern}
              placeholder="prisma/migrations/**"
              hint="A file or a pattern, from the top of the project. The step runs again when it changes."
              onChange={(e) => set({ pattern: e.target.value })}
            />
          )}
        </div>
      )}

      {showPort && (
        <>
          <TextInput
            label="Which port does it use?"
            inputMode="numeric"
            value={f.port}
            placeholder="3000"
            hint={
              template === 'web_app'
                ? 'The number in the address you open, for example 3000 or 5173. Usually 3000 for a Node app.'
                : 'Leave empty if it has no port.'
            }
            onChange={(e) => set({ port: e.target.value })}
          />
          <label className="flex min-h-9 items-center gap-2 text-sm [@media(pointer:coarse)]:min-h-11">
            <input
              type="checkbox"
              checked={f.usePortVar}
              onChange={(e) => set({ usePortVar: e.target.checked })}
            />
            The app reads its port from a setting
          </label>
          {f.usePortVar && (
            <TextInput
              label="Name of that setting"
              value={f.portVar}
              hint="Usually PORT. Guildwise picks a free port and hands it over, so two copies never clash."
              onChange={(e) => set({ portVar: e.target.value })}
            />
          )}
        </>
      )}

      {template === 'docker_service' && (
        <>
          <Select
            label="What should be started?"
            value={f.preset}
            onChange={(e) => set({ preset: e.target.value })}
          >
            {DOCKER_IMAGE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="other">Something else</option>
          </Select>
          {f.preset === 'other' && (
            <>
              <TextInput
                label="Docker image"
                value={f.image}
                placeholder="mongo:7"
                onChange={(e) => set({ image: e.target.value })}
              />
              <TextInput
                label="Which port does it use inside Docker?"
                inputMode="numeric"
                value={f.containerPort}
                placeholder="27017"
                onChange={(e) => set({ containerPort: e.target.value })}
              />
            </>
          )}
          <p className="text-xs text-subtle">
            This starts a throwaway copy for testing, with a simple test password. It is not your real
            database.
          </p>
        </>
      )}

      {template === 'compose_stack' && (
        <>
          <TextInput
            label="Which docker-compose file?"
            value={f.composeFile}
            hint="The file in the project that lists the parts, for example docker-compose.yml."
            onChange={(e) => set({ composeFile: e.target.value })}
          />
          <FolderField f={f} set={set} listId={listId} ctx={ctx} />
          <TextInput
            label="Which parts of it? (optional)"
            value={f.composeServices}
            placeholder="db cache"
            hint="Leave empty to start all of them."
            onChange={(e) => set({ composeServices: e.target.value })}
          />
          <TextInput
            label="Which port should answer when it is ready? (optional)"
            inputMode="numeric"
            value={f.readyPort}
            onChange={(e) => set({ readyPort: e.target.value })}
          />
        </>
      )}

      {(template === 'web_app' || template === 'custom_service') && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-fg">How do we know it is ready?</legend>
          {(
            [
              ['page', 'The page opens'],
              ['port', 'The port answers'],
              ['log', 'A line appears in its output'],
              ['wait', 'Just wait a few seconds'],
            ] as const
          ).map(([k, text]) => (
            <label
              key={k}
              className="flex min-h-9 items-center gap-2 text-sm [@media(pointer:coarse)]:min-h-11"
            >
              <input
                type="radio"
                name={`${uid}-ready`}
                checked={f.ready === k}
                disabled={template === 'custom_service' && (k === 'page' || k === 'port') && !f.port.trim()}
                onChange={() => set({ ready: k })}
              />
              {text}
            </label>
          ))}
          {f.ready === 'page' && (
            <TextInput
              label="Which page?"
              value={f.path}
              hint="/ is the front page. Use /health if the app has a health page."
              onChange={(e) => set({ path: e.target.value })}
            />
          )}
          {f.ready === 'log' && (
            <TextInput
              label="Which line?"
              value={f.logText}
              placeholder="Listening on"
              onChange={(e) => set({ logText: e.target.value })}
            />
          )}
          {f.ready === 'wait' && (
            <TextInput
              label="How many seconds?"
              inputMode="numeric"
              value={f.waitSec}
              onChange={(e) => set({ waitSec: e.target.value })}
            />
          )}
        </fieldset>
      )}

      {isService && template !== 'compose_stack' && others.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-fg">Start after</legend>
          <p className="text-xs text-subtle">This part waits until these are ready.</p>
          <div className="flex flex-wrap gap-2">
            {others.map((n) => (
              <label
                key={n}
                className="flex min-h-9 items-center gap-2 rounded-control border border-line px-3 text-sm [@media(pointer:coarse)]:min-h-11"
              >
                <input
                  type="checkbox"
                  checked={f.after.includes(n)}
                  onChange={(e) =>
                    set({ after: e.target.checked ? [...f.after, n] : f.after.filter((x) => x !== n) })
                  }
                />
                {n}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {(template === 'web_app' || template === 'custom_service') && (
        <TextInput
          label="Settings file on this computer (optional)"
          value={f.envFile}
          placeholder="/home/you/.config/myapp/web.env"
          hint="A file with passwords or keys the app needs. Only its location is saved, never the file."
          onChange={(e) => set({ envFile: e.target.value })}
        />
      )}

      <Disclosure summary="Show technical details" data-testid="step-technical">
        <div className="flex flex-col gap-3">
          <TextInput
            label="Command"
            className="font-mono"
            value={cmdText ?? (built ? formatCommandLine(built.item.cmd) : '')}
            onChange={(e) => setCmdText(e.target.value)}
          />
          {isService && (
            <>
              <TextArea
                label="Settings (NAME=value, one per line)"
                className="font-mono"
                rows={3}
                value={envText ?? envLines(initialEnv)}
                hint="No passwords here: use a settings file. ${port} stands for the port of this part."
                onChange={(e) => setEnvText(e.target.value)}
              />
              <TextInput
                label="Stop command (optional)"
                className="font-mono"
                value={
                  stopText ??
                  ((built?.kind === 'service' ? built.item.stopCmd : undefined)
                    ? formatCommandLine((built as { item: RunService }).item.stopCmd as string[])
                    : '')
                }
                onChange={(e) => setStopText(e.target.value)}
              />
            </>
          )}
          <TextInput
            label={isService ? 'Give up starting after (seconds)' : 'Give up after (seconds)'}
            inputMode="numeric"
            value={
              timeoutText ??
              String(
                built
                  ? built.kind === 'step'
                    ? initial?.kind === 'step'
                      ? initial.item.timeoutSec
                      : built.item.timeoutSec
                    : initial?.kind === 'service'
                      ? initial.item.startTimeoutSec
                      : built.item.startTimeoutSec
                  : '',
              )
            }
            onChange={(e) => setTimeoutText(e.target.value)}
          />
        </div>
      </Disclosure>

      {error && (
        <p role="alert" className="text-sm font-medium text-danger" data-testid="step-error">
          {error}
        </p>
      )}
    </form>
  );
}

function FolderField({
  f,
  set,
  listId,
  ctx,
}: {
  f: F;
  set: (p: Partial<F>) => void;
  listId: string;
  ctx: RunFormContext;
}) {
  return (
    <>
      <TextInput
        label="Which folder?"
        value={f.folder}
        list={listId}
        hint='"." means the top folder of the project. Use a name like web or backend when the app is in a folder.'
        onChange={(e) => set({ folder: e.target.value })}
      />
      <datalist id={listId}>
        {[...new Set(['.', ...ctx.folders])].map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
    </>
  );
}
