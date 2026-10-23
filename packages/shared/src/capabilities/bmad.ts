import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { adaptedHash, type discoverCapabilities, inPack, type PackTree, type RawSkill } from './packs.ts';
import {
  type CapabilityIssue,
  CapabilityKeySchema,
  type ParsedCapability,
  parsePersona,
  parsePlaybook,
  parseSkill,
  STEP_FILE_RE,
  splitFrontmatter,
} from './parse.ts';
import { parseTomlLite, tomlString, tomlStrings, tomlTable } from './toml-lite.ts';

/**
 * The `bmad` pack adapter: maps the BMad Method (github.com/bmad-code-org/BMAD-METHOD, MIT) onto the registry.
 *
 * Verified layouts (both found by the generic pass, which looks for `SKILL.md` folders anywhere):
 *  - the stable tags (v6.12.x): `src/{core-skills,bmm-skills/<group>}/<skill>/SKILL.md` with `customize.toml` and
 *    `src/bmm-skills/module.yaml` (agent roster);
 *  - the development branch: top-level `skills/<skill>/SKILL.md` with `customize.toml` and `bmod.toml`.
 *
 * Mapping (the pack's capability keys are `<pack>:<name without the bmad- prefix>`):
 *  - `bmad-agent-*`  -> personas (`analyst`, `pm`, ...): name, title and icon from the skill, `customize.toml [agent]` or the
 *    module roster; the prompt is built from role, identity, style and principles (the IDE activation and menu steps are dropped);
 *  - `bmad-brainstorming`, `bmad-advanced-elicitation` -> playbooks labelled `discovery` (their CSV catalogues stay as assets);
 *  - `bmad-product-brief`, `bmad-prd` -> playbooks labelled `template:brief` and `template:prd` (templates and checklist as assets);
 *  - `bmad-party-mode` -> not imported (the Boardroom replaces it; the personas stay usable);
 *  - installer and tooling skills (`bmad`, `bmod-*`, `bmad-customize`, `bmad-help`, `bmad-toolsmith`) -> not imported;
 *  - everything else (dev, story, code review, `bmad-create-epics-and-stories`, ...) -> skills, available to grant, not wired into delivery.
 * `customize.toml` is read only for the safe persona fields; it is never served to an agent. Scripts stay in the file list and
 * are removed at use time unless the owner enabled scripts for the pack.
 */

const NOT_IMPORTED = new Set(['bmad', 'bmad-customize', 'bmad-help', 'bmad-toolsmith']);
const PLAYBOOKS: Record<string, string[]> = {
  'bmad-brainstorming': ['discovery'],
  'bmad-advanced-elicitation': ['discovery', 'stress_test'],
  'bmad-product-brief': ['template:brief'],
  'bmad-prd': ['template:prd'],
};
const SKILL_TAGS: Record<string, string[]> = {
  'bmad-create-epics-and-stories': ['ba'],
};

/** What the original text calls things, in our terms. Applied to every markdown file of an imported capability. */
export const BMAD_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ['{user_name}', 'the owner'],
  ['{communication_language}', "the owner's language"],
  ['{document_output_language}', "the owner's language"],
  ['{planning_artifacts}', 'the session documents (save drafts with `aom session draft`)'],
  ['{implementation_artifacts}', 'the project documents'],
  ['{project_knowledge}', "the project's documents (read-only)"],
  ['{output_folder}', 'the session documents'],
  ['{project_name}', 'the project'],
  ['{project-root}', 'the project'],
  ['{skill-root}', 'this skill'],
  ['{skill-name}', 'this skill'],
  ['{date}', 'today'],
];

const CONTEXT_NOTE = (ref: string): string =>
  `> Guildwise context: this text was written for another tool. Ignore anything that names \`uv run\` scripts, \`_bmad/\` folders, \`customize.toml\`, IDE menus or a greeting ritual: they are not available here. The owner is "the owner" and writes in their own language. Save drafts with \`aom session draft\` in a Discovery session, or answer in the conversation. \`{workflow.*}\` and \`{agent.*}\` settings take sensible defaults. Read catalogue and template files of this capability with \`aom skill show ${ref} --file <path>\`.`;

/** Sections whose whole body is installer, activation or headless plumbing. */
const DROPPED_SECTIONS = /^(on activation|conventions|headless mode|headless)$/i;

/** Longest line the shim runs a pattern over; a longer one is cut (such a line is not prose a pack author wrote). */
const MAX_LINE = 4096;

