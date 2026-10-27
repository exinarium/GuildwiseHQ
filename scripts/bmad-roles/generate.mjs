#!/usr/bin/env node
// Reads a checkout of the BMAD Method (https://github.com/bmad-code-org/BMAD-METHOD, MIT) and writes the persona and method
// text the BMAD role set is built from: packages/shared/src/roles/role-sets/bmad.generated.ts. How Guildwise uses it (which
// role gets which persona and skills, and the rules that adapt BMAD to Guildwise) is packages/shared/src/roles/role-sets/bmad.ts.
//
//   node scripts/bmad-roles/generate.mjs <BMAD checkout> [--repo <url>] [--check]
//
// The checkout's HEAD commit is recorded. `--check` only verifies that the file is current for that checkout. See
// docs/bmad-roles.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'packages', 'shared', 'src', 'roles', 'role-sets', 'bmad.generated.ts');

/**
 * The method sections kept besides the personas, by agent skill: `heading` names a section of `file` (up to the next heading
 * of the same or a higher level); `from`/`to` narrow it to the lines from the first match of `from` up to (not including)
 * the first match of `to`.
 */
export const METHODS = {
  'bmad-agent-po': [
    { id: 'spec-law', title: 'Spec Law', file: 'references/spec.md', heading: 'Spec Law' },
    { id: 'load-bearing', title: 'Load-bearing', file: 'references/spec.md', heading: 'Load-bearing' },
    { id: 'self-validate', title: 'Self-validate', file: 'references/spec.md', heading: 'Self-validate' },
    {
      id: 'good-story',
      title: 'What makes a good story',
      file: 'references/slice.md',
      heading: 'Epic into stories',
      from: /^What makes a good story/,
      to: /^Draft the breakdown/,
    },
    {
      id: 'set-checks',
      title: 'Checks for a set of tickets',
      file: 'references/validate-checks.md',
      heading: 'Set',
    },
  ],
};

/**
 * BMAD machinery an agent in Guildwise has no use for: its scripts and config, the memlog, the ticket store files, the
 * install commands. A sentence that names one is left out (and counted in `dropped`).
 */
const MACHINERY =
  /memlog|tickets\.py|tickets\.toml|read_store|_bmad\b|_bmad\/|\{skill-root\}|\{project-root\}|customize\.toml|uv run|npx |render_skill|resolve_customization|resolve_config|\.toml\b/;

const norm = (t) => t.replace(/\r\n/g, '\n');
const readText = (p) => norm(readFileSync(p, 'utf8'));

/** A dotted path (`workflow.checks.ticket`) in the parsed customize.toml. */
function lookup(cfg, path) {
  let cur = cfg;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

/**
 * Renders the Jinja the BMAD templates use, from the skill's customize.toml defaults: `{% if x %}…{% else %}…{% endif %}`
 * and `{{ x }}`. An expression that is not a plain value (a function call, a file path) is left out with its line.
 */
export function renderTemplate(text, cfg) {
  let t = text.replace(
    /\{%-?\s*if\s+([\w.]+)\s*-?%\}([\s\S]*?)(?:\{%-?\s*else\s*-?%\}([\s\S]*?))?\{%-?\s*endif\s*-?%\}/g,
    (_m, cond, yes, no) => (truthy(lookup(cfg, cond)) ? yes : (no ?? '')),
  );
  t = t
    .split('\n')
    .map((line) => {
      let ok = true;
      const r = line.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
        const v = /^[\w.]+$/.test(expr) ? lookup(cfg, expr) : undefined;
        // a file path is BMAD's own; a value's sentences that name machinery go later (`withoutMachinery`)
        if (typeof v !== 'string' || /\{(skill|project)-root\}/.test(v)) {
          ok = false;
          return '';
        }
        return v.trim();
      });
      return ok ? r : null;
    })
    .filter((l) => l !== null)
    .join('\n');
  return t;
}

