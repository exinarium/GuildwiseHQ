import {
  formatCommandLine,
  parseCommandLine,
  type RunHealth,
  type RunPlan,
  type RunService,
  type RunSetupStep,
  validateRunPlan,
} from './plan.ts';

/**
 * Guided run steps (docs/design/deploy-run-ux-design.md section 4.1). A template is a small question form plus a pure
 * function that turns the answers into a plan item (a setup step or a service). The plan item remembers its `template`
 * and a plain-language `label`, so the editor can show it as a template again; `templateParams` is the inverse. The
 * engine format stays the `RunPlan`: nothing here changes how the runner replays a plan.
 */

export type RunTemplateId =
  | 'install_packages'
  | 'build'
  | 'prepare_db'
  | 'web_app'
  | 'docker_service'
  | 'compose_stack'
  | 'custom_step'
  | 'custom_service';

export interface RunTemplateInfo {
  id: RunTemplateId;
  /** `step` runs once before the app starts; `service` is a part of the app that keeps running. */
  kind: 'step' | 'service';
  title: string;
  /** One line in plain words, for the picker. */
  blurb: string;
  /** Hidden from the beginner picker (shown under "More"). */
  advanced?: boolean;
}

export const RUN_TEMPLATES: RunTemplateInfo[] = [
  {
    id: 'install_packages',
    kind: 'step',
    title: 'Install packages',
    blurb: 'Download the libraries the project needs.',
  },
  { id: 'build', kind: 'step', title: 'Build', blurb: 'Compile or bundle the project before it starts.' },
  {
    id: 'prepare_db',
    kind: 'step',
    title: 'Prepare the database',
    blurb: 'Create or update the database tables.',
  },
  {
    id: 'web_app',
    kind: 'service',
    title: 'Start the website or app',
    blurb: 'Run the project itself and wait until it answers.',
  },
  {
    id: 'docker_service',
    kind: 'service',
    title: 'Start a database or service (Docker)',
    blurb: 'Run PostgreSQL, Redis, MySQL or another container the app needs.',
  },
  {
    id: 'compose_stack',
    kind: 'service',
    title: 'Start a Docker Compose file',
    blurb: 'Start the parts listed in a docker-compose file of the project.',
  },
  {
    id: 'custom_step',
    kind: 'step',
    title: 'Something else (a command)',
    blurb: 'Run any command once before the app starts.',
    advanced: true,
  },
  {
    id: 'custom_service',
    kind: 'service',
    title: 'Something else that keeps running',
    blurb: 'Run any command that stays running.',
    advanced: true,
  },
];

export const templateInfo = (id: string | undefined): RunTemplateInfo | undefined =>
  RUN_TEMPLATES.find((t) => t.id === id);

// ------------------------------------------------------------------------------------------------- parameters

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry' | 'bundle' | 'go';

export const PACKAGE_MANAGERS: Array<{
  id: PackageManager;
  label: string;
  cmd: string[];
  /** The file whose change makes the install run again. */
  lockfile: string;
}> = [
  { id: 'npm', label: 'npm', cmd: ['npm', 'ci'], lockfile: 'package-lock.json' },
  { id: 'pnpm', label: 'pnpm', cmd: ['pnpm', 'install', '--frozen-lockfile'], lockfile: 'pnpm-lock.yaml' },
  { id: 'yarn', label: 'Yarn', cmd: ['yarn', 'install', '--frozen-lockfile'], lockfile: 'yarn.lock' },
  {
    id: 'pip',
    label: 'pip (Python)',
    cmd: ['pip', 'install', '-r', 'requirements.txt'],
    lockfile: 'requirements.txt',
  },
  { id: 'poetry', label: 'Poetry (Python)', cmd: ['poetry', 'install'], lockfile: 'poetry.lock' },
  { id: 'bundle', label: 'Bundler (Ruby)', cmd: ['bundle', 'install'], lockfile: 'Gemfile.lock' },
  { id: 'go', label: 'Go modules', cmd: ['go', 'mod', 'download'], lockfile: 'go.sum' },
];