/** `## Title` -> level and trimmed title, by scanning (no backtracking regex). */
export function parseHeading(line: string): { level: number; text: string } | null {
  if (line.length > MAX_LINE) return null;
  let n = 0;
  while (line[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  const c = line[n];
  if (c !== ' ' && c !== '\t') return null;
  return { level: n, text: line.slice(n).trim() };
}

/** Pure text shim: drops activation and plumbing sections and script calls, maps config variables, renames pack references. */
export function shimBmadText(text: string, opts: { pack: string; known: ReadonlySet<string> }): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));
  const out: string[] = [];
  let skipLevel = 0; // heading level of the section being dropped
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = !fenced ? parseHeading(line) : null;
    if (h) {
      const level = h.level;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && DROPPED_SECTIONS.test(h.text)) {
        skipLevel = level;
        continue;
      }
    }
    if (skipLevel) continue;
    if (fenced && /\buv run\b/.test(line)) continue;
    if (/^Activation is complete\b/.test(line)) continue;
    out.push(line);
  }
  let t = out.join('\n');
  t = t.replace(/`uv run [^`]*`/g, '(a script of the original tool, not available here)');
  t = t.replace(/`?\bbmad-party-mode\b`?/g, 'the Boardroom');
  t = t.replace(/\bbmad-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g, (m: string) => {
    if (opts.known.has(m)) return `${opts.pack}:${stripName(m)}`;
    return m;
  });
  for (const [from, to] of BMAD_VARIABLES) t = t.split(from).join(to);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** `bmad-agent-analyst` -> `analyst`; `bmad-dev-story` -> `dev-story`. */
export const stripName = (n: string): string => n.replace(/^bmad-agent-/, '').replace(/^bmad-/, '');

function descriptionOf(main: string, fallback: string): string {
  try {
    const d = splitFrontmatter(main).data.description;
    if (typeof d === 'string' && d.trim()) return d.trim().replace(/\s+/g, ' ').slice(0, 1024);
  } catch {
    // no frontmatter: the fallback
  }
  return fallback;
}

function section(body: string, title: string): string {
  const want = title.toLowerCase();
  const out: string[] = [];
  let inside = false;
  for (const line of body.split('\n')) {
    const h = parseHeading(line);
    if (h?.level === 2) {
      if (inside) break;
      if (h.text.toLowerCase() === want) inside = true;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n').trim();
}

interface Roster {
  name?: string;
  title?: string;
  icon?: string;
  description?: string;
}

function readRoster(tree: PackTree): Map<string, Roster> {
  const out = new Map<string, Roster>();
  for (const [p, t] of Object.entries(tree)) {
    if (!p.endsWith('module.yaml')) continue;
    try {
      const y = parseYaml(t) as { agents?: Array<Record<string, unknown>> } | null;
      for (const a of y?.agents ?? []) {
        if (typeof a?.code !== 'string') continue;
        out.set(a.code, {
          ...(typeof a.name === 'string' ? { name: a.name } : {}),
          ...(typeof a.title === 'string' ? { title: a.title } : {}),
          ...(typeof a.icon === 'string' ? { icon: a.icon } : {}),
          ...(typeof a.description === 'string' ? { description: a.description } : {}),
        });
      }
    } catch {
      // a module file we cannot read adds nothing
    }
  }
  return out;
}

/** The first `# Name - Title` line (dash, en dash or em dash, with spaces around it), found by scanning. */
function h1Of(body: string): [string, string, string] | null {
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (line.length > MAX_LINE || !/^#[ \t]/.test(line)) continue;
    const text = line.slice(1).trim();
    for (let i = 1; i < text.length - 1; i++) {
      const ch = text[i];
      if ((ch === '—' || ch === '–' || ch === '-') && /\s/.test(text[i + 1] as string)) {
        const a = text.slice(0, i).trim();
        const b = text.slice(i + 1).trim();
        if (a && b) return ['', a, b];
      }
    }
  }
  return null;
}

