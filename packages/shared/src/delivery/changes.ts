import { z } from 'zod';
import type { ProbeComposeFile, ProbeReport } from './probe.ts';
import { type DeliverySetup, describeSetupStep, implicitStepText, type SetupEnv } from './setup.ts';

/**
 * "Found / Will change / Will not touch" (design section 6.3). A pure function of the setup and what the probe found, so the
 * wizard, the review and the approval card say the same thing. Adopt, never replace: everything found that the setup does
 * not change is listed as untouched by name.
 */

export const ChangeGroupSchema = z.enum(['reuse', 'each_deploy', 'untouched', 'setup_once', 'question']);
export type ChangeGroup = z.infer<typeof ChangeGroupSchema>;

export interface ChangeItem {
  group: ChangeGroup;
  text: string;
  env: string;
  /** What the item is about: `compose`, `service`, `container`, `volume`, `proxy`, `backups`, `step`, ... */
  ref?: string;
}

/** Does a probed path name the same file as the setup's (`~/x` matches `/home/u/x`)? */
export function samePath(probed: string, wanted: string): boolean {
  if (probed === wanted) return true;
  if (wanted.startsWith('~/')) return probed.endsWith(wanted.slice(1));
  return false;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

const countText = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function composeFor(env: SetupEnv, r: ProbeReport): ProbeComposeFile | undefined {
  return r.composeFiles.find((c) => samePath(c.path, env.app.composeFile));
}

function envChanges(env: SetupEnv, r: ProbeReport | null | undefined): ChangeItem[] {
  const out: ChangeItem[] = [];
  const add = (group: ChangeGroup, text: string, ref?: string) =>
    out.push({ group, text, env: env.name, ...(ref ? { ref } : {}) });
  const where = env.hosting === 'ssh' ? `the server ${env.host ?? ''}`.trim() : 'this computer';
  if (env.runtime === 'direct') {
    directChanges(env, r, add, where);
    return out;
  }

  if (!r) {
    add(
      'question',
      `${where} has not been checked yet. Check it first, so Guildwise can show what it found.`,
    );
  } else {
    if (!r.docker?.installed)
      add('setup_once', `Docker is not installed on ${where}. Install it, then check again.`, 'docker');
    else if (!r.docker.usable)
      add(
        'setup_once',
        `Your user on ${where} cannot use Docker (on Linux an admin adds it to the docker group).`,
        'docker',
      );
    else {
      add('reuse', `Docker${r.docker.version ? ` ${r.docker.version}` : ''} on ${where}`, 'docker');
      // Compose is how the app is restarted: version 2 (`docker compose`) or version 1 (`docker-compose`), either works
      if (!r.docker.composeVersion)
        add(
          'setup_once',
          `Docker Compose is not installed on ${where} (neither “docker compose” nor “docker-compose”). Install it, then check again.`,
          'compose_tool',
        );
      else if (/^1\./.test(r.docker.composeVersion))
        add(
          'reuse',
          `Docker Compose ${r.docker.composeVersion} (the older docker-compose program) on ${where}`,
          'compose_tool',
        );
    }

    const cf = composeFor(env, r);
    if (cf) {
      add(
        'reuse',
        `Compose file ${env.app.composeFile}${cf.project ? ` (project ${cf.project})` : ''} with ${countText(cf.services.length, 'part')}`,
        'compose',
      );
      const svc = cf.services.find((s) => s.name === env.app.service);
      if (svc)
        add(
          'reuse',
          `The app part "${svc.name}"${svc.build ? ' (built from your code)' : svc.image ? ` (image ${svc.image})` : ''}`,
          'service',
        );
      else
        add(
          'question',
          `Which part is your app? "${env.app.service}" is not in the compose file. Parts: ${cf.services.map((s) => s.name).join(', ') || 'none'}.`,
          'service',
        );
      for (const s of cf.services) {
        if (s.name === env.app.service) continue;
        add('untouched', `Part "${s.name}"${s.image ? ` (${s.image})` : ''} is not touched`, 'service');
      }
      for (const v of cf.volumes) add('untouched', `Volume "${v}" (data) is not touched`, 'volume');
      const db = env.steps.find((s) => s.kind === 'db_backup');
      if (db && !cf.services.some((s) => s.name === db.service))
        add('question', `Which part is the database? "${db.service}" is not in the compose file.`, 'service');
    } else {
      add(
        'setup_once',
        `The compose file ${env.app.composeFile} was not found on ${where}. Guildwise does not create it; point the setup at the right file.`,
        'compose',
      );
    }

    const project = cf?.project ?? env.app.composeProject;
    const mine = (c: ProbeReport['containers'][number]) => !!project && c.project === project;
    for (const c of r.containers) {
      if (mine(c) && c.service === env.app.service) {
        add('reuse', `Running now: ${c.name} (${c.image}, ${c.status ?? c.state})`, 'container');
        continue;
      }
      add('untouched', `Container ${c.name} (${c.image}) keeps running, untouched`, 'container');
    }
    const used = new Set(cf?.volumes ?? []);
    for (const v of r.volumes)
      if (!used.has(v) && !(cf?.volumes ?? []).some((cv) => v.endsWith(`_${cv}`)))
        add('untouched', `Volume "${v}" is not touched`, 'volume');

    for (const p of r.proxies)
      add(
        'untouched',
        `${p.kind[0]?.toUpperCase()}${p.kind.slice(1)} proxy (${p.name})${p.sites.length ? ` for ${p.sites.join(', ')}` : ''} is not touched`,
        'proxy',
      );
    for (const f of r.folders) {
      if (env.hosting === 'ssh' && f.path === dirOf(env.app.composeFile)) {
        if (!f.exists) add('setup_once', `The folder ${f.path} does not exist on ${where}.`, 'folder');
        else {
          add('reuse', `Folder ${f.path} on the server`, 'folder');
          if (env.app.imageVar) {
            const iv = f.imageVars?.find((x) => x.name === env.app.imageVar);
            if (iv) add('reuse', `${iv.name} now points at ${iv.value}`, 'image_var');
            else if (f.envKeys?.includes(env.app.imageVar))
              add('reuse', `${env.app.imageVar} is set in the settings file`, 'image_var');
            else if (f.envKeys)
              add(
                'question',
                `The settings file has no ${env.app.imageVar} line yet; it will be added at the first update.`,
                'image_var',
              );
            else add('setup_once', `There is no settings file (.env) in ${f.path}.`, 'image_var');
          }
        }
      }
    }
    for (const b of r.backups)
      add(
        'reuse',
        `Backups folder ${b.dir}: ${countText(b.count, 'file')}${b.newestName ? `, newest ${b.newestName}` : ''}`,
        'backups',
      );
    for (const u of r.urls)
      add('reuse', `${u.url} answers${u.status ? ` (${u.status})` : ' (no answer now)'}`, 'url');
    if (r.listeners.length)
      add(
        'untouched',
        `Ports ${r.listeners.join(' and ')} are in use by other programs and stay as they are`,
        'ports',
      );
  }

  // What every update does
  const imp = implicitStepText(env);
  for (const t of imp.before) add('each_deploy', t, 'step');
  for (const s of env.steps) add('each_deploy', describeSetupStep(s, env), 'step');
  for (const t of imp.after) add('each_deploy', t, 'step');
  return out;
}

/** Found / Will change for an app that runs directly on the machine (no Docker). */
function directChanges(
  env: SetupEnv,
  r: ProbeReport | null | undefined,
  add: (group: ChangeGroup, text: string, ref?: string) => void,
  where: string,
): void {
  const d = env.direct;
  if (!r) {
    add('question', `${where} has not been checked yet. Check it first, so Guildwise can show what it found.`);
  } else if (d) {
    const m = d.manager;
    const name = m.kind === 'systemd' ? m.unit : m.kind === 'pm2' ? m.name : null;
    const norm = (n: string) => n.replace(/\.service$/, '');
    const svc = r.services?.find(
      (x) =>
        (m.kind === 'systemd' && (x.manager === 'systemd' || x.manager === 'systemd_user') && norm(x.name) === norm(m.unit)) ||
        (m.kind === 'pm2' && x.manager === 'pm2' && x.name === m.name),
    );
    if (name)
      if (svc)
        add(
          'reuse',
          `${m.kind === 'pm2' ? 'The pm2 process' : 'The service'} "${name}" is ${svc.state}${svc.workingDir ? ` and runs from ${svc.workingDir}` : ''}${svc.ports.length ? ` (port ${svc.ports.join(', ')})` : ''}`,
          'service',
        );
      else
        add('question', `"${name}" was not found running on ${where}. Is it the right name?`, 'service');
    else add('reuse', 'A restart command of your own', 'service');
    if (m.kind === 'systemd' && m.scope === 'system' && m.sudo)
      add('question', `Restarting ${m.unit} needs administrator rights (sudo). Guildwise only uses sudo without a password prompt; check passes first with “Try it”.`, 'sudo');
    const folder = r.folders.find((f) => f.path === d.appDir);
    if (folder) {
      add('reuse', `The app folder ${d.appDir}`, 'folder');
      const entries = new Set(folder.entries);
      if (entries.has('releases')) add('reuse', 'It already keeps one folder per version (releases)', 'folder');
    } else if (r.appDirs?.includes(d.appDir)) add('reuse', `The app folder ${d.appDir}`, 'folder');
    else add('question', `The app folder ${d.appDir} was not seen on ${where}. It must exist and belong to the signed-in user.`, 'folder');
    if (d.adoptFolder && d.currentLink)
      add(
        'setup_once',
        `${d.currentLink} is a plain folder today. The first update moves it to ${d.appDir}/releases/initial and puts a link with the same name in its place. Nothing is deleted or copied.`,
        'adopt',
      );
    for (const u of r.urls)
      add('reuse', `${u.url} answers${u.status ? ` (${u.status})` : ' (no answer now)'}`, 'url');
    for (const o of r.services ?? []) {
      if (o === svc) continue;
      add('untouched', `${o.name} (${o.manager === 'pm2' ? 'pm2' : o.manager === 'process' ? 'program' : 'service'}) keeps running, untouched`, 'service');
    }
    for (const c of r.containers.filter((x) => x.state === 'running'))
      add('untouched', `Container ${c.name} (${c.image}) keeps running, untouched`, 'container');
  }
  const imp = implicitStepText(env);
  for (const t of imp.before) add('each_deploy', t, 'step');
  for (const s of env.steps) add('each_deploy', describeSetupStep(s, env), 'step');
  for (const t of imp.after) add('each_deploy', t, 'step');
}

/** The change list of every environment. `reports` is keyed by environment name (`null`/absent: not checked yet). */
export function planChanges(
  setup: DeliverySetup,
  reports: Record<string, ProbeReport | null | undefined>,
  only?: string,
): ChangeItem[] {
  return setup.environments
    .filter((e) => !only || e.name === only)
    .flatMap((e) => envChanges(e, reports[e.name]));
}

export const CHANGE_GROUP_TITLES: Record<ChangeGroup, string> = {
  reuse: 'Found and will be used',
  each_deploy: 'Each update will',
  untouched: 'Will not be touched',
  setup_once: 'Needs setting up first',
  question: 'Needs your answer',
};

/** Is there anything that stops a save (something the setup needs that is missing)? */
export const hasBlockers = (items: readonly ChangeItem[]): boolean =>
  items.some((i) => i.group === 'setup_once');