/** The text of a markdown section: from `## heading` to the next heading of the same or a higher level. */
export function section(md, heading) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#+ /, '').trim() === heading);
  if (at < 0) throw new Error(`no section "${heading}"`);
  const level = (lines[at].match(/^#+/) ?? [''])[0].length;
  const end = lines.findIndex(
    (l, i) => i > at && /^#{1,6} /.test(l) && (l.match(/^#+/) ?? [''])[0].length <= level,
  );
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

/** Phrases that name BMAD machinery inside a sentence worth keeping: the phrase goes, the sentence stays. */
const REWRITES = [
  [/, companions, and `\.memlog\.md`/g, ' and its companions'],
  [/,? and `\.memlog\.md`/g, ''],
  [/,? as rendered in `[a-z-]+\.md`/g, ''],
];

/** Leaves out every sentence that names BMAD machinery; returns the text and how many sentences went. */
export function withoutMachinery(text) {
  let dropped = 0;
  for (const [re, by] of REWRITES) text = text.replace(re, by);
  const lines = text.split('\n').map((line) => {
    if (!MACHINERY.test(line)) return line;
    const bullet = /^(\s*(?:[-*]|\d+\.)\s+)/.exec(line)?.[1] ?? '';
    const sentences = line.slice(bullet.length).split(/(?<=[.!?;])\s+(?=[A-Z`*(])/);
    const kept = sentences.filter((s) => !MACHINERY.test(s));
    dropped += sentences.length - kept.length;
    return kept.length ? bullet + kept.join(' ') : null;
  });
  const clean = lines
    .filter((l) => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: clean, dropped };
}

const asList = (v) => (Array.isArray(v) ? v.map(String) : []);

/** The skills an agent's menu points at: `skill = "x"` items and the `x` skills its prompts invoke. */
function menuSkills(menu) {
  const out = [];
  for (const m of menu ?? []) {
    if (typeof m.skill === 'string') out.push(m.skill);
    for (const hit of String(m.prompt ?? '').matchAll(/`(bmad-[a-z0-9-]+)`/g)) out.push(hit[1]);
  }
  return [...new Set(out)];
}

export function build(checkout, opts = {}) {
  const skillsDir = join(checkout, 'skills');
  if (!existsSync(skillsDir))
    throw new Error(`${checkout} has no skills/ folder: is it a BMAD Method checkout?`);
  const commit =
    opts.commit ?? execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const personas = {};
  const methods = {};
  for (const name of readdirSync(skillsDir).sort()) {
    if (!name.startsWith('bmad-agent-')) continue;
    const file = join(skillsDir, name, 'customize.toml');
    if (!existsSync(file)) continue;
    const cfg = parseToml(readText(file));
    const a = cfg.agent ?? {};
    personas[name] = {
      name: String(a.name ?? ''),
      title: String(a.title ?? ''),
      role: String(a.role ?? '').trim(),
      identity: String(a.identity ?? '').trim(),
      communicationStyle: String(a.communication_style ?? '').trim(),
      principles: asList(a.principles),
      menuSkills: menuSkills(a.menu),
      source: `skills/${name}/customize.toml`,
    };
    for (const m of METHODS[name] ?? []) {
      const raw = section(readText(join(skillsDir, name, m.file)), m.heading);
      let part = raw;
      if (m.from || m.to) {
        const lines = raw.split('\n');
        const start = m.from ? lines.findIndex((l) => m.from.test(l)) : 0;
        if (start < 0) throw new Error(`${name}/${m.file}: no line matching ${m.from} under "${m.heading}"`);
        const stopAt = m.to ? lines.findIndex((l, i) => i > start && m.to.test(l)) : -1;
        part = lines.slice(start, stopAt < 0 ? undefined : stopAt).join('\n');
      }
      const { text, dropped } = withoutMachinery(renderTemplate(part, cfg));
      if (!text) throw new Error(`${name}/${m.file} "${m.heading}": nothing is left`);
      if (!methods[name]) methods[name] = [];
      methods[name].push({ id: m.id, title: m.title, text, dropped, source: `skills/${name}/${m.file}` });
    }
  }
  const source = { repo: opts.repo ?? 'https://github.com/bmad-code-org/BMAD-METHOD', commit };
  return `// GENERATED by scripts/bmad-roles/generate.mjs from the BMAD Method (MIT, Copyright (c) 2025 BMad Code, LLC) at the commit
// below. Do not edit by hand: run \`node scripts/bmad-roles/generate.mjs <BMAD checkout>\` (docs/bmad-roles.md).
import type { BmadMethodSection, BmadPersona } from './bmad-types.ts';

export const BMAD_SOURCE = ${JSON.stringify(source, null, 2)} as const;

export const BMAD_PERSONAS: Record<string, BmadPersona> = ${JSON.stringify(personas, null, 2)};

export const BMAD_METHODS: Record<string, BmadMethodSection[]> = ${JSON.stringify(methods, null, 2)};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const checkout = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--repo');
  if (!checkout) {
    console.error('usage: node scripts/bmad-roles/generate.mjs <BMAD checkout> [--repo <url>] [--check]');
    process.exit(2);
  }
  const repoAt = args.indexOf('--repo');
  const text = build(checkout, repoAt >= 0 ? { repo: args[repoAt + 1] } : {});
  if (args.includes('--check')) {
    const cur = existsSync(out) ? readText(out) : '';
    if (cur !== text) {
      console.error(
        'bmad.generated.ts is out of date for this checkout: run node scripts/bmad-roles/generate.mjs',
      );
      process.exit(1);
    }
  } else writeFileSync(out, text);
}
