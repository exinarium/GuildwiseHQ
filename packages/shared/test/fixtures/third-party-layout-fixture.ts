/**
 * A small repository in the layout of a popular third-party skill collection (the BMad Method, written for another tool;
 * original text written for the tests, nothing is copied from the project): skills with `customize.toml`, activation steps,
 * `uv run` calls and a module roster. Used to prove that such a repository imports as plain skills, without errors, through
 * the generic pack reading. `stable` mimics the v6.12 tags (`src/core-skills`, `src/bmm-skills/<group>`, `module.yaml`),
 * `branch` the top-level `skills/` layout.
 */
export type Tree = Record<string, string>;

const skill = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const ACTIVATION = `## Conventions

- Bare paths resolve from {skill-root}.

## On Activation

1. Run \`uv run {project-root}/_bmad/scripts/resolve_config.py --project-root {project-root}\` and resolve {user_name}.
2. Greet {user_name} in {communication_language}.

Activation is complete. Do not begin the main workflow before this.
`;

export const LICENSE =
  'MIT License\n\nCopyright (c) 2025 Example Maintainers\n\nPermission is hereby granted, free of charge...\n';

const agent = (code: string, name: string, title: string, icon: string): Tree => ({
  'SKILL.md': skill(
    code,
    `${title} for tests. Use when the user asks to talk to ${name}`,
    `# ${name} — ${title}\n\n## Overview\n\nYou are ${name}, the ${title}. You greet {user_name} and keep notes in {planning_artifacts}.\n\n## On Activation\n\n### Step 1\nRun \`uv run {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root}\`.\n\n### Step 8: Dispatch or Present the Menu\nRender {agent.menu} as a table.\n`,
  ),
  'customize.toml': `[agent]\nname = "${name}"\ntitle = "${title}"\nicon = "${icon}"\nrole = "Help with ${title.toLowerCase()} work."\nidentity = "Careful and curious."\ncommunication_style = "Short sentences, concrete examples."\nprinciples = [\n  "Evidence first.",\n  "Name the trade-off.",\n]\n\n[[agent.menu]]\ncode = "BP"\ndescription = "Brainstorm"\nskill = "bmad-brainstorming"\n`,
});