/** "When does this step run": every start, only the first start of an environment, or when files changed. */
export type StepWhen = { kind: 'always' } | { kind: 'first' } | { kind: 'changed'; pattern: string };

export type ReadyCheck =
  | { kind: 'page'; path: string }
  | { kind: 'port' }
  | { kind: 'log'; text: string }
  | { kind: 'wait'; seconds: number };

export interface InstallParams {
  repoId: string;
  folder: string;
  manager: PackageManager;
  when?: StepWhen;
}
export interface CommandStepParams {
  repoId: string;
  folder: string;
  /** A command line; split like a shell would, but no shell is involved. */
  command: string;
  label?: string;
  when?: StepWhen;
}
export interface WebAppParams {
  name: string;
  repoId: string;
  folder: string;
  command: string;
  port: number;
  /** The environment variable the app reads its port from (Guildwise picks a free port and passes it in). */
  portEnvVar?: string;
  ready: ReadyCheck;
  after: string[];
  /** Absolute path of a settings file on the computer (never uploaded). */
  envFile?: string;
  label?: string;
}
export interface DockerServiceParams {
  name: string;
  repoId: string;
  image: string;
  /** The port inside the container, for example 5432. */
  containerPort: number;
  /** Extra `-e NAME=value` pairs for a throwaway test container (no secrets). */
  env?: Record<string, string>;
  after: string[];
  label?: string;
}
export interface ComposeParams {
  name: string;
  repoId: string;
  folder: string;
  composeFile: string;
  services: string[];
  /** The port the compose file publishes for the website, when the app opens in a browser. */
  readyPort?: number;
  label?: string;
}
export interface CustomStepParams {
  name: string;
  repoId: string;
  folder: string;
  command: string;
  when?: StepWhen;
  label?: string;
}
export interface CustomServiceParams {
  name: string;
  repoId: string;
  folder: string;
  command: string;
  port?: number;
  portEnvVar?: string;
  ready: ReadyCheck;
  after: string[];
  envFile?: string;
  label?: string;
}

export type RunTemplateParams =
  | { template: 'install_packages'; params: InstallParams }
  | { template: 'build'; params: CommandStepParams }
  | { template: 'prepare_db'; params: CommandStepParams }
  | { template: 'web_app'; params: WebAppParams }
  | { template: 'docker_service'; params: DockerServiceParams }
  | { template: 'compose_stack'; params: ComposeParams }
  | { template: 'custom_step'; params: CustomStepParams }
  | { template: 'custom_service'; params: CustomServiceParams };

export type RunPlanItem = { kind: 'step'; item: RunSetupStep } | { kind: 'service'; item: RunService };

export const DOCKER_IMAGE_PRESETS: Array<{
  id: string;
  label: string;
  image: string;
  containerPort: number;
  env: Record<string, string>;
}> = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    image: 'postgres:16',
    containerPort: 5432,
    env: { POSTGRES_PASSWORD: 'postgres' },
  },
  { id: 'redis', label: 'Redis', image: 'redis:7', containerPort: 6379, env: {} },
  {
    id: 'mysql',
    label: 'MySQL',
    image: 'mysql:8',
    containerPort: 3306,
    env: { MYSQL_ROOT_PASSWORD: 'mysql' },
  },
];

// ------------------------------------------------------------------------------------------------- helpers

