import { applyEdit, type Choices, editableKeys } from './choices.ts';
import type { DockerMode } from './options.ts';
import type { Prompter } from './prompt.ts';

/**
 * Renders the installer's one screen (DESIGN "Installer screen", exact text) and reads the edits. Names from the server
 * are plain text [S2]: the offers schema already refused control characters, so nothing here is interpreted.
 */

export const SCREEN_PROMPT = 'Press Enter to accept, or type a number (like 1a) to change it:';
const WIDTH = 60;

const DOCKER_LABEL: Record<DockerMode, string> = {
  rootless: 'Its own private Docker',
  none: 'No Docker',
  host: 'The Docker already on this computer',
  shared: 'The shared Docker of this computer',
};

function row(indent: string, key: string, label: string, value: string): string {
  const head = `${indent}${key}  ${label} `;
  const dots = Math.max(3, WIDTH - head.length);
  return `${head}${'.'.repeat(dots)} ${value}`;
}

export function renderScreen(c: Choices): string[] {
  const out = [
    'Almost done. Here is what this computer will allow.',
    'The safe choice is already filled in. You can change it later in Approvals on this computer.',
    '',
  ];
  if (c.orgs.length > 0) {
    out.push(' 1  DevOps helpers that may work outside the safety box here');
    for (const o of c.orgs) {
      const who = o.notOffered ? `${o.orgName} (no longer offered)` : `${o.orgName} (you are ${o.role})`;
      const label = o.agentName ? `${who}, helper "${o.agentName}"` : who;
      out.push(row('      ', o.key, label, o.agentId ? (o.allow ? 'Yes' : 'No') : 'no helper yet'));
    }
  }
  out.push(
    row(
      ' ',
      '2',
      'When the website asks a DevOps helper for something',
      c.devopsRequests === 'ask' ? 'Ask me first' : 'Start without asking',
    ),
  );
  out.push(row(' ', '3', 'Docker, for apps your agents build and test', DOCKER_LABEL[c.docker]));
  out.push(
    row(' ', '4', 'Publishing your apps', c.deploy === 'ask' ? 'Ask me first' : 'Never from this computer'),
  );
  if (c.repos.length > 0) {
    out.push(' 5  Install scripts that come with your code projects');
    for (const r of c.repos) out.push(row('      ', r.key, `${r.name} (${r.id})`, r.allow ? 'Yes' : 'No'));
  }
  out.push(row(' ', '6', "Video transcripts (yt-dlp, in the runner's own folder)", c.ytdlp ? 'Yes' : 'No'));
  out.push('');
  return out;
}

function dockerQuestion(options: readonly DockerMode[]): { text: string; map: DockerMode[] } {
  const text: Record<DockerMode, string> = {
    rootless: 'Its own private Docker (safe)',
    none: 'No Docker',
    host: 'The Docker already on this computer: gives full control of this computer (you will type "root-equivalent")',
    shared:
      'The shared Docker of this computer: it can control every container on it (you will type "shared-daemon")',
  };
  const map = [...options];
  return { text: map.map((m, i) => `${i + 1}) ${text[m]}`).join('  '), map };
}

/** One edit: asks the item's own question (DESIGN "Edit prompts"). Unknown keys are ignored with a note. */
export async function editItem(
  c: Choices,
  key: string,
  p: Prompter,
  say: (l: string) => void,
): Promise<Choices> {
  const org = c.orgs.find((o) => o.key === key);
  if (org) {
    if (!org.agentId) {
      say(`${org.orgName} has no DevOps helper on this workstation yet.`);
      return c;
    }
    const helper = org.agentName ? ` "${org.agentName}"` : '';
    const yes = await p.confirm(
      `May ${org.orgName}'s DevOps helper${helper} install tools and run commands on this computer outside the safety box? Each task still asks you first unless you change item 2.`,
      org.allow,
    );
    return applyEdit(c, key, yes);
  }
  const repo = c.repos.find((r) => r.key === key);
  if (repo) {
    const yes = await p.confirm(
      `Let "${repo.name}" run its own install scripts? They run outside the safety box.`,
      repo.allow,
    );
    return applyEdit(c, key, yes);
  }
  switch (key) {
    case '2': {
      const a = await p.choose(
        '1) Ask me first (safe)  2) Let them start without asking',
        ['1', '2'] as const,
        c.devopsRequests === 'auto' ? '2' : '1',
      );
      return applyEdit(c, '2', a === '2' ? 'auto' : 'ask');
    }
    case '3': {
      const q = dockerQuestion(c.dockerOptions);
      const keys = q.map.map((_, i) => String(i + 1));
      const a = await p.choose(q.text, keys, String(q.map.indexOf(c.docker) + 1));
      return applyEdit(c, '3', q.map[Number(a) - 1] ?? c.docker);
    }
    case '4': {
      const a = await p.choose(
        '1) Ask me first  2) Never publish from this computer',
        ['1', '2'] as const,
        c.deploy === 'off' ? '2' : '1',
      );
      return applyEdit(c, '4', a === '2' ? 'off' : 'ask');
    }
    case '6':
      return applyEdit(
        c,
        '6',
        await p.confirm('Install yt-dlp so agents can read video transcripts?', c.ytdlp),
      );
    default:
      say(`There is no item ${key} on this screen.`);
      return c;
  }
}

/** Shows the screen until Enter; each typed number changes one item. At most 50 rounds (a stuck input ends it). */
export async function runScreen(start: Choices, p: Prompter, say: (l: string) => void): Promise<Choices> {
  let c = start;
  for (let round = 0; round < 50; round++) {
    for (const l of renderScreen(c)) say(l);
    const a = (await p.text(SCREEN_PROMPT)).trim().toLowerCase();
    if (a === '') return c;
    if (!editableKeys(c).includes(a) && !c.orgs.some((o) => o.key === a)) {
      say(`There is no item ${a} to change. Type one of: ${editableKeys(c).join(', ')}.`);
      continue;
    }
    c = await editItem(c, a, p, say);
  }
  return c;
}