function skillTree(): Record<string, Tree> {
  return {
    'bmad-agent-analyst': agent('bmad-agent-analyst', 'Mary', 'Business Analyst', '📊'),
    'bmad-agent-pm': agent('bmad-agent-pm', 'John', 'Product Manager', '📋'),
    'bmad-agent-dev': agent('bmad-agent-dev', 'Amelia', 'Senior Software Engineer', '💻'),
    'bmad-brainstorming': {
      'SKILL.md': skill(
        'bmad-brainstorming',
        'Facilitate a brainstorming session using diverse creative techniques',
        `# Brainstorming\n\n## Overview\n\nYou coach a brainstorm. Offer the party mode skill \`bmad-party-mode\` or \`bmad-advanced-elicitation\` at any time.\n\n${ACTIVATION}\n## Run a Session\n\nAsk what is being brainstormed for {user_name}. Pick techniques from assets/brain-methods.csv. Write notes under {planning_artifacts}.\n\n\`\`\`\nuv run {skill-root}/scripts/brain.py list\n\`\`\`\n`,
      ),
      'customize.toml': '[workflow]\nactivation_steps_prepend = []\n',
      'assets/brain-methods.csv':
        'category,technique_name,description\ncollaborative,Yes And,"Build on the last idea"\n',
      'references/finalize.md': '# Finalize\n\nSummarise for {user_name}.\n',
      'scripts/brain.py': 'print("hello")\n',
    },
    'bmad-advanced-elicitation': {
      'SKILL.md': skill(
        'bmad-advanced-elicitation',
        'Push a section further with a named reasoning method',
        '# Advanced elicitation\n\n## Overview\n\nPick a method from assets/methods.csv and apply it to the selected text.\n',
      ),
      'assets/methods.csv':
        'num,category,method_name,description\n1,advanced,Tree of Thoughts,"Explore paths"\n',
    },
    'bmad-party-mode': {
      'SKILL.md': skill(
        'bmad-party-mode',
        'Group chat with all agents',
        '# Party\n\n## Overview\n\nAll agents talk.\n',
      ),
    },
    'bmad-product-brief': {
      'SKILL.md': skill(
        'bmad-product-brief',
        'Create or validate a product brief',
        '# Product brief\n\n## Overview\n\nCoach the brief.\n',
      ),
      'assets/brief-template.md': '# Brief for {project_name}\n\n## Problem\n\n',
    },
    'bmad-prd': {
      'SKILL.md': skill(
        'bmad-prd',
        'Create, update or validate a PRD',
        '# PRD\n\n## Overview\n\nFacilitate the PRD.\n',
      ),
      'assets/prd-template.md': '# PRD {project_name}\n\n## Goals\n\n',
      'assets/prd-validation-checklist.md': '- [ ] Goals are measurable\n',
    },
    'bmad-create-epics-and-stories': {
      'SKILL.md': skill(
        'bmad-create-epics-and-stories',
        'Break a PRD into epics and stories',
        '# Epics\n\n## Overview\n\nSplit work.\n',
      ),
      'steps/step-01-validate.md': '# Step 1\n',
      'templates/epics-template.md': '# Epics\n',
    },
    'bmad-dev-story': {
      'SKILL.md': skill('bmad-dev-story', 'Implement a story', '# Dev story\n\n## Overview\n\nImplement.\n'),
    },
    'bmad-help': { 'SKILL.md': skill('bmad-help', 'Help', '# Help\n') },
    'bmod-method': { 'SKILL.md': skill('bmod-method', 'Installer module', '# Method\n') },
  };
}

const MODULE_YAML = `code: bmm
name: "Fixture module"
agents:
  - code: bmad-agent-analyst
    name: Mary
    title: Business Analyst
    icon: "📊"
    description: "Roster description for Mary"
`;

export function thirdPartyLayoutStable(): Tree {
  const t: Tree = { LICENSE, 'README.md': '# fixture\n', 'src/bmm-skills/module.yaml': MODULE_YAML };
  const place: Record<string, string> = {
    'bmad-brainstorming': 'src/core-skills',
    'bmad-advanced-elicitation': 'src/core-skills',
    'bmad-party-mode': 'src/core-skills',
    'bmad-help': 'src/core-skills',
    'bmad-agent-analyst': 'src/bmm-skills/agents',
    'bmad-agent-pm': 'src/bmm-skills/agents',
    'bmad-agent-dev': 'src/bmm-skills/agents',
    'bmad-product-brief': 'src/bmm-skills/plan',
    'bmad-prd': 'src/bmm-skills/plan',
    'bmad-create-epics-and-stories': 'src/bmm-skills/plan',
    'bmad-dev-story': 'src/bmm-skills/ship',
    'bmod-method': 'src/bmm-skills',
  };
  for (const [name, files] of Object.entries(skillTree()))
    for (const [p, text] of Object.entries(files)) t[`${place[name]}/${name}/${p}`] = text;
  // a legacy shim and a test folder that must never be indexed
  t['src/bmm-skills/v6-shims/bmad-create-prd/SKILL.md'] = skill('bmad-create-prd', 'Legacy shim', '# shim\n');
  t['src/core-skills/bmad-brainstorming/scripts/tests/SKILL.md'] = 'not a skill';
  return t;
}

export function thirdPartyLayoutBranch(): Tree {
  const t: Tree = { LICENSE, 'README.md': '# fixture\n' };
  for (const [name, files] of Object.entries(skillTree()))
    for (const [p, text] of Object.entries(files)) t[`skills/${name}/${p}`] = text;
  return t;
}