const cleanFolder = (f: string | undefined): string => {
  const t = (f ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return t === '' ? '.' : t;
};

const inFolder = (folder: string, file: string): string => (folder === '.' ? file : `${folder}/${file}`);

export function whenToString(w: StepWhen | undefined): string {
  if (!w || w.kind === 'always') return 'always';
  if (w.kind === 'first') return 'first';
  return `changed:${w.pattern}`;
}

export function whenFromString(s: string | undefined): StepWhen {
  const t = (s ?? 'always').trim();
  if (t === 'first') return { kind: 'first' };
  if (t.startsWith('changed:')) return { kind: 'changed', pattern: t.slice('changed:'.length).trim() };
  return { kind: 'always' };
}

/** Plain words for a ready check ("The page opens at /health"). */
export function describeReady(r: ReadyCheck): string {
  if (r.kind === 'page') return `the page opens${r.path && r.path !== '/' ? ` at ${r.path}` : ''}`;
  if (r.kind === 'port') return 'the port answers';
  if (r.kind === 'log') return `the line "${r.text}" appears`;
  return `it has had ${r.seconds} seconds`;
}

const escapeRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function readyToHealth(r: ReadyCheck, hasPort: boolean): RunHealth {
  if (r.kind === 'page' && hasPort)
    return {
      kind: 'http',
      url: `http://localhost:\${port}${r.path.startsWith('/') ? r.path : `/${r.path}`}`,
      expect: '2xx',
    };
  if (r.kind === 'port' && hasPort) return { kind: 'tcp', port: 'http' };
  if (r.kind === 'log') return { kind: 'log', regex: escapeRegex(r.text) };
  if (r.kind === 'wait') return { kind: 'none', graceSec: Math.max(0, Math.min(300, Math.round(r.seconds))) };
  return { kind: 'none', graceSec: 3 };
}

export function healthToReady(h: RunHealth): ReadyCheck {
  if (h.kind === 'http') {
    const m = /^https?:\/\/[^/]*(\/.*)?$/.exec(h.url);
    return { kind: 'page', path: m?.[1] || '/' };
  }
  if (h.kind === 'tcp') return { kind: 'port' };
  if (h.kind === 'log') return { kind: 'log', text: h.regex.replace(/\\(.)/g, '$1') };
  return { kind: 'wait', seconds: h.graceSec };
}

function portsFor(port: number | undefined, envVar: string | undefined): RunService['ports'] {
  if (port === undefined) return [];
  return [
    {
      name: 'http',
      default: port,
      ...(envVar ? { envVar } : {}),
      url: 'http://localhost:${port}/',
    },
  ];
}

function nameFromLabel(label: string): string {
  const n = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return n || 'step';
}

// ------------------------------------------------------------------------------------------------- build

/** Turns the answers of a template into a plan item. Throws an Error with a plain message when an answer is unusable. */
export function buildFromTemplate(t: RunTemplateParams): RunPlanItem {
  switch (t.template) {
    case 'install_packages': {
      const p = t.params;
      const pm = PACKAGE_MANAGERS.find((m) => m.id === p.manager);
      if (!pm) throw new Error('Pick how the packages are installed.');
      const folder = cleanFolder(p.folder);
      return {
        kind: 'step',
        item: stepOf({
          name: 'Install packages',
          label: folder === '.' ? 'Install packages' : `Install packages (${folder})`,
          template: 'install_packages',
          repoId: p.repoId,
          cwd: folder,
          cmd: pm.cmd,
          when: whenToString(p.when ?? { kind: 'changed', pattern: inFolder(folder, pm.lockfile) }),
        }),
      };
    }
    case 'build':
    case 'prepare_db': {
      const p = t.params;
      const cmd = parseCommandLine(p.command);
      if (cmd.length === 0) throw new Error('Type the command to run.');
      const base = t.template === 'build' ? 'Build' : 'Prepare the database';
      const folder = cleanFolder(p.folder);
      return {
        kind: 'step',
        item: stepOf({
          name: p.label?.trim() || base,
          label: p.label?.trim() || (folder === '.' ? base : `${base} (${folder})`),
          template: t.template,
          repoId: p.repoId,
          cwd: folder,
          cmd,
          when: whenToString(p.when),
        }),
      };
    }
    case 'custom_step': {
      const p = t.params;
      const cmd = parseCommandLine(p.command);
      if (cmd.length === 0) throw new Error('Type the command to run.');
      const label = p.label?.trim() || p.name.trim() || 'Run a command';
      return {
        kind: 'step',
        item: stepOf({
          name: p.name.trim() || label,
          label,
          template: 'custom_step',
          repoId: p.repoId,
          cwd: cleanFolder(p.folder),
          cmd,
          when: whenToString(p.when),
        }),
      };
    }
    case 'web_app': {
      const p = t.params;
      const cmd = parseCommandLine(p.command);
      if (cmd.length === 0) throw new Error('Type the command that starts the app.');
      if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)
        throw new Error('The port is a number between 1 and 65535.');
      return {
        kind: 'service',
        item: serviceOf({
          name: p.name || 'web',
          label: p.label?.trim() || 'The website or app',
          template: 'web_app',
          repoId: p.repoId,
          cwd: cleanFolder(p.folder),
          cmd,
          ports: portsFor(p.port, p.portEnvVar?.trim() || undefined),
          health: readyToHealth(p.ready, true),
          after: p.after,
          ...(p.envFile?.trim() ? { envFile: p.envFile.trim() } : {}),
          docker: false,
        }),
      };
    }
    case 'custom_service': {
      const p = t.params;
      const cmd = parseCommandLine(p.command);
      if (cmd.length === 0) throw new Error('Type the command that starts it.');
      return {
        kind: 'service',
        item: serviceOf({
          name: p.name || nameFromLabel(p.label ?? 'service'),
          label: p.label?.trim() || p.name,
          template: 'custom_service',
          repoId: p.repoId,
          cwd: cleanFolder(p.folder),
          cmd,
          ports: portsFor(p.port, p.portEnvVar?.trim() || undefined),
          health: readyToHealth(p.ready, p.port !== undefined),
          after: p.after,
          ...(p.envFile?.trim() ? { envFile: p.envFile.trim() } : {}),
          docker: false,
        }),
      };
    }
    case 'docker_service': {
      const p = t.params;
      if (!/^[a-z0-9][a-z0-9._/:@-]*$/i.test(p.image))
        throw new Error('That does not look like a Docker image name.');
      const envArgs = Object.entries(p.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      return {
        kind: 'service',
        item: serviceOf({
          name: p.name,
          label: p.label?.trim() || `Database or service (${p.image})`,
          template: 'docker_service',
          repoId: p.repoId,
          cwd: '.',
          cmd: [
            'docker',
            'run',
            '--rm',
            '-p',
            // only this computer can reach a throwaway database
            `127.0.0.1:\${port}:${p.containerPort}`,
            ...envArgs,
            p.image,
          ],
          ports: [{ name: 'tcp', default: p.containerPort }],
          health: { kind: 'tcp', port: 'tcp' },
          after: p.after,
          docker: true,
        }),
      };
    }
    case 'compose_stack': {
      const p = t.params;
      if (!p.composeFile.trim()) throw new Error('Pick the docker-compose file.');
      const file = p.composeFile.trim();
      if (file.startsWith('-') || p.services.some((x) => x.trim().startsWith('-')))
        throw new Error('The compose file and the part names cannot start with a dash.');
      // `${envId}` is filled in per environment when the plan is replayed, so two test copies never share a stack
      const project = `aom-run-${nameFromLabel(p.name)}-\${envId}`;
      const base = ['docker', 'compose', '-p', project, '-f', file];
      return {
        kind: 'service',
        item: serviceOf({
          name: p.name,
          label: p.label?.trim() || 'Docker Compose parts',
          template: 'compose_stack',
          repoId: p.repoId,
          cwd: cleanFolder(p.folder),
          cmd: [...base, 'up', ...p.services],
          stopCmd: [...base, 'down'],
          ports: p.readyPort
            ? [{ name: 'http', default: p.readyPort, url: 'http://localhost:${port}/' }]
            : [],
          health: p.readyPort ? { kind: 'tcp', port: 'http' } : { kind: 'none', graceSec: 10 },
          after: [],
          docker: true,
        }),
      };
    }
  }
}

function stepOf(s: {
  name: string;
  label: string;
  template: string;
  repoId: string;
  cwd: string;
  cmd: string[];
  when: string;
}): RunSetupStep {
  return {
    name: s.name.slice(0, 80),
    label: s.label.slice(0, 120),
    template: s.template,
    repoId: s.repoId,
    cwd: s.cwd,
    cmd: s.cmd,
    timeoutSec: 1200,
    when: s.when,
  };
}

function serviceOf(s: {
  name: string;
  label: string;
  template: string;
  repoId: string;
  cwd: string;
  cmd: string[];
  stopCmd?: string[];
  envFile?: string;
  ports: RunService['ports'];
  health: RunHealth;
  after: string[];
  docker: boolean;
}): RunService {
  return {
    name: s.name,
    label: s.label.slice(0, 120),
    template: s.template,
    repoId: s.repoId,
    cwd: s.cwd,
    cmd: s.cmd,
    ...(s.envFile ? { envFile: s.envFile } : {}),
    env: {},
    ports: s.ports,
    health: s.health,
    startTimeoutSec: 300,
    after: s.after,
    ...(s.stopCmd ? { stopCmd: s.stopCmd } : {}),
    docker: s.docker,
  };
}

// ------------------------------------------------------------------------------------------------- reading back

/**
 * The answers that would rebuild this plan item through its template, or null when it was not made from one (or was
 * changed in the technical view so that it no longer fits). The editor then shows it as a plain command.
 */
export function templateParams(
  kind: 'step' | 'service',
  item: RunSetupStep | RunService,
): RunTemplateParams | null {
  if (kind === 'step') {
    const st = item as RunSetupStep;
    const when = whenFromString(st.when);
    const folder = st.cwd;
    if (st.template === 'install_packages') {
      const pm = PACKAGE_MANAGERS.find((m) => m.cmd.join(' ') === st.cmd.join(' '));
      if (!pm) return null;
      return { template: 'install_packages', params: { repoId: st.repoId, folder, manager: pm.id, when } };
    }
    if (st.template === 'build' || st.template === 'prepare_db')
      return {
        template: st.template,
        params: { repoId: st.repoId, folder, command: formatCommandLine(st.cmd), when },
      };
    return {
      template: 'custom_step',
      params: {
        name: st.name,
        repoId: st.repoId,
        folder,
        command: formatCommandLine(st.cmd),
        when,
        ...(st.label ? { label: st.label } : {}),
      },
    };
  }
  const sv = item as RunService;
  const port = sv.ports[0];
  if (sv.template === 'web_app' && port)
    return {
      template: 'web_app',
      params: {
        name: sv.name,
        repoId: sv.repoId,
        folder: sv.cwd,
        command: formatCommandLine(sv.cmd),
        port: port.default,
        ...(port.envVar ? { portEnvVar: port.envVar } : {}),
        ready: healthToReady(sv.health),
        after: sv.after,
        ...(sv.envFile ? { envFile: sv.envFile } : {}),
        ...(sv.label ? { label: sv.label } : {}),
      },
    };
  if (sv.template === 'docker_service') {
    const image = sv.cmd[sv.cmd.length - 1] ?? '';
    const env: Record<string, string> = {};
    for (let i = 0; i < sv.cmd.length - 1; i++)
      if (sv.cmd[i] === '-e') {
        const [k, ...v] = (sv.cmd[i + 1] ?? '').split('=');
        if (k) env[k] = v.join('=');
      }
    return {
      template: 'docker_service',
      params: {
        name: sv.name,
        repoId: sv.repoId,
        image,
        containerPort: port?.default ?? 0,
        env,
        after: sv.after,
        ...(sv.label ? { label: sv.label } : {}),
      },
    };
  }
  if (sv.template === 'compose_stack') {
    const i = sv.cmd.indexOf('-f');
    const up = sv.cmd.indexOf('up');
    return {
      template: 'compose_stack',
      params: {
        name: sv.name,
        repoId: sv.repoId,
        folder: sv.cwd,
        composeFile: i >= 0 ? (sv.cmd[i + 1] ?? '') : '',
        services: up >= 0 ? sv.cmd.slice(up + 1) : [],
        ...(port ? { readyPort: port.default } : {}),
        ...(sv.label ? { label: sv.label } : {}),
      },
    };
  }
  return {
    template: 'custom_service',
    params: {
      name: sv.name,
      repoId: sv.repoId,
      folder: sv.cwd,
      command: formatCommandLine(sv.cmd),
      ...(port ? { port: port.default } : {}),
      ...(port?.envVar ? { portEnvVar: port.envVar } : {}),
      ready: healthToReady(sv.health),
      after: sv.after,
      ...(sv.envFile ? { envFile: sv.envFile } : {}),
      ...(sv.label ? { label: sv.label } : {}),
    },
  };
}

// ------------------------------------------------------------------------------------------------- plain words

/** The name a person sees for a step or service. */
export const itemLabel = (i: { name: string; label?: string | undefined }): string =>
  i.label?.trim() || i.name;

/** One line about what a setup step does, in plain words. */
export function describeStep(s: RunSetupStep): string {
  const where = s.cwd && s.cwd !== '.' ? ` in ${s.cwd}` : '';
  const when = whenFromString(s.when);
  const rhythm =
    when.kind === 'first'
      ? ' Only the first time.'
      : when.kind === 'changed'
        ? ` Again when ${when.pattern || 'files'} changes.`
        : '';
  return `Runs ${formatCommandLine(s.cmd)}${where}.${rhythm}`;
}

/** One line about what a service does, in plain words. */
export function describeService(s: RunService): string {
  const where = s.cwd && s.cwd !== '.' ? ` in ${s.cwd}` : '';
  const port = s.ports[0];
  if (s.template === 'docker_service') {
    const image = s.cmd[s.cmd.length - 1] ?? 'a container';
    return `Starts a throwaway ${image} in Docker for testing${port ? `, on port ${port.default}` : ''}.`;
  }
  if (s.template === 'compose_stack') {
    const f = s.cmd.indexOf('-f');
    const up = s.cmd.indexOf('up');
    const parts = up >= 0 ? s.cmd.slice(up + 1) : [];
    return `Starts ${parts.length ? parts.join(', ') : 'everything'} from ${f >= 0 ? (s.cmd[f + 1] ?? 'the compose file') : 'the compose file'} in Docker.`;
  }
  const ready = healthToReady(s.health);
  return `Runs ${formatCommandLine(s.cmd)}${where}${port ? `, on port ${port.default}` : ''}. Ready when ${describeReady(ready)}.`;
}

const PLAIN_PROBLEMS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [
    /^service "(.+)" appears twice$/,
    (m) => `Two parts are both called "${m[1]}". Give each part its own name.`,
  ],
  [
    /^service "(.+)": cwd must stay inside the repository$/,
    (m) => `The folder of "${m[1]}" must be inside the project.`,
  ],
  [
    /^service "(.+)": envFile must be an absolute path on the workstation$/,
    (m) => `The settings file of "${m[1]}" must be a full path on the computer, like /home/you/app.env.`,
  ],
  [
    /^service "(.+)": after "(.+)" is not a service$/,
    (m) => `"${m[1]}" is set to start after "${m[2]}", but there is no part with that name.`,
  ],
  [/^service "(.+)": port "(.+)" appears twice$/, (m) => `"${m[1]}" lists the port "${m[2]}" twice.`],
  [
    /^step "(.+)": cwd must stay inside the repository$/,
    (m) => `The folder of the step "${m[1]}" must be inside the project.`,
  ],
  [
    /^the "after" dependencies of the services form a cycle$/,
    () => 'Some parts wait for each other, so none can start first. Change a "Start after" choice.',
  ],
];