function personaFor(
  pack: string,
  s: RawSkill,
  roster: Map<string, Roster>,
  known: ReadonlySet<string>,
): ParsedCapability {
  const key = stripName(s.key);
  const main = s.files['SKILL.md'] as string;
  const { body } = splitFrontmatter(main);
  const toml = s.files['customize.toml'] ? parseTomlLite(s.files['customize.toml']) : {};
  const agent = tomlTable(toml.agent) ?? {};
  const r = roster.get(s.key) ?? {};
  const h1 = h1Of(body);
  const name = tomlString(agent.name) ?? r.name ?? h1?.[1] ?? key;
  const title = tomlString(agent.title) ?? r.title ?? h1?.[2] ?? 'Specialist';
  const icon = tomlString(agent.icon) ?? r.icon ?? '🧑';
  const role = tomlString(agent.role);
  const identity = tomlString(agent.identity);
  const style = tomlString(agent.communication_style);
  const principles = tomlStrings(agent.principles);
  const overview = shimBmadText(section(body, 'Overview'), { pack, known });
  const prompt = [
    /^you are\b/i.test(overview) ? '' : `You are ${name}, the ${title}.`,
    overview,
    role ? `Your role: ${role}` : '',
    identity ? `Your identity: ${identity}` : '',
    style ? `How you speak: ${style}` : '',
    principles.length ? `Your principles:\n${principles.map((p) => `- ${p}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const description = descriptionOf(main, r.description ?? `${title}`);
  const fm = {
    name: `${name} (${title})`.slice(0, 100),
    description,
    stance: (role ?? description).slice(0, 500),
    voice: (style ?? 'Professional and direct').slice(0, 500),
    icon: icon.slice(0, 60),
  };
  const text = `---\n${stringifyYaml(fm).trimEnd()}\n---\n${prompt}\n`;
  const e = parsePersona(key, text);
  return inPack(pack, { ...e, hash: adaptedHash(e.files, 'bmad') }, { tags: ['roster'], icon: fm.icon });
}

function skillFiles(s: RawSkill, pack: string, known: ReadonlySet<string>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [p, t] of Object.entries(s.files)) {
    if (p === 'customize.toml' || p === 'bmod.toml' || p.endsWith('/customize.toml')) continue;
    // SKILL.md is shimmed without its frontmatter (`rebuildMain` writes a new one)
    files[p] =
      p === 'SKILL.md'
        ? shimBmadText(splitFrontmatterSafe(t), { pack, known })
        : p.endsWith('.md')
          ? shimBmadText(t, { pack, known })
          : t;
  }
  return files;
}

function splitFrontmatterSafe(text: string): string {
  try {
    return splitFrontmatter(text).body;
  } catch {
    return text;
  }
}

function rebuildMain(s: RawSkill, key: string, ref: string, shimmed: string): string {
  const description = descriptionOf(s.files['SKILL.md'] as string, key);
  const fm = stringifyYaml({ name: key, description }).trimEnd();
  return `---\n${fm}\n---\n\n${CONTEXT_NOTE(ref)}\n\n${shimmed}\n`;
}

export function indexBmadPack(
  pack: string,
  tree: PackTree,
  found: ReturnType<typeof discoverCapabilities>,
): { entries: ParsedCapability[]; issues: CapabilityIssue[]; notes: string[] } {
  const entries: ParsedCapability[] = [];
  const issues: CapabilityIssue[] = [];
  const notes: string[] = [];
  const roster = readRoster(tree);
  const imported = found.skills.filter((s) => {
    if (s.key === 'bmad-party-mode') {
      notes.push('bmad-party-mode: not imported, the Boardroom replaces it (its agent personas stay usable)');
      return false;
    }
    if (s.key.startsWith('bmod-') || NOT_IMPORTED.has(s.key)) {
      notes.push(`${s.key}: installer or tooling skill, not imported`);
      return false;
    }
    return true;
  });
  const known = new Set(imported.map((s) => s.key));
  for (const s of imported) {
    const path = `${s.dir}/SKILL.md`;
    try {
      const key = stripName(s.key);
      if (!CapabilityKeySchema.safeParse(key).success)
        throw new Error(`"${s.key}" cannot be turned into a key`);
      if (s.key.startsWith('bmad-agent-')) {
        entries.push(personaFor(pack, s, roster, known));
        continue;
      }
      const files = skillFiles(s, pack, known);
      const tagsPlaybook = PLAYBOOKS[s.key];
      if (tagsPlaybook) {
        const pbFiles: Record<string, string> = {};
        for (const [p, t] of Object.entries(files)) {
          if (p === 'SKILL.md') continue;
          // a steps/ folder that does not follow our naming moves under references/
          pbFiles[p.startsWith('steps/') && !STEP_FILE_RE.test(p) ? `references/${p}` : p] = t;
        }
        pbFiles['workflow.md'] = rebuildMain(s, key, `playbook:${pack}:${key}`, files['SKILL.md'] as string);
        const e = parsePlaybook(key, pbFiles);
        entries.push(inPack(pack, { ...e, hash: adaptedHash(e.files, 'bmad') }, { tags: tagsPlaybook }));
        continue;
      }
      files['SKILL.md'] = rebuildMain(s, key, `skill:${pack}:${key}`, files['SKILL.md'] as string);
      const e = parseSkill(key, files);
      const tags = SKILL_TAGS[s.key];
      entries.push(inPack(pack, { ...e, hash: adaptedHash(e.files, 'bmad') }, tags ? { tags } : {}));
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { entries, issues, notes };
}