/** `validateRunPlan` in plain words, plus the checks the guided editor adds (something must start the app). */
export function validateRunPlanPlain(plan: RunPlan): string[] {
  const out = validateRunPlan(plan).map((p) => {
    for (const [re, f] of PLAIN_PROBLEMS) {
      const m = re.exec(p);
      if (m) return f(m);
    }
    return p;
  });
  if (plan.services.length === 0) out.push('Add at least one part that keeps running (the website or app).');
  return out;
}

/** The suggested unique service name for a new part ("web", "web-2", ...). */
export function uniqueServiceName(base: string, taken: string[]): string {
  const set = new Set(taken.map((t) => t.toLowerCase()));
  const root = nameFromLabel(base);
  if (!set.has(root)) return root;
  for (let i = 2; ; i++) if (!set.has(`${root}-${i}`)) return `${root}-${i}`;
}

// ------------------------------------------------------------------------------------------------- safety on the server

const DOCKER_TEMPLATES = new Set(['docker_service', 'compose_stack']);
const SENSITIVE_DIRS =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.aom-runner|\.claude[^/]*|\.config\/gcloud|\.config\/gh)(\/|$)|^\/(etc|proc|sys|root|boot|dev|var\/run)(\/|$)/;

/**
 * Normalizes what the client may not decide: a part that came from a Docker template runs in Docker, one from any other
 * known template does not (only a hand-written "custom" part keeps its own flag). Returns a copy.
 */
export function normalizePlanDocker(plan: RunPlan): RunPlan {
  return {
    ...plan,
    services: plan.services.map((sv) =>
      sv.template && DOCKER_TEMPLATES.has(sv.template)
        ? { ...sv, docker: true }
        : sv.template && sv.template !== 'custom_service'
          ? { ...sv, docker: false }
          : sv,
    ),
  };
}

/** Problems that make a plan unsafe to share with other computers (plain words). Empty: fine. */
export function planSafetyProblems(plan: RunPlan): string[] {
  const out: string[] = [];
  for (const sv of plan.services) {
    if (sv.envFile && (sv.envFile.split('/').includes('..') || SENSITIVE_DIRS.test(sv.envFile)))
      out.push(
        `The settings file of "${sv.name}" (${sv.envFile}) is in a place Guildwise does not read from.`,
      );
    if (sv.template === 'compose_stack') {
      const f = sv.cmd.indexOf('-f');
      const up = sv.cmd.indexOf('up');
      if (
        (f >= 0 && (sv.cmd[f + 1] ?? '').startsWith('-')) ||
        (up >= 0 && sv.cmd.slice(up + 1).some((x) => x.startsWith('-')))
      )
        out.push(`"${sv.name}": the compose file and part names cannot start with a dash.`);
    }
  }
  return out;
}

/** Fills `${envId}` (the first 8 characters of the environment id) so every test copy has its own names. */
export function expandEnvId(plan: RunPlan, envId: string): RunPlan {
  const id = envId.replace(/-/g, '').slice(0, 8);
  const f = (t: string) => t.replaceAll('${envId}', id);
  return {
    ...plan,
    setup: plan.setup.map((st) => ({ ...st, cmd: st.cmd.map(f) })),
    services: plan.services.map((sv) => ({
      ...sv,
      cmd: sv.cmd.map(f),
      ...(sv.stopCmd ? { stopCmd: sv.stopCmd.map(f) } : {}),
      env: Object.fromEntries(Object.entries(sv.env).map(([k, v]) => [k, f(v)])),
      health: sv.health.kind === 'http' ? { ...sv.health, url: f(sv.health.url) } : sv.health,
    })),
  };
}
